/**
 * GPX tracks, and matching photographs to them by time.
 *
 * This is the other half of the camera clock. `clock-sync.ts` works out what the camera's
 * timestamps really mean; a track says where you were at a given instant. Put the two together and
 * a day's photographs place themselves, which is the whole reason a phone was carrying a GPS.
 *
 * Two decisions worth knowing about before changing anything here:
 *
 * **The parser is hand-rolled, not `DOMParser`.** `packages/core` has zero platform dependencies by
 * rule, and `DOMParser` exists in a browser but not in Node — using it would put the matching logic
 * beyond the reach of the test runner, which is exactly where the errors that matter would hide.
 * GPX is a shallow format with three point elements and two fields of interest, so a scanner is
 * some forty lines and testable everywhere.
 *
 * **A time with no zone is read as UTC.** The GPX schema requires `xsd:dateTime` in UTC and every
 * logger writes the trailing `Z`, but the ones that do not would otherwise be handed to
 * `new Date('2024-07-01T11:00:00')`, which JavaScript reads as *local* time. That is a silent
 * whole-hours error in the one place an error is least visible — the coordinates would still look
 * entirely plausible, just from the wrong part of the walk.
 */

import type { Coordinates } from './gps.ts';

/** One fix: a position with a time. Times are epoch milliseconds, as `Date.getTime()` gives. */
export interface TrackPoint {
  readonly time: number;
  readonly latitude: number;
  readonly longitude: number;
  /** Metres. Absent when the logger recorded none — plenty of phone tracks have no elevation. */
  readonly altitude?: number;
}

export interface GpxTrack {
  /** Sorted by time, ascending, with duplicate timestamps removed. */
  readonly points: readonly TrackPoint[];
  /** The `<name>` of the first track or the file, when there is one. For telling files apart. */
  readonly name: string | undefined;
  /** Points that were dropped for having no usable time. Reported, not hidden. */
  readonly untimed: number;
  /**
   * Anything the reader wants said about where this track came from.
   *
   * Empty for a GPX file, where the answer is "the file". A converted Google Timeline export needs
   * it: what it contains varies by Android version and by how long Timeline has been on, and
   * whether a match came from a real GPS fix or an inferred visit to a shop is the difference
   * between metres and a hundred metres. Silently averaging the two would be the wrong kindness.
   */
  readonly notes?: readonly string[];
}

/**
 * How far from a track point a photograph may be and still be placed, by default.
 *
 * Two minutes is chosen against how loggers actually behave rather than against how far somebody
 * walks: a one-second logger is common, a smart logger idles at thirty seconds to a minute when
 * you stop moving, and a gap much beyond that usually means the receiver lost its fix or you went
 * indoors — which is precisely when its last known position is worth least.
 */
export const DEFAULT_TOLERANCE_SECONDS = 120;

export interface MatchOptions {
  /** Maximum seconds between the photo and the nearest fix. Default `DEFAULT_TOLERANCE_SECONDS`. */
  readonly toleranceSeconds?: number;
  /**
   * Interpolate between the two fixes either side, rather than taking the nearer one.
   *
   * On by default and worth leaving on: a one-minute logging interval at walking pace puts the
   * nearest fix up to forty metres away, and the midpoint of the two is a far better guess than
   * either end.
   */
  readonly interpolate?: boolean;
}

export type TrackMatch =
  /** The photo's instant fell between two fixes and the position was interpolated. */
  | { readonly kind: 'interpolated'; readonly coordinates: Coordinates; readonly gapSeconds: number }
  /** Taken from the single nearest fix — outside the track's span, or interpolation turned off. */
  | { readonly kind: 'nearest'; readonly coordinates: Coordinates; readonly gapSeconds: number }
  /** No fix close enough. `gapSeconds` is how far off the nearest one was, or Infinity. */
  | { readonly kind: 'none'; readonly gapSeconds: number };

const MS_PER_SECOND = 1000;

// --- Parsing -----------------------------------------------------------------

/**
 * Point elements, in the order of preference they are merged in.
 *
 * `trkpt` is the recorded track. `rtept` is a planned route, which some loggers export instead.
 * `wpt` is a standalone waypoint — rarely a track, but a file of nothing but waypoints is a file
 * somebody expects to work, and refusing it would be pedantry.
 */
const POINT_TAGS = ['trkpt', 'rtept', 'wpt'] as const;

