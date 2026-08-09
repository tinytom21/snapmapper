/**
 * Does the *shipped* batch path give the same answer as the one-at-a-time path?
 *
 * `batch-read.mjs` proved batching is fast and that one bad file does not take the others down.
 * This asks the question that decides whether it is safe to ship: **does it read the same
 * metadata?** A batch reader that is 14x faster and quietly attaches one photograph's coordinates
 * to another is worse than no batch reader at all, and it would look like nothing at all — the
 * app would load quickly and put a few pictures in the wrong place.
 *
 * So this drives the real production modules — `readManyTags` from core, and the same extraction
 * of the ExifTool script the Vite plugin performs — and compares every tag of every fixture
 * against `readTagsAndThumbnail`, which is the path that has been in use all along.
 *
 * Two things are deliberately made hard:
 *
 *   - **Fixtures are duplicated under new names**, so a batch is bigger than seven and so the
 *     index-versus-SourceFile question has room to go wrong.
 *   - **A corrupt file is put in the middle**, because that is what makes the output shorter than
 *     the input, which is the specific condition under which matching by index misattributes
 *     everything after it.
 *
 *   npm run batch-verify --workspace spike
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { readManyTags, readTagsAndThumbnail, createWasmBackend } from '@snapmapper/core';
import { extractExifToolScript } from '../../packages/ui/exiftool-script.ts';

import { patchZeroperl } from './patch-zeroperl.mjs';
import { isMain, listFixtures, note, section } from './support.mjs';

const WANTED = [
  'EXIF:DateTimeOriginal', 'EXIF:CreateDate', 'EXIF:Orientation',
  'EXIF:Make', 'EXIF:Model',
  'Composite:GPSLatitude', 'Composite:GPSLongitude', 'Composite:GPSAltitude',
];

function findScanStart(bytes) {
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) break;
    if (bytes[offset + 1] === 0xda) return offset;
    offset += 2 + ((bytes[offset + 2] << 8) | bytes[offset + 3]);
  }
  return bytes.length;
}

function headerStub(bytes) {
  const scan = findScanStart(bytes);
  const stub = new Uint8Array(scan + 2);
  stub.set(bytes.subarray(0, scan));
  stub[scan] = 0xff;
  stub[scan + 1] = 0xd9;
  return stub;
}

/**
 * The same runner `packages/ui/src/batch-runner.ts` is, expressed for Node.
 *
 * Not imported from there because that module resolves `virtual:exiftool-script`, which only
 * exists under Vite. The *script* it would receive is obtained here the same way the plugin does,
 * so what is under test is the extraction and `readManyTags` — the two pieces that could get this
 * wrong.
 */
async function nodeRunner(zeroperl, script) {
  let out = '';
  let err = '';
  const decoder = new TextDecoder();

  const files = new zeroperl.MemoryFileSystem({ '/': '' });
  files.addFile('/exiftool', script);
  const perl = await zeroperl.ZeroPerl.create({
    fileSystem: files,
    stdout: (chunk) => { out += typeof chunk === 'string' ? chunk : decoder.decode(chunk); },
    stderr: (chunk) => { err += typeof chunk === 'string' ? chunk : decoder.decode(chunk); },
  });

  return {
    async run(batch, args) {
      const paths = batch.map((file, index) => `/${index}_${file.name.replace(/[^A-Za-z0-9._-]/g, '_')}`);
      out = ''; err = '';
      await perl.reset();
      try {
        for (const [index, file] of batch.entries()) files.addFile(paths[index], file.bytes);
        const result = await perl.runFile('/exiftool', [...args, ...paths]);
        perl.flush();
        return { stdout: out, stderr: err, paths, exitCode: result.exitCode };
      } finally {
        for (const at of paths) { try { files.removeFile(at); } catch { /* gone */ } }
      }
    },
  };
}

