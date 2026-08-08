/**
 * A tagging session: the photo list, staged edits, and what is safe to write.
 *
 * The governing rule is that **nothing touches disk until an explicit save**. Edits
 * accumulate here, visibly pending, and a save turns them into a list of write
 * operations. That is what makes the destructive step deliberate rather than a
 * side-effect of clicking a map.
 *
 * Immutable by construction: every mutator returns a new session. That buys undo and
 * redo almost for free, and it keeps React honest about when to re-render. Sessions are
 * small — a few hundred photos of metadata — so copying them is not a real cost, and
 * the photo *bytes* never live here.
 */

import { clockFromSync, type ClockSync } from './clock-sync.ts';
import { assertValidCoordinates, type Coordinates } from './gps.ts';
import { matchTrack, type GpxTrack, type MatchOptions } from './gpx.ts';
import { isEmptyPlace, type Place } from './place.ts';
import { parseExifDateTime, photoInstant, type CameraClock, type NaiveDateTime } from './time.ts';
import type { PhotoRef } from './storage.ts';

export interface PhotoEntry {
  readonly ref: PhotoRef;
  /** As read from the file. `undefined` when the camera wrote an unusable date. */
  readonly takenAt: NaiveDateTime | undefined;
  /** Coordinates already in the file, if any. */
  readonly existing: Coordinates | undefined;
  /** Anything that stopped this photo being read. It stays listed, but unusable. */
  readonly error: string | undefined;
}

/** A photo's location as it currently stands, and where that came from. */
export type LocationState =
  | { readonly kind: 'none' }
  | { readonly kind: 'saved'; readonly coordinates: Coordinates }
  | { readonly kind: 'pending'; readonly coordinates: Coordinates }
  | { readonly kind: 'pending-clear' };

export interface Session {
  readonly photos: readonly PhotoEntry[];
  /** Staged coordinates by photo name. Absent means untouched. */
  readonly edits: ReadonlyMap<string, Coordinates | null>;
  /**
   * Staged place names by photo name. `null` is a staged clear.
   *
   * A second map rather than a field on the edit, because the two are genuinely independent: a
   * photograph can have its coordinates changed without being re-geocoded, and one that already
   * had coordinates on disk can be given place names without its position being touched at all.
   * Folding them together would make "geocode what is already saved" impossible to express.
   */
  readonly places: ReadonlyMap<string, Place | null>;
  readonly selected: ReadonlySet<string>;
  readonly clock: CameraClock;
  /**
   * The measurement `clock.offsetSeconds` came from, when there was one.
   *
   * Held so that changing the time zone re-derives the offset instead of leaving a
   * number that was only ever valid for the old zone. `undefined` means the offset was
   * entered by hand.
   */
  readonly sync: ClockSync | undefined;
  /** Past states, most recent last. Bounded — see UNDO_LIMIT. */
  readonly history: readonly HistoryEntry[];
  readonly future: readonly HistoryEntry[];
}

/** The part of a session undo restores. Selection is not worth undoing. */
interface SessionSnapshot {
  readonly edits: ReadonlyMap<string, Coordinates | null>;
  readonly places: ReadonlyMap<string, Place | null>;
  readonly clock: CameraClock;
  readonly sync: ClockSync | undefined;
}

/**
 * What a step in the history *was*, so the interface can say rather than just offer "Undo".
 *
 * Structured, not a sentence: `packages/core` has no business choosing the words, and a caller
 * that wants "place 5 photos" and one that wants "5 Fotos platzieren" should both be possible.
 * `describe-action.ts` in the UI does the phrasing.
 */
export type SessionAction =
  | { readonly kind: 'place'; readonly count: number }
  | { readonly kind: 'track'; readonly count: number }
  | { readonly kind: 'restore'; readonly count: number }
  | { readonly kind: 'geocode'; readonly count: number }
  | { readonly kind: 'clear'; readonly count: number }
  | { readonly kind: 'revert'; readonly count: number }
  | { readonly kind: 'time-zone'; readonly timeZone: string }
  | { readonly kind: 'offset'; readonly offsetSeconds: number }
  | { readonly kind: 'sync' }
  | { readonly kind: 'clear-sync' };

