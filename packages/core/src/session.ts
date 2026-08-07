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
  readonly history: readonly SessionSnapshot[];
  readonly future: readonly SessionSnapshot[];
}

/** The part of a session undo restores. Selection is not worth undoing. */
interface SessionSnapshot {
  readonly edits: ReadonlyMap<string, Coordinates | null>;
  readonly clock: CameraClock;
  readonly sync: ClockSync | undefined;
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

/** Photos with staged changes, in list order. The save list. */
export function pendingPhotos(session: Session): readonly PhotoEntry[] {
  return session.photos.filter((entry) => session.edits.has(entry.ref.name));
}

export function hasPendingChanges(session: Session): boolean {
  return session.edits.size > 0;
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

  return commit(session, { edits, clock: session.clock, sync: session.sync });
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

  return changed ? commit(session, { edits, clock: session.clock, sync: session.sync }) : session;
}

/** Drop staged changes for the given photos, reverting them to what is on disk. */
export function revert(session: Session, names: readonly string[]): Session {
  const edits = new Map(session.edits);
  let changed = false;
  for (const name of names) {
    if (edits.delete(name)) changed = true;
  }
  return changed ? commit(session, { edits, clock: session.clock, sync: session.sync }) : session;
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

  return commit(session, { edits: session.edits, clock, sync: session.sync });
}

/**
 * Set the drift by hand, discarding any measurement.
 *
 * The reference is dropped deliberately: keeping it would mean the next zone change threw
 * the typed-in value away without saying so.
 */
export function setOffsetSeconds(session: Session, offsetSeconds: number): Session {
  return commit(session, {
    edits: session.edits,
    clock: { ...session.clock, offsetSeconds },
    sync: undefined,
  });
}

/**
 * Adopt a measured clock sync.
 *
 * Undoable, because it silently moves the GPS timestamp of every photo in the session.
 */
export function applySync(session: Session, sync: ClockSync): Session {
  return commit(session, {
    edits: session.edits,
    clock: clockFromSync(sync, session.clock.timeZone),
    sync,
  });
}

/** Discard a measurement, leaving the offset where it was but no longer derived. */
export function clearSync(session: Session): Session {
  if (!session.sync) return session;
  return commit(session, { edits: session.edits, clock: session.clock, sync: undefined });
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

  const photos = session.photos.map((entry) => {
    if (!saved.has(entry.ref.name)) return entry;
    const staged = session.edits.get(entry.ref.name);
    if (staged === undefined) return entry;
    edits.delete(entry.ref.name);
    return { ...entry, existing: staged === null ? undefined : staged };
  });

  return { ...session, photos, edits, history: [], future: [] };
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
    clock: previous.clock,
    sync: previous.sync,
    history: session.history.slice(0, -1),
    future: [...session.future, { edits: session.edits, clock: session.clock, sync: session.sync }],
  };
}

export function redo(session: Session): Session {
  const next = session.future.at(-1);
  if (!next) return session;

  return {
    ...session,
    edits: next.edits,
    clock: next.clock,
    sync: next.sync,
    history: [...session.history, { edits: session.edits, clock: session.clock, sync: session.sync }],
    future: session.future.slice(0, -1),
  };
}

/**
 * Apply a change, pushing the previous state onto the undo stack.
 *
 * Redo is discarded, as it must be: once a new edit is made, the old future is not
 * reachable any more.
 */
function commit(session: Session, next: SessionSnapshot): Session {
  const history = [
    ...session.history,
    { edits: session.edits, clock: session.clock, sync: session.sync },
  ];

  return {
    ...session,
    edits: next.edits,
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
