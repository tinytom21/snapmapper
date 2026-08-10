/**
 * Conversion between decimal degrees and EXIF's GPS representation.
 *
 * EXIF stores latitude and longitude as three *unsigned* rationals — degrees,
 * minutes, seconds — with the hemisphere held separately in a reference tag.
 * The numeric value carries no sign, so every conversion out of decimal
 * degrees has to split the sign off into the ref, and every conversion back in
 * has to reapply it. Getting that wrong puts photos in the wrong hemisphere,
 * which is the classic geotagging bug.
 */

export type LatitudeRef = 'N' | 'S';
export type LongitudeRef = 'E' | 'W';

/** 0 = at or above sea level, 1 = below. Matches the EXIF GPSAltitudeRef enum. */
export type AltitudeRef = 0 | 1;

export interface Coordinates {
  /** Decimal degrees, positive north. Range [-90, 90]. */
  latitude: number;
  /** Decimal degrees, positive east. Range [-180, 180]. */
  longitude: number;
  /** Metres relative to the WGS-84 geoid. Negative is below sea level. */
  altitude?: number;
}

export interface Dms {
  degrees: number;
  minutes: number;
  /** May be fractional. */
  seconds: number;
}

/**
 * Decimal places kept when emitting coordinates. 1e-7 degrees is ~11mm at the
 * equator — far finer than any consumer GPS fix, and well within the precision
 * a double can represent for values of this magnitude.
 */
const COORD_DECIMALS = 7;

/** Fractional-second precision in DMS output. 1e-4 arcseconds is ~3mm. */
const SECONDS_DECIMALS = 4;

export function isValidLatitude(value: number): boolean {
  return Number.isFinite(value) && value >= -90 && value <= 90;
}

export function isValidLongitude(value: number): boolean {
  return Number.isFinite(value) && value >= -180 && value <= 180;
}

export function assertValidCoordinates(coords: Coordinates): void {
  if (!isValidLatitude(coords.latitude)) {
    throw new RangeError(`Latitude ${coords.latitude} is outside [-90, 90]`);
  }
  if (!isValidLongitude(coords.longitude)) {
    throw new RangeError(`Longitude ${coords.longitude} is outside [-180, 180]`);
  }
  if (coords.altitude !== undefined && !Number.isFinite(coords.altitude)) {
    throw new RangeError(`Altitude ${coords.altitude} is not a finite number`);
  }
}

export function latitudeRef(latitude: number): LatitudeRef {
  // Zero and -0 both resolve to 'N'. The equator has no meaningful hemisphere,
  // and every tool we care about reads 'N' there without complaint.
  return latitude < 0 ? 'S' : 'N';
}

export function longitudeRef(longitude: number): LongitudeRef {
  return longitude < 0 ? 'W' : 'E';
}

export function altitudeRef(altitude: number): AltitudeRef {
  return altitude < 0 ? 1 : 0;
}

/**
 * Split an absolute decimal degree value into degrees/minutes/seconds.
 *
 * Rounding is applied to seconds before the carry is resolved, so a value that
 * rounds to exactly 60 seconds rolls up into the next minute rather than being
 * emitted as an invalid `x deg y' 60"`.
 */
export function toDms(decimalDegrees: number): Dms {
  const absolute = Math.abs(decimalDegrees);

  let degrees = Math.floor(absolute);
  const minutesFloat = (absolute - degrees) * 60;
  let minutes = Math.floor(minutesFloat);
  let seconds = roundTo((minutesFloat - minutes) * 60, SECONDS_DECIMALS);

  if (seconds >= 60) {
    seconds -= 60;
    minutes += 1;
  }
  if (minutes >= 60) {
    minutes -= 60;
    degrees += 1;
  }

  return { degrees, minutes, seconds };
}

/** Reassemble degrees/minutes/seconds plus a hemisphere into decimal degrees. */
export function fromDms(dms: Dms, ref: LatitudeRef | LongitudeRef): number {
  const magnitude = dms.degrees + dms.minutes / 60 + dms.seconds / 3600;
  const negative = ref === 'S' || ref === 'W';
  return roundTo(negative ? -magnitude : magnitude, COORD_DECIMALS);
}

/**
 * Signed decimal degrees as a string, for ExifTool's numeric (`-n`) input mode.
 *
 * ExifTool accepts a signed decimal here and derives the ref itself, but we
 * write the ref tags explicitly anyway — relying on inference means a value of
 * exactly 0 silently picks a hemisphere for us.
 */
export function formatDecimal(decimalDegrees: number): string {
  return trimZeros(roundTo(decimalDegrees, COORD_DECIMALS).toFixed(COORD_DECIMALS));
}

/**
 * DMS in the shape ExifTool parses in its default (non-numeric) mode:
 * `51 deg 28' 40.0800"`. Used when raw `-n` cannot be passed through.
 */
export function formatDms(decimalDegrees: number): string {
  const { degrees, minutes, seconds } = toDms(decimalDegrees);
  const secondsText = trimZeros(seconds.toFixed(SECONDS_DECIMALS));
  return `${degrees} deg ${minutes}' ${secondsText}"`;
}

/** Mean Earth radius, metres. WGS-84's semi-major axis is 6378137; this is the IUGG mean. */
const EARTH_RADIUS_METRES = 6371008.8;

/**
 * Great-circle distance between two positions, in metres.
 *
 * Haversine rather than the spherical law of cosines, which loses precision to floating point at
 * short distances — and short distances are the whole use here: telling "the same fix, rounded
 * differently" from "somewhere else entirely" when two records disagree about one photograph.
 *
 * A sphere, not an ellipsoid. The error against Vincenty is a few tenths of a percent, which for
 * "are these the same place, and if not how far apart" is far below the question's own resolution.
 * Altitude is ignored deliberately: two readings of the same spot routinely differ by tens of
 * metres vertically, and folding that in would report a horizontal disagreement that is not there.
 */
export function distanceMetres(a: Coordinates, b: Coordinates): number {
  const toRadians = Math.PI / 180;
  const lat1 = a.latitude * toRadians;
  const lat2 = b.latitude * toRadians;
  const deltaLat = (b.latitude - a.latitude) * toRadians;
  const deltaLon = (b.longitude - a.longitude) * toRadians;

  const h = Math.sin(deltaLat / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLon / 2) ** 2;

  return 2 * EARTH_RADIUS_METRES * Math.asin(Math.min(1, Math.sqrt(h)));
}

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/** `51.4778000` -> `51.4778`, `51.0000000` -> `51`. Keeps output readable. */
function trimZeros(fixed: string): string {
  return fixed.includes('.') ? fixed.replace(/\.?0+$/, '') : fixed;
}