/**
 * A snapshot plus the action that led *away* from it.
 *
 * The pairing is the fiddly part. A history entry holds a past state, and what the user wants named
 * is not that state but the change that replaced it — "Undo place 5 photos". So the action recorded
 * with a past state is the one applied to leave it, and moving an entry between the two stacks
 * carries that action across unchanged.
 */
interface HistoryEntry extends SessionSnapshot {
  readonly action: SessionAction;
}

/**
 * Undo depth. Generous enough to cover a session's worth of mistakes, bounded so a long
 * session cannot grow without limit.
 */
export const UNDO_LIMIT = 100;

export function createSession(photos: readonly PhotoEntry[], clock: CameraClock): Session {
  return {
    photos,
    edits: new Map(),
    places: new Map(),
    selected: new Set(),
    clock,
    sync: undefined,
    history: [],
    future: [],
  };
}

// --- Queries -----------------------------------------------------------------

export function locationOf(session: Session, name: string): LocationState {
  if (session.edits.has(name)) {
    const staged = session.edits.get(name);
    return staged === null
      ? { kind: 'pending-clear' }
      : { kind: 'pending', coordinates: staged as Coordinates };
  }

  const photo = session.photos.find((entry) => entry.ref.name === name);
  if (photo?.existing) return { kind: 'saved', coordinates: photo.existing };
  return { kind: 'none' };
}

/**
 * Photos with staged changes, in list order. The save list.
 *
 * Coordinates *or* place names. Geocoding a photo whose position is already on disk stages nothing
 * in `edits`, and if that did not count as pending it would be a change the Save button never
 * offered to write — work done and silently discarded.
 */
export function pendingPhotos(session: Session): readonly PhotoEntry[] {
  return session.photos.filter(
    (entry) => session.edits.has(entry.ref.name) || session.places.has(entry.ref.name),
  );
}

export function hasPendingChanges(session: Session): boolean {
  return session.edits.size > 0 || session.places.size > 0;
}

/**
 * Photos with no location at all — neither on disk nor staged.
 *
 * The set that still needs work after a track match, and the reason "Select unplaced" exists: a
 * match that places 38 of 45 leaves seven scattered through a list of forty-five, and finding them
 * by eye is the tedious part of an otherwise automatic job.
 *
 * Unreadable photos are excluded. They cannot be placed by hand either, so selecting them would
 * only ever be a way to arm the map with something it cannot act on.
 */
export function unplacedPhotos(session: Session): readonly PhotoEntry[] {
  return session.photos.filter(
    (entry) => entry.error === undefined && locationOf(session, entry.ref.name).kind === 'none',
  );
}

/** Photos with a staged location, in list order. What a review pass steps through. */
export function stagedPhotos(session: Session): readonly PhotoEntry[] {
  return session.photos.filter(
    (entry) => locationOf(session, entry.ref.name).kind === 'pending',
  );
}

export function selectedPhotos(session: Session): readonly PhotoEntry[] {
  return session.photos.filter((entry) => session.selected.has(entry.ref.name));
}

/**
 * The true instant a photo was taken, or `undefined` if its date is unusable.
 *
 * Needed for `GPSDateStamp`/`GPSTimeStamp`, and later for matching against a GPX track.
 * A photo with no readable date still gets coordinates — it just gets no GPS time,
 * which is better than a guessed one.
 */
export function instantOf(session: Session, entry: PhotoEntry): Date | undefined {
  if (!entry.takenAt) return undefined;
  return photoInstant(entry.takenAt, session.clock);
}

// --- Mutations ---------------------------------------------------------------

export function select(session: Session, names: readonly string[]): Session {
  return { ...session, selected: new Set(names) };
}

export function toggleSelected(session: Session, name: string): Session {
  const selected = new Set(session.selected);
  if (!selected.delete(name)) selected.add(name);
  return { ...session, selected };
}

/**
 * Select an inclusive range in list order, as shift-click does everywhere else.
 *
 * `add` keeps the existing selection, matching the convention that shift extends and
 * ctrl-shift accumulates. Order of the two names does not matter — dragging a selection
 * upwards is as normal as downwards.
 */
