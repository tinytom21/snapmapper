/**
 * Does reading the embedded thumbnail by hand give the same bytes as ExifTool?
 *
 * The thumbnail feed in the chooser was costing ~45 ms per photograph even batched, all of it on
 * the main thread, because every picture meant an ExifTool invocation. `embeddedThumbnail` follows
 * two offsets in the EXIF block instead — but "follows two offsets" is exactly the kind of claim
 * that is right on the file you tested and wrong on the next one, so this checks it against the
 * real thing on every fixture, byte for byte.
 *
 * A mismatch here would show up as the wrong picture in a chooser, which is a quiet enough failure
 * to be worth a loud test.
 *
 *   npm run thumb --workspace spike
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { embeddedThumbnail, THUMBNAIL_HEAD_BYTES, createWasmBackend, readThumbnail } from '@snapmapper/core';

import { isMain, listFixtures, note, section } from './support.mjs';

export async function verifyThumbnails() {
  section('Hand-read thumbnails against ExifTool, on real files');

  const fixtures = await listFixtures();
  if (fixtures.length === 0) {
    note('No fixtures in spike/fixtures/. Copy real A6400 files in first.');
    return;
  }

  const wasm = await import('@uswriting/exiftool');
  const backend = createWasmBackend(wasm);

  let checks = 0;
  let failures = 0;
  let handMs = 0;
  let toolMs = 0;
  let handled = 0;

  for (const file of fixtures) {
    const name = path.basename(file);
    const whole = new Uint8Array(await readFile(file));
    // Only the head, exactly as the app reads it.
    const head = whole.subarray(0, THUMBNAIL_HEAD_BYTES);

    const started = performance.now();
    const mine = embeddedThumbnail(head);
    handMs += performance.now() - started;

    let theirs;
    const toolStarted = performance.now();
    try {
      theirs = await readThumbnail(backend, whole, name);
    } catch (error) {
      theirs = undefined;
    }
    toolMs += performance.now() - toolStarted;

    checks += 1;
    if (!theirs || theirs.length === 0) {
      // ExifTool found nothing; the hand reader must not invent something.
      if (mine === undefined) {
        console.log(`  ok    ${name}: neither found a thumbnail`);
      } else {
        failures += 1;
        console.log(`  FAIL  ${name}: hand reader produced ${mine.length} bytes, ExifTool none`);
      }
      continue;
    }

    if (mine === undefined) {
      // Allowed, and the reason the fallback exists — but worth seeing which formats need it.
      console.log(`  --    ${name}: hand reader declined, falls back to ExifTool (${theirs.length} bytes)`);
      continue;
    }

    handled += 1;
    const same = mine.length === theirs.length && mine.every((b, i) => b === theirs[i]);
    if (!same) {
      failures += 1;
      console.log(`  FAIL  ${name}: ${mine.length} bytes vs ExifTool's ${theirs.length}, not identical`);
    } else {
      console.log(`  ok    ${name}: ${mine.length} bytes, byte-identical to ExifTool`);
    }
  }

  section('Cost');
  note(`hand:     ${handMs.toFixed(1)} ms for ${fixtures.length} files `
    + `(${(handMs / fixtures.length).toFixed(3)} ms each)`);
  note(`ExifTool: ${toolMs.toFixed(0)} ms for ${fixtures.length} files `
    + `(${(toolMs / fixtures.length).toFixed(0)} ms each, one at a time)`);

  section('Verdict');
  note(`${checks} files, ${handled} read by hand, ${failures} failures.`);
  if (failures > 0) process.exitCode = 1;
}

if (isMain(import.meta.url)) await verifyThumbnails();
