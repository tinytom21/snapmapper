/**
 * The desktop MVP.
 *
 * Open a folder, see the photos, place them on the map, save. Everything of substance is
 * in `@geotagger/core`; this wires it to a screen.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  applySync,
  assignLocation,
  canRedo,
  canUndo,
  clearLocation,
  clearSync,
  createSession,
  createWasmBackend,
  hasPendingChanges,
  instantOf,
  isValidTimeZone,
  locationOf,
  markSaved,
  pendingPhotos,
  redo,
  revert,
  select,
  selectRange,
  setOffsetSeconds,
  setTimeZone,
  toggleSelected,
  undo,
  type CameraClock,
  type ClockSync,
  type Coordinates,
  type MetadataBackend,
  type PhotoEntry,
  type Session,
} from '@geotagger/core';

import { ClockPanel } from './ClockPanel.tsx';
import { PhotoMap, type MapPin } from './PhotoMap.tsx';
import { scanForSyncCode } from './clock-sync-qr.ts';
import {
  MTIME_LIMITATION,
  createBrowserFileStore,
  isFileSystemAccessSupported,
  pickFolder,
  type BrowserFolder,
} from './browser-file-store.ts';
import {
  loadPhotos,
  revokeThumbnailUrls,
  toThumbnailUrls,
  type LoadProgress,
} from './load-photos.ts';
import { saveSession, type SaveOutcome, type SaveProgress } from './save.ts';

const store = createBrowserFileStore();

/** The system zone is the right default; the camera was probably set to it. */
function defaultClock(): CameraClock {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return { timeZone: isValidTimeZone(timeZone) ? timeZone : 'UTC', offsetSeconds: 0 };
}

