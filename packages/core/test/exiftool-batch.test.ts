/**
 * Matching batched results back to the photographs they came from.
 *
 * Every test here is about the same failure: metadata attached to the wrong picture. That is the
 * worst bug this application can have and the one with no symptom — the app loads quickly and puts
 * a few photographs in the wrong place, which looks like the camera clock being off rather than
 * like a defect.
 *
 * The equivalence of batched and single-file reads is proved against real A6400 files by
 * `spike/src/batch-verify.mjs` (93 checks, 0 failures). These pin the shapes that spike found, so
 * that a change here fails in a second rather than needing a Perl interpreter and a camera card.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { errorsByPath, readManyTags, type BatchRun, type BatchRunner } from '../src/exiftool-batch.ts';

/** A runner that replays a canned invocation, so the mapping is what is under test. */
function fakeRunner(reply: (paths: string[]) => Omit<BatchRun, 'paths'>): BatchRunner {
  return {
    async run(files) {
      const paths = files.map((file, index) => `/${index}_${file.name}`);
      return { ...reply(paths), paths };
    },
  };
}

function bytes(): Uint8Array {
  return new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
}

const THREE = [
  { name: 'a.jpg', bytes: bytes() },
  { name: 'b.jpg', bytes: bytes() },
  { name: 'c.jpg', bytes: bytes() },
];

