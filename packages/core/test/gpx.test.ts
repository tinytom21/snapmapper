/**
 * The GPX parser and the time matcher.
 *
 * The tests that matter here are not the happy path — a well-formed track from a well-behaved
 * logger works or it obviously does not. They are the ones about *silent* wrongness: a time with
 * no zone, an unsorted file, a gap in the fixes, and the antimeridian. Every one of those produces
 * coordinates that look entirely plausible while being in the wrong place, which is the only kind
 * of geotagging bug worth being afraid of.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DEFAULT_TOLERANCE_SECONDS,
  matchTrack,
  parseGpx,
  parseGpxTime,
  trackSpan,
  type GpxTrack,
} from '../src/gpx.ts';

/** A minimal but real-shaped document. Points are `[isoTime, lat, lon, ele?]`. */
function gpxOf(points: readonly (readonly [string, number, number, number?])[]): string {
  const body = points
    .map(([time, lat, lon, ele]) =>
      `<trkpt lat="${lat}" lon="${lon}">`
      + (ele === undefined ? '' : `<ele>${ele}</ele>`)
      + `<time>${time}</time></trkpt>`)
    .join('\n');

  return '<?xml version="1.0"?>\n'
    + '<gpx version="1.1" creator="test">\n'
    + '<trk><name>A walk</name><trkseg>\n'
    + body
    + '\n</trkseg></trk></gpx>';
}

const WALK = parseGpx(gpxOf([
  ['2024-07-01T11:00:00Z', 51.0, -1.0, 100],
  ['2024-07-01T11:01:00Z', 51.0, -1.0, 100],
  ['2024-07-01T11:02:00Z', 51.2, -1.2, 120],
]));

function at(iso: string): Date {
  return new Date(iso);
}

describe('parsing GPX', () => {
  it('reads position, elevation and time out of a track', () => {
    assert.equal(WALK.points.length, 3);
    assert.deepEqual(WALK.points[0], {
      time: Date.parse('2024-07-01T11:00:00Z'),
      latitude: 51,
      longitude: -1,
      altitude: 100,
    });
    assert.equal(WALK.name, 'A walk');
  });

  it('takes attributes in either order and in either kind of quote', () => {
    const track = parseGpx(
      "<gpx><trkpt lon='-1.5' lat=\"51.5\"><time>2024-07-01T11:00:00Z</time></trkpt></gpx>",
    );
    assert.deepEqual(
      [track.points[0]?.latitude, track.points[0]?.longitude],
      [51.5, -1.5],
    );
  });

  it('omits altitude entirely when the logger recorded none', () => {
    const track = parseGpx(gpxOf([['2024-07-01T11:00:00Z', 51, -1]]));
    // Not zero, and not present-but-undefined: a phone track with no elevation must not write
    // GPSAltitude at sea level into every photograph.
    assert.equal('altitude' in (track.points[0] ?? {}), false);
  });

  it('reads a time with no zone as UTC, not as local', () => {
    /*
     * The trap this exists for. `new Date('2024-07-01T11:00:00')` is *local* time in JavaScript,
     * so on a machine an hour off UTC every match would silently come from the wrong part of the
     * walk — with coordinates that look perfectly reasonable.
     */
    assert.equal(parseGpxTime('2024-07-01T11:00:00'), Date.parse('2024-07-01T11:00:00Z'));
    assert.equal(parseGpxTime('2024-07-01T11:00:00Z'), Date.parse('2024-07-01T11:00:00Z'));
    // An explicit offset is honoured rather than overridden.
    assert.equal(parseGpxTime('2024-07-01T12:00:00+01:00'), Date.parse('2024-07-01T11:00:00Z'));
  });

  it('sorts by time and drops duplicate instants', () => {
    // The matcher binary-searches, so order is an assumption it cannot check. Files that
    // concatenate days, or hold segments recorded out of order, are common.
    const track = parseGpx(gpxOf([
      ['2024-07-01T11:02:00Z', 51.2, -1.2],
      ['2024-07-01T11:00:00Z', 51.0, -1.0],
      ['2024-07-01T11:00:00Z', 40.0, -3.0],
    ]));

    assert.deepEqual(
      track.points.map((point) => point.time),
      [Date.parse('2024-07-01T11:00:00Z'), Date.parse('2024-07-01T11:02:00Z')],
    );
  });

  it('falls back to route points and waypoints when there is no track', () => {
    const waypoints = parseGpx(
      '<gpx><wpt lat="51" lon="-1"><time>2024-07-01T11:00:00Z</time></wpt></gpx>',
    );
    assert.equal(waypoints.points.length, 1);
  });

  it('does not interleave a route with the track it was planned from', () => {
    const both = parseGpx(
      '<gpx>'
      + '<rtept lat="10" lon="10"><time>2024-07-01T11:00:30Z</time></rtept>'
      + '<trkpt lat="51" lon="-1"><time>2024-07-01T11:00:00Z</time></trkpt>'
      + '</gpx>',
    );
    assert.deepEqual(both.points.map((point) => point.latitude), [51]);
  });

  it('counts points that carry no time rather than inventing one', () => {
    const track = parseGpx(
      '<gpx><trkpt lat="51" lon="-1"/>'
      + '<trkpt lat="52" lon="-2"><time>2024-07-01T11:00:00Z</time></trkpt></gpx>',
    );
    assert.equal(track.untimed, 1);
    assert.equal(track.points.length, 1);
  });

  it('says what is wrong rather than returning an empty track', () => {
    // Two different failures needing two different responses from the user.
    assert.throws(() => parseGpx('<html><body>not a track</body></html>'), /not look like a GPX/);
    assert.throws(
      () => parseGpx('<gpx><trkpt lat="51" lon="-1"/></gpx>'),
      /none of them carry a time/,
    );
  });

  it('reports the span of a track', () => {
    const span = trackSpan(WALK);
    assert.equal(span?.from.toISOString(), '2024-07-01T11:00:00.000Z');
    assert.equal(span?.to.toISOString(), '2024-07-01T11:02:00.000Z');
  });
});

