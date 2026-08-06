/**
 * Spike Q3 + Q4 — what does ExifTool-WASM cost, and where does it fall over?
 *
 * Node numbers are the optimistic case. The tablet is the one that will hurt,
 * so treat these as a floor and run `npm run browser --workspace spike` for
 * numbers that actually predict Android.
 *
 * The decision this feeds: a batch of 200 photos has to be tolerable. If a
 * single write costs a second, that is three and a half minutes of staring at
 * a progress bar, and the backend needs rethinking.
 */

import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  formatBytes,
  formatMs,
  isMain,
  listFixtures,
  note,
  result,
  section,
} from './support.mjs';

const BATCH_SIZE = 20;
const TYPICAL_BATCH = 200;

export async function benchmark() {
  const fixtures = await listFixtures();
  if (fixtures.length === 0) {
    section('Benchmark');
    result(false, 'no fixtures — see spike/fixtures/README.md');
    return { failed: true };
  }

  const findings = {};

  // --- Cold start: paid once per session, or once per photo? -------------
  section('Cold start');

  const importStarted = performance.now();
  const pkg = await import('@uswriting/exiftool');
  const importMs = performance.now() - importStarted;
  note(`module import: ${formatMs(importMs)}`);

  const largest = await largestFixture(fixtures);
  const bytes = await readFile(largest);
  const name = path.basename(largest);
  note(`using ${name} (${formatBytes(bytes.byteLength)})`);

  const firstStarted = performance.now();
  await pkg.parseMetadata({ name, data: bytes }, { args: ['-json', '-n'] });
  const firstMs = performance.now() - firstStarted;

  const secondStarted = performance.now();
  await pkg.parseMetadata({ name, data: bytes }, { args: ['-json', '-n'] });
  const secondMs = performance.now() - secondStarted;

  note(`first read:  ${formatMs(firstMs)}`);
  note(`second read: ${formatMs(secondMs)}`);

  // If the second call is roughly as slow as the first, the WASM instance is
  // being rebuilt every time and a 200-photo batch pays that cost 200 times.
  const instanceReused = secondMs < firstMs * 0.5;
  result(
    instanceReused,
    instanceReused
      ? `instance appears reused (${formatMs(firstMs)} -> ${formatMs(secondMs)})`
      : `instance may be rebuilt per call (${formatMs(firstMs)} -> ${formatMs(secondMs)}) — a batch pays this repeatedly`,
  );

  findings.importMs = importMs;
  findings.firstCallMs = firstMs;
  findings.warmCallMs = secondMs;
  findings.instanceReused = instanceReused;

  // --- Steady-state write cost -------------------------------------------
  section(`Write throughput (${BATCH_SIZE} sequential writes)`);

  const tags = { 'EXIF:GPSLatitude': '51.4778', 'EXIF:GPSLatitudeRef': 'N' };
  const timings = [];

  for (let i = 0; i < BATCH_SIZE; i++) {
    const started = performance.now();
    // -n only. -P and -overwrite_original assume a real filesystem the WASM
    // sandbox does not have; see WRITE_ARGS in write-gps.mjs.
    const output = await pkg.writeMetadata({ name, data: bytes }, tags, {
      args: ['-n'],
    });
    timings.push(performance.now() - started);

    if (!output?.success) {
      result(false, `write ${i + 1} failed: ${output?.error ?? 'unknown'}`);
      return { failed: true, findings };
    }
  }

  timings.sort((a, b) => a - b);
  const median = timings[Math.floor(timings.length / 2)];
  const worst = timings[timings.length - 1];
  const total = timings.reduce((sum, t) => sum + t, 0);

  note(`median ${formatMs(median)}, worst ${formatMs(worst)}, mean ${formatMs(total / timings.length)}`);

  const projected = median * TYPICAL_BATCH;
  const tolerable = projected < 120_000;
  result(
    tolerable,
    `${TYPICAL_BATCH} photos projects to ${formatMs(projected)} on this machine${tolerable ? '' : ' — too slow'}`,
  );
  note('A tablet is typically 3-5x slower than a desktop here. Multiply accordingly.');

  findings.medianWriteMs = median;
  findings.projectedBatchMs = projected;

  // --- Q4: memory ceiling -------------------------------------------------
  section('Memory ceiling');

  note('WASM is 32-bit, so ~4GB is the hard wall. ARW files are ~25MB, which is');
  note('the size that matters for the deferred raw phase.');

  const synthetic = await syntheticLargeFile(bytes, 25 * 1024 * 1024);
  try {
    const started = performance.now();
    const output = await pkg.parseMetadata(
      { name: 'large.jpg', data: synthetic },
      { args: ['-json', '-n'] },
    );
    const elapsed = performance.now() - started;
    result(
      output?.success === true,
      `${formatBytes(synthetic.byteLength)} file read in ${formatMs(elapsed)}`,
    );
    findings.largeFileMs = elapsed;
  } catch (error) {
    result(false, `${formatBytes(synthetic.byteLength)} file threw: ${error.message}`);
    findings.largeFileError = error.message;
  }

  const heap = process.memoryUsage();
  note(`heap used ${formatBytes(heap.heapUsed)}, rss ${formatBytes(heap.rss)}`);

  // --- Bundle size ---------------------------------------------------------
  section('Bundle size');

  const wasmSize = await measureWasmSize();
  if (wasmSize === null) {
    note('could not locate the .wasm asset — check node_modules manually');
  } else {
    note(`zeroperl wasm: ${formatBytes(wasmSize)}`);
    note('This ships inside the APK and is downloaded once for a web build.');
    findings.wasmBytes = wasmSize;
  }

  return { findings };
}

async function largestFixture(fixtures) {
  const sizes = await Promise.all(
    fixtures.map(async (file) => ({ file, size: (await stat(file)).size })),
  );
  sizes.sort((a, b) => b.size - a.size);
  return sizes[0].file;
}

/**
 * Pad a real JPEG out to a target size by appending bytes after the end of
 * image marker. Trailing data is ignored by decoders, so the file stays valid
 * while exercising the memory path.
 */
async function syntheticLargeFile(bytes, targetSize) {
  if (bytes.byteLength >= targetSize) return bytes;
  const padding = Buffer.alloc(targetSize - bytes.byteLength, 0);
  return Buffer.concat([bytes, padding]);
}

/**
 * Size of the largest distinct .wasm asset under node_modules.
 *
 * Searched from the repository root rather than the working directory, because
 * npm hoists workspace dependencies up there.
 *
 * Deliberately not a sum: the package ships the same zeroperl.wasm twice, once
 * under dist/esm and once under dist/cjs, and a bundler pulls in exactly one of
 * them. Adding them reports 50MB for a 25MB shipped artifact, which would make
 * the Q3 cost look twice as bad as it is.
 */
async function measureWasmSize() {
  const { glob } = await import('node:fs/promises');
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

  try {
    let largest = 0;
    for await (const entry of glob('**/node_modules/**/*.wasm', { cwd: repoRoot })) {
      const { size } = await stat(path.join(repoRoot, entry));
      if (size > largest) largest = size;
    }
    return largest || null;
  } catch {
    return null;
  }
}

if (isMain(import.meta.url)) {
  const { failed } = await benchmark();
  process.exitCode = failed ? 1 : 0;
}
