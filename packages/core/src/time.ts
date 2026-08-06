/**
 * Camera-clock and timezone arithmetic.
 *
 * The A6400 records `DateTimeOriginal` as a *naive* wall-clock reading with no
 * timezone and no indication of how far the camera's clock has drifted. To
 * write a correct `GPSDateStamp`/`GPSTimeStamp` (which are UTC) — and, later,
 * to match photos against a GPX track — that naive reading has to be resolved
 * to a real instant. Two corrections are needed, in this order:
 *
 *   1. the offset of the camera's clock from true time, and
 *   2. the timezone the clock was nominally set to.
 *
 * Zone conversion goes through `Intl.DateTimeFormat` rather than a date
 * library. It is present in Node and in every browser and webview we target,
 * carries the platform's own IANA database, and keeps the core dependency-free.
 */

/** A wall-clock reading with no timezone attached — exactly what EXIF gives us. */
export interface NaiveDateTime {
  year: number;
  /** 1-12. Not the zero-based month of the `Date` constructor. */
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
}

export interface CameraClock {
  /** IANA zone the camera's clock was set to, e.g. `Europe/London`. */
  timeZone: string;
  /**
   * Seconds the camera's clock reads *ahead* of true time. A camera running
   * 45 seconds fast has an offset of +45, and 45 seconds is subtracted when
   * resolving its timestamps.
   */
  offsetSeconds: number;
}

const MS_PER_SECOND = 1000;

/** `Intl.DateTimeFormat` construction is slow enough to be worth caching. */
const formatterCache = new Map<string, Intl.DateTimeFormat>();

function zoneFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatterCache.set(timeZone, formatter);
  }
  return formatter;
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

/**
 * Milliseconds a zone is ahead of UTC at a given instant.
 *
 * Derived by asking the platform what the wall clock reads in that zone at
 * that instant, then treating the answer as if it were UTC. The difference is
 * the offset. This is the standard trick for getting a zone offset out of
 * `Intl` without a tz database of our own.
 */
export function zoneOffsetMs(instantMs: number, timeZone: string): number {
  const parts = zoneFormatter(timeZone).formatToParts(new Date(instantMs));

  const field = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((p) => p.type === type);
    if (!part) throw new Error(`Intl did not return a '${type}' part for zone ${timeZone}`);
    return Number(part.value);
  };

  // Some engines render midnight as hour 24 under hour12:false.
  const hour = field('hour') % 24;

  const asIfUtc = Date.UTC(
    field('year'),
    field('month') - 1,
    field('day'),
    hour,
    field('minute'),
    field('second'),
  );

  // formatToParts drops sub-second precision, so compare against a whole second.
  return asIfUtc - Math.floor(instantMs / MS_PER_SECOND) * MS_PER_SECOND;
}

/**
 * Resolve a naive wall-clock reading in a given zone to a real instant.
 *
 * The offset depends on the instant, and the instant is what we are solving
 * for, so this iterates: guess, measure the offset at the guess, correct, then
 * measure once more to settle cases where the correction crossed a DST
 * boundary. A second pass is sufficient for every real-world transition.
 *
 * During the spring-forward gap the requested wall clock does not exist, and
 * during the autumn overlap it happens twice. This resolves both to a single
 * instant without complaint — acceptable here, because a one-hour error in a
 * manually placed photo is visible and correctable, and the alternative is
 * forcing the user to answer a question they cannot usefully answer.
 */
export function naiveToInstant(naive: NaiveDateTime, timeZone: string): Date {
  const asIfUtc = Date.UTC(
    naive.year,
    naive.month - 1,
    naive.day,
    naive.hour,
    naive.minute,
    naive.second,
    naive.millisecond,
  );

  let instant = asIfUtc - zoneOffsetMs(asIfUtc, timeZone);
  instant = asIfUtc - zoneOffsetMs(instant, timeZone);

  return new Date(instant);
}

/**
 * The true instant a photo was taken, correcting for clock drift and zone.
 *
 * Drift is removed from the wall-clock reading first, because the offset
 * describes an error in the clock's own face — not in the resulting instant.
 */
export function photoInstant(naive: NaiveDateTime, clock: CameraClock): Date {
  const uncorrected = naiveToInstant(naive, clock.timeZone);
  return new Date(uncorrected.getTime() - clock.offsetSeconds * MS_PER_SECOND);
}

/**
 * Work out the camera's clock offset from a reference photo.
 *
 * The user photographs a trusted clock — a GPS display, a phone — and tells us
 * the true instant it showed. The difference against the camera's own
 * timestamp for that frame is the drift, and it applies to the whole session.
 */
export function deriveClockOffsetSeconds(
  referenceNaive: NaiveDateTime,
  trueInstant: Date,
  timeZone: string,
): number {
  const cameraInstant = naiveToInstant(referenceNaive, timeZone);
  return Math.round((cameraInstant.getTime() - trueInstant.getTime()) / MS_PER_SECOND);
}

/**
 * Parse EXIF's `YYYY:MM:DD HH:MM:SS` datetime, with optional sub-seconds.
 *
 * Returns null rather than throwing: cameras do write malformed or all-zero
 * timestamps, and a photo with an unreadable date should be flagged in the UI,
 * not allowed to abort a batch.
 */
export function parseExifDateTime(value: string): NaiveDateTime | null {
  const match = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?/.exec(value.trim());
  if (!match) return null;

  const [, year, month, day, hour, minute, second, fraction] = match;

  const naive: NaiveDateTime = {
    year: Number(year),
    month: Number(month),
    day: Number(day),
    hour: Number(hour),
    minute: Number(minute),
    second: Number(second),
    // `.5` means 500ms, not 5ms — pad before truncating to milliseconds.
    millisecond: fraction ? Number(fraction.padEnd(3, '0').slice(0, 3)) : 0,
  };

  // Cameras with a dead backup battery emit 0000:00:00 00:00:00.
  if (naive.month < 1 || naive.month > 12 || naive.day < 1 || naive.day > 31) return null;
  if (naive.hour > 23 || naive.minute > 59 || naive.second > 60) return null;

  return naive;
}

/** EXIF `GPSDateStamp`, always UTC: `2024:05:17`. */
export function formatGpsDateStamp(instant: Date): string {
  return [
    instant.getUTCFullYear(),
    pad2(instant.getUTCMonth() + 1),
    pad2(instant.getUTCDate()),
  ].join(':');
}

/** EXIF `GPSTimeStamp`, always UTC: `14:32:08`. */
export function formatGpsTimeStamp(instant: Date): string {
  return [
    pad2(instant.getUTCHours()),
    pad2(instant.getUTCMinutes()),
    pad2(instant.getUTCSeconds()),
  ].join(':');
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}