/**
 * Read a GPX document.
 *
 * Throws with something a user can act on rather than returning an empty track: "no points with
 * times" and "not a GPX file" call for completely different responses, and a silent empty result
 * would present as the matching being broken.
 */
export function parseGpx(xml: string): GpxTrack {
  if (!/<gpx[\s>]/i.test(xml)) {
    throw new Error('That does not look like a GPX file — no <gpx> element.');
  }

  const points: TrackPoint[] = [];
  let untimed = 0;

  for (const tag of POINT_TAGS) {
    // A point is `<trkpt lat=".." lon="..">…</trkpt>` or the same self-closed. Attributes come in
    // either order and in either kind of quote, so they are read out of the captured run rather
    // than positionally.
    const pattern = new RegExp(`<${tag}\\b([^>]*?)(/?)>`, 'gi');
    // Compiled once per tag, and searched from an offset rather than over a copy of the document
    // — see `indexOfClose`.
    const closing = new RegExp(`</${tag}\\s*>`, 'gi');

    for (const opening of xml.matchAll(pattern)) {
      const attributes = opening[1] ?? '';
      const latitude = Number(attribute(attributes, 'lat'));
      const longitude = Number(attribute(attributes, 'lon'));
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) continue;

      // Self-closing points carry no time, so they are counted as untimed rather than searched.
      const body = opening[2] === '/'
        ? ''
        : xml.slice(
          (opening.index ?? 0) + opening[0].length,
          indexOfClose(xml, closing, (opening.index ?? 0) + opening[0].length),
        );

      const time = parseGpxTime(element(body, 'time'));
      if (time === undefined) {
        untimed += 1;
        continue;
      }

      const elevation = Number(element(body, 'ele'));
      points.push({
        time,
        latitude,
        longitude,
        ...(Number.isFinite(elevation) ? { altitude: elevation } : {}),
      });
    }

    // Stop at the first element type that produced anything. A file with both a route and the
    // track it was planned from would otherwise interleave the two into one incoherent path.
    if (points.length > 0) break;
  }

  if (points.length === 0) {
    throw new Error(
      untimed > 0
        ? `The track has ${untimed} point(s) but none of them carry a time, so nothing can be `
          + 'matched to a photograph.'
        : 'No track points found in that file.',
    );
  }

  return trackFromPoints(points, element(xml, 'name'), untimed);
}

/**
 * An ISO instant from a `<time>`, or `undefined`.
 *
 * A bare local-looking time is read as UTC — see the note at the top of the file. This is the one
 * piece of leniency in the parser and it is the safe direction: GPX says UTC, so assuming it
 * matches the spec, while `Date`'s own default does not.
 */
export function parseGpxTime(text: string | undefined): number | undefined {
  if (!text) return undefined;

  const trimmed = text.trim();
  const zoned = /(Z|[+-]\d{2}:?\d{2})$/i.test(trimmed) ? trimmed : `${trimmed}Z`;
  const parsed = Date.parse(zoned);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** `lat="51.4"` out of an attribute run. */
function attribute(attributes: string, name: string): string | undefined {
  const match = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i').exec(attributes);
  return match?.[2] ?? match?.[3];
}

/** The text of the first `<name>`/`<time>`/`<ele>` in a fragment, with entities decoded. */
function element(fragment: string, name: string): string | undefined {
  const match = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, 'i').exec(fragment);
  const text = match?.[1]?.trim();
  return text === undefined ? undefined : decodeEntities(text);
}

/**
 * XML's five entities, plus numeric references.
 *
 * Needed because a hand-rolled reader gets no decoding for free, and it showed up the moment the
 * writer was tested against the reader: a track named `Dad & I` is written correctly as
 * `Dad &amp; I` by any tool and read back as the literal `&amp;` without this. Harmless in a
 * `<time>`, which has no special characters, and plainly wrong everywhere a human named something.
 *
 * `&amp;` is decoded **last**. Doing it first would turn `&amp;lt;` — the correct encoding of the
 * literal text `&lt;` — into `&lt;` and then into `<`, which is how a decoder invents markup that
 * was never in the document.
 */
function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([\da-f]+);/gi, (_, hex: string) => codePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, digits: string) => codePoint(Number(digits)))
    .replace(/&amp;/g, '&');
}

/** A numeric reference, or the empty string if it names nothing a string can hold. */
function codePoint(value: number): string {
  try {
    return String.fromCodePoint(value);
  } catch {
    return '';
  }
}

