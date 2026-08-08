/**
 * The desktop MVP.
 *
 * Open a folder, see the photos, place them on the map, save. Everything of substance is
 * in `@snapmapper/core`; this wires it to a screen.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  addPhotos as addPhotosToSession,
  applySync,
  applyTrack,
  assignLocation,
  assignPlaces,
  canRedo,
  canUndo,
  clearLocation,
  clearSync,
  createSession,
  createWasmBackend,
  filterByAccuracy,
  hasPendingChanges,
  instantOf,
  isValidTimeZone,
  mergeTracks,
  locationOf,
  markSaved,
  pendingPhotos,
  readTrackFile,
  redo,
  redoAction,
  restoreEdits,
  revert,
  select,
  selectRange,
  setOffsetSeconds,
  setTimeZone,
  toggleSelected,
  stagedPhotos,
  unplacedPhotos,
  undo,
  undoAction,
  type CameraClock,
  type ClockSync,
  type Coordinates,
  type GpxTrack,
  type TrackApplyOptions,
  type MetadataBackend,
  type PhotoEntry,
  type PhotoRef,
  type Session,
} from '@snapmapper/core';

import { PlatformReport } from './PlatformReport.tsx';
import { ReviewBar } from './ReviewBar.tsx';
import { locatedGroups, placesByPhoto } from './PlacePanel.tsx';
import { geocodeGroups, type GeocodeProgress } from './nominatim.ts';
import { Sidebar } from './Sidebar.tsx';
import { PhotoMap, type MapPin } from './PhotoMap.tsx';
import { PhotoPreview } from './PhotoPreview.tsx';
import { ActionMenu } from './ActionMenu.tsx';
import { Wordmark } from './Wordmark.tsx';
import { describeAction, explainAction } from './describe-action.ts';
import { Landing } from './Landing.tsx';
import { UPDATE_READY_EVENT, activateUpdate } from './register-sw.ts';
import { isMapVisible } from './map-focus.ts';
import { scanForSyncCode } from './clock-sync-qr.ts';
import {
  LARGE_FOLDER_THRESHOLD,
  MTIME_LIMITATION_IN_PLACE,
  OUTPUT_FOLDER_NAME,
  createBrowserFileStore,
  isFilePickerSupported,
  isFileSystemAccessSupported,
  isFolderPickerSupported,
  type BrowserFolder,
  type SaveDestination,
  type TrackFolder,
} from './browser-file-store.ts';
import {
  clearSpanCache,
  searchTrackFolder,
  type TrackSearchProgress,
} from './track-search.ts';
import type { TrackSearchOutcome } from './TrackPanel.tsx';
import {
  applicableEdits,
  backupSession,
  clearBackup,
  findBackup,
  type SessionBackup,
} from './session-backup.ts';
import {
  loadPhotos,
  revokeThumbnailUrls,
  toThumbnailUrls,
  type LoadProgress,
} from './load-photos.ts';
import { saveSession, type SaveOutcome, type SaveProgress } from './save.ts';
import { loadViewMode, saveViewMode, type ViewMode } from './view-mode.ts';

const store = createBrowserFileStore();

/**
 * How long after the last edit the backup is written.
 *
 * Placing fifty photographs is one gesture and fifty state changes, and writing the whole edit map
 * on each would be fifty round trips while somebody is watching the map. Short enough that a tab
 * killed moments after a placement still has it.
 */
const BACKUP_DEBOUNCE_MS = 800;

/** The system zone is the right default; the camera was probably set to it. */
function defaultClock(): CameraClock {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return { timeZone: isValidTimeZone(timeZone) ? timeZone : 'UTC', offsetSeconds: 0 };
}

/**
 * Whether the screen is too narrow for the map and the list side by side.
 *
 * The breakpoint is about layout, not about phones: a narrow desktop window has the same
 * problem, and a tablet in landscape does not.
 */
