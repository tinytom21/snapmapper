/**
 * Sampling a track down to a drawable line.
 *
 * The property that matters is that the ends survive. A line that stops short of where the walk
 * ended reads as a truncated file — a false alarm raised by the one thing on screen whose job is
 * to reassure you the file is right.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseGpx } from '@snapmapper/core';

import { MAX_LINE_POINTS, trackLine } from '../src/track-line.ts';

/** A track of `count` fixes, one a second, walking east. */
function walk(count: number) {
  const points: string[] = [];
  for (let index = 0; index < count; index++) {
    points.push(
      `<trkpt lat="51" lon="${index / 1000}">`
      + `<time>${new Date(Date.UTC(2024, 6, 1, 11, 0, index)).toISOString()}</time></trkpt>`,
    );
  }
  return parseGpx(`<gpx><trk><trkseg>${points.join('')}</trkseg></trk></gpx>`);
}

describe('trackLine', () => {
  it('is empty without a track, so the map has nothing to draw', () => {
    assert.deepEqual(trackLine(null), []);
  });

  it('passes a small track through unchanged', () => {
    const line = trackLine(walk(100));
    assert.equal(line.length, 100);
    assert.deepEqual(line[0], [0, 51]);
  });

  it('samples a huge track down, and keeps both ends exactly', () => {
    const track = walk(50_000);
    const line = trackLine(track);

    assert.ok(line.length <= MAX_LINE_POINTS, `${line.length} points is too many to redraw`);
    assert.deepEqual(line[0], [0, 51]);
    // The last fix, not the last one the stride happened to land on.
    assert.deepEqual(line.at(-1), [49_999 / 1000, 51]);
  });

  it('does not repeat the final fix when the stride already lands on it', () => {
    // 4000 points at a stride of 1 ends on the last index, so appending it again would draw a
    // zero-length segment — invisible, but it would make the count wrong for anything counting.
    const line = trackLine(walk(MAX_LINE_POINTS));
    assert.equal(line.length, MAX_LINE_POINTS);
  });

  it('gives coordinates as [longitude, latitude], which is the order that gets reversed', () => {
    // The classic mistake, and it is silent: a track through Toulouse drawn in the Indian Ocean.
    const line = trackLine(walk(2));
    assert.equal(line[0]?.[1], 51);
  });
});
