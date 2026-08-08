/**
 * What it costs to *open* photographs, which is the slowest thing the app does.
 *
 * Everything else was measured during Phase 0; this was not, and it is the operation that shapes
 * the whole interface. Opening a card is roughly half a second per photo on a desktop and three on
 * a phone, which is why there is a file picker at all — a 1000-photo card would take the better
 * part of an hour, so the app works around the cost rather than paying it.
 *
 * Three things are compared, each against the same real A6400 files:
 *
 *   1. **whole file** — what the very first version did: push all 6MB through the WASM boundary.
 *   2. **header stub, two calls** — what ships today: `buildHeaderStub`, then one ExifTool
 *      invocation for the tags and a second for the thumbnail.
 *   3. **header stub, one call** — the proposal: ask for the tags *and* the thumbnail together.
 *
 * The question it answers is whether ExifTool's per-invocation cost dominates. If it does, halving
 * the number of invocations halves the wait, and batching several photos into one would matter far
 * more than anything else.
 *
 *   npm run load-cost --workspace spike
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { patchZeroperl } from './patch-zeroperl.mjs';
import { isMain, listFixtures, note, section } from './support.mjs';

/** The same tags the app asks for. A narrower request is less output to parse. */
const WANTED = [
  'EXIF:DateTimeOriginal',
  'EXIF:CreateDate',
  'EXIF:Orientation',
  'EXIF:Make',
  'EXIF:Model',
  'Composite:GPSLatitude',
  'Composite:GPSLongitude',
  'Composite:GPSAltitude',
];

/** JPEG start-of-scan. Everything after it is pixels, and no metadata reader needs them. */
function findScanStart(bytes) {
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) break;
    const marker = bytes[offset + 1];
    if (marker === 0xda) return offset;
    const length = (bytes[offset + 2] << 8) | bytes[offset + 3];
    offset += 2 + length;
  }
  return bytes.length;
}

/** The header, plus a minimal tail so the result is still a valid JPEG. */
function headerStub(bytes) {
  const scan = findScanStart(bytes);
  const stub = new Uint8Array(scan + 2);
  stub.set(bytes.subarray(0, scan));
  stub[scan] = 0xff;
  stub[scan + 1] = 0xd9;
  return stub;
}

/**
 * Time several variants against each other, honestly.
 *
 * The first attempt at this ran each variant in its own block and reported the mean of five, and
 * produced nonsense: reading tags *and* a thumbnail came out faster than reading tags alone, and a
 * 101KB stub slower than the 6.9MB file it came from. Both are impossible, so the numbers were
 * measuring something other than the work — warm-up, garbage collection, and whatever else drifts
 * over the seconds a block takes.
 *
 * So the variants are interleaved round-robin, and the **median** is reported rather than the mean.
 * Interleaving spreads any drift across all of them equally instead of loading it onto whichever
 * ran first; the median throws away the occasional outlier that a mean of five is at the mercy of.
 */
async function raceVariants(variants, runs) {
  const samples = new Map(variants.map(({ label }) => [label, []]));

  for (let round = 0; round < runs; round++) {
    for (const { label, work } of variants) {
      const started = performance.now();
      await work();
      samples.get(label).push(performance.now() - started);
    }
  }

  return variants.map(({ label }) => {
    const sorted = [...samples.get(label)].sort((a, b) => a - b);
    return {
      label,
      each: sorted[Math.floor(sorted.length / 2)],
      best: sorted[0],
      spread: sorted[sorted.length - 1] - sorted[0],
    };
  });
}

export async function measureLoadCost() {
  section('What it costs to open a photograph');

  const fixtures = await listFixtures();
  if (fixtures.length === 0) {
    note('No fixtures in spike/fixtures/. Copy a few real A6400 JPEGs in first.');
    return;
  }

  await patchZeroperl();
  const wasm = await import('@uswriting/exiftool');

  const file = fixtures[0];
  const bytes = new Uint8Array(await readFile(file));
  const stub = headerStub(bytes);
  const name = path.basename(file);

  note(`${name}: ${(bytes.length / 1e6).toFixed(1)}MB whole, `
    + `${(stub.length / 1024).toFixed(0)}KB as a header stub `
    + `(${(stub.length / bytes.length * 100).toFixed(1)}%)`);

  const run = (input, args) => wasm.parseMetadata({ name, data: input }, { args });

  const TAGS = ['-json', '-n', '-G', '-fast2', ...WANTED.map((tag) => `-${tag}`)];
  const THUMB = ['-json', '-b', '-G', '-fast2', '-ThumbnailImage'];
  const BOTH = ['-json', '-n', '-b', '-G', '-fast2',
    ...WANTED.map((tag) => `-${tag}`), '-ThumbnailImage'];

  // One untimed pass so the WASM module is warm and the first invocation's compile cost does not
  // land on whichever measurement happens to run first.
  await run(stub, TAGS);

  const results = await raceVariants([
    {
      label: 'whole file, two calls',
      work: async () => { await run(bytes, TAGS); await run(bytes, THUMB); },
    },
    {
      label: 'header stub, two calls  (ships today)',
      work: async () => { await run(stub, TAGS); await run(stub, THUMB); },
    },
    { label: 'header stub, one call   (proposed)', work: () => run(stub, BOTH) },
    { label: 'one call, tags only     (floor)', work: () => run(stub, TAGS) },
  ], 9);

  section('Per photograph, median of 9 interleaved runs');
  const slowest = Math.max(...results.map((one) => one.each));
  for (const { label, each, best, spread } of results) {
    const bar = '█'.repeat(Math.round(each / slowest * 26));
    console.log(`  ${label.padEnd(38)} ${each.toFixed(0).padStart(5)} ms  ${bar}`);
    console.log(`  ${' '.repeat(38)} ${`best ${best.toFixed(0)}, spread ${spread.toFixed(0)}`.padStart(5)}`);
  }

  const today = results[1].each;
  const proposed = results[2].each;
  note('');
  note(`Merging the two calls: ${(today / proposed).toFixed(2)}x faster per photo.`);
  note(`A 200-photo card: ${(today * 200 / 1000).toFixed(0)}s today, `
    + `${(proposed * 200 / 1000).toFixed(0)}s merged — and roughly six times those figures `
    + 'on a phone.');

  // Does the *content* matter, or is the cost fixed per invocation? If a 100KB stub and a 6MB
  // file cost the same, then the invocation is the whole cost and batching is the real lever.
  const perByte = results[0].each - results[1].each;
  note(`Pushing 6MB rather than ${(stub.length / 1024).toFixed(0)}KB costs `
    + `${perByte.toFixed(0)} ms of the total, so the rest is fixed per invocation.`);

  // Verify the merged call actually returns both things, or the speed is meaningless.
  const merged = await run(stub, BOTH);
  const parsed = JSON.parse(merged.data)[0];
  const hasDate = typeof parsed['EXIF:DateTimeOriginal'] === 'string';
  const thumb = parsed['EXIF:ThumbnailImage'];
  const hasThumb = typeof thumb === 'string' && thumb.startsWith('base64:');

  section('And it returns both');
  console.log(`  date       ${hasDate ? 'yes' : 'NO'}  ${parsed['EXIF:DateTimeOriginal'] ?? ''}`);
  console.log(`  thumbnail  ${hasThumb ? 'yes' : 'NO'}  `
    + `${hasThumb ? `${Math.round(thumb.length * 0.75 / 1024)}KB decoded` : ''}`);
}

if (isMain(import.meta.url)) await measureLoadCost();