/**
 * Where a point's closing tag starts, or the end of the document if it was never closed.
 *
 * The search runs from an offset on the original string rather than over a lower-cased copy, and
 * both halves of that are deliberate. Case-folding the document inside the loop is **quadratic** —
 * measured, it was the entire cost of a one-second parse of a 5,000-point track, and a full day at
 * one fix a second would have taken minutes. Folding it once outside the loop would be fast but
 * unsound: `toLowerCase` can change a string's *length* on some Unicode, so a track named in
 * Turkish would silently shift every offset.
 */
function indexOfClose(xml: string, closing: RegExp, from: number): number {
  closing.lastIndex = from;
  return closing.exec(xml)?.index ?? xml.length;
}

/**
 * Build a track from points gathered anywhere — the GPX parser, or a converted Timeline export.
 *
 * The sorting and de-duplication are not optional garnish, which is why every producer goes
 * through here rather than assembling a `GpxTrack` literal. See below.
 *
 * Ascending by time, with repeated timestamps collapsed.
 *
 * Both halves are load-bearing for the matcher, which binary-searches and therefore assumes order.
 * Files that concatenate several days, or several `<trkseg>`s recorded out of order, are common
 * enough that sorting is not a theoretical nicety. Duplicates are dropped because two positions
 * claiming the same instant cannot both be right, and keeping them would make the answer depend on
 * which one the search happened to land on.
 */
export function trackFromPoints(
  points: readonly TrackPoint[],
  name: string | undefined,
  untimed = 0,
  notes: readonly string[] = [],
): GpxTrack {
  return { points: sortAndDedupe(points), name, untimed, notes };
}

function sortAndDedupe(points: readonly TrackPoint[]): readonly TrackPoint[] {
  const sorted = [...points].sort((a, b) => a.time - b.time);

  const unique: TrackPoint[] = [];
  for (const point of sorted) {
    if (unique.at(-1)?.time === point.time) continue;
    unique.push(point);
  }
  return unique;
}

/**
 * A track back out as a GPX document.
 *
 * The point of this is a Timeline export, which is a format only Google reads and which Google has
 * already changed twice. Converting once and keeping the GPX means the day's track survives in
 * something every mapping tool on earth can open — and it is a far smaller file than the export it
 * came from, which covers years.
 *
 * Times are written in UTC with the `Z`, as the schema requires, because the whole reason
 * `parseGpxTime` has to be lenient is loggers that do not.
 */
export function toGpx(track: GpxTrack, name = track.name ?? 'Track'): string {
  const points = track.points.map((point) => {
    const elevation = point.altitude !== undefined
      ? `<ele>${round(point.altitude, 2)}</ele>`
      : '';
    return `      <trkpt lat="${round(point.latitude, 7)}" lon="${round(point.longitude, 7)}">`
      + `${elevation}<time>${new Date(point.time).toISOString()}</time></trkpt>`;
  });

  return '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<gpx version="1.1" creator="Snapmapper" xmlns="http://www.topografix.com/GPX/1/1">\n'
    + `  <trk>\n    <name>${escapeXml(name)}</name>\n    <trkseg>\n`
    + `${points.join('\n')}\n`
    + '    </trkseg>\n  </trk>\n</gpx>\n';
}

/** Only the five that matter, and only in text — no attribute here takes user content. */
function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

// --- Matching ----------------------------------------------------------------

/** First and last instants in a track. */
export function trackSpan(track: GpxTrack): { readonly from: Date; readonly to: Date } | undefined {
  const first = track.points[0];
  const last = track.points.at(-1);
  if (!first || !last) return undefined;
  return { from: new Date(first.time), to: new Date(last.time) };
}

/**
 * Where the track says you were at a given instant.
 *
 * The tolerance is measured against the *nearest fix*, not against the interval between the two
 * surrounding it. That distinction matters at the ends of a gap: sitting in a café for an hour
 * with the logger running produces two fixes an hour apart, and a photo taken one minute after the
 * first is a photo taken where that fix says, whatever the size of the hole that follows it.
 */