export function selectRange(
  session: Session,
  fromName: string,
  toName: string,
  add = false,
): Session {
  const names = session.photos.map((entry) => entry.ref.name);
  const from = names.indexOf(fromName);
  const to = names.indexOf(toName);
  if (from < 0 || to < 0) return session;

  const selected = new Set(add ? session.selected : []);
  for (let index = Math.min(from, to); index <= Math.max(from, to); index++) {
    const name = names[index];
    if (name !== undefined) selected.add(name);
  }

  return { ...session, selected };
}

/**
 * Stage coordinates for the given photos.
 *
 * Validates before staging, so an out-of-range value cannot sit in a session waiting to
 * reach a file. Photos that failed to read are skipped: writing to a file we could not
 * parse is exactly the sort of optimism that corrupts things.
 */
export function assignLocation(
  session: Session,
  names: readonly string[],
  coordinates: Coordinates,
): Session {
  assertValidCoordinates(coordinates);

  const writable = names.filter((name) => {
    const photo = session.photos.find((entry) => entry.ref.name === name);
    return photo !== undefined && photo.error === undefined;
  });

  if (writable.length === 0) return session;

  const edits = new Map(session.edits);
  for (const name of writable) edits.set(name, coordinates);

  return commit(
    session,
    { edits, places: session.places, clock: session.clock, sync: session.sync },
    { kind: 'place', count: writable.length },
  );
}

/** Why a photo came away from a track with nothing. Phrased by the UI, like `SessionAction`. */
export type TrackSkip =
  | { readonly name: string; readonly reason: 'unreadable' }
  | { readonly name: string; readonly reason: 'no-date' }
  | { readonly name: string; readonly reason: 'already-placed' }
  /** The track has no fix close enough. `gapSeconds` is how far the nearest one was. */
  | { readonly name: string; readonly reason: 'no-fix'; readonly gapSeconds: number };

/** A photo the track placed, and how confidently. */
export interface TrackPlacement {
  readonly name: string;
  readonly coordinates: Coordinates;
  readonly gapSeconds: number;
  readonly interpolated: boolean;
}

export interface TrackApplyOptions extends MatchOptions {
  /** Which photos to consider. All of them when absent. */
  readonly names?: readonly string[];
  /**
   * Overwrite photos that already have a location.
   *
   * Off by default, and that default is the important one: a hand-placed photograph is somebody's
   * considered judgement, and a track sweeping it aside is a loss that Undo can reverse but nobody
   * would notice in time to press it.
   */
  readonly replaceExisting?: boolean;
}

/**
 * Place photographs from a GPS track, by time.
 *
 * The correction chain is the point of the whole feature: `instantOf` resolves the camera's naive
 * reading through the session's zone *and* its measured drift, and only then is the track asked
 * where that instant was. A track match with an uncorrected clock is confidently wrong — off by
 * the drift, and by hours if the zone is wrong — which is exactly the failure the clock panel
 * exists to prevent, so the two features are only useful together.
 *
 * Reports what it skipped and why, rather than quietly placing the ones it could. "18 of 24" with
 * no explanation is the sort of result that makes people distrust a tool that was working
 * correctly.
 */
export function applyTrack(
  session: Session,
  track: GpxTrack,
  options: TrackApplyOptions = {},
): {
  readonly session: Session;
  readonly placed: readonly TrackPlacement[];
  readonly skipped: readonly TrackSkip[];
} {
  const wanted = options.names ? new Set(options.names) : undefined;
  const candidates = wanted
    ? session.photos.filter((entry) => wanted.has(entry.ref.name))
    : session.photos;

  const placed: TrackPlacement[] = [];
  const skipped: TrackSkip[] = [];
  const edits = new Map(session.edits);

  for (const entry of candidates) {
    const name = entry.ref.name;

    if (entry.error !== undefined) {
      skipped.push({ name, reason: 'unreadable' });
      continue;
    }

    if (!options.replaceExisting && locationOf(session, name).kind !== 'none') {
      skipped.push({ name, reason: 'already-placed' });
      continue;
    }

    const instant = instantOf(session, entry);
    if (!instant) {
      skipped.push({ name, reason: 'no-date' });
      continue;
    }

    const match = matchTrack(track, instant, options);
    if (match.kind === 'none') {
      skipped.push({ name, reason: 'no-fix', gapSeconds: match.gapSeconds });
      continue;
    }

    edits.set(name, match.coordinates);
    placed.push({
      name,
      coordinates: match.coordinates,
      gapSeconds: match.gapSeconds,
      interpolated: match.kind === 'interpolated',
    });
  }

  if (placed.length === 0) return { session, placed, skipped };

  return {
    session: commit(
      session,
      { edits, places: session.places, clock: session.clock, sync: session.sync },
      { kind: 'track', count: placed.length },
    ),
    placed,
    skipped,
  };
}

