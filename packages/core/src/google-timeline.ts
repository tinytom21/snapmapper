/**
 * Google Timeline exports, converted to a track.
 *
 * The case for this over a dedicated logger app is simply that Timeline is already running. A
 * logger you have to remember to start is a logger that is off on the day you wanted it, and the
 * whole point of geotagging after the fact is that you were not thinking about it at the time.
 *
 * The case *against* it — which the interface has to pass on rather than hide — is that Timeline is
 * inferred, not recorded. Google thins the raw fixes hard to save battery, snaps them to roads, and
 * replaces stationary periods with a named place. So the output of this file is a track of wildly
 * uneven quality, and which kind of point a photograph matched decides whether it is accurate to
 * ten metres or to a building. Every source below is therefore counted and reported.
 *
 * ## The shapes
 *
 * Google has changed this format more than once, and an export made today may be any of these:
 *
 *   1. **`rawSignals`** — the new on-device export's actual GPS fixes, with timestamps and accuracy.
 *      Easily the best thing in the file, and the closest to what a logger app would have written.
 *   2. **`semanticSegments[].timelinePath`** — the processed path: sparse, snapped, and the only
 *      thing present in many exports.
 *   3. **`locations`** — the old Takeout `Records.json`, with `latitudeE7`-style integers. Still
 *      what some accounts produce, and what most guides on the internet describe.
 *
 * Visits are folded in from any of them; see `visitPoints`.
 *
 * All of it is read defensively. This is a format nobody documents, that differs by Android
 * version, and that will change again — so an unrecognised field is skipped and counted rather
 * than thrown at the user, and the error raised when *nothing* is recognised says what was
 * looked for.
 */

import { trackFromPoints, type GpxTrack, type TrackPoint } from './gpx.ts';

/**
 * How finely a visit is filled in, and how much of one is worth filling.
 *
 * A visit asserts a *constant* position across an interval — "you were at this café from 14:10 to
 * 15:25" — which the matcher, working entirely in point fixes, has no way to represent. Two points
 * at the ends would leave a photo taken in the middle further from either than any sane tolerance
 * allows, and it would be refused despite the data being perfectly clear about where it was.
 *
 * So a visit is expanded into fixes at a regular step. They are honest — every one is a position
 * the export genuinely claims for that instant — and cheap: a day of visits is a few hundred
 * points against the tens of thousands a real logger writes.
 */
const VISIT_STEP_MS = 60_000;
/** Ceiling per visit, so a fortnight's "at home" cannot become a hundred thousand points. */
const VISIT_MAX_SAMPLES = 720;

/** What the conversion found, so the interface can be specific about quality. */
export interface TimelineSummary {
  /** Real GPS fixes, from `rawSignals`. Accurate to a receiver's error. */
  readonly rawFixes: number;
  /** Processed path points. Thinned and snapped to roads. */
  readonly pathPoints: number;
  /** Points synthesised from stationary visits. Accurate to a *place*, not to where you stood. */
  readonly visitPoints: number;
  /** Endpoints of journeys, where the route between them is unknown. */
  readonly activityPoints: number;
  /** Entries recognised but skipped for having no usable position or time. */
  readonly skipped: number;
}

/**
 * Convert a Google Timeline export.
 *
 * Throws when the file is not a Timeline export at all, or is one with nothing usable in it —
 * those need different responses from the user, so they get different messages.
 */
