/**
 * Converting a Google Timeline export.
 *
 * These fixtures are written from the documented and observed shapes of the export, not captured
 * from a real one, and that is worth stating plainly: this file proves the converter does what it
 * intends with each shape, **not** that those shapes match what a given phone produces today.
 * Google has changed this format more than once and does not document it. The real check is a real
 * export, and the parser is written to say what it could not recognise for exactly that reason.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseGoogleTimeline } from '../src/google-timeline.ts';
import { matchTrack, toGpx, parseGpx } from '../src/gpx.ts';

/** The new on-device export: real fixes, a processed path, a visit and a journey. */
const ANDROID = JSON.stringify({
  rawSignals: [
    {
      position: {
        LatLng: '51.4778000°, -0.0015000°',
        timestamp: '2024-07-01T12:00:00.000+01:00',
        altitudeMeters: 12.5,
        accuracyMeters: 8,
      },
    },
    {
      position: {
        LatLng: '51.4779000°, -0.0016000°',
        timestamp: '2024-07-01T12:00:30.000+01:00',
      },
    },
  ],
  semanticSegments: [
    {
      startTime: '2024-07-01T13:00:00.000+01:00',
      endTime: '2024-07-01T13:02:00.000+01:00',
      timelinePath: [
        { point: '51.5000000°, -0.1000000°', time: '2024-07-01T13:00:00.000+01:00' },
        { point: '51.5010000°, -0.1010000°', time: '2024-07-01T13:01:00.000+01:00' },
      ],
    },
    {
      startTime: '2024-07-01T14:00:00.000+01:00',
      endTime: '2024-07-01T15:00:00.000+01:00',
      visit: {
        topCandidate: { placeLocation: { latLng: '51.5200000°, -0.1300000°' } },
      },
    },
    {
      startTime: '2024-07-01T16:00:00.000+01:00',
      endTime: '2024-07-01T16:30:00.000+01:00',
      activity: {
        start: { latLng: '51.5200000°, -0.1300000°' },
        end: { latLng: '51.6000000°, -0.2000000°' },
      },
    },
  ],
});

describe('the new on-device export', () => {
  const { track, summary } = parseGoogleTimeline(ANDROID);

  it('reads raw GPS fixes, degree signs and all', () => {
    assert.equal(summary.rawFixes, 2);
    assert.deepEqual(track.points[0], {
      // 12:00 BST is 11:00 UTC. The offset in the timestamp is honoured, not assumed away.
      time: Date.parse('2024-07-01T11:00:00Z'),
      latitude: 51.4778,
      longitude: -0.0015,
      altitude: 12.5,
    });
  });

  it('reads the processed path', () => {
    assert.equal(summary.pathPoints, 2);
  });

  it('fills a visit in, so a photo taken in the middle of it can be placed', () => {
    /*
     * The reason visits are expanded rather than reduced to two endpoints. A visit asserts a
     * constant position across an hour; with only the ends, a photo taken at half past is half an
     * hour from the nearest fix and gets refused — despite the data being perfectly clear.
     */
    assert.ok(summary.visitPoints > 50, `only ${summary.visitPoints} points for an hour`);

    const middle = matchTrack(track, new Date('2024-07-01T13:30:00Z'));
    assert.notEqual(middle.kind, 'none');
    assert.ok(middle.kind !== 'none');
    assert.equal(middle.coordinates.latitude, 51.52);
  });

  it('takes journey endpoints but refuses the middle of the journey', () => {
    assert.equal(summary.activityPoints, 2);

    // Near the start, the start is right.
    const setOff = matchTrack(track, new Date('2024-07-01T15:00:30Z'));
    assert.ok(setOff.kind !== 'none');
    assert.equal(setOff.coordinates.latitude, 51.52);

    // Fifteen minutes into a half-hour drive, Timeline does not know where you were, and inventing
    // a point on the straight line between two stations would be a confident lie.
    assert.equal(matchTrack(track, new Date('2024-07-01T15:15:00Z')).kind, 'none');
  });

  it('keeps the real fix when a visit sample lands on the same millisecond', () => {
    /*
     * Observed rather than imagined: a synthetic export in the browser produced 63 points and a
     * track of 62. Visits are filled at a round 60-second step, so collisions with a real fix are
     * routine — and the de-duplication keeps whichever was gathered first. Gathering in quality
     * order is what makes the survivor the better point, so this pins that ordering.
     */
    const collision = parseGoogleTimeline(JSON.stringify({
      rawSignals: [{
        position: { LatLng: '51.4778000°, -0.0015000°', timestamp: '2024-07-01T11:00:00Z' },
      }],
      semanticSegments: [{
        startTime: '2024-07-01T11:00:00Z',
        endTime: '2024-07-01T11:05:00Z',
        visit: { topCandidate: { placeLocation: { latLng: '51.9999999°, -0.9999999°' } } },
      }],
    })).track;

    const first = collision.points.find((point) => point.time === Date.parse('2024-07-01T11:00:00Z'));
    assert.equal(first?.latitude, 51.4778, 'the inferred visit displaced a real GPS fix');
  });

  it('says what it found, in terms of how much it can be trusted', () => {
    const notes = (track.notes ?? []).join(' ');
    assert.match(notes, /real GPS fixes/);
    assert.match(notes, /accurate to the place, not to where you stood/);
  });
});