/**
 * Put a whole set of staged edits back, as one step.
 *
 * For restoring work a killed tab took — see `session-backup.ts` in the UI. Not a general-purpose
 * setter: it validates every coordinate before staging any of them, because these have been
 * through storage and out again, and a value that has been serialised is a value that could have
 * come back as something else.
 *
 * Photos that are no longer in the session are skipped rather than refused, since a backup may be
 * offered against a folder that has changed underneath it. The caller reports the shortfall.
 */
export function restoreEdits(
  session: Session,
  restored: ReadonlyMap<string, Coordinates | null>,
): Session {
  const edits = new Map(session.edits);
  let count = 0;

  for (const [name, staged] of restored) {
    const photo = session.photos.find((entry) => entry.ref.name === name);
    if (!photo || photo.error !== undefined) continue;
    if (staged !== null) assertValidCoordinates(staged);
    edits.set(name, staged);
    count += 1;
  }

  if (count === 0) return session;

  return commit(
    session,
    { edits, places: session.places, clock: session.clock, sync: session.sync },
    { kind: 'restore', count },
  );
}

/**
 * The place names a photo will have after a save, if any.
 *
 * Only staged values, and deliberately: place names already in the file are not read back when a
 * folder is opened. Doing so would cost a fifth of the load budget on fields that change nothing
 * about what the app can do — the map is drawn from coordinates, and nothing here decides anything
 * from a city name. What is on disk stays on disk and is only ever *added to*.
 */
export function placeOf(session: Session, name: string): Place | null | undefined {
  return session.places.get(name);
}

/** Photos with a staged place name. What a save has place tags to write for. */
export function placedNames(session: Session): readonly string[] {
  return session.photos
    .map((entry) => entry.ref.name)
    .filter((name) => session.places.has(name));
}

/**
 * Stage place names for photos.
 *
 * One step for the lot, because a geocode is one action from the user's side however many requests
 * it took. Empty results are stored as `null` — a staged *clear* rather than an absence — so that
 * "the service had nothing for this spot" is distinguishable from "not looked up yet", and asking
 * again is a decision rather than something that happens by itself.
 */
export function assignPlaces(
  session: Session,
  found: ReadonlyMap<string, Place>,
): Session {
  const places = new Map(session.places);
  let count = 0;

  for (const [name, place] of found) {
    const photo = session.photos.find((entry) => entry.ref.name === name);
    if (!photo || photo.error !== undefined) continue;
    places.set(name, isEmptyPlace(place) ? null : place);
    count += 1;
  }

  if (count === 0) return session;

  return commit(
    session,
    { edits: session.edits, places, clock: session.clock, sync: session.sync },
    { kind: 'geocode', count },
  );
}

/** Stage removal of a photo's location. */
export function clearLocation(session: Session, names: readonly string[]): Session {
  const edits = new Map(session.edits);
  let changed = false;

  for (const name of names) {
    const photo = session.photos.find((entry) => entry.ref.name === name);
    if (!photo || photo.error !== undefined) continue;
    // Nothing to clear on a photo that has neither saved nor staged coordinates.
    if (!photo.existing && !session.edits.has(name)) continue;
    edits.set(name, null);
    changed = true;
  }

  return changed
    ? commit(
      session,
      { edits, places: session.places, clock: session.clock, sync: session.sync },
      { kind: 'clear', count: countChanged(session.edits, edits) },
    )
    : session;
}

/** Drop staged changes for the given photos, reverting them to what is on disk. */
export function revert(session: Session, names: readonly string[]): Session {
  const edits = new Map(session.edits);
  let reverted = 0;
  for (const name of names) {
    if (edits.delete(name)) reverted += 1;
  }
  return reverted > 0
    ? commit(
      session,
      { edits, places: session.places, clock: session.clock, sync: session.sync },
      { kind: 'revert', count: reverted },
    )
    : session;
}

