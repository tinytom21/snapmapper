/**
 * Spike Q3, sharpened — is the per-photo cost fixed, or proportional to size?
 *
 * The headline benchmark says a write costs ~4.5s for a 24MP JPEG, which puts
 * 200 photos at a quarter of an hour on a fast desktop. That number on its own
 * does not say whether the backend is salvageable, and the two possibilities
 * point in opposite directions:
 *
 *   - Mostly *fixed* cost means a Perl interpreter is booting once per photo.
 *     Real ExifTool has always been slow to start and fast per file afterwards,
 *     which is why its own CLI has -stay_open and why GeoSetter uses it. The fix
 *     would be batching, not a new backend.
 *   - Mostly *size-proportional* cost means the bytes themselves are the
 *     problem, and A6400 files do not get smaller. That is a backend decision.
 *
 * Run with: npm run cost --workspace spike
 */

import { readFile } from 'node:fs/promises';

import { formatBytes, formatMs, isMain, listFixtures, note, result, section } from './support.mjs';
import { patchZeroperl } from './patch-zeroperl.mjs';

/** A 24MP A6400 fine JPEG is around this size, and is what the bar is set by. */
const TYPICAL_JPEG_MB = 11.7;
const TYPICAL_BATCH = 200;
const REPEATS = 5;

export async function costShape() {
  section('Cost shape — fixed per invocation vs per megabyte');

  const fixtures = await listFixtures();
  if (fixtures.length === 0) {
    result(false, 'no fixtures — see spike/fixtures/README.md');
    return { failed: true };
  }

  await patchZeroperl();
  const pkg = await import('@uswriting/exiftool');

  const bytes = await readFile(fixtures[0]);
  note(`base file: ${formatBytes(bytes.byteLength)}`);

  // Truncating a JPEG part-way through the scan data leaves the header intact,
  // which is all ExifTool needs in order to write metadata. It just has less
  // entropy-coded data to copy through, which is exactly the variable we want.
  const sizes = [64 * 1024, 512 * 1024, 2 * 1024 * 1024, 6 * 1024 * 1024, bytes.byteLength]
    .filter((size) => size <= bytes.byteLength);

  const tags = { 'EXIF:GPSLatitude': '51.4778', 'EXIF:GPSLatitudeRef': 'N' };
  const points = [];

  for (const size of sizes) {
    const slice = bytes.subarray(0, size);
    const timings = [];

    for (let i = 0; i < REPEATS; i++) {
      const started = performance.now();
      const output = await pkg.writeMetadata({ name: 'probe.jpg', data: slice }, tags, {
        args: ['-n'],
      });
      timings.push(performance.now() - started);
      if (!output?.success) {
        result(false, `write failed at ${formatBytes(size)}: ${output?.error ?? 'unknown'}`);
        return { failed: true };
      }
    }

    timings.sort((a, b) => a - b);
    const median = timings[Math.floor(timings.length / 2)];
    points.push({ mb: size / 1048576, median });
    note(`${formatBytes(size).padStart(9)} -> ${formatMs(median)} (median of ${REPEATS})`);
  }

  const { fixed, perMb } = fitLine(points);

  note('');
  note(`fit: ${formatMs(fixed)} fixed per invocation + ${formatMs(perMb)} per MB`);

  const perPhoto = fixed + perMb * TYPICAL_JPEG_MB;
  const asIs = perPhoto * TYPICAL_BATCH;
  const ifBatched = fixed + perMb * TYPICAL_JPEG_MB * TYPICAL_BATCH;

  note(`a ${TYPICAL_JPEG_MB}MB A6400 JPEG: ${formatMs(perPhoto)}`);
  note(`${TYPICAL_BATCH} photos, one invocation each: ${formatMs(asIs)}`);
  note(`${TYPICAL_BATCH} photos if the fixed cost were paid once: ${formatMs(ifBatched)}`);

  // Which term dominates decides what the fix is.
  const fixedShare = fixed / perPhoto;
  if (fixedShare > 0.5) {
    result(
      true,
      `startup dominates (${(fixedShare * 100).toFixed(0)}% of a typical photo) — batching is the lever, not a new backend`,
    );
  } else {
    result(
      false,
      `the bytes dominate (${((1 - fixedShare) * 100).toFixed(0)}% of a typical photo) — batching cannot rescue this`,
    );
  }

  return { findings: { fixed, perMb, perPhoto, asIs, ifBatched, fixedShare } };
}

/** Least squares through (MB, ms). */
function fitLine(points) {
  const n = points.length;
  const sx = points.reduce((sum, p) => sum + p.mb, 0);
  const sy = points.reduce((sum, p) => sum + p.median, 0);
  const sxy = points.reduce((sum, p) => sum + p.mb * p.median, 0);
  const sxx = points.reduce((sum, p) => sum + p.mb * p.mb, 0);

  const perMb = (n * sxy - sx * sy) / (n * sxx - sx * sx);
  return { perMb, fixed: (sy - perMb * sx) / n };
}

if (isMain(import.meta.url)) {
  const { failed } = await costShape();
  process.exitCode = failed ? 1 : 0;
}