export function matchTrack(
  track: GpxTrack,
  instant: Date,
  options: MatchOptions = {},
): TrackMatch {
  const toleranceMs = (options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS) * MS_PER_SECOND;
  const interpolate = options.interpolate ?? true;
  const time = instant.getTime();

  const { points } = track;
  if (points.length === 0) return { kind: 'none', gapSeconds: Infinity };

  const after = lowerBound(points, time);
  const before = after > 0 ? points[after - 1] : undefined;
  const next = points[after];

  const gapBefore = before ? time - before.time : Infinity;
  const gapAfter = next ? next.time - time : Infinity;
  const gapMs = Math.min(gapBefore, gapAfter);

  if (!Number.isFinite(gapMs) || gapMs > toleranceMs) {
    return { kind: 'none', gapSeconds: gapMs / MS_PER_SECOND };
  }

  /*
   * Interpolate only when *both* neighbours are close, not merely the nearer one.
   *
   * The tolerance asks "is there a fix near this photo", which is the right question for whether
   * to place it at all. It is the wrong question for how. A photo one minute after a fix whose
   * successor is half an hour and twenty kilometres away is genuinely *at* that fix — but
   * interpolating would slide it a thirtieth of the way along, several hundred metres into a
   * journey it was not yet on. Taking the near fix is both more accurate and easier to defend.
   *
   * This is the difference between a track logged every second, where every neighbour is close and
   * interpolation always wins, and a sparse or inferred one — a Google Timeline export, a
   * battery-saving logger — where most intervals are long and only the endpoints are real.
   */
  const bracketed = before !== undefined && next !== undefined && next.time > before.time;
  if (interpolate && bracketed && gapBefore <= toleranceMs && gapAfter <= toleranceMs) {
    return {
      kind: 'interpolated',
      // Non-null by `bracketed`, which the checker cannot narrow through a const.
      coordinates: interpolatePosition(before as TrackPoint, next as TrackPoint, time),
      gapSeconds: gapMs / MS_PER_SECOND,
    };
  }

  const nearest = gapBefore <= gapAfter ? before : next;
  // Unreachable — a finite gap means one of the two exists — but the checker cannot see that.
  if (!nearest) return { kind: 'none', gapSeconds: Infinity };

  return {
    kind: 'nearest',
    coordinates: positionOf(nearest),
    gapSeconds: gapMs / MS_PER_SECOND,
  };
}

/** Index of the first point at or after `time`. Binary search: tracks run to 100k points. */
function lowerBound(points: readonly TrackPoint[], time: number): number {
  let low = 0;
  let high = points.length;

  while (low < high) {
    const middle = (low + high) >> 1;
    const point = points[middle];
    if (point !== undefined && point.time < time) low = middle + 1;
    else high = middle;
  }
  return low;
}

/**
 * Straight-line interpolation between two fixes.
 *
 * Linear in latitude and longitude, not along a great circle. Over the distance between two fixes
 * — metres to a few hundred metres — the two agree to far less than the receiver's own error, and
 * the great-circle form would trade a real cost in clarity for an imaginary gain in accuracy.
 *
 * Longitude is wrapped first, so a track crossing the antimeridian interpolates the short way round
 * instead of sweeping backwards across the entire planet.
 */
function interpolatePosition(before: TrackPoint, after: TrackPoint, time: number): Coordinates {
  const fraction = (time - before.time) / (after.time - before.time);

  const latitude = before.latitude + (after.latitude - before.latitude) * fraction;
  const longitude = wrapLongitude(
    before.longitude + shortestLongitudeDelta(before.longitude, after.longitude) * fraction,
  );

  // Altitude only when both ends have one. Interpolating from a single end would invent a
  // gradient, and an elevation nobody recorded is worse than none.
  const altitude = before.altitude !== undefined && after.altitude !== undefined
    ? before.altitude + (after.altitude - before.altitude) * fraction
    : undefined;

  return { latitude, longitude, ...(altitude !== undefined ? { altitude } : {}) };
}

function positionOf(point: TrackPoint): Coordinates {
  return {
    latitude: point.latitude,
    longitude: point.longitude,
    ...(point.altitude !== undefined ? { altitude: point.altitude } : {}),
  };
}

/** The signed difference between two longitudes, taken the short way around. */
function shortestLongitudeDelta(from: number, to: number): number {
  let delta = to - from;
  while (delta > 180) delta -= 360;
  while (delta < -180) delta += 360;
  return delta;
}

function wrapLongitude(longitude: number): number {
  let wrapped = longitude;
  while (wrapped > 180) wrapped -= 360;
  while (wrapped < -180) wrapped += 360;
  return wrapped;
}