/**
 * Change the time zone, re-deriving the offset from the sync reference if there is one.
 *
 * This is the whole reason the reference is kept. An offset is only valid for the zone it
 * was measured in, so a zone change without re-derivation would leave every GPS timestamp
 * quietly wrong — by the zone difference *and* by the stale offset.
 */
export function setTimeZone(session: Session, timeZone: string): Session {
  const clock = session.sync
    ? clockFromSync(session.sync, timeZone)
    : { ...session.clock, timeZone };

  return commit(
    session,
    { edits: session.edits, places: session.places, clock, sync: session.sync },
    { kind: 'time-zone', timeZone },
  );
}

/**
 * Set the drift by hand, discarding any measurement.
 *
 * The reference is dropped deliberately: keeping it would mean the next zone change threw
 * the typed-in value away without saying so.
 */
export function setOffsetSeconds(session: Session, offsetSeconds: number): Session {
  return commit(
    session,
    { edits: session.edits, places: session.places, clock: { ...session.clock, offsetSeconds }, sync: undefined },
    { kind: 'offset', offsetSeconds },
  );
}

/**
 * Adopt a measured clock sync.
 *
 * Undoable, because it silently moves the GPS timestamp of every photo in the session.
 */
export function applySync(session: Session, sync: ClockSync): Session {
  return commit(
    session,
    { edits: session.edits, places: session.places, clock: clockFromSync(sync, session.clock.timeZone), sync },
    { kind: 'sync' },
  );
}

/** Discard a measurement, leaving the offset where it was but no longer derived. */
export function clearSync(session: Session): Session {
  if (!session.sync) return session;
  return commit(
    session,
    { edits: session.edits, places: session.places, clock: session.clock, sync: undefined },
    { kind: 'clear-sync' },
  );
}

/**
 * Mark staged edits as written.
 *
 * Called with the names that actually succeeded, so a partial save leaves the failures
 * still pending and visible rather than quietly dropping them. History is cleared: undo
 * cannot reach back past a write to disk, and pretending otherwise would be a lie.
 */
export function markSaved(session: Session, savedNames: readonly string[]): Session {
  const saved = new Set(savedNames);
  const edits = new Map(session.edits);
  const places = new Map(session.places);

  const photos = session.photos.map((entry) => {
    if (!saved.has(entry.ref.name)) return entry;

    // Place names are settled by the same write, and are not read back into the entry — see
    // `placeOf`. Clearing them here is what stops a saved photo staying listed as unsaved.
    places.delete(entry.ref.name);

    const staged = session.edits.get(entry.ref.name);
    if (staged === undefined) return entry;
    edits.delete(entry.ref.name);
    return { ...entry, existing: staged === null ? undefined : staged };
  });

  return { ...session, photos, edits, places, history: [], future: [] };
}

/**
 * Add photos to an open session, keeping everything else.
 *
 * Needed because the clock-sync reference frame is shot *after* work has started, so there has
 * to be a way to bring one more file in without discarding the staged edits, the measurement,
 * or the undo history.
 *
 * Not undoable, and deliberately so: adding a photo is not an edit to anything, and putting it
 * on the undo stack would mean Ctrl+Z made a file disappear from the list.
 *
 * Entries whose names are already present are ignored rather than replacing what is there.
 * Re-reading a photo already open would throw away nothing useful and cost a metadata read —
 * three seconds on a phone — for no gain.
 */
export function addPhotos(session: Session, entries: readonly PhotoEntry[]): Session {
  const present = new Set(session.photos.map((entry) => entry.ref.name));
  const fresh = entries.filter((entry) => !present.has(entry.ref.name));
  if (fresh.length === 0) return session;

  const photos = [...session.photos, ...fresh]
    .sort((a, b) => a.ref.name.localeCompare(b.ref.name, undefined, { numeric: true }));

  return { ...session, photos };
}

// --- Undo / redo -------------------------------------------------------------

export function canUndo(session: Session): boolean {
  return session.history.length > 0;
}

