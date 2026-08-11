/**
 * The desktop MVP.
 *
 * Open a folder, see the photos, place them on the map, save. Everything of substance is
 * in `@snapmapper/core`; this wires it to a screen.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  addPhotos as addPhotosToSession,
  adoptPriorLocations,
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
  isRawFile,
  isValidTimeZone,
  mergeTracks,
  locationOf,
  markSaved,
  pendingPhotos,
  findPriorLocations,
  readTrackFile,
  redo,
  resolvePriorConflicts,
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
  type BatchRunner,
  type GpxTrack,
  type LocationChoice,
  type LocationConflict,
  type TrackApplyOptions,
  type MetadataBackend,
  type PhotoEntry,
  type PhotoRef,
  type Session,
} from '@snapmapper/core';

import { ConflictPrompt } from './ConflictPrompt.tsx';
import { FolderChooser } from './FolderChooser.tsx';
import { readPriorLocations } from './prior-locations.ts';
import { PlatformReport } from './PlatformReport.tsx';
import { ReviewBar } from './ReviewBar.tsx';
import { locatedGroups, placesByPhoto } from './PlacePanel.tsx';
import { geocodeGroups, type GeocodeProgress } from './nominatim.ts';
import { Sidebar } from './Sidebar.tsx';
import { PhotoMap, type MapPin } from './PhotoMap.tsx';
import { PhotoPreview } from './PhotoPreview.tsx';
import { ActionMenu } from './ActionMenu.tsx';
import { Mark, Wordmark } from './Wordmark.tsx';
import { describeAction, explainAction } from './describe-action.ts';
import { Landing } from './Landing.tsx';
import { UPDATE_READY_EVENT, activateUpdate } from './register-sw.ts';
import { isMapVisible, keepMapMounted } from './map-focus.ts';
import { scanForSyncCode } from './clock-sync-qr.ts';
import {
  MTIME_LIMITATION_IN_PLACE,
  OUTPUT_FOLDER_NAME,
  createBrowserFileStore,
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
import { createBatchRunner } from './batch-runner.ts';
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
   * Back to the start screen, ending the session.
   *
   * **It asks first when anything is staged.** Placements live in memory until Save, so this is
   * one of the few controls in the app that can destroy work — and it sits in the corner where
   * every interface in the world puts a harmless "go home", which is precisely why it needs the
   * guard. Nothing warns when there is nothing to lose.
   *
   * The photographs are untouched: this closes the session, it does not delete anything. What goes
   * is the session, the folder, the loaded track and the last set of results.
   *
   * Three things deliberately survive, because they are settings rather than session state: the
   * view mode, the remembered track folder, and the save destination. Being asked for the logger's
   * folder again because you tapped the logo would be the opposite of remembering it.
   *
   * Thumbnail URLs are revoked here rather than left to the unmount effect — three hundred blobs
   * held for the life of the page is a real leak on a phone.
   */
  const goHome = useCallback(() => {
    if (session && hasPendingChanges(session)) {
      const staged = pendingPhotos(session).length;
      const sure = window.confirm(
        `${staged} photo(s) have changes that have not been saved. `
        + 'Starting again will discard them. Continue?',
      );
      if (!sure) return;
    }

    setThumbnails((previous) => {
      revokeThumbnailUrls(previous);
      return new Map();
    });
    setSession(null);
    setFolder(null);
    setTrack(null);
    setTrackFile(null);
    setOutcomes(null);
    setError(null);
    setNotice(null);
    setPreview(null);
    setReviewing(null);
    setLastSearch(null);
    setLastGeocode(null);
    // A question about photographs that are no longer open has nothing to be an answer to.
    setConflicts([]);
    setBrowsing(null);
    setMenuOpen(false);
    setPane('photos');
  }, [session]);

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
   * Photographs whose file and whose earlier copy disagree about where they were taken.
   *
   * Queued rather than resolved: each one is a decision only the user can make. The first is on
   * screen and the rest wait behind it — see `ConflictPrompt`.
   */
  const [conflicts, setConflicts] = useState<readonly LocationConflict[]>([]);
  /** True while the output folder and any sidecars are being consulted. A second or two. */
  const [checkingPriors, setCheckingPriors] = useState(false);
  /** Reading a folder's names and dates. No metadata — but on a phone it is not instant. */
  const [listing, setListing] = useState<
    { readonly done: number; readonly total: number; readonly name: string } | null
  >(null);

  /**
   * Find out which of these photographs an earlier session already placed, and say so.
   *
   * A photograph geotagged last week is *placed*, and showing it as untouched is the app being
   * wrong about the state of the disk. The coordinates are in the copy under `geotagged/`, or in
   * the sidecar beside a raw file; `prior-locations.ts` does the reading and
   * `core/prior-location.ts` decides which are safe to take up without asking.
   *
   * Nothing here can fail the session. This is a convenience running after the photographs are
   * already on screen, and a card that refused to open because an optional lookup threw would be a
   * bad trade — so a failure becomes a notice and the session carries on.
   */
  const checkPriorLocations = useCallback(async (
    entries: readonly PhotoEntry[],
    metadataBackend: MetadataBackend,
    runner: BatchRunner | undefined,
  ): Promise<void> => {
    setCheckingPriors(true);
    try {
      const { priors, problems } = await readPriorLocations(entries, store, metadataBackend, runner);
      if (priors.length === 0) {
        if (problems.length > 0) setNotice(describePriorProblems(problems));
        return;
      }

      const review = findPriorLocations(entries, priors);

      // Adopted straight in: already on disk, so nothing is staged and the Save button is
      // untouched. The disagreements are queued for the prompt instead.
      if (review.adopt.length > 0) {
        setSession((current) => (current ? adoptPriorLocations(current, review.adopt) : current));
      }
      if (review.conflicts.length > 0) {
        setConflicts((current) => [...current, ...review.conflicts]);
      }

      setNotice([
        review.adopt.length > 0
          ? `${review.adopt.length} photo(s) were already geotagged in an earlier session.`
          : undefined,
        problems.length > 0 ? describePriorProblems(problems) : undefined,
      ].filter(Boolean).join(' ') || null);
    } catch (cause) {
      setNotice(
        'Could not check for earlier geotagging: '
        + (cause instanceof Error ? cause.message : String(cause)),
      );
    } finally {
      setCheckingPriors(false);
    }
  }, []);

  /**
   * Answer the conflict on screen, and possibly the rest of them.
   *
   * `all` exists because the reason two sources disagree is usually systematic — one afternoon
   * re-placed, or a dozen frames on a cold GPS fix — so the second question tends to have the same
   * answer as the first. It is off by default: a disagreement is a decision.
   *
   * Note the deliberate absence of a `setConflicts` updater function around this. Putting the
   * `setSession` call inside one would make it a side effect inside a state updater, which React
   * is entitled to run twice — and does in development — applying every answer to the session
   * twice over.
   */
  const resolveConflict = useCallback((choice: LocationChoice, all: boolean) => {
    const answered = all ? conflicts : conflicts.slice(0, 1);
    if (answered.length === 0) return;

    setSession((current) => (current
      ? resolvePriorConflicts(current, answered.map((conflict) => ({ conflict, choice })))
      : current));
    setConflicts(all ? [] : conflicts.slice(1));
  }, [conflicts]);

  /**
   * What the search for earlier geotagging depends on: these photographs, and that output folder.
   *
   * A string rather than the objects, and that is the whole trick. Adopting a prior location
   * produces a **new** `photos` array, so an effect keyed on the array itself would re-run, adopt
   * again, produce another new array, and never stop. The filenames do not change when a location
   * is adopted, so keying on them settles after one pass.
   */
  const priorCheckKey = useMemo(() => {
    if (!session) return null;
    const where = destination.kind === 'copy' ? destination.label : destination.kind;
    return `${where}\n${session.photos.map((entry) => entry.ref.name).join('\n')}`;
  }, [session, destination]);

  const priorsCheckedFor = useRef<string | null>(null);

  /**
   * Look for earlier geotagging whenever the set of photographs or the output folder changes.
   *
   * An effect rather than a call at the end of loading, because **the output folder is often not
   * known yet when the photographs are**. In folder mode the destination is prepared *after*
   * `loadRefs` returns; through the file picker it is not chosen until the user presses a button
   * in the destination bar, which may be minutes later. A search run at load time would find
   * nothing in either case and never run again — the whole feature inert, with no error to notice.
   *
   * Keyed on names, so it settles: see `priorCheckKey`. And on the destination, so choosing the
   * folder later is what triggers the real pass.
   */
  useEffect(() => {
    if (!priorCheckKey) {
      // The session ended. Forgetting what was checked is what lets the *same* folder, reopened,
      // be searched again — otherwise going home and straight back in would find nothing.
      priorsCheckedFor.current = null;
      return;
    }
    if (priorsCheckedFor.current === priorCheckKey) return;
    priorsCheckedFor.current = priorCheckKey;

    // Nothing to consult until copies have somewhere to go. In-place mode has no second file at
    // all — the original *is* the copy — so its coordinates arrived with the ordinary read.
    if (destination.kind !== 'copy') return;

    const entries = session?.photos;
    if (!entries || entries.length === 0) return;

    void (async () => {
      // Cached page-wide, so this is free when the load has already built one. The `> 2` is
      // `loadPhotos`'s rule: below it, booting an interpreter costs more than batching saves.
      const runner = entries.length > 2 ? await createBatchRunner() : undefined;
      await checkPriorLocations(entries, await getBackend(), runner);
    })();
    // `session` and `destination` are read through the key, deliberately: depending on them
    // directly would re-run this every time a pin moves.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [priorCheckKey]);

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
    /*
     * The progress line is cleared *here*, in a `finally`, rather than by each caller.
     *
     * It used to be the caller's job, and every caller but one remembered — so importing raw left
     * "Reading metadata 2/2" on screen for the rest of the session, above a photo list that had
     * plainly finished loading. Whoever turns it on should be the one who turns it off; anything
     * else is correct by convention, and a convention is a bug waiting for the next call site.
     */
    setLoading({ done: 0, total: refs.length, current: '' });
    try {
      const loaded = await loadPhotos(refs, store, await getBackend(), setLoading);

      setThumbnails((previous) => {
        revokeThumbnailUrls(previous);
        return toThumbnailUrls(loaded.thumbnails);
      });
      setFolder(target);
      setSession(createSession(loaded.entries, keepClock ?? defaultClock()));
      // The search for earlier geotagging is not started here — see the effect below, which
      // covers this *and* the case where the output folder is chosen minutes later.
    } finally {
      setLoading(null);
    }
  }, [getBackend]);

  /**
   * The file picker. The right way in for a camera card.
   *
   * A card holds hundreds or thousands of photos in one folder, and reading all of them before
   * anything can be done would run for the better part of an hour on a phone. Letting the OS
   * picker narrow the set first is the difference between unusable and instant.
   */
  /**
   * A folder that is open and listed, waiting for somebody to say which photographs to read.
   *
   * This is the operating system's file picker, moved inside the application. It had to move,
   * because the real one cannot say **where a file lives**: `showOpenFilePicker` returns handles
   * with no route to their parent, so neither "copies beside the originals" nor "a sidecar next to
   * the raw file" could be answered from it, and the interface had to ask for a folder *after* the
   * photographs were chosen. That question was the confusing step, and it is gone — one folder
   * grant now answers where to read, where `geotagged/` goes, and where a sidecar belongs.
   *
   * Showing it costs nothing: 20 ms to enumerate a thousand entries and 235 ms for their dates and
   * sizes, measured. The minutes are ExifTool, and ExifTool only runs on what was chosen.
   */
  const [browsing, setBrowsing] = useState<
    { readonly folder: BrowserFolder; readonly refs: readonly PhotoRef[] } | null
  >(null);

  /**
   * Add more photographs from the folder that is already open.
   *
   * The clock-sync flow needs this: the reference frame is shot *after* the session started, so
   * there has to be a way to bring one more file in without discarding the work so far.
   *
   * The folder is re-listed rather than remembered, because a frame shot since it was opened is
   * exactly what this is usually for. Listing is cheap; reading is not, so what is already open is
   * shown as such and cannot be chosen twice.
   */
  const addPhotos = useCallback(async () => {
    if (!session || !folder?.directory) return;
    setError(null);
    setNotice(null);

    try {
      setListing({ done: 0, total: 0, name: folder.displayName });
      const refs = await store.listFolder(
        folder,
        (done, total) => setListing({ done, total, name: folder.displayName }),
      );
      setBrowsing({ folder, refs });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setListing(null);
    }
  }, [session, folder]);

  /**
   * Read the chosen photographs, and either start a session or add to one.
   *
   * The only path from a folder listing to metadata, so it is the only place that pays ExifTool's
   * price — which is the entire reason the chooser exists.
   */
  const openChosen = useCallback(async (chosen: readonly PhotoRef[]) => {
    const target = browsing?.folder;
    if (!target || chosen.length === 0) return;

    const adding = session !== null && folder?.id === target.id;
    setBrowsing(null);
    setError(null);
    setOutcomes(null);
    setNotice(null);

    if (!adding) {
      await loadRefs(chosen, target);
      return;
    }

    setLoading({ done: 0, total: chosen.length, current: '' });
    try {
      const loaded = await loadPhotos(chosen, store, await getBackend(), setLoading);

      // Append rather than rebuild, so staged edits, the clock measurement and the undo
      // history all survive.
      setThumbnails((previous) => new Map([...previous, ...toThumbnailUrls(loaded.thumbnails)]));
      setSession((current) => (current ? addPhotosToSession(current, loaded.entries) : current));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(null);
    }
  }, [browsing, session, folder, loadRefs, getBackend]);

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

      /*
       * Progress, because on a phone this is not instant and silence reads as failure.
       *
       * Reported exactly that way: a whole camera folder of 322 files where "nothing seemed to
       * happen". The listing was serialised — see `listFolder`, now batched — but the deeper fault
       * was that a slow step showed nothing at all, so there was no way to tell a long wait from a
       * dead button.
       */
      setListing({ done: 0, total: 0, name: picked.displayName });
      const refs = await store.listFolder(
        picked,
        (done, total) => setListing({ done, total, name: picked.displayName }),
      );
      setListing(null);

      if (refs.length === 0) {
        setError(
          `Nothing to geotag in \u201c${picked.displayName}\u201d \u2014 no JPEG or raw files there. `
          + 'Video is not supported yet, so a folder of clips reads as empty.',
        );
        return;
      }

      /*
       * The destination is settled here, before anything is read, and never asked about again.
       *
       * The grant on this folder already covers creating things inside it, so `geotagged/` costs
       * no further prompt — and doing it now rather than after loading means the search for
       * earlier geotagging has somewhere to look on its first pass.
       */
      const output = await store.outputFolderWithin(picked);
      if (output) applyDestination(output);

      /*
       * No size warning, and none needed any more. It existed because opening a folder read every
       * file in it; now opening a folder reads nothing at all, and the cost is attached to the
       * selection instead — where the person can see it and change their mind.
       */
      setSession(null);
      setBrowsing({ folder: picked, refs });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setListing(null);
    }
  }, [applyDestination]);

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

    /*
     * Check the destination is still there before writing a single byte.
     *
     * A folder chosen last week can be deleted in between — tidying up `geotagged` is an ordinary
     * thing to do — and the handle does not survive it. Without this the save proceeds and fails
     * once per photograph with `NotFoundError`, which says nothing about what went wrong and
     * offers no way out. `ensureDestination` remakes the folder where it can, silently, and
     * otherwise hands back `copy-pending` so the destination bar asks the question properly.
     *
     * `folder?.directory` is offered as the fallback because in folder mode the photographs' own
     * folder was read from moments ago and is certainly alive.
     */
    const ready = await store.ensureDestination(folder?.directory);
    if (ready !== destination) applyDestination(ready);
    if (ready.kind === 'copy-pending') {
      setError(
        `The ${OUTPUT_FOLDER_NAME} folder is no longer there, and could not be remade where it `
        + 'was. Choose where the copies should go and save again — nothing has been written and '
        + 'no work has been lost.',
      );
      return;
    }

    setSaving({ done: 0, total: pendingPhotos(session).length, current: '' });

    try {
      const { outcomes: results, savedNames } = await saveSession(
        session, store, await getBackend(), setSaving,
        // Only raw photographs need it, and it is the same instance the loader already built.
        { runner: await createBatchRunner() },
      );
      setOutcomes(results);
      setSession((current) => (current ? markSaved(current, savedNames) : current));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(null);
    }
  }, [session, getBackend, folder, destination, applyDestination]);

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
        // The camera's own embedded thumbnail, already an object URL for the list. The map draws
        // it in the marker so one frame can be told from another without opening anything.
        // Spread rather than assigned: `exactOptionalPropertyTypes` distinguishes an absent
        // property from one holding `undefined`, and a photograph without a thumbnail has none.
        ...(thumbnails.has(entry.ref.name) ? { thumbnail: thumbnails.get(entry.ref.name)! } : {}),
      }];
    });
  }, [session, thumbnails]);

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
   * Not *asked* for here — `requestPermission` needs a user gesture and would throw — so it
   * reports that it needs reconnecting, which becomes a button.
   *
   * There is no output folder to restore any more. It is derived from whichever folder is open,
   * every time, which is the whole point of the folder being the only way in.
   */
  useEffect(() => {
    void (async () => {
      const remembered = await store.restoreTrackFolder();
      if (remembered) setTrackFolder(remembered);
    })();
  }, []);

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
   * Mounted the first time it would be visible, kept for the rest of the session, released when
   * the session ends. `keepMapMounted` is the rule, and each of its three answers was a bug.
   *
   * Constructing a MapLibre map inside a `display: none` container gives it a zero-sized viewport
   * — on a phone the Photos tab is the default, so mounting with the session would mean every map
   * on a phone was born blind and dependent on a later `resize()`. Within a session, hiding beats
   * unmounting, because a rebuild discards the tiles, the viewport and every marker. And the
   * release matters just as much: without it, going home left the landing screen squeezed into the
   * sidebar's 26rem, which reads as a mobile layout served to a desktop.
   */
  const [mapMounted, setMapMounted] = useState(false);
  const hasSession = session !== null;
  useEffect(() => {
    setMapMounted((mounted) => keepMapMounted(mounted, mapVisible, hasSession));
  }, [mapVisible, hasSession]);

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
        {/*
          The mark is always in the top left, and it is always the way back.

          It used to vanish once photos were open on a phone, because the full wordmark plus the
          labelled buttons needed 436px of a 375px screen. The fix is not to hide it but to shrink
          it: below the breakpoint only the pin is drawn, which is the part people recognise, and
          the word is dropped instead. `header.working h1` no longer hides anything.

          Going home discards a session, so it asks first when there is anything staged — the whole
          premise of this app is that unsaved work lives in memory until Save, and a stray tap on
          the logo is exactly the sort of thing that should not be able to throw fifty placements
          away.
        */}
        <h1>
          {/*
            `aria-label` rather than a visually-hidden span. The wordmark renders the word
            "Snapmapper" as real text, so a hidden label *beside* it is announced twice —
            "Snapmapper, Snapmapper — start again". A label on the button replaces the content
            rather than adding to it, and covers the narrow case where only the pin is drawn and
            there is no text at all.
          */}
          <button
            type="button"
            className="home"
            onClick={goHome}
            title="Start again"
            aria-label="Snapmapper — start again"
          >
            {narrow && session ? <Mark size={26} /> : <Wordmark />}
          </button>
        </h1>
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
        {/*
          One button, where there were four.

          The header carried the folder name, Re-scan, Select photos… and Open whole folder… —
          three of which start a *different* session, which is to say they all go back to the
          beginning by a slightly different route. As a group they took most of the width and the
          overflow menu existed to hold them.

          `Start again` says the one thing they had in common, and the mark beside it does the same
          for anyone who reaches for a logo. Adding photographs mid-session goes with them: it was
          the only genuinely distinct action here, and it is not worth a permanent control until
          somebody wants it back.
        */}
        {session && (
          <button type="button" onClick={goHome} disabled={busy}>Start again</button>
        )}
        </div>
      </header>

      {/*
        The destination is a question about *copies*, and raw photographs are never copied.

        A raw file is never opened for writing at all — its location goes into a sidecar written
        beside it — so there is nothing for a `geotagged` folder to hold and nothing to overwrite.
        Asking anyway put a red blocker across the top of a raw session demanding an answer that
        would have changed nothing, directly contradicting the notice underneath it saying where
        the sidecars were already going.

        Only asked when the session actually contains something that gets copied. A mixed session
        still needs it, for the JPEGs.
      */}
      {session && session.photos.some((entry) => !isRawFile(entry.ref.name)) && (
        <DestinationBar
          destination={destination}
          busy={busy}
          onSaveCopies={async () => {
            setError(null);
            try {
              // Always derived from the open folder — there is no other kind of session now, and
              // the grant on that folder already covers creating `geotagged/` inside it.
              if (!folder) return;
              const output = await store.outputFolderWithin(folder);
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
      {/*
        One line, with Dismiss on it rather than under it.

        `.banner button` carries a top margin, so the button dropped onto its own row and the
        notice took twice the height it needed — a permanent bite out of the map for one sentence.
      */}
      {notice && (
        <div className="banner warn line">
          <span>{notice}</span>
          <button type="button" className="link" onClick={() => setNotice(null)}>Dismiss</button>
        </div>
      )}

      {loading && (
        <div className="banner">
          Reading metadata {loading.done}/{loading.total} — {loading.current}
        </div>
      )}

      {listing && (
        <div className="banner">
          Reading <code>{listing.name}</code>
          {listing.total > 0 ? ` — ${listing.done}/${listing.total} files` : '…'}
        </div>
      )}

      {checkingPriors && !loading && (
        <div className="banner">Looking for photographs geotagged in an earlier session…</div>
      )}

      {conflicts.length > 0 && (
        <ConflictPrompt
          conflicts={conflicts}
          thumbnails={thumbnails}
          onChoose={resolveConflict}
          onDismiss={() => setConflicts([])}
        />
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
            {/*
              The chooser outranks the session, because adding photographs shows it *over* an open
              one. It is a step in the work rather than a dialog on top of it, so it takes the pane.
            */}
            {browsing
              ? (
                <FolderChooser
                  folderName={browsing.folder.displayName}
                  refs={browsing.refs}
                  busy={busy}
                  onOpen={openChosen}
                  onCancel={() => setBrowsing(null)}
                  store={store}
                  {...(session
                    ? { alreadyOpen: new Set(session.photos.map((entry) => entry.ref.name)) }
                    : {})}
                />
              )
              : session
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
                  canPickFolder={isFolderPickerSupported()}
                  busy={busy}
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

/**
 * Say that a lookup failed, without listing every file.
 *
 * Naming the first is enough to act on and keeps the notice one line; the count says whether it
 * was a stray corrupt sidecar or something wrong with the whole folder.
 */
function describePriorProblems(problems: readonly string[]): string {
  const [first] = problems;
  return problems.length === 1
    ? `Could not read an earlier location — ${first}`
    : `Could not read ${problems.length} earlier locations — first: ${first}`;
}


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