export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [folder, setFolder] = useState<BrowserFolder | null>(null);
  const [thumbnails, setThumbnails] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState<LoadProgress | null>(null);
  const [saving, setSaving] = useState<SaveProgress | null>(null);
  const [outcomes, setOutcomes] = useState<SaveOutcome[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  /**
   * The WASM backend, loaded once and lazily.
   *
   * 24MB of WebAssembly, so it is not fetched until a folder is opened — no point paying
   * for it on a screen that only has a button.
   */
  const backend = useRef<MetadataBackend | null>(null);
  const getBackend = useCallback(async (): Promise<MetadataBackend> => {
    const existing = backend.current;
    if (existing) return existing;

    const wasm = await import('@uswriting/exiftool');
    const created = createWasmBackend(wasm);
    backend.current = created;
    return created;
  }, []);

  /** Read a folder, replacing whatever was loaded. Shared by open and re-scan. */
  const scanFolder = useCallback(async (target: BrowserFolder, keepClock?: CameraClock) => {
    const refs = await store.listFolder(target);
    if (refs.length === 0) {
      setError(`No JPEGs in “${target.displayName}”.`);
      return;
    }

    setLoading({ done: 0, total: refs.length, current: '' });
    const loaded = await loadPhotos(refs, store, await getBackend(), setLoading);

    setThumbnails((previous) => {
      revokeThumbnailUrls(previous);
      return toThumbnailUrls(loaded.thumbnails);
    });
    setSession(createSession(loaded.entries, keepClock ?? defaultClock()));
  }, [getBackend]);

  const openFolder = useCallback(async () => {
    setError(null);
    setOutcomes(null);

    try {
      const picked = await pickFolder();
      if (!picked) return;

      setFolder(picked);
      setSession(null);
      await scanFolder(picked);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(null);
    }
  }, [scanFolder]);

  /**
   * Re-read the folder, keeping the clock settings.
   *
   * Needed by the sync flow: the reference photo is shot *after* the folder was opened, so
   * it has to be picked up without losing the zone or a measurement already made. Staged
   * edits are lost, so this warns first when there are any.
   */
  const rescanFolder = useCallback(async () => {
    if (!folder) return;

    if (session && hasPendingChanges(session)) {
      const count = pendingPhotos(session).length;
      const proceed = window.confirm(
        `Re-scanning reloads the folder and discards ${count} unsaved change`
        + `${count === 1 ? '' : 's'}. Continue?`,
      );
      if (!proceed) return;
    }

    setError(null);
    setOutcomes(null);
    try {
      await scanFolder(folder, session?.clock);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(null);
    }
  }, [folder, session, scanFolder]);

  const save = useCallback(async () => {
    if (!session) return;
    setError(null);
    setOutcomes(null);
    setSaving({ done: 0, total: pendingPhotos(session).length, current: '' });

    try {
      const { outcomes: results, savedNames } = await saveSession(
        session, store, await getBackend(), setSaving,
      );
      setOutcomes(results);
      setSession((current) => (current ? markSaved(current, savedNames) : current));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(null);
    }
  }, [session, getBackend]);

  /**
   * Read the clock code out of a reference photograph.
   *
   * Returns a message on failure rather than throwing, so the panel can explain what to
   * try differently. A failure here changes nothing: better no measurement than a wrong one.
   */
  const scanReference = useCallback(async (name: string): Promise<string | null> => {
    const current = session;
    if (!current) return 'No folder is open.';

    const entry = current.photos.find((photo) => photo.ref.name === name);
    if (!entry) return 'That photo is no longer in the list.';
    if (!entry.takenAt) {
      return `${name} has no readable date, so it cannot anchor a measurement.`;
    }

    try {
      const bytes = await store.read(entry.ref);
      const found = await scanForSyncCode(bytes);
      if (found.kind !== 'found') return found.message;

      setSession((latest) => (latest
        ? applySync(latest, {
          cameraReading: entry.takenAt as NonNullable<PhotoEntry['takenAt']>,
          trueInstant: found.trueInstant,
          sourcePhoto: name,
          method: 'qr',
        })
        : latest));
      return null;
    } catch (cause) {
      return cause instanceof Error ? cause.message : String(cause);
    }
  }, [session]);

  // Undo/redo on the keyboard, because this is a desktop app and people expect it.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const target = event.target;
      // Never steal Ctrl+Z from a text field.
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'z') return;

      event.preventDefault();
      setSession((current) => {
        if (!current) return current;
        return event.shiftKey ? redo(current) : undo(current);
      });
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // Refuse to lose staged edits to a stray refresh.
  useEffect(() => {
    if (!session || !hasPendingChanges(session)) return;
    function onBeforeUnload(event: BeforeUnloadEvent) {
      event.preventDefault();
    }
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [session]);

  // Object URLs outlive the component unless revoked.
  useEffect(() => () => revokeThumbnailUrls(thumbnails), [thumbnails]);

  const pins = useMemo<MapPin[]>(() => {
    if (!session) return [];
    return session.photos.flatMap((entry) => {
      const location = locationOf(session, entry.ref.name);
      if (location.kind !== 'saved' && location.kind !== 'pending') return [];
      return [{
        name: entry.ref.name,
        coordinates: location.coordinates,
        pending: location.kind === 'pending',
        selected: session.selected.has(entry.ref.name),
      }];
    });
  }, [session]);

  const place = useCallback((coordinates: Coordinates) => {
    setSession((current) => {
      if (!current || current.selected.size === 0) return current;
      return assignLocation(current, [...current.selected], coordinates);
    });
  }, []);

  const movePin = useCallback((name: string, coordinates: Coordinates) => {
    setSession((current) => (current ? assignLocation(current, [name], coordinates) : current));
  }, []);

  const selectOnly = useCallback((name: string) => {
    setSession((current) => (current ? select(current, [name]) : current));
  }, []);

  if (!isFileSystemAccessSupported()) {
    return (
      <main className="gate">
        <h1>photo-geotagger</h1>
        <p>
          This browser has no File System Access API, so it cannot write to your photos in
          place. Use <strong>Chrome or Edge on the desktop</strong>.
        </p>
      </main>
    );
  }

  const busy = loading !== null || saving !== null;
  const pending = session ? pendingPhotos(session).length : 0;

  return (
    <div className="app">
      <header>
        <h1>photo-geotagger</h1>
        <button type="button" onClick={openFolder} disabled={busy}>
          {folder ? 'Open another folder…' : 'Open folder…'}
        </button>
        {folder && (
          <>
            <span className="folder">{folder.displayName}</span>
            <button type="button" onClick={rescanFolder} disabled={busy}>Re-scan folder</button>
          </>
        )}

        <div className="spacer" />

        {session && (
          <>
            <button
              type="button"
              onClick={() => setSession(undo(session))}
              disabled={!canUndo(session) || busy}
              title="Ctrl+Z"
            >
              Undo
            </button>
            <button
              type="button"
              onClick={() => setSession(redo(session))}
              disabled={!canRedo(session) || busy}
              title="Ctrl+Shift+Z"
            >
              Redo
            </button>
            <button
              type="button"
              className="primary"
              onClick={save}
              disabled={pending === 0 || saving !== null}
            >
              {saving ? `Saving ${saving.done}/${saving.total}…` : `Save ${pending || ''}`.trim()}
            </button>
          </>
        )}
      </header>

      {error && <div className="banner error">{error}</div>}

      {loading && (
        <div className="banner">
          Reading metadata {loading.done}/{loading.total} — {loading.current}
        </div>
      )}

      {session && hasPendingChanges(session) && (
        <div className="banner warn">
          {pending} photo{pending === 1 ? '' : 's'} with unsaved changes. Nothing is written
          until you press Save.
        </div>
      )}

      {outcomes && <Outcomes outcomes={outcomes} onDismiss={() => setOutcomes(null)} />}

      <div className="body">
        <aside>
          {session
            ? (
              <>
                <ClockPanel
                  session={session}
                  busy={busy}
                  onTimeZone={(zone) => setSession(setTimeZone(session, zone))}
                  onOffsetSeconds={(seconds) => setSession(setOffsetSeconds(session, seconds))}
                  onSync={(sync: ClockSync) => setSession(applySync(session, sync))}
                  onClearSync={() => setSession(clearSync(session))}
                  onScanReference={scanReference}
                />
                <PhotoList
                  session={session}
                  thumbnails={thumbnails}
                  onToggle={(name) => setSession(toggleSelected(session, name))}
                  onSelectOnly={selectOnly}
                  onSelectRange={(from, to, add) =>
                    setSession(selectRange(session, from, to, add))}
                  onSelectAll={() =>
                    setSession(select(session, session.photos.map((entry) => entry.ref.name)))}
                  onSelectNone={() => setSession(select(session, []))}
                  onClear={() => setSession(clearLocation(session, [...session.selected]))}
                  onRevert={() => setSession(revert(session, [...session.selected]))}
                />
              </>
            )
            : !loading && (
              <div className="empty">
                <p>Open a folder of JPEGs to begin.</p>
                <p className="note">{MTIME_LIMITATION}</p>
              </div>
            )}
        </aside>

        <PhotoMap
          pins={pins}
          onPlace={place}
          onSelectPin={selectOnly}
          onMovePin={movePin}
          armed={Boolean(session && session.selected.size > 0)}
        />
      </div>
    </div>
  );
}

