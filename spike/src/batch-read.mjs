/**
 * Can several photographs share one ExifTool invocation, and is it worth it?
 *
 * `load-cost.mjs` established that reading costs ~1 s **per invocation** and almost nothing per
 * byte — sixty-eight times the data made no measurable difference. If that is right, then the
 * single biggest thing that could happen to this app is several photographs sharing one
 * invocation: a 200-photo card would go from "put the kettle on" to a few seconds.
 *
 * The wrapper this app uses takes one file. But it is a thin layer: it mounts the input into
 * zeroperl's virtual filesystem with `addFile(path, bytes)`, pushes the path onto an argument
 * list, and runs `/exiftool`. A *list*. So this drives zeroperl directly to find out whether
 * ExifTool in WASM will take several paths at once, and what that costs.
 *
 * **This is a measurement, not a proposal.** It reaches into the wrapper's bundle to borrow the
 * ExifTool script, which is not something to ship — the point is to know the number before
 * deciding whether to take on a vendored dependency for it.
 *
 *   npm run batch-read --workspace spike
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

import { patchZeroperl } from './patch-zeroperl.mjs';
import { isMain, listFixtures, note, section } from './support.mjs';

const require_ = createRequire(import.meta.url);

const WANTED = [
  'EXIF:DateTimeOriginal', 'EXIF:CreateDate', 'EXIF:Orientation',
  'EXIF:Make', 'EXIF:Model',
  'Composite:GPSLatitude', 'Composite:GPSLongitude', 'Composite:GPSAltitude',
];

/**
 * Borrow the ExifTool script out of the wrapper's bundle.
 *
 * It is a template literal assigned to a minified binding and is not exported, so this reads the
 * file and finds the unescaped closing backtick. Thoroughly not shippable — see the header.
 */