describe('the old Takeout Records.json', () => {
  const OLD = JSON.stringify({
    locations: [
      { latitudeE7: 514778000, longitudeE7: -15000, timestampMs: '1719831600000', altitude: 12 },
      { latitudeE7: 514779000, longitudeE7: -16000, timestamp: '2024-07-01T11:01:00Z' },
    ],
  });

  it('reads E7 integers and a string of epoch millis', () => {
    // `timestampMs` is a *string* of milliseconds, which Date.parse would reject outright — and
    // the failure would be a track that silently placed nothing.
    const { track, summary } = parseGoogleTimeline(OLD);
    assert.equal(summary.rawFixes, 2);
    assert.equal(track.points[0]?.time, 1_719_831_600_000);
    assert.equal(track.points[0]?.latitude, 51.4778);
  });

  it('is not read when the new format already produced points', () => {
    // An export holding both would otherwise double every fix, and a duplicated track is one that
    // looks fine and matches inconsistently.
    const both = JSON.parse(ANDROID);
    both.locations = [{ latitudeE7: 0, longitudeE7: 0, timestamp: '2024-07-01T11:00:00Z' }];
    const { summary } = parseGoogleTimeline(JSON.stringify(both));
    assert.equal(summary.rawFixes, 2);
  });
});

describe('the iOS export', () => {
  it('reads a bare array whose path times are minutes from the segment start', () => {
    /*
     * The trap in the iOS shape: `durationMinutesOffsetFromStartTime` is not an instant. Read as
     * one it yields 1970, and a photograph matched against 1970 is never matched at all — a silent
     * nothing rather than a visible error.
     */
    const { track, summary } = parseGoogleTimeline(JSON.stringify([
      {
        startTime: '2024-07-01T11:00:00Z',
        endTime: '2024-07-01T11:10:00Z',
        timelinePath: [
          { point: '51.5°, -0.1°', durationMinutesOffsetFromStartTime: '0' },
          { point: '51.51°, -0.11°', durationMinutesOffsetFromStartTime: 5 },
        ],
      },
    ]));

    // Both points, including the one whose offset is the *string* "0". Timeline quotes numbers
    // inconsistently, and a strict number check drops that point silently — which presents as a
    // photograph that simply never matches.
    assert.equal(summary.pathPoints, 2);
    assert.equal(track.points[0]?.time, Date.parse('2024-07-01T11:00:00Z'));
    assert.equal(track.points[1]?.time, Date.parse('2024-07-01T11:05:00Z'));
  });
});

describe('refusing what it cannot use', () => {
  it('tells valid JSON that is not a Timeline export apart from a broken file', () => {
    assert.throws(() => parseGoogleTimeline('{ not json'), /not valid JSON/);
    assert.throws(
      () => parseGoogleTimeline('{"settings":{}}'),
      /not a Google Timeline export/,
    );
  });

  it('says so when the export is recognised but empty of anything usable', () => {
    // The likeliest real disappointment: Timeline was on, but not for the day you wanted.
    assert.throws(
      () => parseGoogleTimeline('{"semanticSegments":[{"startTime":"2024-07-01T11:00:00Z"}]}'),
      /nothing in it carries both a position and a time/,
    );
  });

  it('drops a position that did not parse rather than putting it in the Gulf of Guinea', () => {
    // `0, 0` is what a half-read coordinate looks like, and it is a real place on the map — so a
    // point that fails to parse must vanish, not default.
    assert.throws(
      () => parseGoogleTimeline(JSON.stringify({
        rawSignals: [{ position: { LatLng: 'somewhere nice', timestamp: '2024-07-01T11:00:00Z' } }],
      })),
      /nothing in it carries both a position and a time/,
    );
  });

  it('drops an out-of-range coordinate', () => {
    assert.throws(
      () => parseGoogleTimeline(JSON.stringify({
        rawSignals: [{ position: { LatLng: '514778000°, -15000°', timestamp: '2024-07-01T11:00:00Z' } }],
      })),
      /nothing in it carries both a position and a time/,
    );
  });
});

describe('writing the converted track back out as GPX', () => {
  it('round-trips through the GPX parser unchanged', () => {
    // The claim the "Save as GPX" button makes: what you keep is what was matched. A converter
    // whose output differed from what placed the photographs would be worse than none.
    const { track } = parseGoogleTimeline(ANDROID);
    const round = parseGpx(toGpx(track));

    assert.equal(round.points.length, track.points.length);
    assert.deepEqual(round.points[0], track.points[0]);
    assert.deepEqual(round.points.at(-1), track.points.at(-1));
  });

  it('writes times in UTC with the Z, as the schema requires', () => {
    const { track } = parseGoogleTimeline(ANDROID);
    assert.match(toGpx(track), /<time>2024-07-01T11:00:00\.000Z<\/time>/);
  });

  it('escapes a name that would otherwise break the document', () => {
    const { track } = parseGoogleTimeline(ANDROID);
    const xml = toGpx(track, 'Tom & Jerry <walk>');
    assert.match(xml, /<name>Tom &amp; Jerry &lt;walk&gt;<\/name>/);
    // And it still parses, which is the actual requirement.
    assert.equal(parseGpx(xml).name, 'Tom & Jerry <walk>');
  });
});