describe('readManyTags', () => {
  it('returns one result per file, in the order given', async () => {
    const runner = fakeRunner((paths) => ({
      stdout: JSON.stringify(paths.map((path, index) => ({
        SourceFile: path,
        'EXIF:Model': `model-${index}`,
      }))),
      stderr: '',
      exitCode: 0,
    }));

    const results = await readManyTags(runner, THREE, ['EXIF:Model']);

    assert.equal(results.length, 3);
    assert.deepEqual(
      results.map((result) => (result.ok ? result.tags['EXIF:Model'] : result.error)),
      ['model-0', 'model-1', 'model-2'],
    );
  });

  it('matches by SourceFile when ExifTool reorders the records', async () => {
    /*
     * ExifTool is not documented to preserve input order, and nothing about the way it walks an
     * argument list guarantees it. Matching by index would be correct today and wrong on a version
     * bump, with no test failing and no user-visible symptom until somebody noticed a photograph
     * on the wrong hillside.
     */
    const runner = fakeRunner((paths) => ({
      stdout: JSON.stringify([
        { SourceFile: paths[2], 'EXIF:Model': 'third' },
        { SourceFile: paths[0], 'EXIF:Model': 'first' },
        { SourceFile: paths[1], 'EXIF:Model': 'second' },
      ]),
      stderr: '',
      exitCode: 0,
    }));

    const results = await readManyTags(runner, THREE, ['EXIF:Model']);

    assert.deepEqual(
      results.map((result) => (result.ok ? result.tags['EXIF:Model'] : 'failed')),
      ['first', 'second', 'third'],
    );
  });

  it('keeps the good files when one in the middle is corrupt', async () => {
    /*
     * The measured shape, from `spike/src/batch-read.mjs`: five files in, five records out, exit
     * code 1, and stderr naming the culprit. The exit code describes the batch, not any one file,
     * so treating non-zero as total failure would discard four intact photographs.
     */
    const runner = fakeRunner((paths) => ({
      stdout: JSON.stringify([
        { SourceFile: paths[0], 'EXIF:Model': 'first' },
        // The corrupt one still gets a record — with nothing whatsoever in it.
        { SourceFile: paths[1] },
        { SourceFile: paths[2], 'EXIF:Model': 'third' },
      ]),
      stderr: `Error: File format error - ${paths[1] as string}\n    3 image files read\n`,
      exitCode: 1,
    }));

    const results = await readManyTags(runner, THREE, ['EXIF:Model']);

    assert.equal(results[0]?.ok, true);
    assert.equal(results[2]?.ok, true);

    const middle = results[1];
    assert.equal(middle?.ok, false);
    // Reported with ExifTool's own words, and naming the file rather than the batch.
    assert.match(middle.ok === false ? middle.error : '', /File format error/);
  });

  it('treats a record holding only SourceFile as a failure', async () => {
    /*
     * The trap the single-file path does not have. The wrapper treats any stderr as a failure and
     * throws, so one at a time this file never reaches the caller; batched it arrives as an empty
     * record. Read as success it would list as a photograph that merely has no date — and the user
     * would place it by hand and discover the problem at the point of writing.
     */
    const runner = fakeRunner((paths) => ({
      stdout: JSON.stringify([{ SourceFile: paths[0] }]),
      stderr: '',
      exitCode: 0,
    }));

    const results = await readManyTags(runner, [THREE[0] as never], ['EXIF:Model']);
    assert.equal(results[0]?.ok, false);
  });

  it('lifts the thumbnail out of the tag values', async () => {
    // Left among the tags it is a several-kilobyte string that every session copy would carry.
    const runner = fakeRunner((paths) => ({
      stdout: JSON.stringify([{
        SourceFile: paths[0],
        'EXIF:Model': 'a6400',
        // "hi" in base64.
        'EXIF:ThumbnailImage': 'base64:aGk=',
      }]),
      stderr: '',
      exitCode: 0,
    }));

    const results = await readManyTags(runner, [THREE[0] as never]);
    const first = results[0];

    assert.equal(first?.ok, true);
    if (first.ok !== true) return;
    assert.deepEqual([...(first.thumbnail ?? [])], [0x68, 0x69]);
    assert.equal(first.tags['EXIF:ThumbnailImage'], undefined);
    assert.equal(first.tags['EXIF:Model'], 'a6400');
  });

  it('fails every file when there was no output at all', async () => {
    // The one case that really is a whole-batch failure: ExifTool did not get far enough to report
    // on anything. The caller retries these one at a time.
    const runner = fakeRunner(() => ({
      stdout: '',
      stderr: 'zeroperl exploded',
      exitCode: 2,
    }));

    const results = await readManyTags(runner, THREE);
    assert.equal(results.length, 3);
    assert.ok(results.every((result) => !result.ok));
  });

  it('does not invoke anything for an empty batch', async () => {
    let called = false;
    const runner: BatchRunner = {
      async run() {
        called = true;
        return { stdout: '', stderr: '', paths: [], exitCode: 0 };
      },
    };

    assert.deepEqual(await readManyTags(runner, []), []);
    assert.equal(called, false);
  });

  it('refuses a Blob, as the whole write path does', async () => {
    // Rule 1: zeroperl reads a Blob one slice per syscall, ~69x slower on a phone, and the only
    // symptom is slowness — so nothing else would ever catch it.
    const runner = fakeRunner(() => ({ stdout: '[]', stderr: '', exitCode: 0 }));

    await assert.rejects(
      () => readManyTags(runner, [{ name: 'a.jpg', bytes: 'not bytes' as never }]),
      /Uint8Array/,
    );
  });
});

describe('errorsByPath', () => {
  it('attributes an error line to the file it names', () => {
    const found = errorsByPath('Error: File format error - /2_broken.jpg\n    5 image files read\n');

    assert.match(found.get('/2_broken.jpg') ?? '', /File format error/);
    // The tally is about the batch, not about any one file.
    assert.equal(found.size, 1);
  });

  it('ignores a line that names no file', () => {
    assert.equal(errorsByPath('something went wrong').size, 0);
  });

  it('keeps the first line about a file, not the last', () => {
    // The first is the cause; anything after it tends to be a consequence.
    const found = errorsByPath(
      'Error: File format error - /0_a.jpg\nWarning: giving up - /0_a.jpg\n',
    );
    assert.match(found.get('/0_a.jpg') ?? '', /File format error/);
  });
});
