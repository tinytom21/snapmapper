import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { readThumbnails } from '../src/read-thumbnails.ts';
import { MIN_WINDOW_BYTES, nextWindow } from '../src/thumbnail-window.ts';
import type { FileStore, FolderHandle, PhotoRef } from '@snapmapper/core';

/**
 * The second read is the cost, and this is the proof it goes away.
 *
 * Measured on a Galaxy S23 reading its own JPEGs: 1.75 reads per photograph, 107 ms per call, and
 * therefore 187 ms per photograph — *slower on internal storage than the same phone managed on an
 * SD card*, purely because three quarters of its files needed a second round trip. Its thumbnail is
 * about 53KB and the head window was 48KB.
 *
 * So what is checked here is not a timing, which this machine cannot produce honestly, but the
 * thing the timing is made of: **how many reads each photograph takes.**
 */

const folder: FolderHandle = { id: 'f1', displayName: 'DCIM' };

/** A JPEG whose embedded thumbnail ends well past the default window. */
function jpegWithDeepThumbnail(thumbnailBytes: number): Uint8Array {
  const thumbnail = new Uint8Array(thumbnailBytes);
  thumbnail.set([0xff, 0xd8], 0);
  thumbnail.set([0xff, 0xd9], thumbnailBytes - 2);

  const ifd0At = 8;
  const ifd1At = ifd0At + 2 + 12 + 4;
  const thumbAt = ifd1At + 2 + 24 + 4;

  const tiff = new Uint8Array(thumbAt + thumbnailBytes);
  const view = new DataView(tiff.buffer);
  view.setUint16(0, 0x4949);
  view.setUint16(2, 42, true);
  view.setUint32(4, ifd0At, true);

  // IFD0: one harmless entry, then the link to IFD1.
  view.setUint16(ifd0At, 1, true);
  view.setUint16(ifd0At + 2, 0x011a, true);
  view.setUint16(ifd0At + 4, 3, true);
  view.setUint32(ifd0At + 6, 1, true);
  view.setUint32(ifd0At + 10, 0, true);
  view.setUint32(ifd0At + 14, ifd1At, true);

  // IFD1: where the thumbnail is, and how long.
  view.setUint16(ifd1At, 2, true);
  view.setUint16(ifd1At + 2, 0x0201, true);
  view.setUint16(ifd1At + 4, 4, true);
  view.setUint32(ifd1At + 6, 1, true);
  view.setUint32(ifd1At + 10, thumbAt, true);
  view.setUint16(ifd1At + 14, 0x0202, true);
  view.setUint16(ifd1At + 16, 4, true);
  view.setUint32(ifd1At + 18, 1, true);
  view.setUint32(ifd1At + 22, thumbnailBytes, true);
  view.setUint32(ifd1At + 26, 0, true);
  tiff.set(thumbnail, thumbAt);

  const payload = new Uint8Array(6 + tiff.byteLength);
  payload.set([0x45, 0x78, 0x69, 0x66, 0, 0], 0);
  payload.set(tiff, 6);

  // SOI, APP1, its length, the payload, then enough scan data that even a large window is a
  // fraction of the file — otherwise "one read" would be true only because there is nothing else.
  const body = new Uint8Array(400_000);
  const out = new Uint8Array(2 + 2 + 2 + payload.byteLength + body.byteLength);
  out.set([0xff, 0xd8, 0xff, 0xe1], 0);
  new DataView(out.buffer).setUint16(4, payload.byteLength + 2);
  out.set(payload, 6);
  out.set(body, 6 + payload.byteLength);
  return out;
}

/** A store that answers from bytes and, crucially, counts the round trips. */
function countingStore(bytes: Uint8Array): FileStore & { reads: number[] } {
  const reads: number[] = [];
  return {
    reads,
    async read() { reads.push(bytes.byteLength); return bytes; },
    async readHead(_ref: PhotoRef, length: number) {
      reads.push(length);
      return bytes.subarray(0, Math.min(length, bytes.byteLength));
    },
    async readRange(_ref: PhotoRef, start: number, end: number) {
      reads.push(end - start);
      return bytes.subarray(start, Math.min(end, bytes.byteLength));
    },
    async write() { throw new Error('not used'); },
    async list() { return []; },
  } as unknown as FileStore & { reads: number[] };
}

