/**
 * Can the app read an ARW's metadata the way it reads a JPEG's?
 *
 * The sidecar write path never touches the raw file, so it was provable without one. *Reading* is
 * the other half and could not be checked at all until now: the date, any coordinates already in
 * the file and the thumbnail all come from `readTagsAndThumbnail` over the first **1MB** of the
 * file, and that number was chosen for a JPEG.
 *
 * Two reasons it might not carry over, and both are structural rather than a matter of luck:
 *
 *   - **ARW is TIFF, not JPEG.** `buildHeaderStub` walks JPEG segment markers looking for the start
 *     of scan; there is no such thing here, so `headerOnly` falls back to handing over whatever
 *     bytes it was given. Fine — but it means the 1MB is doing all the work.
 *   - **A TIFF's IFDs point anywhere in the file.** Sony embeds a large JPEG preview, and in a JPEG
 *     that preview turned out to sit 94% of the way in. If the ARW's thumbnail is past the first
 *     megabyte, the list shows a blank tile; if the *date* is out there, the photograph cannot be
 *     placed by a track at all.
 *
 * So this asks what each head size actually yields, against native ExifTool over the whole file as
 * the ground truth.
 *
 *   npm run arw --workspace spike
 */

import { open, readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { readdir } from 'node:fs/promises';

import { readTagsAndThumbnail, createWasmBackend } from '@snapmapper/core';

import { patchZeroperl } from './patch-zeroperl.mjs';
import { isMain, note, section } from './support.mjs';

const run = promisify(execFile);
const FIXTURES = path.join(process.cwd(), 'fixtures');

/** Exactly what `load-photos.ts` asks for. */
const WANTED = [
  'EXIF:DateTimeOriginal', 'EXIF:CreateDate', 'EXIF:Orientation',
  'EXIF:Make', 'EXIF:Model',
  'Composite:GPSLatitude', 'Composite:GPSLongitude', 'Composite:GPSAltitude',
];

/** The size `load-photos.ts` reads. Everything else here is context for it. */
const APP_HEAD = 1024 * 1024;

function exifToolPath() {
  return process.env.EXIFTOOL
    ?? path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'ExifTool', 'exiftool.exe');
}

async function head(file, bytes) {
  const handle = await open(file, 'r');
  try {
    const size = (await handle.stat()).size;
    const take = Math.min(bytes, size);
    const buffer = new Uint8Array(take);
    await handle.read(buffer, 0, take, 0);
    return buffer;
  } finally {
    await handle.close();
  }
}

export async function verifyArwRead() {
  section('Reading an ARW');

  const names = (await readdir(FIXTURES)).filter((name) => /\.arw$/i.test(name));
  const file = names[0] && path.join(FIXTURES, names[0]);
  if (!file) {
    note('No .ARW in spike/fixtures/. Drop one in — a copy, never the only one.');
    return;
  }

  const size = (await readFile(file)).length;
  note(`${names[0]} — ${(size / 1e6).toFixed(1)}MB`);

  section('Ground truth, from native ExifTool over the whole file');
  let truth;
  try {
    const { stdout } = await run(exifToolPath(), [
      '-json', '-n', '-G', ...WANTED.map((t) => `-${t}`), '-ThumbnailImage', '-PreviewImage', file,
    ], { maxBuffer: 64 * 1024 * 1024 });
    truth = JSON.parse(stdout)[0];
  } catch (error) {
    note(`Could not run native ExifTool: ${error.message}`);
    return;
  }

  for (const [tag, value] of Object.entries(truth)) {
    if (tag === 'SourceFile') continue;
    const shown = typeof value === 'string' && value.startsWith('base64:')
      ? `<${value.length} chars of base64>`
      : value;
    console.log(`  ${tag}: ${shown}`);
  }

  await patchZeroperl();
  const wasm = await import('@uswriting/exiftool');
  const backend = createWasmBackend(wasm);

  section('What each head size yields through the app’s own reader');
  const rows = [];
  for (const bytes of [256 * 1024, APP_HEAD, 4 * 1024 * 1024, size]) {
    const slice = await head(file, bytes);
    const started = performance.now();

    let result;
    try {
      result = await readTagsAndThumbnail(backend, slice, names[0], WANTED);
    } catch (error) {
      rows.push({ bytes, failed: error instanceof Error ? error.message : String(error) });
      console.log(`  ${(bytes / 1e6).toFixed(1).padStart(5)}MB  FAILED: ${rows.at(-1).failed}`);
      continue;
    }

    const elapsed = performance.now() - started;
    const row = {
      bytes,
      elapsed,
      date: result.tags['EXIF:DateTimeOriginal'],
      model: result.tags['EXIF:Model'],
      latitude: result.tags['Composite:GPSLatitude'],
      thumbnail: result.thumbnail?.length ?? 0,
    };
    rows.push(row);

    console.log(
      `  ${(bytes / 1e6).toFixed(1).padStart(5)}MB  ${elapsed.toFixed(0).padStart(5)} ms  `
      + `date ${row.date ?? '—'}  model ${row.model ?? '—'}  `
      + `thumb ${row.thumbnail ? `${(row.thumbnail / 1024).toFixed(0)}KB` : 'NONE'}`
      + `${bytes === APP_HEAD ? '   <- what the app reads' : ''}`,
    );
  }

  section('Verdict for the shipped path');
  const app = rows.find((row) => row.bytes === APP_HEAD);
  let failures = 0;

  const check = (ok, good, bad) => {
    console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${ok ? good : bad}`);
    if (!ok) failures += 1;
  };

  if (!app || app.failed) {
    check(false, '', `the 1MB head could not be read at all: ${app?.failed}`);
  } else {
    check(
      String(app.date) === String(truth['EXIF:DateTimeOriginal']),
      `date matches native ExifTool (${app.date})`,
      `date is ${app.date}, native says ${truth['EXIF:DateTimeOriginal']}`,
    );
    check(
      String(app.model) === String(truth['EXIF:Model']),
      `model matches (${app.model})`,
      `model is ${app.model}, native says ${truth['EXIF:Model']}`,
    );
    check(
      String(app.latitude) === String(truth['Composite:GPSLatitude']),
      `coordinates agree (${app.latitude ?? 'none in the file'})`,
      `coordinates are ${app.latitude}, native says ${truth['Composite:GPSLatitude']}`,
    );

    // The thumbnail is cosmetic — a missing one is a blank tile, not a wrong answer — so it is
    // reported separately rather than counted as a failure.
    note(app.thumbnail
      ? `  Thumbnail: ${(app.thumbnail / 1024).toFixed(0)}KB from the first megabyte.`
      : '  Thumbnail: NOT in the first megabyte. The list will show a blank tile for raw files. '
        + 'Not a wrong answer, but worth knowing.');
  }

  note(`${failures} failure(s).`);
  if (failures > 0) process.exitCode = 1;
}

if (isMain(import.meta.url)) await verifyArwRead();