function PhotoList({
  session,
  thumbnails,
  onToggle,
  onSelectOnly,
  onSelectRange,
  onSelectAll,
  onSelectNone,
  onClear,
  onRevert,
}: {
  session: Session;
  thumbnails: Map<string, string>;
  onToggle: (name: string) => void;
  onSelectOnly: (name: string) => void;
  onSelectRange: (from: string, to: string, add: boolean) => void;
  onSelectAll: () => void;
  onSelectNone: () => void;
  onClear: () => void;
  onRevert: () => void;
}) {
  const selectedCount = session.selected.size;

  /** Where the last plain click landed, so shift-click has something to extend from. */
  const anchor = useRef<string | null>(null);

  return (
    <section className="panel grow">
      <h2>
        Photos <span className="count">{session.photos.length}</span>
      </h2>

      <div className="row">
        <button type="button" onClick={onSelectAll}>All</button>
        <button type="button" onClick={onSelectNone} disabled={selectedCount === 0}>None</button>
        <button type="button" onClick={onClear} disabled={selectedCount === 0}>
          Clear location
        </button>
        <button type="button" onClick={onRevert} disabled={selectedCount === 0}>Revert</button>
      </div>

      <p className="note">
        {selectedCount === 0
          ? 'Click a photo, then click the map to place it. Shift-click for a range.'
          : `${selectedCount} selected — click the map to place ${selectedCount === 1 ? 'it' : 'them'}.`}
      </p>

      <ul className="photos">
        {session.photos.map((entry) => (
          <PhotoRow
            key={entry.ref.name}
            entry={entry}
            session={session}
            thumbnail={thumbnails.get(entry.ref.name)}
            onToggle={onToggle}
            onClick={(event) => {
              if (event.shiftKey && anchor.current) {
                onSelectRange(anchor.current, entry.ref.name, event.ctrlKey || event.metaKey);
                return;
              }
              anchor.current = entry.ref.name;
              if (event.ctrlKey || event.metaKey) onToggle(entry.ref.name);
              else onSelectOnly(entry.ref.name);
            }}
          />
        ))}
      </ul>
    </section>
  );
}

