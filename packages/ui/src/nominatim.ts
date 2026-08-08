/**
 * Turning coordinates into place names, using OpenStreetMap's Nominatim.
 *
 * Chosen because it needs no key, no account and no billing relationship, which is the same reason
 * OpenFreeMap serves the tiles. The cost of that is a usage policy, and this file exists as much to
 * honour the policy as to make the requests.
 *
 * ## What the policy asks, and what is done about it
 *
 * - **No more than one request a second.** `RATE_LIMIT_MS` and a promise chain that serialises
 *   every call, so concurrency cannot smuggle a burst past it.
 * - **No bulk geocoding.** Photographs are grouped by rounded position *before* anything is sent —
 *   see `groupByPlace` — so a fifty-photo walk around a park is three or four requests, not fifty.
 *   The cache below then means the second look at the same shoot sends none at all.
 * - **Identify yourself.** A browser cannot set `User-Agent`, so the `Referer` the browser sends is
 *   the identification, which is what the policy expects of a web app.
 *
 * The rate limit makes this visibly slow for a spread-out shoot, and that is the honest cost of a
 * free service rather than something to engineer around. The UI shows progress and can be stopped.
 *
 * ## It is the only feature that needs the network
 *
 * Everything else works offline. A failure here has to be ordinary and legible rather than an
 * exception, because being on a train is not an error condition.
 */

import { placeKey, type Coordinates, type Place } from '@snapmapper/core';

/** One request a second, as the policy asks. Not negotiable, and not a tuning parameter. */
const RATE_LIMIT_MS = 1100;

const ENDPOINT = 'https://nominatim.openstreetmap.org/reverse';

/**
 * Zoom 14 is roughly "suburb", which is the level that fills city and county reliably.
 *
 * Higher asks for a building and often returns a house number nobody wants in a City field; lower
 * skips the town entirely. This is the address *detail*, not the map zoom.
 */
const ZOOM = 14;

const CACHE_KEY = 'snapmapper.places.v1';

/** A cached answer, or the fact that a spot had none. Both are worth not asking twice. */
type CachedPlace = Place | null;

function loadCache(): Record<string, CachedPlace> {
  try {
    const stored = localStorage.getItem(CACHE_KEY);
    const parsed: unknown = stored ? JSON.parse(stored) : {};
    return typeof parsed === 'object' && parsed !== null
      ? parsed as Record<string, CachedPlace>
      : {};
  } catch {
    return {};
  }
}

function saveCache(cache: Record<string, CachedPlace>): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
  } catch {
    // Quota, or private browsing. The answers were still correct; only the next look costs more.
  }
}

/**
 * Serialises every request across the whole app, at one a second.
 *
 * A module-level chain rather than a per-call sleep, because the thing being limited is the *rate
 * to the service*, not the rate within one loop. Two geocodes started from different parts of the
 * interface would otherwise each politely wait a second and then fire together.
 */
let queue: Promise<unknown> = Promise.resolve();

function serialise<T>(work: () => Promise<T>): Promise<T> {
  const next = queue.then(work, work);
  // The chain must survive a rejection, or one failed request stops every later one for good.
  queue = next.then(
    () => new Promise((resolve) => setTimeout(resolve, RATE_LIMIT_MS)),
    () => new Promise((resolve) => setTimeout(resolve, RATE_LIMIT_MS)),
  );
  return next;
}

/** What Nominatim returns, of the parts worth reading. Everything is optional in practice. */
interface NominatimAddress {
  readonly city?: string;
  readonly town?: string;
  readonly village?: string;
  readonly hamlet?: string;
  readonly municipality?: string;
  readonly suburb?: string;
  readonly neighbourhood?: string;
  readonly state?: string;
  readonly county?: string;
  readonly region?: string;
  readonly country?: string;
  readonly country_code?: string;
}

/**
 * Nominatim's address into a `Place`.
 *
 * The fallback chains are the substance here. OSM has no single "city" concept — a place is tagged
 * `city`, `town`, `village`, `hamlet` or `municipality` depending on how big it is and who mapped
 * it, and a reader that only looked at `city` would leave the field empty for most of the
 * countryside. Same for the first-level division, which is `state` in some countries and `county`
 * or `region` in others.
 */
