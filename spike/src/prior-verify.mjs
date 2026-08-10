/**
 * Can the app find out where an earlier session already put a photograph?
 *
 * The feature reads two kinds of file and the two need different tags — `Composite:GPSLatitude`
 * from a JPEG copy, `XMP:GPSLatitude` from a raw file's sidecar. Both failure modes are silent:
 * ask a sidecar for Composite and it answers nothing, and a raw photograph that is *already
 * geotagged* goes on looking untouched with no error anywhere. Unit tests can only pin that the
 * code asks for the tag it meant to; whether ExifTool actually answers is a question for real
 * files, real bytes and a second implementation.
 *
 * Three things are checked, and the middle one is the reason this exists:
 *
 *   1. A JPEG that has been through the real write path reads its coordinates back through the
 *      **batched** reader, from a header stub rather than the whole file.
 *   2. An XMP sidecar does too — **under `-fast2`**, which `readManyTags` passes and which exists
 *      to stop ExifTool parsing things it does not need. `-fast2` is already known to suppress
 *      maker-note warnings, which is why the verification read is forbidden from using it; whether
 *      it also skips an XMP document was an assumption until this ran.
 *   3. Both are read **in one mixed invocation**, JPEG and XMP together, which is the shape the
 *      app actually produces and a case neither existing spike covers.
 *
 * Everything is cross-checked against a separate native ExifTool, which is the only thing here
 * that makes the answer meaningful.
 *
 *   npm run prior-verify --workspace spike
 */

import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { readManyTags, writeMetadataSpliced, buildGeotagTags, createWasmBackend } from '@snapmapper/core';
import { extractExifToolScript } from '../../packages/ui/exiftool-script.ts';

import { patchZeroperl } from './patch-zeroperl.mjs';
import { isMain, listFixtures, note, section } from './support.mjs';

const run = promisify(execFile);

/** Exactly what `prior-locations.ts` asks for. Both spellings, one request. */
const WANTED = [
  'Composite:GPSLatitude', 'Composite:GPSLongitude', 'Composite:GPSAltitude',
  'XMP:GPSLatitude', 'XMP:GPSLongitude', 'XMP:GPSAltitude',
];

/** Somewhere unambiguous, and nowhere near where an A6400 with no GPS would claim to be. */
const PLACED = { latitude: -33.8688, longitude: 151.2093, altitude: 42.5 };

function exifToolPath() {
  return process.env.EXIFTOOL
    ?? path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'ExifTool', 'exiftool.exe');
}

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

/** The runner from `batch-runner.ts`, expressed for Node. Same shape as in `batch-verify.mjs`. */
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
    fs: files,
    perl,
    async run(batch, args) {
      const paths = batch.map((file, index) =>
        `/${index}_${file.name.replace(/[^A-Za-z0-9._-]/g, '_')}`);
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
    /** Run ExifTool for its *output file* rather than its stdout — how a sidecar is made. */
    async produce(args, wanted) {
      out = ''; err = '';
      await perl.reset();
      try { files.removeFile(wanted); } catch { /* not there */ }

      const result = await perl.runFile('/exiftool', args);
      perl.flush();

      const node = files.lookup(wanted);
      const bytes = node && node.type === 'file' && node.content instanceof Uint8Array
        ? node.content
        : undefined;

      return { exitCode: result.exitCode, stderr: err.trim(), bytes };
    },
  };
}