async function borrowExifToolScript() {
  // Located from the workspace root rather than through `resolve`: the package's `exports` map
  // deliberately hides everything but the entry point, which is exactly what this is going around.
  const source = await readFile(
    path.join(process.cwd(), '..', 'node_modules', '@uswriting', 'exiftool', 'dist', 'esm', 'index.js'),
    'utf8',
  );

  const start = source.indexOf('=`use strict;use warnings;');
  if (start < 0) throw new Error('the wrapper no longer embeds the script the same way');

  let at = start + 2;
  while (at < source.length) {
    if (source[at] === '\\') { at += 2; continue; }
    if (source[at] === '`') break;
    at += 1;
  }

  // Undo the bundler's escaping: it is a JS template literal, so backticks, backslashes and `${`
  // are escaped in the source and must come back out to be valid Perl.
  return source.slice(start + 2, at)
    .replaceAll('\\`', '`')
    .replaceAll('\\$', '$')
    .replaceAll('\\\\', '\\');
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

export async function measureBatchRead() {
  section('Can several photographs share one invocation?');

  const fixtures = await listFixtures();
  if (fixtures.length === 0) {
    note('No fixtures in spike/fixtures/. Copy a few real A6400 JPEGs in first.');
    return;
  }

  await patchZeroperl();
  const zeroperl = await import('@6over3/zeroperl-ts');
  const script = await borrowExifToolScript();
  note(`ExifTool script: ${(script.length / 1024).toFixed(0)}KB of Perl`);

  // Build a working set big enough to be interesting, reusing the fixtures under distinct names.
  const stubs = [];
  for (let round = 0; round < 4; round++) {
    for (const file of fixtures) {
      const bytes = new Uint8Array(await readFile(file));
      stubs.push({ name: `${round}_${path.basename(file)}`, data: headerStub(bytes) });
    }
  }
  note(`${stubs.length} header stubs, ${(stubs.reduce((n, s) => n + s.data.length, 0) / 1e6).toFixed(1)}MB total`);

  let out = '';
  let err = '';
  const fs = new zeroperl.MemoryFileSystem({ '/': '' });
  fs.addFile('/exiftool', script);
  const perl = await zeroperl.ZeroPerl.create({
    fileSystem: fs,
    stdout: (chunk) => { out += typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk); },
    stderr: (chunk) => { err += typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk); },
  });

  /** Run ExifTool over `count` files in one invocation, and return what it took. */
  async function runBatch(count) {
    const chosen = stubs.slice(0, count);
    const paths = [];
    out = ''; err = '';
    await perl.reset();

    for (const stub of chosen) {
      const at = `/${stub.name}`;
      fs.addFile(at, stub.data);
      paths.push(at);
    }

    const started = performance.now();
    const result = await perl.runFile('/exiftool', [
      '-json', '-n', '-b', '-G', '-fast2',
      ...WANTED.map((tag) => `-${tag}`), '-ThumbnailImage',
      ...paths,
    ]);
    perl.flush();
    const elapsed = performance.now() - started;

    for (const at of paths) { try { fs.removeFile(at); } catch { /* already gone */ } }

    let parsed = [];
    try { parsed = JSON.parse(out); } catch { /* reported below */ }
    return { elapsed, ok: result.success, records: parsed.length, stderr: err.trim().slice(0, 160) };
  }

  // Warm, so the first invocation's compile cost does not land on the first measurement.
  await runBatch(1);

  section('One invocation, N photographs');
  const rows = [];
  for (const count of [1, 2, 5, 10, 20, 28]) {
    if (count > stubs.length) continue;
    const run = await runBatch(count);
    rows.push({ count, ...run });
    console.log(
      `  ${String(count).padStart(3)} files  ${run.elapsed.toFixed(0).padStart(6)} ms  `
      + `${(run.elapsed / count).toFixed(0).padStart(5)} ms each  `
      + `${run.records} records${run.ok ? '' : '  FAILED'}`,
    );
    if (run.stderr) note(`    stderr: ${run.stderr}`);
  }

  /*
   * The question that decides whether batching is safe at all.
   *
   * One at a time, a corrupt photograph fails on its own and the other forty-nine are unaffected —
   * that isolation is why the loader has a try/catch per file. Sharing an invocation puts them in
   * the same basket, so: does one bad file take the batch down, or does ExifTool report it and
   * carry on?
   */
  section('And when one file in the batch is rubbish?');
  {
    const good = stubs.slice(0, 4);
    const paths = [];
    out = ''; err = '';
    await perl.reset();

    for (const stub of good) {
      fs.addFile(`/${stub.name}`, stub.data);
      paths.push(`/${stub.name}`);
    }
    // A file that is not a JPEG at all, in the middle of the batch.
    fs.addFile('/broken.jpg', new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
    paths.splice(2, 0, '/broken.jpg');

    const result = await perl.runFile('/exiftool', [
      '-json', '-n', '-b', '-G', '-fast2',
      ...WANTED.map((tag) => `-${tag}`), '-ThumbnailImage',
      ...paths,
    ]);
    perl.flush();

    let parsed = [];
    try { parsed = JSON.parse(out); } catch { /* below */ }

    console.log(`  ${paths.length} files in, ${parsed.length} records out, `
      + `exit ${result.exitCode}, success ${result.success}`);
    note(`  stderr: ${err.trim().split(String.fromCharCode(10)).join(' | ').slice(0, 200)}`);
    // Which ones came back, so a caller knows it can map results by SourceFile rather than by index.
    note(`  returned: ${parsed.map((r) => r.SourceFile).join(', ')}`);

    for (const at of [...paths]) { try { fs.removeFile(at); } catch { /* gone */ } }
  }

  const one = rows.find((row) => row.count === 1);
  const many = rows.at(-1);
  if (one && many && many.records === many.count) {
    section('What that means');
    note(`Per photograph: ${one.elapsed.toFixed(0)} ms alone, `
      + `${(many.elapsed / many.count).toFixed(0)} ms in a batch of ${many.count} — `
      + `${(one.elapsed / (many.elapsed / many.count)).toFixed(1)}x.`);
    note(`A 200-photo card: ${(one.elapsed * 200 / 1000).toFixed(0)}s one at a time, `
      + `${(many.elapsed / many.count * 200 / 1000).toFixed(0)}s batched.`);
  } else {
    note('Batching did not return one record per file — see the failures above.');
  }
}

if (isMain(import.meta.url)) await measureBatchRead();