export function parseGoogleTimeline(text: string): {
  readonly track: GpxTrack;
  readonly summary: TimelineSummary;
} {
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch (cause) {
    throw new Error(
      `That file is not valid JSON (${cause instanceof Error ? cause.message : String(cause)}). `
      + 'A Timeline export is a .json file; a track from a logger app is a .gpx.',
    );
  }

  const points: TrackPoint[] = [];
  const summary = {
    rawFixes: 0, pathPoints: 0, visitPoints: 0, activityPoints: 0, skipped: 0,
  };

  /*
   * The iOS export is a bare array of segments; Android wraps everything in an object. Normalising
   * here means the readers below never care which phone it came off.
   */
  const root = Array.isArray(document) ? { semanticSegments: document } : asRecord(document);
  if (!root) throw new Error('That file is not a Google Timeline export.');

  /*
   * Raw fixes first, and the order is load-bearing rather than tidy.
   *
   * `trackFromPoints` drops points that share a timestamp, keeping the first — and `Array.sort` is
   * stable, so "first" means first pushed. A visit sample landing on the same millisecond as a
   * real GPS fix is not hypothetical: visits are filled at a round 60-second step, and observed on
   * a synthetic export in the browser (63 points in, 62 out). Gathering in quality order means the
   * survivor of every such collision is the better point.
   */
  for (const signal of asArray(root['rawSignals'])) {
    const position = asRecord(asRecord(signal)?.['position']);
    if (!position) continue;

    const point = pointFrom(
      position['LatLng'] ?? position['latLng'],
      position['timestamp'],
      position['altitudeMeters'],
    );
    if (point) {
      points.push(point);
      summary.rawFixes += 1;
    } else summary.skipped += 1;
  }

  for (const raw of asArray(root['semanticSegments'])) {
    const segment = asRecord(raw);
    if (!segment) continue;

    const startTime = instantOf(segment['startTime']);
    const endTime = instantOf(segment['endTime']);

    for (const entry of asArray(segment['timelinePath'])) {
      const step = asRecord(entry);
      if (!step) continue;

      /*
       * Android writes an absolute `time`; iOS writes minutes elapsed from the segment's start.
       * Reading the offset as though it were an instant would produce 1970, and a photograph
       * matched against 1970 is simply never matched — a silent nothing rather than a visible
       * error, which is the worst way for this to fail.
       */
      // Quoted in real exports — `"0"`, not `0`. A strict number check drops the point, and a
      // dropped point is a photograph that never matches, which looks like nothing happening.
      const offset = numberish(step['durationMinutesOffsetFromStartTime']);
      const time = offset !== undefined && startTime !== undefined
        ? startTime + offset * 60_000
        : instantOf(step['time']);

      const point = pointFrom(step['point'], undefined, undefined, time);
      if (point) {
        points.push(point);
        summary.pathPoints += 1;
      } else summary.skipped += 1;
    }

    const visit = asRecord(segment['visit']);
    if (visit && startTime !== undefined && endTime !== undefined) {
      const place = asRecord(asRecord(visit['topCandidate'])?.['placeLocation'])
        ?? asRecord(visit['placeLocation']);
      const filled = visitPoints(place?.['latLng'] ?? place?.['LatLng'], startTime, endTime);
      points.push(...filled);
      summary.visitPoints += filled.length;
      if (filled.length === 0) summary.skipped += 1;
    }

    const activity = asRecord(segment['activity']);
    if (activity) {
      // Two true positions at two true times, and nothing known about the line between them. The
      // matcher's own rules take it from here: a photo near either end is placed from that end,
      // and one in the middle of the journey is refused, which is the correct answer.
      for (const [end, when] of [['start', startTime], ['end', endTime]] as const) {
        const latLng = asRecord(activity[end])?.['latLng'] ?? asRecord(activity[end])?.['LatLng'];
        const point = pointFrom(latLng, undefined, undefined, when);
        if (point) {
          points.push(point);
          summary.activityPoints += 1;
        }
      }
    }
  }

  // The old Takeout format, read only when the new one produced nothing — an export holding both
  // would otherwise double every fix.
  if (points.length === 0) {
    for (const entry of asArray(root['locations'])) {
      const location = asRecord(entry);
      if (!location) continue;

      const latitude = e7(location['latitudeE7']) ?? asNumber(location['latitude']);
      const longitude = e7(location['longitudeE7']) ?? asNumber(location['longitude']);
      // `timestampMs` is epoch milliseconds *as a string*, which `Date.parse` would reject.
      const millis = asNumber(location['timestampMs'])
        ?? (typeof location['timestampMs'] === 'string' ? Number(location['timestampMs']) : undefined);
      const time = millis !== undefined && Number.isFinite(millis)
        ? millis
        : instantOf(location['timestamp']);

      if (latitude === undefined || longitude === undefined || time === undefined) {
        summary.skipped += 1;
        continue;
      }

      const altitude = asNumber(location['altitude']);
      points.push({
        time, latitude, longitude, ...(altitude !== undefined ? { altitude } : {}),
      });
      summary.rawFixes += 1;
    }
  }

  if (points.length === 0) {
    const recognised = ['rawSignals', 'semanticSegments', 'locations']
      .filter((key) => root[key] !== undefined);

    throw new Error(
      recognised.length === 0
        ? 'That JSON file is not a Google Timeline export — none of rawSignals, semanticSegments '
          + 'or locations are in it.'
        : `The export has ${recognised.join(' and ')} but nothing in it carries both a position `
          + `and a time (${summary.skipped} entr${summary.skipped === 1 ? 'y' : 'ies'} skipped).`,
    );
  }

  return {
    track: trackFromPoints(points, 'Google Timeline', summary.skipped, notesFor(summary)),
    summary,
  };
}

/**
 * What to say about the quality of what was found.
 *
 * Written as plain sentences here rather than as counts for the UI to phrase, because the point is
 * not the numbers — it is that a match against a visit means *the shop*, not *the pavement outside
 * it where you took the photograph*, and somebody has to say so.
 */