export async function verifyBatchRead() {
  section('Does batching read the same metadata as reading one at a time?');

  const fixtures = await listFixtures();
  if (fixtures.length === 0) {
    note('No fixtures in spike/fixtures/. Copy a few real A6400 JPEGs in first.');
    return;
  }

  await patchZeroperl();
  const zeroperl = await import('@6over3/zeroperl-ts');
  const wasm = await import('@uswriting/exiftool');
  const backend = createWasmBackend(wasm);

  const source = await readFile(
    path.join(process.cwd(), '..', 'node_modules', '@uswriting', 'exiftool', 'dist', 'esm', 'index.js'),
    'utf8',
  );
  const script = extractExifToolScript(source);
  note(`ExifTool script extracted: ${(script.length / 1024).toFixed(0)}KB of Perl`);

  // Duplicated so the batch is meaningfully larger than the fixture set.
  const files = [];
  for (let round = 0; round < 2; round++) {
    for (const file of fixtures) {
      const bytes = new Uint8Array(await readFile(file));
      files.push({ name: `${round}_${path.basename(file)}`, bytes: headerStub(bytes) });
    }
  }

  // A file that is not a JPEG at all, in the middle: this is what makes the output shorter than
  // the input, which is the condition under which matching by index goes wrong.
  const broken = { name: 'broken.jpg', bytes: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]) };
  files.splice(Math.floor(files.length / 2), 0, broken);
  note(`${files.length} files, one of them deliberately corrupt`);

  const runner = await nodeRunner(zeroperl, script);

  section('One invocation for all of them');
  const started = performance.now();
  const batched = await readManyTags(runner, files, WANTED);
  const batchMs = performance.now() - started;
  note(`${batchMs.toFixed(0)} ms total, ${(batchMs / files.length).toFixed(0)} ms per photograph`);

  section('And one at a time, for comparison');
  const oneByOne = [];
  const startedSingle = performance.now();
  for (const file of files) {
    try {
      oneByOne.push(await readTagsAndThumbnail(backend, file.bytes, file.name, WANTED));
    } catch (error) {
      oneByOne.push({ error: error instanceof Error ? error.message : String(error) });
    }
  }
  const singleMs = performance.now() - startedSingle;
  note(`${singleMs.toFixed(0)} ms total, ${(singleMs / files.length).toFixed(0)} ms per photograph`);
  note(`Batching is ${(singleMs / batchMs).toFixed(1)}x faster here.`);

  section('Tag by tag');
  let checks = 0;
  let failures = 0;

  for (const [index, file] of files.entries()) {
    const fromBatch = batched[index];
    const fromSingle = oneByOne[index];

    if (file === broken) {
      // The corrupt one must fail in *both* paths, and the batch must name it rather than
      // reporting somebody else's metadata for it.
      checks += 1;
      if (fromBatch.ok) {
        failures += 1;
        console.log(`  FAIL  ${file.name}: batch returned metadata for a corrupt file`);
      } else {
        console.log(`  ok    ${file.name}: refused, "${fromBatch.error.slice(0, 60)}"`);
      }
      continue;
    }

    if (!fromBatch.ok) {
      failures += 1;
      console.log(`  FAIL  ${file.name}: batch failed — ${fromBatch.error}`);
      continue;
    }
    if (fromSingle.error) {
      failures += 1;
      console.log(`  FAIL  ${file.name}: single-file read failed — ${fromSingle.error}`);
      continue;
    }

    let mismatches = 0;
    const keys = new Set([...Object.keys(fromBatch.tags), ...Object.keys(fromSingle.tags)]);
    for (const key of keys) {
      checks += 1;
      if (String(fromBatch.tags[key]) !== String(fromSingle.tags[key])) {
        mismatches += 1;
        failures += 1;
        console.log(`  FAIL  ${file.name} ${key}: batch ${fromBatch.tags[key]} vs single ${fromSingle.tags[key]}`);
      }
    }

    // The thumbnail is what a wrong match would show most obviously, so compare the bytes.
    checks += 1;
    const a = fromBatch.thumbnail;
    const b = fromSingle.thumbnail;
    const same = a && b ? a.length === b.length && a.every((byte, at) => byte === b[at]) : a === b;
    if (!same) {
      mismatches += 1;
      failures += 1;
      console.log(`  FAIL  ${file.name}: thumbnails differ (${a?.length} vs ${b?.length})`);
    }

    if (mismatches === 0) {
      console.log(`  ok    ${file.name}: ${keys.size} tags identical, thumbnail ${a?.length ?? 0} bytes identical`);
    }
  }

  section('Verdict');
  note(`${checks} checks, ${failures} failures.`);
  if (failures > 0) {
    note('Batched reads are NOT equivalent. Do not ship this.');
    process.exitCode = 1;
  } else {
    note('Batched reads are identical to reading one at a time, including with a corrupt file '
      + 'in the middle shortening the output.');
  }
}

if (isMain(import.meta.url)) await verifyBatchRead();
