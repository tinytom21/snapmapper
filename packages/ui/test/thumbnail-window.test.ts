import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  MAX_WINDOW_BYTES,
  MIN_WINDOW_BYTES,
  nextWindow,
} from '../src/thumbnail-window.ts';

/**
 * The window exists because a read is charged per round trip, not per byte.
 *
 * Measured on a Galaxy S23: 107 ms per call at 50KB, 113 ms at 43KB, 128 ms at 128KB. Tripling the
 * bytes costs 15 ms; a second call costs 110 ms. So the head must be large enough to contain the
 * thumbnail, and 48KB — right for an A6400 — was wrong for the phone's own JPEGs, whose thumbnail
 * is about 53KB. Three quarters of them needed a second read.
 */

const KB = 1024;

describe('fitting the head window to the camera', () => {
  it('grows past a thumbnail that did not fit, which is the whole point', () => {
    // The S23 case: a ~53KB thumbnail ending beyond the 48KB head.
    const grown = nextWindow(MIN_WINDOW_BYTES, 92 * KB);
    assert.ok(grown > 92 * KB, `${grown} must clear the thumbnail it just measured`);
  });

  it('leaves room above the deepest seen, so the next file does not miss by a byte', () => {
    // The very file that set the mark would otherwise sit flush against the edge.
    assert.ok(nextWindow(MIN_WINDOW_BYTES, 64 * KB) >= 80 * KB);
  });

  it('stays where it is for an A6400, whose thumbnails fit already', () => {
    // Measured on the fixtures: IFD1 at ~38.8KB, the thumbnail ending by 45KB.
    assert.equal(nextWindow(MIN_WINDOW_BYTES, 45 * KB), MIN_WINDOW_BYTES);
  });

  it('never shrinks, so a card of two cameras cannot oscillate', () => {
    /*
     * Shrink to fit the Sony and the next Samsung pays a second read; shrink again and it repeats
     * for ever. An over-large window costs fifteen milliseconds and an under-large one a hundred
     * and ten, so the asymmetry decides it.
     */
    const wide = nextWindow(MIN_WINDOW_BYTES, 120 * KB);
    assert.equal(nextWindow(wide, 20 * KB), wide);
  });

  it('is capped, so one pathological file cannot enlarge every later read', () => {
    assert.equal(nextWindow(MIN_WINDOW_BYTES, 8 * 1024 * KB), MAX_WINDOW_BYTES);
  });

  it('holds still when a batch found no thumbnail at all', () => {
    // A batch of raw: every file declined, and nothing was learnt either way.
    assert.equal(nextWindow(MIN_WINDOW_BYTES, 0), MIN_WINDOW_BYTES);
  });

  it('settles after one batch rather than creeping up', () => {
    // It reads the end offset exactly, so there is nothing to converge towards.
    const first = nextWindow(MIN_WINDOW_BYTES, 92 * KB);
    assert.equal(nextWindow(first, 92 * KB), first);
  });
});