function notesFor(summary: TimelineSummary): readonly string[] {
  const notes: string[] = [];

  if (summary.rawFixes > 0) {
    notes.push(`${summary.rawFixes.toLocaleString()} real GPS fixes — as good as a logger app.`);
  }
  if (summary.pathPoints > 0) {
    notes.push(
      `${summary.pathPoints.toLocaleString()} points from Google's processed path, which is `
      + 'thinned and snapped to roads — expect tens of metres.',
    );
  }
  if (summary.visitPoints > 0) {
    notes.push(
      `${summary.visitPoints.toLocaleString()} filled in from places you stopped. These are `
      + 'accurate to the place, not to where you stood in it.',
    );
  }
  if (summary.activityPoints > 0) {
    notes.push(
      `${summary.activityPoints.toLocaleString()} journey endpoints. Photos taken *during* a `
      + 'journey are left alone, because the route between them is not recorded.',
    );
  }
  if (summary.rawFixes === 0) {
    notes.push(
      'No raw GPS fixes in this export, so everything here is inferred. Worth checking a few '
      + 'against where you remember being before saving.',
    );
  }
  return notes;
}

/**
 * A visit as a run of fixes at one position.
 *
 * See `VISIT_STEP_MS`. Both ends are always included, whatever the step works out to, so the
 * boundaries of the visit stay exact.
 */
function visitPoints(latLng: unknown, startTime: number, endTime: number): readonly TrackPoint[] {
  const place = pointFrom(latLng, undefined, undefined, startTime);
  if (!place || endTime <= startTime) return place ? [place] : [];

  const step = Math.max(VISIT_STEP_MS, Math.ceil((endTime - startTime) / VISIT_MAX_SAMPLES));
  const filled: TrackPoint[] = [];

  for (let time = startTime; time < endTime; time += step) filled.push({ ...place, time });
  filled.push({ ...place, time: endTime });
  return filled;
}

/**
 * A track point from whatever shape the position happens to be in.
 *
 * Google writes coordinates as a string — `"51.4778000°, -0.0015000°"`, degree sign included — in
 * the newer exports, and as an object in others. Both are handled here so that the readers above
 * stay about the *structure* of the file rather than about this.
 */
function pointFrom(
  position: unknown,
  timestamp?: unknown,
  altitude?: unknown,
  knownTime?: number,
): TrackPoint | undefined {
  const time = knownTime ?? instantOf(timestamp);
  if (time === undefined) return undefined;

  const coordinates = latLngOf(position);
  if (!coordinates) return undefined;

  const height = asNumber(altitude);
  return {
    time,
    latitude: coordinates[0],
    longitude: coordinates[1],
    ...(height !== undefined ? { altitude: height } : {}),
  };
}

/** `"51.4778°, -0.0015°"`, `{ latitude, longitude }` or `{ lat, lng }` to a pair. */
function latLngOf(position: unknown): readonly [number, number] | undefined {
  if (typeof position === 'string') {
    // The degree signs are Google's; anything that is not a number, a sign or a point goes.
    const parts = position.split(',').map((part) => Number(part.replace(/[^\d.eE+-]/g, '')));
    const [latitude, longitude] = parts;
    return validPair(latitude, longitude);
  }

  const record = asRecord(position);
  if (!record) return undefined;

  return validPair(
    asNumber(record['latitude']) ?? asNumber(record['lat']) ?? e7(record['latitudeE7']),
    asNumber(record['longitude']) ?? asNumber(record['lng']) ?? asNumber(record['lon'])
      ?? e7(record['longitudeE7']),
  );
}

/**
 * A pair, if it is a real position.
 *
 * The range check is not pedantry: `0, 0` off the coast of Africa is what a half-parsed coordinate
 * looks like, and out-of-range values are how a mis-read field announces itself. Better no point
 * than a point in the Gulf of Guinea.
 */
function validPair(
  latitude: number | undefined,
  longitude: number | undefined,
): readonly [number, number] | undefined {
  if (latitude === undefined || longitude === undefined) return undefined;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return undefined;
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return undefined;
  return [latitude, longitude];
}

/**
 * Google's fixed-point degrees: 515000000 means 51.5.
 *
 * Distinguished from a plain degree value by magnitude, because both appear under names that only
 * differ by the `E7` suffix and exports have been seen to disagree.
 */
function e7(value: unknown): number | undefined {
  const number = asNumber(value);
  return number === undefined ? undefined : number / 1e7;
}

/**
 * An instant from a Timeline timestamp.
 *
 * Unlike GPX, these carry an explicit zone — `2024-07-01T11:00:00.000+01:00` — so they are parsed
 * as written, with no assumption of UTC. A bare one with no zone is *not* nudged to UTC here
 * either: Timeline writes local time with the offset attached, so an offset-less value is far more
 * likely to be a local reading than a UTC one, and `Date.parse` already treats it that way.
 */
function instantOf(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || value.trim() === '') return undefined;

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * A number that may have been written as a string.
 *
 * Timeline quotes numbers inconsistently — `"0"` beside `5` in the same array — so anywhere a
 * strict check would silently drop a field, this is used instead. Deliberately *not* used for
 * coordinates: there, a value that is not what it should be is a reason to discard the point, not
 * to try harder to read it.
 */
function numberish(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