export function canRedo(session: Session): boolean {
  return session.future.length > 0;
}

export function undo(session: Session): Session {
  const previous = session.history.at(-1);
  if (!previous) return session;

  return {
    ...session,
    edits: previous.edits,
    places: previous.places,
    clock: previous.clock,
    sync: previous.sync,
    history: session.history.slice(0, -1),
    // The action travels with the state it produced, so redoing offers the same name that undoing
    // just used. Attaching the *current* top of history here instead would drift by one step.
    future: [
      ...session.future,
      {
        edits: session.edits,
        places: session.places,
        clock: session.clock,
        sync: session.sync,
        action: previous.action,
      },
    ],
  };
}

export function redo(session: Session): Session {
  const next = session.future.at(-1);
  if (!next) return session;

  return {
    ...session,
    edits: next.edits,
    places: next.places,
    clock: next.clock,
    sync: next.sync,
    history: [
      ...session.history,
      { edits: session.edits, places: session.places, clock: session.clock, sync: session.sync, action: next.action },
    ],
    future: session.future.slice(0, -1),
  };
}

/** What Undo would take back, for labelling the button. `undefined` when there is nothing. */
export function undoAction(session: Session): SessionAction | undefined {
  return session.history.at(-1)?.action;
}

/** What Redo would put back. */
export function redoAction(session: Session): SessionAction | undefined {
  return session.future.at(-1)?.action;
}

/** How many entries differ between two edit maps — the size of a clear, in practice. */
function countChanged(
  before: ReadonlyMap<string, Coordinates | null>,
  after: ReadonlyMap<string, Coordinates | null>,
): number {
  let changed = 0;
  for (const [name, value] of after) {
    if (before.get(name) !== value) changed += 1;
  }
  return changed;
}

/**
 * Apply a change, pushing the previous state onto the undo stack.
 *
 * Redo is discarded, as it must be: once a new edit is made, the old future is not
 * reachable any more.
 */
function commit(session: Session, next: SessionSnapshot, action: SessionAction): Session {
  const history = [
    ...session.history,
    { edits: session.edits, places: session.places, clock: session.clock, sync: session.sync, action },
  ];

  return {
    ...session,
    edits: next.edits,
    places: next.places,
    clock: next.clock,
    sync: next.sync,
    history: history.length > UNDO_LIMIT ? history.slice(-UNDO_LIMIT) : history,
    future: [],
  };
}

// --- Building entries --------------------------------------------------------

/**
 * Turn a file's tags into a photo entry.
 *
 * Reads what ExifTool reports, tolerating absence everywhere: cameras write malformed
 * dates, and a photo that cannot be fully understood should still appear in the list
 * rather than vanish.
 */
export function entryFromTags(ref: PhotoRef, tags: Record<string, unknown>): PhotoEntry {
  const dateText = firstString(tags, [
    'EXIF:DateTimeOriginal',
    'DateTimeOriginal',
    'EXIF:CreateDate',
    'CreateDate',
  ]);

  // Composite:GPS* are ExifTool's signed values; the raw EXIF tags are unsigned with a
  // separate hemisphere ref, which is the trap the spike's verifier originally fell into.
  const latitude = firstNumber(tags, ['Composite:GPSLatitude', 'GPSLatitude']);
  const longitude = firstNumber(tags, ['Composite:GPSLongitude', 'GPSLongitude']);
  const altitude = firstNumber(tags, ['Composite:GPSAltitude', 'GPSAltitude']);

  const hasLocation = latitude !== undefined && longitude !== undefined;

  return {
    ref,
    takenAt: dateText ? (parseExifDateTime(dateText) ?? undefined) : undefined,
    existing: hasLocation
      ? { latitude, longitude, ...(altitude !== undefined ? { altitude } : {}) }
      : undefined,
    error: undefined,
  };
}

/** A photo that could not be read. Listed, but not writable. */
export function failedEntry(ref: PhotoRef, error: string): PhotoEntry {
  return { ref, takenAt: undefined, existing: undefined, error };
}

function firstString(tags: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = tags[key];
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  return undefined;
}

function firstNumber(tags: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = tags[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
      const parsed = Number(value);
      if (value.trim() !== '' && Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}
