import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { LOOKAHEAD, nextBatch, wantedSettled, type FeedState } from '../src/thumbnail-feed.ts';

/**
 * The order thumbnails are fetched in, which is the whole of the background feed's design.
 *
 * Worth pinning here because the failure is silent: an off-by-one leaves some photographs
 * permanently blank, and nobody looking at a half-filled grid can tell whether it is still working.
 */

function state(over: Partial<FeedState> = {}): FeedState {
  return {
    all: ['a', 'b', 'c', 'd', 'e'],
    wanted: new Set(),
    done: new Set(),
    inFlight: new Set(),
    ...over,
  };
}

describe('what to fetch next', () => {
  it('fetches what is on screen before anything else', () => {
    const batch = nextBatch(state({ wanted: new Set(['d', 'e']) }), 2);
    assert.deepEqual(batch, ['d', 'e']);
  });

  it('keeps list order within the visible set', () => {
    // So a day fills from the top down rather than arriving in scattered pieces.
    const batch = nextBatch(state({ wanted: new Set(['e', 'b', 'd']) }), 3);
    assert.deepEqual(batch, ['b', 'd', 'e']);
  });

  it('reaches a little past what is on screen, so a short scroll finds pictures ready', () => {
    const batch = nextBatch(state({ wanted: new Set(['c']), done: new Set(['c']) }), 3);
    assert.deepEqual(batch, ['a', 'b', 'd']);
  });

  it('stops after the lookahead rather than walking the whole folder', () => {
    /*
     * The measurement that decided this: ExifTool runs on the main thread and holds it for about
     * 700 ms per batch, so prefetching a 322-file card is fifteen seconds of a barely usable
     * interface spent on days nobody has opened. Two batches past the visible set, then stop.
     */
    const all = Array.from({ length: 500 }, (_, i) => `p${i}`);
    const batch = nextBatch({ all, wanted: new Set(), done: new Set(), inFlight: new Set() }, 1000);

    assert.equal(batch.length, LOOKAHEAD);
  });

  it('mixes visible and unvisible in one batch, visible first', () => {
    const batch = nextBatch(state({ wanted: new Set(['e']) }), 3);
    assert.deepEqual(batch, ['e', 'a', 'b']);
  });

  it('never repeats what is done or in flight', () => {
    const batch = nextBatch(state({ done: new Set(['a', 'c']), inFlight: new Set(['b']) }), 10);
    assert.deepEqual(batch, ['d', 'e']);
  });

  it('respects the batch size', () => {
    assert.equal(nextBatch(state(), 2).length, 2);
  });

  it('returns nothing when everything is spoken for', () => {
    const all = state({ done: new Set(['a', 'b', 'c']), inFlight: new Set(['d', 'e']) });
    assert.deepEqual(nextBatch(all, 10), []);
  });

  it('has nothing to do for an empty folder', () => {
    assert.deepEqual(nextBatch(state({ all: [] }), 10), []);
  });
});

describe('knowing when what is on screen is covered', () => {
  it('is not settled while a visible photograph is still in flight', () => {
    const running = state({ wanted: new Set(['d', 'e']), inFlight: new Set(['d', 'e']) });
    assert.deepEqual(nextBatch(running, 10, 0), []);
    assert.equal(wantedSettled(running), false);
  });

  it('is settled when every visible photograph has been tried', () => {
    // Tried, not succeeded: a file that failed is done, or the loop would retry it for ever.
    const covered = state({ wanted: new Set(['a', 'b']), done: new Set(['a', 'b']) });
    assert.equal(wantedSettled(covered), true);
  });

  it('is settled when nothing is on screen, which is the resting state', () => {
    /*
     * Resting, not finished. The feed never walks a whole card, so having nothing to do is normal
     * — the loop idles and waits for another day to be opened rather than stopping for good.
     */
    assert.equal(wantedSettled(state()), true);
  });
});
