/**
 * Staged edits, kept somewhere they survive the tab being killed.
 *
 * The failure this exists for is specific and silent. Android discards backgrounded tabs whenever
 * it wants the memory: check a message mid-session, come back, and every placement that had not
 * reached disk is gone. `beforeunload` does not fire for that — the page is not unloading, it is
 * being destroyed — so the existing guard against a stray refresh does nothing here, and there is
 * no moment at which anything could have warned you.
 *
 * It is the worst loss the app can inflict, because the work is invisible: forty photographs
 * placed by hand or matched against a track look exactly like forty photographs that were never
 * touched.
 *
 * ## What is kept, and what is not
 *
 * Only what cannot be recovered: the staged coordinates, the camera clock, and the measurement it
 * came from. Not the photographs — those are on disk and are re-read when the folder is opened
 * again. Not the undo history, which would multiply the size for something nobody expects to
 * survive a crash. Not the selection.
 *
 * ## Why IndexedDB rather than localStorage
 *
 * A session's edits are a map of coordinates, which JSON handles — but `localStorage` is
 * synchronous and shares a small quota with the track-span cache, and writing to it on every edit
 * blocks the main thread at exactly the moment somebody is tapping the map. IndexedDB is
 * asynchronous and roomy, and the database is already open for remembered folders — see `idb.ts`,
 * which owns the schema so the two cannot disagree about its version.
 */

import type { CameraClock, ClockSync, Coordinates, Session } from '@snapmapper/core';

import { SESSION_STORE, transact } from './idb.ts';

/** One slot. Two folders open at once is not a thing the app can do. */
const KEY = 'staged';

/**
 * How long a backup is worth offering.
 *
 * Long enough to cover a phone that was put down mid-session and picked up the next evening; short
 * enough that a backup from a fortnight ago, whose folder has probably moved on, is not presented
 * as though it were relevant. It is deleted rather than offered after this.
 */
export const BACKUP_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

export interface SessionBackup {
  /** Coordinates by photo name; `null` is a staged clear. */
  readonly edits: Record<string, Coordinates | null>;
  readonly clock: CameraClock;
  readonly sync: ClockSync | undefined;
  /** What the folder was called, so the offer can name it. */
  readonly folderName: string;
  /** Names of the photos the edits belong to, for reporting how many can be restored. */
  readonly photoNames: readonly string[];
  readonly savedAtMs: number;
}


/**
 * Write the staged edits away. Never throws.
 *
 * A backup that fails must not interrupt the editing it is backing up — this runs while somebody
 * is tapping a map, and an exception here would be a bug in the feature that exists to prevent
 * losing work causing exactly that.
 */
export async function backupSession(
  session: Session,
  folderName: string,
  now: number,
): Promise<void> {
  try {
    const edits: Record<string, Coordinates | null> = {};
    for (const [name, value] of session.edits) edits[name] = value;

    const backup: SessionBackup = {
      edits,
      clock: session.clock,
      sync: session.sync,
      folderName,
      photoNames: session.photos.map((entry) => entry.ref.name),
      savedAtMs: now,
    };

    await transact(SESSION_STORE, 'readwrite', (rows) => rows.put(backup, KEY));
  } catch {
    // See above.
  }
}

export async function clearBackup(): Promise<void> {
  try {
    await transact(SESSION_STORE, 'readwrite', (rows) => rows.delete(KEY));
  } catch {
    // Nothing depends on it.
  }
}

/**
 * A backup worth offering, if there is one.
 *
 * Returns `null` for anything doubtful — absent, malformed, stale, or empty — because the only
 * thing worse than losing the edits is being offered a restore that puts back something wrong.
 */
export async function findBackup(now: number): Promise<SessionBackup | null> {
  try {
    const found = await transact<unknown>(SESSION_STORE, 'readonly', (rows) => rows.get(KEY));
    if (!isBackup(found)) return null;

    if (now - found.savedAtMs > BACKUP_LIFETIME_MS) {
      await clearBackup();
      return null;
    }

    return Object.keys(found.edits).length > 0 ? found : null;
  } catch {
    return null;
  }
}

/**
 * Whether a stored value is still the shape this version expects.
 *
 * Structured clone will hand back whatever an older version of the app wrote, and a restore is a
 * write path — the coordinates in here end up in files. So the shape is checked rather than
 * trusted, and anything unrecognised is treated as no backup at all.
 */
function isBackup(value: unknown): value is SessionBackup {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<SessionBackup>;

  if (typeof candidate.savedAtMs !== 'number') return false;
  if (typeof candidate.folderName !== 'string') return false;
  if (!Array.isArray(candidate.photoNames)) return false;
  if (typeof candidate.clock !== 'object' || candidate.clock === null) return false;
  if (typeof candidate.clock.timeZone !== 'string') return false;
  if (typeof candidate.clock.offsetSeconds !== 'number') return false;
  if (typeof candidate.edits !== 'object' || candidate.edits === null) return false;

  for (const staged of Object.values(candidate.edits)) {
    if (staged === null) continue;
    if (typeof staged !== 'object') return false;
    if (typeof staged.latitude !== 'number' || typeof staged.longitude !== 'number') return false;
  }

  return true;
}

/**
 * How much of a backup applies to the photographs now open.
 *
 * A backup is offered against whatever folder is open, which may not be the folder it came from —
 * so the answer is per photograph rather than all-or-nothing. Restoring the ones that match is
 * more useful than refusing because two are missing, and saying how many matched is what lets
 * somebody notice they have opened the wrong folder.
 */
export function applicableEdits(
  backup: SessionBackup,
  session: Session,
): { readonly edits: Map<string, Coordinates | null>; readonly missing: number } {
  const present = new Set(session.photos.map((entry) => entry.ref.name));
  const edits = new Map<string, Coordinates | null>();
  let missing = 0;

  for (const [name, staged] of Object.entries(backup.edits)) {
    if (present.has(name)) edits.set(name, staged);
    else missing += 1;
  }

  return { edits, missing };
}
