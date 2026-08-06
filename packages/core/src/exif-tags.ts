/**
 * Builds the tag set written for a geotagged photo.
 *
 * Deliberately mirrors what GeoSetter emits, so files tagged by this tool and
 * files tagged by GeoSetter stay consistent in a library that contains both.
 *
 * Both EXIF and XMP are written. EXIF alone is enough for Windows Explorer and
 * Google Photos, but Lightroom and Capture One read XMP and will disagree with
 * Explorer if only one is present. Writing both is what GeoSetter does.
 */

import {
  altitudeRef,
  assertValidCoordinates,
  formatDecimal,
  latitudeRef,
  longitudeRef,
  type Coordinates,
} from './gps.ts';
import { formatGpsDateStamp, formatGpsTimeStamp } from './time.ts';

/** Tag name to string value, as ExifTool's write API accepts. */
export type TagSet = Record<string, string>;

export interface GeotagOptions {
  coordinates: Coordinates;
  /**
   * True instant the photo was taken, used for `GPSDateStamp`/`GPSTimeStamp`.
   * Omitted when the camera's timestamp can't be trusted or parsed — better to
   * write no GPS time than a wrong one.
   */
  instant?: Date;
}

/**
 * Values are formatted as signed decimal degrees, which requires ExifTool's
 * numeric mode (`-n`). The refs are still written explicitly rather than left
 * to inference — at exactly 0 degrees the sign carries no hemisphere, and we
 * would rather choose than be surprised.
 */
export function buildGeotagTags(options: GeotagOptions): TagSet {
  const { coordinates, instant } = options;
  assertValidCoordinates(coordinates);

  const tags: TagSet = {
    'EXIF:GPSLatitude': formatDecimal(Math.abs(coordinates.latitude)),
    'EXIF:GPSLatitudeRef': latitudeRef(coordinates.latitude),
    'EXIF:GPSLongitude': formatDecimal(Math.abs(coordinates.longitude)),
    'EXIF:GPSLongitudeRef': longitudeRef(coordinates.longitude),
    'EXIF:GPSMapDatum': 'WGS-84',

    // XMP stores signed decimals, so no separate ref tags here.
    'XMP:GPSLatitude': formatDecimal(coordinates.latitude),
    'XMP:GPSLongitude': formatDecimal(coordinates.longitude),
    // GeoSetter writes the datum into XMP as well as EXIF. Verified against two
    // of its own output files during the spike, and matching it is the point.
    'XMP:GPSMapDatum': 'WGS-84',
  };

  if (coordinates.altitude !== undefined) {
    tags['EXIF:GPSAltitude'] = formatDecimal(Math.abs(coordinates.altitude));
    tags['EXIF:GPSAltitudeRef'] = String(altitudeRef(coordinates.altitude));
    tags['XMP:GPSAltitude'] = formatDecimal(coordinates.altitude);
  }

  if (instant) {
    // Both are UTC by specification, regardless of the camera's timezone.
    tags['EXIF:GPSDateStamp'] = formatGpsDateStamp(instant);
    tags['EXIF:GPSTimeStamp'] = formatGpsTimeStamp(instant);
  }

  return tags;
}

/**
 * Tags cleared when a photo's location is removed.
 *
 * An empty string is ExifTool's "delete this tag" value. `GPSMapDatum` and the
 * refs go too — leaving a stray ref behind on an otherwise untagged photo
 * confuses some readers into showing a location at 0,0.
 */
export function buildClearLocationTags(): TagSet {
  const names = [
    'EXIF:GPSLatitude',
    'EXIF:GPSLatitudeRef',
    'EXIF:GPSLongitude',
    'EXIF:GPSLongitudeRef',
    'EXIF:GPSAltitude',
    'EXIF:GPSAltitudeRef',
    'EXIF:GPSMapDatum',
    'EXIF:GPSDateStamp',
    'EXIF:GPSTimeStamp',
    'XMP:GPSLatitude',
    'XMP:GPSLongitude',
    'XMP:GPSAltitude',
    'XMP:GPSMapDatum',
  ];

  return Object.fromEntries(names.map((name) => [name, '']));
}

/**
 * Arguments that accompany every write.
 *
 * `-n` puts ExifTool in numeric mode, so the signed decimal degrees above are
 * read as numbers instead of being parsed as DMS strings. It is the only one
 * needed.
 *
 * Spike Q2 asked whether `-P` and `-overwrite_original` could be passed through
 * the WASM wrapper, and the answer is that they can be passed and they *fail*:
 * `-overwrite_original` errors with "Error erasing original", and `-P` warns with
 * "Error setting file time". Both are correct failures. The WASM build has no
 * real filesystem — it works on a copy inside a virtual FS and returns the bytes
 * — so there is no original to erase and no file time to preserve.
 *
 * Neither is a loss, but each obligation moves to the host:
 *   - Preserving the modification date is `FileStore.writeAtomic`'s job, applied
 *     after the replace.
 *   - There is no `_original` backup to suppress, so if we want one, we make it.
 *
 * Note also that the wrapper reports `success: false` for a bare warning, so the
 * write path must inspect the error text rather than trust the boolean.
 */
export const REQUIRED_WRITE_ARGS = ['-n'] as const;