function useIsNarrow(): boolean {
  const [narrow, setNarrow] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(max-width: 900px)').matches,
  );

  useEffect(() => {
    const query = window.matchMedia('(max-width: 900px)');
    const update = () => setNarrow(query.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);

  return narrow;
}

/**
 * Which pane a narrow screen is showing.
 *
 * Below the breakpoint there is not enough height for a map and a list at once — squeezing both
 * gave the map 40vh and the list whatever was left, which on a phone was a few rows behind a wall
 * of chrome. One at a time, each with the full height, is the honest answer.
 */
type NarrowPane = 'photos' | 'map';

export function App() {
  const narrow = useIsNarrow();
  const [pane, setPane] = useState<NarrowPane>('photos');
  const [session, setSession] = useState<Session | null>(null);
  const [folder, setFolder] = useState<BrowserFolder | null>(null);
  const [thumbnails, setThumbnails] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState<LoadProgress | null>(null);
  const [saving, setSaving] = useState<SaveProgress | null>(null);
  const [outcomes, setOutcomes] = useState<SaveOutcome[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Which photo is open full size, if any. */
  const [preview, setPreview] = useState<string | null>(null);
  /** A new version is installed and will take over on reload. */
  const [updateReady, setUpdateReady] = useState(false);
  /** The narrow-screen overflow menu. */
  const [menuOpen, setMenuOpen] = useState(false);
  const [view, setViewState] = useState<ViewMode>(loadViewMode);
  /** The loaded GPS track, if any, and the file it came from. */
  const [track, setTrack] = useState<GpxTrack | null>(null);
  const [trackFile, setTrackFile] = useState<string | null>(null);
  /** The logger's folder, remembered across visits. See `handle-store.ts`. */
  const [trackFolder, setTrackFolder] = useState<TrackFolder | null>(null);
  const [searching, setSearching] = useState<TrackSearchProgress | null>(null);
  /**
   * Which staged photo is being reviewed, or null when not reviewing.
   *
   * A pass over what a track just placed, one at a time, so the map centres on each — the failure
   * mode of a match is not a wild outlier but a frame a few hundred metres down the road, which
   * looks perfectly reasonable as a pin and obviously wrong beside its own picture.
   */
  const [reviewing, setReviewing] = useState<string | null>(null);
  /** Reverse geocoding, which is the only thing in the app that needs the network. */
  const [geocoding, setGeocoding] = useState<GeocodeProgress | null>(null);
  const [lastGeocode, setLastGeocode] = useState<{ named: number; failed: number } | null>(null);
  const geocodeAbort = useRef<AbortController | null>(null);
  const [lastSearch, setLastSearch] = useState<TrackSearchOutcome | null>(null);

  const setView = useCallback((next: ViewMode) => {
    saveViewMode(next);
    setViewState(next);
  }, []);
  /** Something worth saying that is not a failure — duplicates skipped, files read-only. */
  const [notice, setNotice] = useState<string | null>(null);
  /**
   * Where saves go. Copies by default.
   *
   * Safer in three ways at once: the originals are never opened for writing, ungeotagged photos
   * stay visibly ungeotagged because the output is a separate folder, and — since nothing writes
   * to the picked files — the per-file write permission prompt disappears entirely.
   */
  const [destination, setDestinationState] = useState<SaveDestination>(
    () => store.getDestination(),
  );

  const applyDestination = useCallback((next: SaveDestination) => {
    store.setDestination(next);
    setDestinationState(next);
  }, []);

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

      /*
       * The destination is *not* asked for here, and that is the fix for a real bug.
       *
       * This used to chain `pickOutputFolder()` straight after the pick, so that Save was ready
       * immediately. It cannot work: a file picker may only open while the browser considers a
       * user gesture to be in flight, and by this point the gesture has been spent on the first
       * picker and several seconds of metadata reading have gone by. The result was
       * "Failed to execute 'showDirectoryPicker' on 'Window': Must be handling a user gesture",
       * on desktop and phone alike.
       *
       * So the destination bar asks instead, and its button *is* the gesture.
       */
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(null);
    }
  }, [loadRefs, applyDestination]);

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

      // The folder grant already covers creating things inside it, so a geotagged subfolder
      // beside the photos costs no further prompt. This is the nicest case.
      const output = await store.outputFolderWithin(picked);
      if (output) applyDestination(output);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(null);
    }
  }, [loadRefs, applyDestination]);

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

  useEffect(() => {
    const onReady = () => setUpdateReady(true);
    window.addEventListener(UPDATE_READY_EVENT, onReady);
    return () => window.removeEventListener(UPDATE_READY_EVENT, onReady);
  }, []);

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

  /*
   * Keep staged edits somewhere a killed tab cannot take them.
   *
   * Android discards backgrounded tabs when it wants the memory, and `beforeunload` does not fire
   * for that — the page is not unloading, it is being destroyed. So the guard below does nothing
   * for the likeliest way to lose work on a phone.
   *
   * Debounced, because placing fifty photographs at once is one gesture and fifty state changes,
   * and writing the whole edit map each time would be fifty round trips to the database while
   * somebody is looking at the map.
   */
  useEffect(() => {
    if (!session) return;

    if (!hasPendingChanges(session)) {
      // Nothing staged means nothing to restore. Clearing here is what makes a save that empties
      // the edit map also clear the backup, without `save` having to remember to.
      void clearBackup();
      return;
    }

    const timer = setTimeout(
      () => void backupSession(session, folder?.displayName ?? 'photos', Date.now()),
      BACKUP_DEBOUNCE_MS,
    );
    return () => clearTimeout(timer);
  }, [session, folder]);

  /*
   * Offer a backup back, once, when a session appears.
   *
   * Deliberately an offer rather than an automatic restore. Coordinates from this end up in files,
   * and quietly staging edits somebody did not ask for — against a folder that may not even be the
   * one they came from — is the sort of helpfulness that loses trust. `applicableEdits` reports
   * how many match, so the banner can say what it would actually do.
   */
  const [backup, setBackup] = useState<SessionBackup | null>(null);
  const offeredFor = useRef<readonly PhotoEntry[] | null>(null);

  useEffect(() => {
    if (!session || offeredFor.current === session.photos) return;
    offeredFor.current = session.photos;
    // Only worth offering against a session that has no staged edits of its own; otherwise the
    // restore would be competing with work in progress.
    if (hasPendingChanges(session)) return;

    void (async () => {
      const found = await findBackup(Date.now());
      if (found && applicableEdits(found, session).edits.size > 0) setBackup(found);
    })();
  }, [session]);

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

  /**
   * Place photographs from the loaded track.
   *
   * Returns the outcome rather than pushing it into state, because the report belongs to the panel
   * that asked — it is the answer to a button press, not a property of the session. The session
   * change itself is one undo step, so a match that goes wrong costs one Ctrl+Z.
   */
  const matchToTrack = useCallback((
    options: TrackApplyOptions & { maxAccuracy?: number | null },
  ) => {
    if (!session || !track) return { placed: [], skipped: [] };

    // Filtering here rather than on load, so the dial can be moved and re-tried without
    // re-reading the file — and so the map keeps showing the whole track that was found.
    const usable = options.maxAccuracy != null
      ? filterByAccuracy(track, options.maxAccuracy)
      : track;

    const outcome = applyTrack(session, usable, options);
    setSession(outcome.session);
    return { placed: outcome.placed, skipped: outcome.skipped };
  }, [session, track]);

  /**
   * Search the logger's folder for whatever covers the photographs that are open.
   *
   * Everything about *which* file is decided in core from the times inside them — see
   * `track-folder.ts`. This is the plumbing: read what has to be read, merge the winners, and turn
   * the outcome into something the panel can phrase.
   */
  const searchTracks = useCallback(async (
    folder: TrackFolder,
    current: Session,
  ): Promise<void> => {
    setSearching({ read: 0, total: 0 });
    setLastSearch(null);

    try {
      const found = await searchTrackFolder(
        store,
        folder,
        current.photos.map((entry) => instantOf(current, entry)),
        setSearching,
      );

      if (found === 'no-dates') {
        setLastSearch({ kind: 'no-dates', files: [], considered: 0 });
        return;
      }

      if (found.chosen.length === 0) {
        setLastSearch({
          kind: 'nothing',
          files: [],
          considered: found.considered,
          ...(found.nearest
            ? { nearestDays: Math.round(found.nearest.offBy / 86_400_000) }
            : {}),
        });
        return;
      }

      /*
       * Only the winners are parsed, and only the part of them that covers the photographs.
       *
       * The window matters most for monthly files: one holds a quarter of a million points, of
       * which a shoot uses a few hundred. Without it the map draws a month of travel across the
       * whole county and the day you want is invisible inside it — and `parseGpx` would allocate
       * every point on the way to throwing them away.
       */
      const loaded = await Promise.all(found.chosen.map(async (name) =>
        readTrackFile(await store.readTrack(folder, name), found.window).track));

      const merged = mergeTracks(loaded.filter((one) => one.points.length > 0));
      if (merged.points.length === 0) {
        // Files that overlapped on span but hold nothing in the window. Rare, but a track with no
        // points would then be reported as loaded and place nothing.
        setLastSearch({
          kind: 'nothing',
          files: [],
          considered: found.considered,
        });
        return;
      }

      setTrack(merged);
      setTrackFile(found.chosen.join(', '));
      setLastSearch({ kind: 'loaded', files: found.chosen, considered: found.considered });
    } catch (cause) {
      setLastSearch({
        kind: 'error',
        files: [],
        considered: 0,
        message: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      setSearching(null);
    }
  }, []);

  /*
   * Bring the remembered folders back on start-up.
   *
   * Neither is *asked* for here — `requestPermission` needs a user gesture and would throw. The
   * track folder reports that it needs reconnecting, which becomes a button; the output folder is
   * simply not restored unless its grant survived, so the destination bar asks as it always did.
   */
  useEffect(() => {
    void (async () => {
      const remembered = await store.restoreTrackFolder();
      if (remembered) setTrackFolder(remembered);

      const output = await store.restoreOutputFolder();
      if (output) applyDestination(output);
    })();
  }, [applyDestination]);

  /*
   * Search as soon as a session exists, without being asked.
   *
   * The whole point of remembering the folder: the photographs know their own dates, so the
   * question "which track" has an answer before anybody has to ask it.
   *
   * Keyed on `session.photos`, **not on the session**. A session is immutable, so selecting a
   * photograph or staging an edit produces a new one — keying on that restarted the folder search
   * on every click, which on a year of daily tracks is a real cost and a flickering panel. The
   * photo array's identity survives every edit and changes exactly when photos are opened or
   * added, which is precisely when the answer could differ.
   */
  const searchedFor = useRef<readonly PhotoEntry[] | null>(null);
  useEffect(() => {
    if (!session || !trackFolder || trackFolder.needsPermission || track) return;
    if (searchedFor.current === session.photos) return;
    searchedFor.current = session.photos;
    void searchTracks(trackFolder, session);
  }, [session, trackFolder, track, searchTracks]);

  /**
   * Look up place names for what is on the map, and stage them.
   *
   * Grouped by rounded position *before* anything is sent, so a fifty-photo walk around a park is
   * three or four requests rather than fifty — which is both much faster and the difference
   * between using a free service and abusing it.
   */
  const geocode = useCallback(async (scope: 'all' | 'selected') => {
    if (!session) return;

    const groups = locatedGroups(session, scope === 'selected');
    if (groups.length === 0) return;

    const controller = new AbortController();
    geocodeAbort.current = controller;
    setGeocoding({ done: 0, total: groups.length, fromCache: 0 });
    setLastGeocode(null);

    try {
      const { places, failed } = await geocodeGroups(groups, {
        signal: controller.signal,
        onProgress: setGeocoding,
      });

      const found = placesByPhoto(groups, places);
      setSession((current) => (current ? assignPlaces(current, found) : current));
      setLastGeocode({ named: found.size, failed });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setGeocoding(null);
      geocodeAbort.current = null;
    }
  }, [session]);

  const readOriginal = useCallback(
    (entry: PhotoEntry) => store.read(entry.ref),
    [],
  );

  const selectOnly = useCallback((name: string) => {
    setSession((current) => (current ? select(current, [name]) : current));
  }, []);

  /*
   * No session, no map.
   *
   * An empty map is not merely unhelpful on the landing screen — it costs a MapLibre instance and
   * a screenful of tile requests to show somebody the mid-Atlantic before they have chosen a
   * photograph.
   */
  const mapVisible = isMapVisible(session !== null, narrow, pane);

  /*
   * Mounted the first time it would be visible, and never unmounted after that.
   *
   * Both halves matter. Constructing a MapLibre map inside a `display: none` container gives it a
   * zero-sized viewport — on a phone the Photos tab is the default, so mounting with the session
   * would mean every map on a phone was born blind and dependent on a later `resize()`. And once
   * it exists, hiding beats unmounting, because a rebuild discards the tiles, the viewport and
   * every marker, so returning to the tab would land somewhere other than where you left.
   */
  const [mapMounted, setMapMounted] = useState(false);
  useEffect(() => {
    if (mapVisible) setMapMounted(true);
  }, [mapVisible]);

  if (!isFileSystemAccessSupported()) {
    return (
      <main className="gate">
        <h1><Wordmark variant="hero" /></h1>
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
  const selected = session?.selected.size ?? 0;
  const saveDisabled = pending === 0 || saving !== null || destination.kind === 'copy-pending';
  const saveLabel = saving
    ? `Saving ${saving.done}/${saving.total}…`
    : `Save ${pending || ''}`.trim();

  return (
    <div className="app">
      {/*
        `working` drops the wordmark on a phone once photos are open. Measured: with it, Undo and
        Redo carrying their labels plus the More button needed up to 436px of a 375px screen. The
        name of the app is the least useful thing on that row while you are placing photographs —
        and it is still on the landing screen, the browser tab and the home-screen icon.
      */}
      <header className={narrow && session ? 'working' : ''}>
        <h1><Wordmark /></h1>
        {/*
          A horizontally scrolling row rather than a wrapping one. Wrapping put four buttons and a
          folder name onto three lines on a phone, which cost more height than the photo list got.
        */}
        <div className="actions">
        {session && (
          <>
            {/*
              Undo and Redo stay on screen at every width. A mis-tap on the map is the single most
              likely mistake here, and it should cost one touch to put right — not a touch to open
              a menu and another to find the item.
            */}
            <button
              type="button"
              className="undo"
              onClick={() => setSession(undo(session))}
              disabled={!canUndo(session) || busy}
              title={explainAction('Undo', undoAction(session))}
            >
              Undo <span className="what">{describeAction(undoAction(session))}</span>
            </button>
            <button
              type="button"
              className="redo"
              onClick={() => setSession(redo(session))}
              disabled={!canRedo(session) || busy}
              title={explainAction('Redo', redoAction(session))}
            >
              Redo <span className="what">{describeAction(redoAction(session))}</span>
            </button>

            {!narrow && (
              <button type="button" className="primary" onClick={save} disabled={saveDisabled}>
                {saveLabel}
              </button>
            )}
          </>
        )}

        <div className="spacer" />

        {/*
          On a wide screen these sit in the header. On a phone they are behind one labelled button,
          because the alternative — a horizontally scrolling row — hides whatever is past the right
          edge behind a gesture nobody knows to make.
        */}
        {session && (narrow
          ? (
            <ActionMenu
              open={menuOpen}
              onOpen={() => setMenuOpen(true)}
              onClose={() => setMenuOpen(false)}
            >
              {folder && <div className="menu-label">{folder.displayName}</div>}
              {folder?.directory
                ? (
                  <button type="button" onClick={rescanFolder} disabled={busy}>
                    Re-scan folder
                  </button>
                )
                : (
                  <button type="button" onClick={addPhotos} disabled={busy}>Add photos…</button>
                )}
              {isFilePickerSupported() && (
                <button type="button" onClick={openPhotos} disabled={busy}>
                  Select different photos…
                </button>
              )}
              {isFolderPickerSupported() && (
                <button type="button" onClick={openFolder} disabled={busy}>
                  Open a whole folder…
                </button>
              )}
            </ActionMenu>
          )
          : (
            <>
              {folder && <span className="folder">{folder.displayName}</span>}
              {folder?.directory
                ? (
                  <button type="button" onClick={rescanFolder} disabled={busy}>
                    Re-scan folder
                  </button>
                )
                : (
                  <button type="button" onClick={addPhotos} disabled={busy}>Add photos…</button>
                )}
              {isFilePickerSupported() && (
                <button type="button" onClick={openPhotos} disabled={busy}>Select photos…</button>
              )}
              {isFolderPickerSupported() && (
                <button type="button" onClick={openFolder} disabled={busy}>
                  Open whole folder…
                </button>
              )}
            </>
          ))}
        </div>
      </header>

      {session && (
        <DestinationBar
          destination={destination}
          busy={busy}
          onSaveCopies={async () => {
            setError(null);
            try {
              const output = folder?.directory
                ? await store.outputFolderWithin(folder)
                : await store.pickOutputFolder();
              if (output) applyDestination(output);
            } catch (cause) {
              setError(cause instanceof Error ? cause.message : String(cause));
            }
          }}
          onSaveInPlace={() => applyDestination({ kind: 'in-place' })}
        />
      )}

      {updateReady && (
        <div className="banner ok">
          <strong>A new version is ready.</strong>
          <div className="note">
            {session && hasPendingChanges(session)
              ? 'Save your changes first — reloading discards anything unsaved.'
              : 'It takes effect on reload, or by itself next time you open the app.'}
          </div>
          <div className="row">
            <button
              type="button"
              onClick={() => {
                // Reloading with staged edits would throw them away, and the app has no way to
                // put them back. Ask, rather than quietly deciding for them.
                if (session && hasPendingChanges(session)
                  && !window.confirm(
                    `${pendingPhotos(session).length} unsaved change(s) will be lost. Reload anyway?`,
                  )) return;
                activateUpdate();
              }}
            >
              Reload now
            </button>
            <button type="button" onClick={() => setUpdateReady(false)}>Later</button>
          </div>
        </div>
      )}

      {session && reviewing !== null && (
        <ReviewBar
          session={session}
          thumbnails={thumbnails}
          current={reviewing}
          onGo={(name) => { setReviewing(name); selectOnly(name); if (narrow) setPane('map'); }}
          onClose={() => setReviewing(null)}
          onPreview={setPreview}
        />
      )}

      {backup && session && (
        <RestoreBanner
          backup={backup}
          session={session}
          onRestore={() => {
            const { edits } = applicableEdits(backup, session);
            setSession(restoreEdits(session, edits));
            setBackup(null);
          }}
          onDiscard={() => {
            void clearBackup();
            setBackup(null);
          }}
        />
      )}

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

      {outcomes && (
        <Outcomes
          outcomes={outcomes}
          destination={destination}
          onDismiss={() => setOutcomes(null)}
        />
      )}

      {narrow && session && (
        <div className="tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={pane === 'photos'}
            className={pane === 'photos' ? 'active' : ''}
            onClick={() => setPane('photos')}
          >
            Photos {session.photos.length}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={pane === 'map'}
            className={pane === 'map' ? 'active' : ''}
            onClick={() => setPane('map')}
          >
            Map{selected > 0 ? ` — ${selected} to place` : ''}
          </button>
        </div>
      )}

      {/* `solo` when there is no map beside it, so the landing screen is not a narrow column
          with an empty two-thirds to its right. */}
      <div className={`body${mapMounted ? '' : ' solo'}`}>
        {(!narrow || !session || pane === 'photos') && (
          <aside>
            {session
              ? (
                <Sidebar
                  session={session}
                  thumbnails={thumbnails}
                  busy={busy}
                  addPhotosLabel={folder?.directory ? 'Re-scan folder' : 'Add photos…'}
                  onToggle={(name) => setSession(toggleSelected(session, name))}
                  onSelectOnly={selectOnly}
                  onSelectRange={(from, to, add) =>
                    setSession(selectRange(session, from, to, add))}
                  onSelectAll={() =>
                    setSession(select(session, session.photos.map((entry) => entry.ref.name)))}
                  onSelectNone={() => setSession(select(session, []))}
                  onSelectUnplaced={() => setSession(select(
                    session,
                    unplacedPhotos(session).map((entry) => entry.ref.name),
                  ))}
                  onClear={() => setSession(clearLocation(session, [...session.selected]))}
                  onRevert={() => setSession(revert(session, [...session.selected]))}
                  onPreview={setPreview}
                  view={view}
                  onView={setView}
                  onTimeZone={(zone) => setSession(setTimeZone(session, zone))}
                  onOffsetSeconds={(seconds) => setSession(setOffsetSeconds(session, seconds))}
                  onSync={(sync: ClockSync) => setSession(applySync(session, sync))}
                  onClearSync={() => setSession(clearSync(session))}
                  onScanReference={scanReference}
                  places={{
                    progress: geocoding,
                    lastRun: lastGeocode,
                    onGeocode: (scope) => void geocode(scope),
                    onStop: () => geocodeAbort.current?.abort(),
                  }}
                  track={{
                    track,
                    trackFile,
                    onTrack: (loaded, fileName) => {
                      setTrack(loaded);
                      setTrackFile(fileName);
                    },
                    onClearTrack: () => {
                      setTrack(null);
                      setTrackFile(null);
                    },
                    onMatch: matchToTrack,
                    onReview: () => {
                      const first = stagedPhotos(session)[0];
                      if (!first) return;
                      setReviewing(first.ref.name);
                      selectOnly(first.ref.name);
                      if (narrow) setPane('map');
                    },
                    folder: {
                      name: trackFolder?.displayName ?? null,
                      needsPermission: trackFolder?.needsPermission ?? false,
                      searching,
                      lastSearch,
                      onChoose: async () => {
                        setError(null);
                        try {
                          const picked = await store.pickTrackFolder();
                          if (!picked) return;
                          setTrackFolder(picked);
                          clearSpanCache();
                          if (session) await searchTracks(picked, session);
                        } catch (cause) {
                          setError(cause instanceof Error ? cause.message : String(cause));
                        }
                      },
                      onReconnect: async () => {
                        // This click is the user gesture `requestPermission` requires.
                        const regranted = await store.regrantTrackFolder();
                        if (!regranted) return;
                        setTrackFolder(regranted);
                        if (session) await searchTracks(regranted, session);
                      },
                      onForget: async () => {
                        await store.forgetTrackFolder();
                        clearSpanCache();
                        setTrackFolder(null);
                        setLastSearch(null);
                      },
                      onSearch: () => {
                        if (trackFolder && session) void searchTracks(trackFolder, session);
                      },
                    },
                  }}
                />
              )
              : !loading && (
                <Landing
                  canPickFiles={isFilePickerSupported()}
                  canPickFolder={isFolderPickerSupported()}
                  busy={busy}
                  onPickPhotos={openPhotos}
                  onPickFolder={openFolder}
                />
              )}

            {/*
              Sticky to the bottom of the scrolling pane, and present only when there is something
              to save. It sits where the thumb already is, and its absence is the honest signal
              that nothing is staged.
            */}
            {narrow && session && pending > 0 && (
              <div className="save-bar">
                <div className="note">
                  {pending} photo{pending === 1 ? '' : 's'} changed — nothing is written yet.
                </div>
                <button type="button" className="primary" onClick={save} disabled={saveDisabled}>
                  {saveLabel}
                </button>
                {destination.kind === 'copy-pending' && (
                  <div className="note">
                    Choose where copies should go first, above.
                  </div>
                )}
              </div>
            )}
          </aside>
        )}

        {/*
          Once mounted the map is hidden rather than unmounted. Rebuilding a MapLibre instance on
          every tab switch would throw away the tiles, the viewport and every marker, so switching
          back would jump somewhere other than the place just left.
        */}
        {mapMounted && (
          <div className={`map-slot${mapVisible ? '' : ' hidden'}`}>
            <PhotoMap
              pins={pins}
              onPlace={place}
              onSelectPin={selectOnly}
              onMovePin={movePin}
              armed={Boolean(session && session.selected.size > 0)}
              selectedCount={selected}
              visible={mapVisible}
              track={track}
            />
          </div>
        )}
      </div>

      {preview !== null && session && (
        <PhotoPreview
          session={session}
          name={preview}
          read={readOriginal}
          onShow={setPreview}
          onClose={() => setPreview(null)}
          onSelectOnly={(name) => {
            selectOnly(name);
            setPreview(null);
            // On a phone the map is the other tab, so land where the photo can be placed.
            if (narrow) setPane('map');
          }}
        />
      )}
    </div>
  );
}

/**
 * The offer to put back work a killed tab took.
 *
 * Phrased around what it *would do* rather than around what happened, because "your session was
 * interrupted" invites the question "was it?" while "put back 23 unsaved locations" can simply be
 * answered. Discard is offered beside it and is not the quiet option — leaving a backup sitting
 * there to be offered again next time is worse than deleting it on request.
 */
function RestoreBanner({
  backup,
  session,
  onRestore,
  onDiscard,
}: {
  backup: SessionBackup;
  session: Session;
  onRestore: () => void;
  onDiscard: () => void;
}) {
  const { edits, missing } = applicableEdits(backup, session);
  const when = new Date(backup.savedAtMs);

  return (
    <div className="banner warn">
      <strong>
        {edits.size} unsaved location{edits.size === 1 ? '' : 's'} from last time
      </strong>
      <div className="note">
        Staged in <code>{backup.folderName}</code>{' '}
        {when.toLocaleString(undefined, {
          day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
        })}
        , and never written to disk. Putting them back stages them again — nothing is saved until
        you press Save.
      </div>
      {missing > 0 && (
        // The signal that a different folder is open. Worth saying plainly rather than restoring
        // what matches and leaving somebody to wonder why the count is short.
        <div className="note">
          {missing} more {missing === 1 ? 'was' : 'were'} for {missing === 1 ? 'a photo' : 'photos'}
          {' '}not in this folder, so {missing === 1 ? 'it' : 'they'} cannot be put back here.
        </div>
      )}
      <div className="row">
        <button type="button" className="primary" onClick={onRestore}>
          Put {edits.size === 1 ? 'it' : 'them'} back
        </button>
        <button type="button" onClick={onDiscard}>Discard</button>
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

/**
 * Where saves are going, and how to change it.
 *
 * Shown rather than buried in a settings panel, because "which file am I about to change" is the
 * single most important thing to know before pressing Save.
 */
/**
 * Where saves are going, and how to change it.
 *
 * Shown rather than buried in a settings screen, because "which file am I about to change" is the
 * single most important thing to know before pressing Save.
 *
 * **Once it is settled it is one line.** It was three — a heading, a reassurance and a row of two
 * buttons — which is a lot of permanent chrome to spend on a question that has been answered. The
 * unanswered case still gets the full treatment, because then it is a blocker rather than a fact.
 */
function DestinationBar({
  destination,
  busy,
  onSaveCopies,
  onSaveInPlace,
}: {
  destination: SaveDestination;
  busy: boolean;
  onSaveCopies: () => void;
  onSaveInPlace: () => void;
}) {
  if (destination.kind === 'copy-pending') {
    return (
      <div className="banner error">
        <strong>Choose where copies should go before saving</strong>
        <div className="note">
          Pick the folder your photos are in and a <code>{OUTPUT_FOLDER_NAME}</code> folder will be
          created inside it.
        </div>
        <div className="row">
          <button type="button" className="primary" onClick={onSaveCopies} disabled={busy}>
            {`Choose the ${OUTPUT_FOLDER_NAME} folder…`}
          </button>
          <button type="button" onClick={onSaveInPlace} disabled={busy}>
            Write over originals
          </button>
        </div>
      </div>
    );
  }

  const copying = destination.kind === 'copy';

  return (
    <div className={`destination ${copying ? 'ok' : 'warn'}`}>
      <span className="dot" aria-hidden="true" />
      {copying
        ? (
          <span className="where">
            Copies to <code>{destination.label}/</code>
            <span className="aside"> · originals untouched</span>
          </span>
        )
        : (
          <span className="where">
            <strong>Writing over your originals</strong>
            <span className="aside"> · {MTIME_LIMITATION_IN_PLACE}</span>
          </span>
        )}

      {/* The switch, small and last: reading this line is the common case, changing it is not. */}
      <button
        type="button"
        className="link"
        onClick={copying ? onSaveInPlace : onSaveCopies}
        disabled={busy}
      >
        {copying ? 'Write over originals instead' : 'Save copies instead…'}
      </button>
    </div>
  );
}

function Outcomes({
  outcomes,
  destination,
  onDismiss,
}: {
  outcomes: readonly SaveOutcome[];
  destination: SaveDestination;
  onDismiss: () => void;
}) {
  const failed = outcomes.filter((outcome) => !outcome.ok);
  const unverified = failed.filter((outcome) => outcome.writtenButUnverified);
  const warned = outcomes.filter((outcome) => outcome.warnings.length > 0);

  return (
    <div className={`banner ${failed.length > 0 ? 'error' : 'ok'}`}>
      <strong>Saved {outcomes.length - failed.length} of {outcomes.length}</strong>
      {failed.length === 0 && (
        <div className="note">
          Each file was read back and confirmed
          {destination.kind === 'copy' ? ` in ${destination.label}/` : ''}.
          {destination.kind === 'copy' && ' Your originals are unchanged.'}
        </div>
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
      {destination.kind === 'in-place' && <p className="note">{MTIME_LIMITATION_IN_PLACE}</p>}
      <button type="button" onClick={onDismiss}>Dismiss</button>
    </div>
  );
}
