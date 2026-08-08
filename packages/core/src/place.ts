/**
 * Place names for a set of coordinates, and the tags that carry them.
 *
 * Coordinates make a photograph *mappable*. Place names make it **findable** — "show me everything
 * from Toulouse" is a question Lightroom, digiKam and Immich can all answer from these fields and
 * none of them can answer from a latitude. That is the whole value, and it is why GeoSetter has had
 * this since the beginning.
 *
 * ## Nothing here talks to the network
 *
 * `packages/core` has zero platform dependencies by rule, and a geocoder is the most
 * platform-shaped thing in the app: it needs an HTTP client, a rate limiter and a cache. So this
 * file holds the *shape* of an answer, the mapping to tags, and the arithmetic that decides how
 * many questions have to be asked at all. `nominatim.ts` in the UI does the asking.
 *
 * That split is not ceremony. Grouping fifty photographs into three requests is the part with the
 * interesting edge cases, and it is testable here without a server.
 */

import type { Coordinates } from './gps.ts';
import type { TagSet } from './exif-tags.ts';

/**
 * A named place, as much of it as the service knew.
 *
 * Every field is optional because coverage is wildly uneven: a city centre resolves to all five, a
 * hilltop in Wales to a country and possibly a county. Writing an empty string for the ones that
 * came back blank would be worse than leaving them out — it would overwrite whatever was there.
 */
export interface Place {
  /** A named spot: a park, a building, a hamlet. IPTC calls this Sub-location. */
  readonly location?: string;
  readonly city?: string;
  /** County, region, state — whatever the country calls its first-level division. */
  readonly state?: string;
  readonly country?: string;
  /** ISO 3166-1 alpha-2, upper case. Some readers index on this rather than the name. */
  readonly countryCode?: string;
}

/** True when the service gave back nothing worth writing. */
export function isEmptyPlace(place: Place): boolean {
  return !place.location && !place.city && !place.state && !place.country && !place.countryCode;
}

/**
 * One line, for a list or a button.
 *
 * Most specific first and duplicates dropped — Nominatim frequently returns the same string as
 * both city and state for a city-state, and "Singapore, Singapore, Singapore" reads as a bug.
 */
export function describePlace(place: Place): string {
  const parts = [place.location, place.city, place.state, place.country]
    .filter((part): part is string => Boolean(part));
  return [...new Set(parts)].join(', ');
}

/**
 * The tags a place is written into.
 *
 * **Both IPTC and XMP**, for the same reason both EXIF and XMP carry the coordinates: readers
 * disagree about which to believe, and a file where they differ is a file that shows one thing in
 * Explorer and another in Lightroom. GeoSetter writes both, and matching it is the point.
 *
 * Fields the service did not fill are **omitted, never blanked**. A photograph that already had a
 * city from another tool must not lose it because this lookup happened to return only a country.
 */
export function buildPlaceTags(place: Place): TagSet {
  const tags: TagSet = {};

  const put = (names: readonly string[], value: string | undefined) => {
    if (!value) return;
    for (const name of names) tags[name] = value;
  };

  put(['IPTC:Sub-location', 'XMP:Location'], place.location);
  put(['IPTC:City', 'XMP:City'], place.city);
  // IPTC's field is spelled with the hyphen; XMP's is not. Getting either wrong writes a tag
  // nothing reads, which looks exactly like the feature not working.
  put(['IPTC:Province-State', 'XMP:State'], place.state);
  put(['IPTC:Country-PrimaryLocationName', 'XMP:Country'], place.country);

  /*
   * The code goes to XMP **only**, and that is a specification detail rather than an omission.
   *
   * IPTC IIM's `Country-PrimaryLocationCode` is a fixed **three**-octet field — ISO 3166-1
   * *alpha-3*. Geocoders return alpha-2, and writing `FR` there makes ExifTool pad it to `FR ` and
   * warn `String too short`. Found by writing to a real A6400 file, where the write was refused
   * outright: a two-letter code in a three-letter field is not a cosmetic mismatch, it is a value
   * that means a different country or none.
   *
   * Converting would need the whole alpha-2 to alpha-3 table for one legacy field that XMP already
   * carries correctly, so `XMP:CountryCode` — which *is* alpha-2 by its own specification — is the
   * one written.
   */
  put(['XMP:CountryCode'], place.countryCode);

  return tags;
}

/** Every tag a place occupies, for clearing one. */
export function buildClearPlaceTags(): TagSet {
  return Object.fromEntries(
    Object.keys(buildPlaceTags({
      location: 'x', city: 'x', state: 'x', country: 'x', countryCode: 'x',
    })).map((name) => [name, '']),
  );
}

/**
 * How precisely coordinates are rounded before being treated as "the same place".
 *
 * Four decimal places is about 11 metres at the equator. Two photographs eleven metres apart are
 * in the same street, the same park and the same town, so asking twice would be asking the same
 * question — and the service whose free tier this runs on asks, reasonably, that it not be.
 *
 * Deliberately not coarser. A tenth of a degree would be eleven kilometres, which crosses a city
 * boundary and would put a photograph in the wrong town's name.
 */
export const PLACE_PRECISION = 4;

/** The cache key for a position: the same key means the same answer. */
export function placeKey(coordinates: Coordinates): string {
  return `${coordinates.latitude.toFixed(PLACE_PRECISION)},`
    + `${coordinates.longitude.toFixed(PLACE_PRECISION)}`;
}

export interface PlaceGroup {
  readonly key: string;
  /** A position standing for the whole group — the first one, not an average. */
  readonly coordinates: Coordinates;
  readonly names: readonly string[];
}

/**
 * Group photographs by where they are, so a shoot costs a handful of lookups rather than one each.
 *
 * This is the difference between a feature that works and one that is rude: fifty photographs
 * walked around a park share three or four keys, so three or four requests answer all of them.
 * A per-photograph loop would send fifty, at one a second, for an answer it already had.
 *
 * The representative position is the **first** in each group, not the average of it. An average is
 * a position nobody was at, and rounding has already established that everything in the group is
 * within metres of everything else — so picking a real one costs nothing and means the coordinates
 * sent to the service are coordinates that actually occurred.
 */
export function groupByPlace(
  located: readonly { readonly name: string; readonly coordinates: Coordinates }[],
): readonly PlaceGroup[] {
  const groups = new Map<string, { coordinates: Coordinates; names: string[] }>();

  for (const { name, coordinates } of located) {
    const key = placeKey(coordinates);
    const existing = groups.get(key);
    if (existing) existing.names.push(name);
    else groups.set(key, { coordinates, names: [name] });
  }

  return [...groups].map(([key, group]) => ({ key, ...group }));
}