export async function verifyPriorRead() {
  section('Can an earlier session\'s work be found again?');

  const fixtures = await listFixtures();
  const jpegFixture = fixtures.find((file) => /\.jpe?g$/i.test(file));
  if (!jpegFixture) {
    note('No JPEG fixtures in spike/fixtures/. Copy a few real A6400 JPEGs in first.');
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
  const runner = await nodeRunner(zeroperl, extractExifToolScript(source));

  let checks = 0;
  let failures = 0;
  const check = (ok, text) => {
    checks += 1;
    if (!ok) failures += 1;
    console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${text}`);
  };

  // --- Make the two files an earlier session would have left behind ---------

  section('Standing in for last week: a geotagged copy, and a sidecar');

  const original = new Uint8Array(await readFile(jpegFixture));
  // The real write path, splice and all — so what is read back is what the app actually leaves
  // in `geotagged/`, not a convenient stand-in.
  const written = await writeMetadataSpliced(
    backend,
    original,
    path.basename(jpegFixture),
    buildGeotagTags({ coordinates: PLACED }),
  );
  const copy = written.bytes;
  note(`copy: ${path.basename(jpegFixture)}, ${(copy.length / 1024 / 1024).toFixed(1)}MB, `
    + `placed at ${PLACED.latitude}, ${PLACED.longitude}`);

  const made = await runner.produce([
    '-n',
    `-XMP:GPSLatitude=${PLACED.latitude}`,
    `-XMP:GPSLongitude=${PLACED.longitude}`,
    `-XMP:GPSAltitude=${PLACED.altitude}`,
    '-o', '/out.xmp',
  ], '/out.xmp');

  if (!made.bytes) {
    note(`No sidecar was produced — ${made.stderr || 'no reason given'}`);
    process.exitCode = 1;
    return;
  }
  note(`sidecar: ${made.bytes.length} bytes`);

  // --- The thing under test: one mixed invocation, as the app makes ---------

  section('One invocation, a JPEG head and an XMP together');

  const batch = [
    { name: 'DSC00119.JPG', bytes: headerStub(copy) },
    { name: 'DSC00516.xmp', bytes: made.bytes },
  ];
  note(`${(batch[0].bytes.length / 1024).toFixed(0)}KB stub of a `
    + `${(copy.length / 1024 / 1024).toFixed(1)}MB file, and ${batch[1].bytes.length} bytes of XML`);

  const started = performance.now();
  const results = await readManyTags(runner, batch, WANTED);
  note(`${(performance.now() - started).toFixed(0)} ms for both`);

  const [fromJpeg, fromXmp] = results;

  check(fromJpeg.ok, 'the JPEG copy was read at all');
  check(fromXmp.ok, 'the sidecar was read at all');
  if (!fromJpeg.ok || !fromXmp.ok) {
    section('Verdict');
    note(`${checks} checks, ${failures} failures.`);
    process.exitCode = 1;
    return;
  }

  section('The JPEG answers through Composite');
  for (const [tag, want] of [
    ['Composite:GPSLatitude', PLACED.latitude],
    ['Composite:GPSLongitude', PLACED.longitude],
    ['Composite:GPSAltitude', PLACED.altitude],
  ]) {
    const got = Number(fromJpeg.tags[tag]);
    check(Math.abs(got - want) < 1e-6, `${tag}: ${got}`);
  }

  section('The sidecar answers through XMP — under -fast2');
  note('This is the assumption the feature rests on. `-fast2` stops ExifTool parsing what it does');
  note('not need, and it is already known to skip maker notes. If it skipped XMP too, every raw');
  note('photograph already geotagged would silently go on looking unplaced.');
  for (const [tag, want] of [
    ['XMP:GPSLatitude', PLACED.latitude],
    ['XMP:GPSLongitude', PLACED.longitude],
    ['XMP:GPSAltitude', PLACED.altitude],
  ]) {
    const got = Number(fromXmp.tags[tag]);
    check(Math.abs(got - want) < 1e-6, `${tag}: ${got}`);
  }

  section('And the two are not confused with one another');
  // The mirror image of the real bug: a JPEG must not be believed through XMP, nor a sidecar
  // through Composite. If either answered both ways, the source-driven tag choice in
  // `prior-locations.ts` would be untested by accident.
  check(
    fromXmp.tags['Composite:GPSLatitude'] === undefined,
    'the sidecar has no Composite:GPSLatitude — there is nothing to compose it from',
  );

  // --- The independent check ------------------------------------------------

  section('Verified against native ExifTool');

  const dir = await mkdtemp(path.join(tmpdir(), 'snapmapper-prior-'));
  const copyPath = path.join(dir, 'DSC00119.JPG');
  const xmpPath = path.join(dir, 'DSC00516.xmp');
  await writeFile(copyPath, copy);
  await writeFile(xmpPath, made.bytes);

  let native;
  try {
    const { stdout } = await run(exifToolPath(), ['-json', '-n', '-G', copyPath, xmpPath]);
    native = JSON.parse(stdout);
  } catch (error) {
    note(`  Could not run native ExifTool: ${error.message}`);
    note('  Install it, or set EXIFTOOL to its absolute path. The WASM checks above still stand.');
    section('Verdict');
    note(`${checks} checks, ${failures} failures — without the independent verifier.`);
    if (failures > 0) process.exitCode = 1;
    return;
  }

  const nativeJpeg = native.find((record) => record.SourceFile.endsWith('.JPG'));
  const nativeXmp = native.find((record) => record.SourceFile.endsWith('.xmp'));

  for (const [label, record, tag, want] of [
    ['copy', nativeJpeg, 'Composite:GPSLatitude', PLACED.latitude],
    ['copy', nativeJpeg, 'Composite:GPSLongitude', PLACED.longitude],
    ['sidecar', nativeXmp, 'XMP:GPSLatitude', PLACED.latitude],
    ['sidecar', nativeXmp, 'XMP:GPSLongitude', PLACED.longitude],
  ]) {
    const got = Number(record?.[tag]);
    check(Math.abs(got - want) < 1e-6, `native, ${label} ${tag}: ${got}`);
  }

  // The whole-file read is the honest comparison for the stub the app actually uses: if the
  // header stub were losing the GPS, this is where it would show.
  check(
    Math.abs(Number(nativeJpeg?.['Composite:GPSLatitude']) - Number(fromJpeg.tags['Composite:GPSLatitude'])) < 1e-6,
    'the header stub and the whole file agree',
  );

  // Maker notes, because this file has been through the write path and that is the damage that
  // reports as nothing at all.
  const warning = nativeJpeg?.['ExifTool:Warning'];
  check(!warning, `no structural warning on the copy${warning ? `: ${warning}` : ''}`);

  section('Verdict');
  note(`${checks} checks, ${failures} failures.`);
  if (failures > 0) process.exitCode = 1;
  else note('Both kinds of prior location are found, read through the right tag, in one call.');
}

if (isMain(import.meta.url)) await verifyPriorRead();
