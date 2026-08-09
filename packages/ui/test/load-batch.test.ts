/**
 * `loadPhotos` with batching on.
 *
 * The equivalence of batched and single-file reads is proved against real A6400 files by
 * `spike/src/batch-verify.mjs`. What is left for here is the orchestration around it, and every
 * case is about the same principle: **batching is an optimisation over a path that already works,
 * so no failure of it may cost a photograph.**
 *
 * That is why the fallback is per photograph rather than per batch. A card usually has either no
 * bad frames or several, and retrying sixteen because one was unreadable would throw away the
 * whole win exactly when it is needed.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { BatchRunner, FileStore, FolderHandle, PhotoRef } from '@snapmapper/core';

import { loadPhotos } from '../src/load-photos.ts';

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);

const folder: FolderHandle = { id: 'f1', displayName: '100MSDCF' };

function ref(name: string): PhotoRef {
  return { folder, name, sizeBytes: JPEG.length, modifiedAtMs: 0, locator: name };
}

function store(): FileStore {
  return {
    async read() { return JPEG; },
    async readHead() { return JPEG; },
  } as unknown as FileStore;
}

/** A backend that answers the one-at-a-time path, so a fallback is observable. */
function singleBackend(calls: string[]) {
  return {
    async read(input: { name: string }) {
      calls.push(input.name);
      return {
        ok: true,
        data: JSON.stringify([{
          SourceFile: `/${input.name}`,
          'EXIF:DateTimeOriginal': '2024:07:01 12:00:00',
          'EXIF:Model': 'single',
        }]),
        message: undefined,
      };
    },
    async write() {
      throw new Error('not used');
    },
  } as never;
}

/** A runner whose answer for each file is decided by the test. */
function runnerReturning(
  decide: (name: string, index: number) => Record<string, unknown> | undefined,
  seen?: number[],
): BatchRunner {
  return {
    async run(files) {
      seen?.push(files.length);
      const paths = files.map((file, index) => `/${index}_${file.name}`);
      const records = files
        .map((file, index) => {
          const record = decide(file.name, index);
          return record ? { SourceFile: paths[index], ...record } : undefined;
        })
        .filter((record) => record !== undefined);

      return { stdout: JSON.stringify(records), stderr: '', paths, exitCode: 0 };
    },
  };
}

const GOOD = { 'EXIF:DateTimeOriginal': '2024:07:01 12:00:00', 'EXIF:Model': 'batched' };

describe('loadPhotos with a batch runner', () => {
  it('reads everything in one invocation, and does not touch the single-file path', async () => {
    const calls: string[] = [];
    const sizes: number[] = [];
    const refs = ['a.jpg', 'b.jpg', 'c.jpg', 'd.jpg'].map(ref);

    const { entries } = await loadPhotos(
      refs, store(), singleBackend(calls), undefined, runnerReturning(() => GOOD, sizes),
    );

    assert.deepEqual(sizes, [4], 'should have been one invocation for all four');
    assert.deepEqual(calls, [], 'nothing should have fallen back');
    assert.equal(entries.length, 4);
    assert.equal(entries[0]?.takenAt?.year, 2024);
  });

  it('retries only the photograph the batch could not read', async () => {
    /*
     * The measured shape: ExifTool returns a record for every file it *could* read and one holding
     * only `SourceFile` for one it could not, exiting 1 for the batch as a whole. Falling back for
     * the whole batch here would be four wasted invocations to recover one photograph.
     */
    const calls: string[] = [];
    const refs = ['a.jpg', 'bad.jpg', 'c.jpg'].map(ref);

    const { entries } = await loadPhotos(
      refs, store(), singleBackend(calls), undefined,
      runnerReturning((name) => (name === 'bad.jpg' ? undefined : GOOD)),
    );

    assert.deepEqual(calls, ['bad.jpg'], 'only the unreadable one should have been retried');
    assert.equal(entries.length, 3);
    // And the retry succeeded, so it is an ordinary photograph rather than a failure.
    assert.equal(entries[1]?.error, undefined);
    assert.equal(entries[1]?.ref.name, 'bad.jpg');
  });

  it('keeps every photograph when the runner throws outright', async () => {
    // A dead interpreter, or an out-of-memory on a phone. The folder must still load.
    const calls: string[] = [];
    const refs = ['a.jpg', 'b.jpg', 'c.jpg'].map(ref);

    const dead: BatchRunner = {
      async run() { throw new Error('interpreter gone'); },
    };

    const { entries } = await loadPhotos(refs, store(), singleBackend(calls), undefined, dead);

    assert.deepEqual(calls, ['a.jpg', 'b.jpg', 'c.jpg']);
    assert.equal(entries.length, 3);
    assert.ok(entries.every((entry) => entry.error === undefined));
  });

  it('keeps results in the order the photographs were given', async () => {
    /*
     * With a failure in the middle, the batch returns fewer records than files — the exact
     * condition under which matching by position misattributes everything after it. A date landing
     * on the wrong photograph has no symptom at all; it just ends up somewhere plausible and wrong.
     */
    const refs = ['a.jpg', 'bad.jpg', 'c.jpg', 'd.jpg'].map(ref);

    const { entries } = await loadPhotos(
      refs, store(), singleBackend([]), undefined,
      runnerReturning((name) => (name === 'bad.jpg' ? undefined : {
        ...GOOD, 'EXIF:Model': `model-of-${name}`,
      })),
    );

    assert.deepEqual(
      entries.map((entry) => entry.ref.name),
      ['a.jpg', 'bad.jpg', 'c.jpg', 'd.jpg'],
    );
  });

  it('splits a large folder into batches and finishes the progress bar', async () => {
    const sizes: number[] = [];
    const refs = Array.from({ length: 35 }, (_, index) => ref(`p${index}.jpg`));
    const seen: number[] = [];

    const { entries } = await loadPhotos(
      refs, store(), singleBackend([]),
      (progress) => seen.push(progress.done),
      runnerReturning(() => GOOD, sizes),
    );

    assert.equal(entries.length, 35);
    assert.deepEqual(sizes, [16, 16, 3], 'batches of sixteen, and the remainder');
    assert.equal(seen.at(-1), 35, 'the bar must reach the total');
  });

  it('is off entirely when the runner is null', async () => {
    // What the browser does when the script or zeroperl could not be loaded, and what the rest of
    // the test suite relies on to exercise the original path.
    const calls: string[] = [];
    const { entries } = await loadPhotos(
      ['a.jpg', 'b.jpg'].map(ref), store(), singleBackend(calls), undefined, null,
    );

    assert.deepEqual(calls, ['a.jpg', 'b.jpg']);
    assert.equal(entries.length, 2);
  });
});
