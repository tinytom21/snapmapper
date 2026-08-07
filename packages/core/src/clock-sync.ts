/**
 * Working out how far the camera's clock is from the truth.
 *
 * The camera writes a naive wall-clock reading with no timezone and no idea how far it
 * has drifted. Two corrections are needed — the drift, and the zone — and this module is
 * about establishing the first one from evidence rather than guesswork.
 *
 * ## Why a *reference* is stored, and not just a number of seconds
 *
 * `deriveClockOffsetSeconds` resolves the camera's reading *in a given zone* before
 * comparing it to the truth, so **a derived offset is only valid for the zone it was
 * derived in.** Derive "43 s fast" under `Europe/London`, switch to `America/New_York`,
 * and the offset is now wrong by five hours on top of the zone change itself.
 *
 * Keeping the reference — the camera's reading and the true instant — means the offset can
 * be *re-derived* whenever the zone changes, so correcting a timezone after a sync stays
 * correct. Storing only the resulting seconds would silently rot.
 *
 * ## Establishing the true instant
 *
 * Two methods, one shared calculation:
 *
 *   - **`qr`** — the application displays a QR code carrying the current instant, the user
 *     photographs the screen, and the code is read back out of the photograph. No
 *     transcription, and no way to misread it silently: a QR either satisfies its own
 *     error correction or fails to decode, so a corrupted read produces nothing rather
 *     than a plausible wrong answer. That matters when the result shifts the timestamp of
 *     every photo in the session.
 *   - **`manual`** — the user photographed some other trusted clock and types in the time
 *     it showed. The only option for a shoot that is already over.
 */

import { deriveClockOffsetSeconds, type CameraClock, type NaiveDateTime } from './time.ts';

export type SyncMethod = 'qr' | 'manual';

/**
 * Evidence of what the camera's clock read at a known true instant.
 *
 * Deliberately zone-free. The zone is applied when an offset is derived, which is what
 * lets the zone change afterwards without invalidating the measurement.
 */
export interface ClockSync {
  /** The camera's own `DateTimeOriginal` for the reference frame. */
  readonly cameraReading: NaiveDateTime;
  /** The instant that frame was actually taken. */
  readonly trueInstant: Date;
  /** Which photo established this, for display and for undoing. */
  readonly sourcePhoto: string;
  readonly method: SyncMethod;
}

/**
 * The camera clock implied by a reference, in a given zone.
 *
 * Call this again with a new zone rather than adjusting the offset by hand.
 */
export function clockFromSync(sync: ClockSync, timeZone: string): CameraClock {
  return {
    timeZone,
    offsetSeconds: deriveClockOffsetSeconds(sync.cameraReading, sync.trueInstant, timeZone),
  };
}

/**
 * How far off the camera is, in seconds, positive when it reads ahead of true time.
 *
 * Exposed separately so the interface can describe the measurement without pretending the
 * number means anything outside its zone.
 */
export function syncOffsetSeconds(sync: ClockSync, timeZone: string): number {
  return deriveClockOffsetSeconds(sync.cameraReading, sync.trueInstant, timeZone);
}

// --- The QR payload ----------------------------------------------------------

/**
 * Format marker. Versioned so a later change is detectable rather than misread, and
 * distinctive so an unrelated QR code that happens to be in a photograph is rejected
 * instead of being treated as a time.
 */
export const SYNC_QR_PREFIX = 'PGT1|';

/** What the application renders on screen, refreshed several times a second. */
export function encodeSyncPayload(instant: Date): string {
  if (!Number.isFinite(instant.getTime())) {
    throw new RangeError('cannot encode an invalid instant');
  }
  return `${SYNC_QR_PREFIX}${instant.toISOString()}`;
}

/**
 * Read a payload back out of a decoded QR code.
 *
 * Returns `undefined` for anything unrecognised rather than throwing: a photograph may
 * contain any barcode at all, and the caller's job is to say "that is not the clock",
 * not to crash.
 */
export function parseSyncPayload(text: string): Date | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith(SYNC_QR_PREFIX)) return undefined;

  const isoText = trimmed.slice(SYNC_QR_PREFIX.length);

  // Demand a full UTC instant. Accepting a looser format risks reading a local time as
  // UTC, which is a silent multi-hour error of exactly the kind this module exists to
  // prevent.
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(isoText)) return undefined;

  const parsed = new Date(isoText);
  if (!Number.isFinite(parsed.getTime())) return undefined;

  return parsed;
}

/**
 * How precise a QR sync can be.
 *
 * The code is redrawn on this interval, so the photograph captures whichever code was on
 * screen at the moment of exposure — placing the true instant within one interval of the
 * value decoded. Fast enough to be well under the one-second resolution of the camera's
 * own timestamp, so the camera's clock, not this, is the limit on accuracy.
 */
export const SYNC_QR_REFRESH_MS = 250;

/** Stated so the interface can be honest about it instead of implying exactness. */
export function syncUncertaintySeconds(method: SyncMethod): number {
  // Manual entry is only as good as the second the user reads off a clock face.
  return method === 'qr' ? SYNC_QR_REFRESH_MS / 1000 : 1;
}
