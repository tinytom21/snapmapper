/**
 * The desktop MVP.
 *
 * Open a folder, see the photos, click the map to place the selected ones, save.
 * Everything of substance is in `@geotagger/core`; this wires it to a screen.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  assignLocation,
  canRedo,
  canUndo,
  clearLocation,
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
  setClock,
  toggleSelected,
  undo,
  type CameraClock,
  type Coordinates,
  type MetadataBackend,
  type PhotoEntry,
  type Session,
} from '@geotagger/core';

import { PhotoMap, type MapPin } from './PhotoMap.tsx';
import {
  MTIME_LIMITATION,
  createBrowserFileStore,
  isFileSystemAccessSupported,
  pickFolder,
  type BrowserFolder,
} from './browser-file-store.ts';
import { loadPhotos, type LoadProgress } from './load-photos.ts';
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
  const [loading, setLoading] = useState<LoadProgress | null>(null);
  const [saving, setSaving] = useState<SaveProgress | null>(null);
  const [outcomes, setOutcomes] = useState<SaveOutcome[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  /**
   * The WASM backend, loaded once and lazily.
   *
   * 24MB of WebAssembly, so it is not fetched until a folder is opened — there is no
   * point paying for it on a screen that only has a button.
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

  const openFolder = useCallback(async () => {
    setError(null);
    setOutcomes(null);

    try {
      const picked = await pickFolder();
      if (!picked) return;

      setFolder(picked);
      setSession(null);

      const refs = await store.listFolder(picked);
      if (refs.length === 0) {
        setError(`No JPEGs in “${picked.displayName}”.`);
        return;
      }

      setLoading({ done: 0, total: refs.length, current: '' });
      const entries = await loadPhotos(refs, store, await getBackend(), setLoading);
      setSession(createSession(entries, defaultClock()));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(null);
    }
  }, [getBackend]);

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

  // Undo/redo on the keyboard, because this is a desktop app and people expect it.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
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

  const pending = session ? pendingPhotos(session).length : 0;

  return (
    <div className="app">
      <header>
        <h1>photo-geotagger</h1>
        <button type="button" onClick={openFolder} disabled={loading !== null || saving !== null}>
          {folder ? 'Open another folder…' : 'Open folder…'}
        </button>
        {folder && <span className="folder">{folder.displayName}</span>}

        <div className="spacer" />

        {session && (
          <>
            <button
              type="button"
              onClick={() => setSession(undo(session))}
              disabled={!canUndo(session) || saving !== null}
              title="Ctrl+Z"
            >
              Undo
            </button>
            <button
              type="button"
              onClick={() => setSession(redo(session))}
              disabled={!canRedo(session) || saving !== null}
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
                  clock={session.clock}
                  onChange={(clock) => setSession(setClock(session, clock))}
                />
                <PhotoList
                  session={session}
                  onToggle={(name) => setSession(toggleSelected(session, name))}
                  onSelectOnly={selectOnly}
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

function ClockPanel({
  clock,
  onChange,
}: {
  clock: CameraClock;
  onChange: (clock: CameraClock) => void;
}) {
  const [zoneText, setZoneText] = useState(clock.timeZone);
  const zoneValid = isValidTimeZone(zoneText);

  return (
    <section className="panel">
      <h2>Camera clock</h2>
      <p className="note">
        Used for GPS timestamps, which are written in UTC. Getting the zone wrong shifts
        them by hours.
      </p>

      <label>
        Time zone
        <input
          value={zoneText}
          onChange={(event) => {
            setZoneText(event.target.value);
            if (isValidTimeZone(event.target.value)) {
              onChange({ ...clock, timeZone: event.target.value });
            }
          }}
          className={zoneValid ? '' : 'invalid'}
          spellCheck={false}
        />
      </label>
      {!zoneValid && <p className="note error">Not an IANA zone, e.g. Europe/London.</p>}

      <label>
        Clock runs fast by (seconds)
        <input
          type="number"
          value={clock.offsetSeconds}
          onChange={(event) =>
            onChange({ ...clock, offsetSeconds: Number(event.target.value) || 0 })}
        />
      </label>
    </section>
  );
}

function PhotoList({
  session,
  onToggle,
  onSelectOnly,
  onSelectAll,
  onSelectNone,
  onClear,
  onRevert,
}: {
  session: Session;
  onToggle: (name: string) => void;
  onSelectOnly: (name: string) => void;
  onSelectAll: () => void;
  onSelectNone: () => void;
  onClear: () => void;
  onRevert: () => void;
}) {
  const selectedCount = session.selected.size;

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
          ? 'Select photos, then click the map to place them.'
          : `${selectedCount} selected — click the map to place ${selectedCount === 1 ? 'it' : 'them'}.`}
      </p>

      <ul className="photos">
        {session.photos.map((entry) => (
          <PhotoRow
            key={entry.ref.name}
            entry={entry}
            session={session}
            onToggle={onToggle}
            onSelectOnly={onSelectOnly}
          />
        ))}
      </ul>
    </section>
  );
}

function PhotoRow({
  entry,
  session,
  onToggle,
  onSelectOnly,
}: {
  entry: PhotoEntry;
  session: Session;
  onToggle: (name: string) => void;
  onSelectOnly: (name: string) => void;
}) {
  const location = locationOf(session, entry.ref.name);
  const selected = session.selected.has(entry.ref.name);
  const instant = instantOf(session, entry);

  return (
    <li className={`photo${selected ? ' selected' : ''}${entry.error ? ' broken' : ''}`}>
      <label>
        <input
          type="checkbox"
          checked={selected}
          onChange={() => onToggle(entry.ref.name)}
          disabled={entry.error !== undefined}
        />
        <button type="button" className="name" onClick={() => onSelectOnly(entry.ref.name)}>
          {entry.ref.name}
        </button>
      </label>

      <div className="meta">
        {entry.error
          ? <span className="error">unreadable — {entry.error}</span>
          : (
            <>
              <span>{instant ? instant.toISOString().replace('T', ' ').slice(0, 19) + 'Z' : 'no date'}</span>
              <LocationLabel location={location} />
            </>
          )}
      </div>
    </li>
  );
}

function LocationLabel({ location }: { location: ReturnType<typeof locationOf> }) {
  if (location.kind === 'none') return <span className="dim">no location</span>;
  if (location.kind === 'pending-clear') return <span className="pendingText">location will be removed</span>;

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
      <strong>
        Saved {outcomes.length - failed.length} of {outcomes.length}
      </strong>
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