function PhotoRow({
  entry,
  session,
  thumbnail,
  onToggle,
  onClick,
}: {
  entry: PhotoEntry;
  session: Session;
  thumbnail: string | undefined;
  onToggle: (name: string) => void;
  onClick: (event: React.MouseEvent) => void;
}) {
  const location = locationOf(session, entry.ref.name);
  const selected = session.selected.has(entry.ref.name);
  const instant = instantOf(session, entry);
  const broken = entry.error !== undefined;

  return (
    <li
      className={`photo${selected ? ' selected' : ''}${broken ? ' broken' : ''}`}
      onClick={onClick}
    >
      <input
        type="checkbox"
        checked={selected}
        onChange={() => onToggle(entry.ref.name)}
        onClick={(event) => event.stopPropagation()}
        disabled={broken}
        aria-label={`Select ${entry.ref.name}`}
      />

      {/*
        draggable={false} matters even though nothing here handles a drag: browsers make
        images draggable by default, so without it a click-and-drag on a thumbnail starts a
        native image drag with a ghost image, which looks like the interface misbehaving.
      */}
      {thumbnail
        ? <img className="thumb" src={thumbnail} alt="" draggable={false} loading="lazy" />
        : <span className="thumb placeholder" aria-hidden="true" />}

      <div className="details">
        <span className="name">{entry.ref.name}</span>
        <div className="meta">
          {broken
            ? <span className="error">unreadable — {entry.error}</span>
            : (
              <>
                <span>
                  {instant
                    ? `${instant.toISOString().replace('T', ' ').slice(0, 19)}Z`
                    : 'no date'}
                </span>
                <LocationLabel location={location} />
              </>
            )}
        </div>
      </div>
    </li>
  );
}

function LocationLabel({ location }: { location: ReturnType<typeof locationOf> }) {
  if (location.kind === 'none') return <span className="dim">no location</span>;
  if (location.kind === 'pending-clear') {
    return <span className="pendingText">location will be removed</span>;
  }

  const { latitude, longitude } = location.coordinates;
  const text = `${latitude.toFixed(5)}, ${longitude.toFixed(5)}`;

  return location.kind === 'pending'
    ? <span className="pendingText">{text} (unsaved)</span>
    : <span>{text}</span>;
}

function Outcomes({
  outcomes,
  onDismiss,
}: {
  outcomes: readonly SaveOutcome[];
  onDismiss: () => void;
}) {
  const failed = outcomes.filter((outcome) => !outcome.ok);
  const warned = outcomes.filter((outcome) => outcome.warnings.length > 0);

  return (
    <div className={`banner ${failed.length > 0 ? 'error' : 'ok'}`}>
      <strong>Saved {outcomes.length - failed.length} of {outcomes.length}</strong>
      {failed.length > 0 && (
        <ul>
          {failed.map((outcome) => (
            <li key={outcome.name}>{outcome.name} — {outcome.message}</li>
          ))}
        </ul>
      )}
      {warned.map((outcome) => (
        <div key={outcome.name} className="note">
          {outcome.name}: {outcome.warnings.join('; ')}
        </div>
      ))}
      <p className="note">{MTIME_LIMITATION}</p>
      <button type="button" onClick={onDismiss}>Dismiss</button>
    </div>
  );
}
