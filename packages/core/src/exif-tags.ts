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
  ];

  return Object.fromEntries(names.map((name) => [name, '']));
}

/**
 * Arguments that must accompany every write.
 *
 * `-P` preserves the file modification date: geotagging is not an edit to the
 * photograph, and tools that sort by file date should not see one.
 * `-overwrite_original` suppresses ExifTool's `_original` backup copy — the
 * application makes its own atomic-write guarantees, and stray `_original`
 * files on a camera card are a nuisance.
 *
 * Spike Q2 establishes whether these can actually be passed through the WASM
 * wrapper's write path. If they cannot, that is a finding, not a detail.
 */
export const REQUIRED_WRITE_ARGS = ['-n', '-P', '-overwrite_original'] as const;
