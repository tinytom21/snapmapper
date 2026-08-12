import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { NOTHING, addBatch, report, type Totals } from '../src/diagnostics.ts';
import type { BatchTiming } from '../src/read-thumbnails.ts';

/**
 * The report exists because two performance faults in a row were invisible on this machine.
 *
 * Both were the same shape — a file access awaited inside a loop — and both looked perfect on a
 * desktop with the files on an SSD. What is tested here is the *verdict*, since that is the line
 * that has to point at the right stage on hardware nobody here can attach to.
 */

function batch(over: Partial<BatchTiming> = {}): BatchTiming {
  return {
    files: 16, readMs: 20, parseMs: 2, exifMs: 0, fast: 16, slow: 0,
    bytesRead: 16 * 48 * 1024, reads: 16, window: 48 * 1024, deepestEnd: 44 * 1024, ...over,
  };
}

const facts = { summary: 'test', cores: '8', memory: '8 GB or more' };


/** The one line the report exists for, pulled out by name. */
function verdictLine(totals: Totals): string {
  return report(totals, facts).split(String.fromCharCode(10))
    .find((line) => line.includes('verdict')) ?? '';
}

describe('accumulating batches', () => {
  it('sums every stage across batches', () => {
    const totals = addBatch(addBatch(NOTHING, batch()), batch());
    assert.equal(totals.batches, 2);
    assert.equal(totals.files, 32);
    assert.equal(totals.readMs, 40);
    assert.equal(totals.fast, 32);
  });

  it('starts at nothing', () => {
    assert.equal(NOTHING.files, 0);
    assert.equal(NOTHING.batches, 0);
  });
});

describe('the verdict, which is the line that matters', () => {
  const verdictOf = (totals: Totals) =>
    report(totals, facts).split('\n').find((line) => line.includes('verdict')) ?? '';

  it('says reads are dominating when they are, which is the fault that shipped twice', () => {
    /*
     * The symptom of awaiting a file access inside a loop: reading takes tens of milliseconds per
     * photograph while the parse takes a fraction of one. On a desktop it is invisible; on a phone
     * reading a card it is the whole cost. Both `listFolder` and `readThumbnails` had it.
     */
    const serial = addBatch(NOTHING, batch({ readMs: 640, parseMs: 2 }));
    assert.match(verdictOf(serial), /reading dominates at 40 ms each/);
    assert.match(verdictOf(serial), /not overlapping/);
  });

  it('points at ExifTool when that is what is costing, not at the card', () => {
    // A raw-heavy folder, where the byte reader declines and the fallback is doing the work.
    const raw = addBatch(NOTHING, batch({ readMs: 30, exifMs: 700, fast: 0, slow: 16 }));
    assert.match(verdictOf(raw), /ExifTool dominates/);
  });

  it('says so plainly when everything is as it should be', () => {
    assert.match(verdictOf(addBatch(NOTHING, batch())), /as expected/);
  });

  it('does not divide by zero before anything has run', () => {
    assert.match(verdictOf(NOTHING), /nothing measured yet/);
  });
});

describe('the report itself', () => {
  it('gives per-photograph figures, not just totals', () => {
    // The totals scale with how much was looked at; the per-photograph ones are what can be
    // compared against the numbers written down in CLAUDE.md.
    const text = report(addBatch(NOTHING, batch({ files: 10, readMs: 100 })), facts);
    assert.match(text, /10\.00 ms each/);
  });

  it('reports the bytes pulled off the card, which is the lever on a phone', () => {
    // Reading is the whole cost there — 128 ms a photograph against 0.01 ms to parse — and it does
    // not overlap, so the only thing that can be improved is how much is asked for.
    const text = report(addBatch(NOTHING, batch({ files: 10, bytesRead: 10 * 22 * 1024 })), facts);
    assert.match(text, /bytes read {4}0\.2 MB total, 22 KB each/);
  });

  it('reports reads separately from bytes, since they point at different fixes', () => {
    /*
     * There is no way to tell from here whether a slow card charges per round trip or per byte.
     * If the cost tracks the calls, fewer and larger reads win; if it tracks the bytes, smaller
     * windows win. Reporting both means the next paste from a real device settles it.
     */
    const text = report(addBatch(NOTHING, batch({ files: 10, reads: 20, readMs: 400 })), facts);
    assert.match(text, /reads {9}20 calls, 20\.0 ms per call/);
  });

  it('separates what the byte reader answered from what ExifTool did', () => {
    const text = report(addBatch(NOTHING, batch({ fast: 12, slow: 4 })), facts);
    assert.match(text, /by byte read {2}12/);
    assert.match(text, /by ExifTool {3}4/);
  });

  it('is plain text, because it is pasted from a phone into a message', () => {
    const text = report(addBatch(NOTHING, batch()), facts);
    assert.doesNotMatch(text, /[<>{}]/);
  });
});

describe('the head window, which the round-trip finding made the lever', () => {
  /*
   * Two devices agreed: a read costs about 110 ms whether it carries 43KB or 128KB, so a head too
   * small to hold the thumbnail buys a second round trip and nearly doubles that photograph. The
   * report has to say what the window settled on, or the next paste cannot show whether the tuning
   * worked.
   */
  it('reports the window it settled on and what justified it', () => {
    const text = report(addBatch(NOTHING, batch({ window: 128 * 1024, deepestEnd: 100 * 1024 })), facts);
    assert.match(text, /head window {3}128 KB, deepest thumbnail ends at 100 KB/);
  });

  it('takes the largest window rather than summing them', () => {
    // The feed grows the window as it learns, so a total of every window it tried is meaningless.
    const grown = addBatch(addBatch(NOTHING, batch()), batch({ window: 128 * 1024 }));
    assert.equal(grown.window, 128 * 1024);
  });

  it('counts the second reads, which is the cost being removed', () => {
    const text = report(addBatch(NOTHING, batch({ files: 16, reads: 28 })), facts);
    assert.match(text, /second reads {2}12/);
  });

  it('names the second reads in the verdict, since that is the cause with a known fix', () => {
    const missing = addBatch(NOTHING, batch({ files: 16, reads: 28, readMs: 16 * 187 }));
    const line = verdictLine(missing);
    assert.match(line, /1\.75 reads per photograph/);
    assert.match(line, /head window is still too small/);
  });

  it('does not blame the window when there is one read per photograph', () => {
    const fine = addBatch(NOTHING, batch({ files: 16, reads: 16, readMs: 16 * 130 }));
    const line = verdictLine(fine);
    assert.doesNotMatch(line, /window/);
    assert.match(line, /not overlapping/);
  });

  it('never reports a negative count when a file was answered without any read', () => {
    const text = report(addBatch(NOTHING, batch({ files: 16, reads: 0 })), facts);
    assert.match(text, /second reads {2}0/);
  });
});
