/**
 * The desktop MVP.
 *
 * Open a folder, see the photos, place them on the map, save. Everything of substance is
 * in `@geotagger/core`; this wires it to a screen.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  addPhotos as addPhotosToSession,
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
  type PhotoRef,
  type Session,
} from '@geotagger/core';

import { ClockPanel } from './ClockPanel.tsx';
import { PlatformReport } from './PlatformReport.tsx';
import { PhotoMap, type MapPin } from './PhotoMap.tsx';
import { scanForSyncCode } from './clock-sync-qr.ts';
import {
  LARGE_FOLDER_THRESHOLD,
  MTIME_LIMITATION,
  createBrowserFileStore,
  isFilePickerSupported,
  isFileSystemAccessSupported,
  isFolderPickerSupported,
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
  /** Something worth saying that is not a failure — duplicates skipped, files read-only. */
  const [notice, setNotice] = useState<string | null>(null);

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

  /**
   * Read metadata for a set of files and start a session from them.
   *
   * Only ever called with a set somebody has already chosen — a picked selection, or a folder
   * small enough to be worth reading whole. Parsing is the expensive part: about half a second
   * per photo on a desktop and three on a phone, so what gets passed here matters far more
   * than how fast it runs.
   */
  const loadRefs = useCallback(async (
    refs: readonly PhotoRef[],
    target: BrowserFolder,
    keepClock?: CameraClock,
  ) => {
    setLoading({ done: 0, total: refs.length, current: '' });
    const loaded = await loadPhotos(refs, store, await getBackend(), setLoading);

    setThumbnails((previous) => {
      revokeThumbnailUrls(previous);
      return toThumbnailUrls(loaded.thumbnails);
    });
    setFolder(target);
    setSession(createSession(loaded.entries, keepClock ?? defaultClock()));
  }, [getBackend]);

  /**
   * The file picker. The right way in for a camera card.
   *
   * A card holds hundreds or thousands of photos in one folder, and reading all of them before
   * anything can be done would run for the better part of an hour on a phone. Letting the OS
   * picker narrow the set first is the difference between unusable and instant.
   */
  const openPhotos = useCallback(async () => {
    setError(null);
    setOutcomes(null);
    setNotice(null);

    try {
      const picked = await store.pickPhotos();
      if (!picked) return;

      setSession(null);
      await loadRefs(picked.refs, picked.folder);
      setNotice(describePicked(picked));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(null);
    }
  }, [loadRefs]);

  /**
   * Add more photos to what is already open.
   *
   * The clock-sync flow needs this: the reference frame is shot *after* the session started, so
   * there has to be a way to bring one more file in without discarding the work so far. In
   * folder mode that is Re-scan; here it is this.
   *
   * Only the *new* files are parsed. Re-reading the whole selection would cost a metadata read
   * per photo already open — three seconds each on a phone — so adding one reference frame to a
   * twenty-photo session would take a minute, which would defeat the point of picking files in
   * the first place.
   */
  const addPhotos = useCallback(async () => {
    if (!session || !folder) return;
    setError(null);
    setNotice(null);

    try {
      const open = session.photos.map((entry) => entry.ref);
      const picked = await store.pickPhotos({ add: open });
      if (!picked) return;

      const openNames = new Set(open.map((ref) => ref.name));
      const fresh = picked.refs.filter((ref) => !openNames.has(ref.name));

      if (fresh.length === 0) {
        setNotice(describePicked(picked) ?? 'Those photos are already open.');
        return;
      }

      setLoading({ done: 0, total: fresh.length, current: '' });
      const loaded = await loadPhotos(fresh, store, await getBackend(), setLoading);

      // Append rather than rebuild, so staged edits, the clock measurement and the undo
      // history all survive.
      setThumbnails((previous) => new Map([...previous, ...toThumbnailUrls(loaded.thumbnails)]));
      setSession((current) => (current ? addPhotosToSession(current, loaded.entries) : current));
      setNotice(describePicked(picked));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(null);
    }
  }, [session, folder, getBackend]);

  /**
   * The folder picker, with a guard.
   *
   * One permission prompt covers a whole folder, which is much less clicking — but a camera
   * card's folder holds far too much to read whole, so the count is checked *before* any
   * metadata is touched and a large folder asks first rather than silently starting.
   */
  const openFolder = useCallback(async () => {
    setError(null);
    setOutcomes(null);
    setNotice(null);

    try {
      const picked = await store.pickFolder();
      if (!picked) return;

      // Counting only enumerates names; it reads no metadata, so it is fast even for
      // thousands of files.
      const count = await store.countFolder(picked);
      if (count === 0) {
        setError(`No JPEGs in “${picked.displayName}”.`);
        return;
      }

      if (count > LARGE_FOLDER_THRESHOLD) {
        const minutes = Math.ceil((count * 0.6) / 60);
        const proceed = window.confirm(
          `“${picked.displayName}” holds ${count} photos. Reading them all takes roughly `
          + `${minutes} minute${minutes === 1 ? '' : 's'} here, and considerably longer on a `
          + 'phone.\n\nUse “Select photos…” to choose just the ones you want instead.'
          + '\n\nRead all of them anyway?',
        );
        if (!proceed) return;
      }

      setSession(null);
      await loadRefs(await store.listFolder(picked), picked);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(null);
    }
  }, [loadRefs]);

  /**
   * Re-read the folder, keeping the clock settings.
   *
   * Needed by the sync flow: the reference photo is shot *after* the folder was opened, so
   * it has to be picked up without losing the zone or a measurement already made. Staged
   * edits are lost, so this warns first when there are any.
   */
  const rescanFolder = useCallback(async () => {
    if (!folder?.directory) return;

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
    setNotice(null);
    try {
      await loadRefs(await store.listFolder(folder), folder, session?.clock);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(null);
    }
  }, [folder, session, loadRefs]);

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
          This browser cannot open a folder and write to your photos in place. Use{' '}
          <strong>Chrome or Edge on the desktop</strong>.
        </p>
        {/*
          The report matters most here. This is the screen a phone lands on, and whether the
          picker is genuinely missing or merely hidden by an insecure origin is exactly the
          question the shell decision rests on.
        */}
        <PlatformReport />
      </main>
    );
  }

  const busy = loading !== null || saving !== null;
  const pending = session ? pendingPhotos(session).length : 0;

  return (
    <div className="app">
      <header>
        <h1>photo-geotagger</h1>
        {isFilePickerSupported() && (
          <button type="button" className="primary" onClick={openPhotos} disabled={busy}>
            Select photos…
          </button>
        )}
        {isFolderPickerSupported() && (
          <button type="button" onClick={openFolder} disabled={busy}>Open whole folder…</button>
        )}
        {folder && (
          <>
            <span className="folder">{folder.displayName}</span>
            {folder.directory
              ? (
                <button type="button" onClick={rescanFolder} disabled={busy}>
                  Re-scan folder
                </button>
              )
              : session && (
                <button type="button" onClick={addPhotos} disabled={busy}>Add photos…</button>
              )}
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
      {notice && (
        <div className="banner warn">
          {notice}
          <button type="button" onClick={() => setNotice(null)}>Dismiss</button>
        </div>
      )}

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
                  addPhotosLabel={folder?.directory ? 'Re-scan folder' : 'Add photos…'}
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
              <>
                <div className="empty">
                  <p><strong>Select photos…</strong> to choose the ones you want.</p>
                  <p className="note">
                    Best for a camera card: a folder there can hold a thousand photos, and
                    reading metadata for all of them takes minutes on a desktop and far longer
                    on a phone. Opening a whole folder needs only one permission prompt, so it
                    is the easier route when the folder is small.
                  </p>
                  <p className="note">{MTIME_LIMITATION}</p>
                </div>
                <PlatformReport />
              </>
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

/** What is worth telling the user about a pick, if anything. */
function describePicked(picked: {
  skippedDuplicates: readonly string[];
  readOnly: readonly string[];
}): string | null {
  const parts: string[] = [];

  if (picked.skippedDuplicates.length > 0) {
    // Not cosmetic: photos are keyed by filename, so two files with the same name would be
    // treated as one and an edit meant for one could be written into the other.
    parts.push(
      `Skipped ${picked.skippedDuplicates.length} file(s) whose names clash with photos already `
      + `open (${picked.skippedDuplicates.slice(0, 3).join(', ')}). Photos are identified by `
      + 'filename, so two with the same name cannot both be edited.',
    );
  }

  if (picked.readOnly.length > 0) {
    parts.push(
      `${picked.readOnly.length} file(s) are readable but not writable, so they cannot be `
      + `saved (${picked.readOnly.slice(0, 3).join(', ')}).`,
    );
  }

  return parts.length > 0 ? parts.join(' ') : null;
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
  const unverified = failed.filter((outcome) => outcome.writtenButUnverified);
  const warned = outcomes.filter((outcome) => outcome.warnings.length > 0);

  return (
    <div className={`banner ${failed.length > 0 ? 'error' : 'ok'}`}>
      <strong>Saved {outcomes.length - failed.length} of {outcomes.length}</strong>
      {failed.length === 0 && (
        <div className="note">Each file was read back and confirmed.</div>
      )}
      {failed.length > 0 && (
        <ul>
          {failed.map((outcome) => (
            <li key={outcome.name}>{outcome.name} — {outcome.message}</li>
          ))}
        </ul>
      )}
      {unverified.length > 0 && (
        <div className="note">
          <strong>
            {unverified.length === 1 ? 'That file was' : 'Those files were'} changed on disk
          </strong>{' '}
          but did not read back as intended, so {unverified.length === 1 ? 'it is' : 'they are'}
          {' '}still listed as unsaved. Check {unverified.length === 1 ? 'it' : 'them'} before
          saving again.
        </div>
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