const refs = (count: number): PhotoRef[] => Array.from({ length: count }, (_, i) => ({
  folder,
  name: `DSC0${1000 + i}.JPG`,
  sizeBytes: 400_000,
  modifiedAtMs: 0,
  locator: `DSC0${1000 + i}.JPG`,
}));

const noRunner = async () => undefined;

describe('a thumbnail that does not fit the window', () => {
  /*
   * Driven from an explicitly small window rather than from `MIN_WINDOW_BYTES`, because the start
   * has since been raised to 80KB and this camera's thumbnail now fits it — see the suite below.
   * What is being pinned here is the mechanism, which still has to work for whatever camera turns
   * up next.
   */
  const SMALL = 48 * 1024;
  const bytes = jpegWithDeepThumbnail(60 * 1024);

  it('costs two reads per photograph before anything has been learnt', async () => {
    const store = countingStore(bytes);
    const batch = await readThumbnails(refs(8), store, noRunner, SMALL);

    assert.equal(batch.timing.reads, 16, 'eight photographs, two round trips each');
    assert.equal(batch.results.filter((r) => r.bytes).length, 8, 'and every picture found');
  });

  it('costs one read per photograph once the window has been fitted', async () => {
    const first = await readThumbnails(refs(8), countingStore(bytes), noRunner, SMALL);
    const fitted = nextWindow(SMALL, first.timing.deepestEnd);

    const store = countingStore(bytes);
    const second = await readThumbnails(refs(8), store, noRunner, fitted);

    assert.equal(second.timing.reads, 8, 'one round trip each, which is the whole saving');
    assert.equal(second.results.filter((r) => r.bytes).length, 8);
  });

  it('finds the same pictures either way, byte for byte', async () => {
    // The window is a performance choice and must not be able to change the answer.
    const small = await readThumbnails(refs(3), countingStore(bytes), noRunner, SMALL);
    const large = await readThumbnails(refs(3), countingStore(bytes), noRunner, 256 * 1024);

    for (const [i, result] of small.results.entries()) {
      assert.deepEqual(result.bytes, large.results[i]?.bytes, result.name);
    }
  });

  it('reports where the deepest thumbnail ended, which is what tunes the next batch', async () => {
    const batch = await readThumbnails(refs(2), countingStore(bytes), noRunner, SMALL);
    assert.ok(
      batch.timing.deepestEnd > SMALL,
      `${batch.timing.deepestEnd} should exceed the window that failed to hold it`,
    );
  });
});

describe('the cameras actually measured, from the first batch', () => {
  /*
   * Both of the user's devices tuned themselves to 80KB and then stayed there, so that is where the
   * window now starts and neither should ever need a second read. The deepest ends came back as
   * 60KB from a Galaxy S23's own JPEGs and 51KB from an A6400 card.
   */
  for (const [camera, thumbnail] of [['a Galaxy S23', 53], ['an A6400', 45]] as const) {
    it(`takes one read per photograph on ${camera}, with no learning phase`, async () => {
      const store = countingStore(jpegWithDeepThumbnail(thumbnail * 1024));
      const batch = await readThumbnails(refs(8), store, noRunner, MIN_WINDOW_BYTES);

      assert.equal(batch.timing.reads, 8, 'one round trip each, from the very first batch');
      assert.equal(batch.results.filter((r) => r.bytes).length, 8);
      // And nothing grows: more bytes for no fewer round trips is the wrong trade.
      assert.equal(nextWindow(MIN_WINDOW_BYTES, batch.timing.deepestEnd), MIN_WINDOW_BYTES);
    });
  }
});