export function placeFromAddress(address: NominatimAddress): Place {
  const city = address.city ?? address.town ?? address.village
    ?? address.hamlet ?? address.municipality;
  const state = address.state ?? address.county ?? address.region;
  // The neighbourhood only when it is not already the city — in a village they are often the same
  // string, and "Grasmere, Grasmere" reads as a bug.
  const locality = address.suburb ?? address.neighbourhood;

  return {
    ...(locality && locality !== city ? { location: locality } : {}),
    ...(city ? { city } : {}),
    ...(state && state !== city ? { state } : {}),
    ...(address.country ? { country: address.country } : {}),
    // ISO 3166-1 alpha-2. Nominatim gives it lower case; every reader expects upper.
    ...(address.country_code ? { countryCode: address.country_code.toUpperCase() } : {}),
  };
}

export interface GeocodeProgress {
  readonly done: number;
  readonly total: number;
  /** How many of those came from the cache rather than the network. */
  readonly fromCache: number;
}

export interface GeocodeOptions {
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: GeocodeProgress) => void;
  /** Swappable for tests. Defaults to the real thing. */
  readonly lookup?: (coordinates: Coordinates, signal?: AbortSignal) => Promise<Place | null>;
}

/**
 * Look up one position, through the rate limiter.
 *
 * Returns `null` for "the service had nothing here", which is a real answer over an ocean, and
 * throws only for a genuine failure — no network, a refusal, a malformed response. The two must
 * stay distinguishable: one is worth caching and the other is worth retrying.
 */
async function lookupPlace(
  coordinates: Coordinates,
  signal?: AbortSignal,
): Promise<Place | null> {
  return serialise(async () => {
    const url = `${ENDPOINT}?format=jsonv2&zoom=${ZOOM}&addressdetails=1`
      + `&lat=${encodeURIComponent(coordinates.latitude)}`
      + `&lon=${encodeURIComponent(coordinates.longitude)}`;

    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
      ...(signal ? { signal } : {}),
    });

    if (!response.ok) {
      throw new Error(`the place-name service answered ${response.status}`);
    }

    const body: unknown = await response.json();
    if (typeof body !== 'object' || body === null) return null;

    const address = (body as { address?: NominatimAddress }).address;
    return address ? placeFromAddress(address) : null;
  });
}

/**
 * Name every position in a set, asking as few times as possible.
 *
 * Cache first, then the network at one request a second. Progress is reported per group so a slow
 * run is visibly working rather than apparently hung, and an `AbortSignal` stops it — a shoot
 * spread over twenty places is twenty seconds, and somebody who changes their mind should not have
 * to wait it out.
 *
 * Failures are collected rather than thrown. Half the photographs named is a better outcome than
 * none, and the caller reports what did not resolve.
 */
export async function geocodeGroups(
  groups: readonly { readonly key: string; readonly coordinates: Coordinates }[],
  options: GeocodeOptions = {},
): Promise<{ readonly places: Map<string, Place>; readonly failed: number }> {
  const lookup = options.lookup ?? lookupPlace;
  const cache = loadCache();
  const places = new Map<string, Place>();

  let done = 0;
  let fromCache = 0;
  let failed = 0;
  let dirty = false;

  for (const group of groups) {
    if (options.signal?.aborted) break;

    const cached = cache[group.key];
    if (cached !== undefined) {
      if (cached) places.set(group.key, cached);
      fromCache += 1;
    } else {
      try {
        const found = await lookup(group.coordinates, options.signal);
        // A miss is cached too. Somewhere with no address does not acquire one by being asked
        // again, and re-asking would spend the rate limit on a known answer.
        cache[group.key] = found;
        dirty = true;
        if (found) places.set(group.key, found);
      } catch {
        failed += 1;
      }
    }

    done += 1;
    options.onProgress?.({ done, total: groups.length, fromCache });
  }

  if (dirty) saveCache(cache);
  return { places, failed };
}

/** Forget every cached answer. For when a lookup returned something plainly wrong. */
export function clearPlaceCache(): void {
  try {
    localStorage.removeItem(CACHE_KEY);
  } catch {
    // Nothing depends on it.
  }
}

/** How many positions in a set already have an answer, so the UI can say what it will cost. */
export function cachedCount(keys: readonly string[]): number {
  const cache = loadCache();
  return keys.reduce((count, key) => count + (cache[key] === undefined ? 0 : 1), 0);
}

/** Re-exported so callers need only this module for the whole flow. */
export { placeKey };