describe('matching a photo to a track', () => {
  it('interpolates between the two fixes either side', () => {
    const match = matchTrack(WALK, at('2024-07-01T11:01:30Z'));

    assert.equal(match.kind, 'interpolated');
    assert.ok(match.kind === 'interpolated');
    // Halfway between 51.0/-1.0 and 51.2/-1.2, in position and in elevation.
    assert.equal(round(match.coordinates.latitude), 51.1);
    assert.equal(round(match.coordinates.longitude), -1.1);
    assert.equal(round(match.coordinates.altitude ?? 0), 110);
    // The gap is to the *nearest* fix, which is 30s away in both directions here.
    assert.equal(match.gapSeconds, 30);
  });

  it('takes the nearest fix when interpolation is turned off', () => {
    const match = matchTrack(WALK, at('2024-07-01T11:01:20Z'), { interpolate: false });
    assert.ok(match.kind === 'nearest');
    assert.equal(match.coordinates.latitude, 51.0);
    assert.equal(match.gapSeconds, 20);
  });

  it('extends the ends of the track by the tolerance, not beyond it', () => {
    // A minute before the logger was switched on is still where the logger says.
    const just = matchTrack(WALK, at('2024-07-01T10:59:00Z'));
    assert.ok(just.kind === 'nearest');
    assert.equal(just.coordinates.latitude, 51.0);

    const hours = matchTrack(WALK, at('2024-07-01T09:00:00Z'));
    assert.equal(hours.kind, 'none');
    assert.equal(hours.gapSeconds, 7200);
  });

  it('measures the tolerance against the nearest fix, not the gap around it', () => {
    /*
     * The café case. An hour parked with the logger running leaves two fixes an hour apart, and a
     * photo taken one minute after the first is a photo taken where that fix says — whatever the
     * size of the hole that follows it. Judging by the interval would refuse it.
     */
    const parked = parseGpx(gpxOf([
      ['2024-07-01T11:00:00Z', 51.0, -1.0],
      ['2024-07-01T12:00:00Z', 51.5, -1.5],
    ]));

    const match = matchTrack(parked, at('2024-07-01T11:01:00Z'));
    assert.notEqual(match.kind, 'none');
  });

  it('refuses a photo with no fix inside the tolerance', () => {
    const sparse = parseGpx(gpxOf([
      ['2024-07-01T11:00:00Z', 51.0, -1.0],
      ['2024-07-01T13:00:00Z', 51.5, -1.5],
    ]));

    const match = matchTrack(sparse, at('2024-07-01T12:00:00Z'));
    assert.equal(match.kind, 'none');
    // Reported so the UI can say how far off it was, which is what tells you whether raising the
    // tolerance would be reasonable or absurd.
    assert.equal(match.gapSeconds, 3600);
  });

  it('honours a tolerance the caller chose', () => {
    const late = at('2024-07-01T11:05:00Z');
    assert.equal(matchTrack(WALK, late).kind, 'none');
    assert.notEqual(matchTrack(WALK, late, { toleranceSeconds: 600 }).kind, 'none');
    assert.equal(DEFAULT_TOLERANCE_SECONDS, 120);
  });

  it('interpolates the short way round the antimeridian', () => {
    // Straight arithmetic between +179.9 and -179.9 sweeps backwards across the entire planet and
    // lands at longitude 0 — in Africa, for a photograph taken in Fiji.
    const dateline = parseGpx(gpxOf([
      ['2024-07-01T11:00:00Z', -17.0, 179.9],
      ['2024-07-01T11:01:00Z', -17.0, -179.9],
    ]));

    const match = matchTrack(dateline, at('2024-07-01T11:00:30Z'));
    assert.ok(match.kind === 'interpolated');
    assert.equal(Math.abs(match.coordinates.longitude), 180);
  });

  it('does not invent an elevation when only one end has one', () => {
    const partial = parseGpx(gpxOf([
      ['2024-07-01T11:00:00Z', 51.0, -1.0, 100],
      ['2024-07-01T11:01:00Z', 51.1, -1.1],
    ]));

    const match = matchTrack(partial, at('2024-07-01T11:00:30Z'));
    assert.ok(match.kind === 'interpolated');
    assert.equal(match.coordinates.altitude, undefined);
  });

  it('handles a single-point track', () => {
    const one = parseGpx(gpxOf([['2024-07-01T11:00:00Z', 51.0, -1.0]]));
    const match = matchTrack(one, at('2024-07-01T11:00:10Z'));
    assert.ok(match.kind === 'nearest');
    assert.equal(match.coordinates.latitude, 51);
  });

  it('finds the right pair in a long track', () => {
    // Exercises the binary search rather than trusting three points to prove it.
    const long: (readonly [string, number, number])[] = [];
    for (let index = 0; index < 5000; index++) {
      long.push([new Date(Date.UTC(2024, 6, 1, 11, 0, index)).toISOString(), 51 + index / 1e5, -1]);
    }
    const track: GpxTrack = parseGpx(gpxOf(long));

    const match = matchTrack(track, new Date(Date.UTC(2024, 6, 1, 11, 0, 4000)));
    assert.ok(match.kind === 'interpolated' || match.kind === 'nearest');
    assert.equal(round(match.coordinates.latitude, 5), 51.04);
  });
});

function round(value: number, decimals = 6): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
