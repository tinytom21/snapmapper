/**
 * Spike Q1 — does ExifTool-WASM write correct GPS into a real A6400 JPEG
 * without damaging anything else?
 *
 * This is the question the whole project rests on. If MakerNotes do not survive
 * byte-identically, the backend is wrong and no amount of UI work saves it.
 */

import { readFile, writeFile, stat, utimes } from 'node:fs/promises';
import path from 'node:path';

import {
  ensureOutputDir,
  formatBytes,
  isMain,
  listFixtures,
  note,
  result,
  section,
} from './support.mjs';
import { compare, nativeExifToolVersion } from './verify.mjs';

/** Greenwich Observatory — recognisable enough that a wrong result is obvious. */
const TEST_LOCATION = { latitude: 51.4778, longitude: -0.0015, altitude: 45.7 };

/**
 * A deliberately awkward second case: southern *and* western hemisphere, so a
 * dropped sign shows up rather than hiding behind a positive value.
 */
const SIGNED_LOCATION = { latitude: -33.8688, longitude: -70.6693 };

export async function writeGpsChecks() {
  section('Native ExifTool (the independent verifier)');

  const nativeVersion = await nativeExifToolVersion();
  if (!nativeVersion) {
    result(false, 'exiftool not found on PATH');
    note('Install it: winget install OliverBetz.ExifTool');
    note('Already installed but not on PATH? Set EXIFTOOL to the absolute path.');
    note('Without it, nothing here is independently verified and Q1 stays open.');
    return { failed: true };
  }
  result(true, `ExifTool ${nativeVersion}`);

  const fixtures = await listFixtures();
  if (fixtures.length === 0) {
    section('Fixtures');
    result(false, 'no JPEGs in spike/fixtures/ — see the README there');
    return { failed: true };
  }

  const pkg = await import('@uswriting/exiftool');
  const outputDir = await ensureOutputDir();

  let allPassed = true;

  for (const fixturePath of fixtures) {
    const name = path.basename(fixturePath);
    section(`${name}`);

    const originalStat = await stat(fixturePath);
    const originalBytes = await readFile(fixturePath);

    note(`${formatBytes(originalBytes.byteLength)} on disk`);

    for (const [label, location] of [
      ['Greenwich', TEST_LOCATION],
      ['southern + western', SIGNED_LOCATION],
    ]) {
      const tags = buildTags(location);
      const outputPath = path.join(outputDir, `${label.replace(/\W+/g, '-')}-${name}`);

      const started = performance.now();
      let output;
      try {
        output = await pkg.writeMetadata(
          { name, data: originalBytes },
          tags,
          { args: ['-n', '-P', '-overwrite_original'] },
        );
      } catch (error) {
        result(false, `${label}: writeMetadata threw — ${error.message}`);
        allPassed = false;
        continue;
      }
      const elapsed = performance.now() - started;

      if (!output?.success || !output.data?.byteLength) {
        result(false, `${label}: write failed — ${output?.error ?? 'no data returned'}`);
        allPassed = false;
        continue;
      }

      const taggedBytes = Buffer.from(output.data);
      await writeFile(outputPath, taggedBytes);

      // -P should have preserved the modification date. The WASM build has no
      // real filesystem, so it cannot do that itself — the shell has to restore
      // it, and this is where we find out that is our job.
      await utimes(outputPath, originalStat.atime, originalStat.mtime);

      note(`${label}: wrote in ${elapsed.toFixed(0)} ms -> ${path.basename(outputPath)}`);

      const checks = await compare({
        originalPath: fixturePath,
        taggedPath: outputPath,
        originalBytes,
        taggedBytes,
        expected: location,
      });

      for (const check of checks) {
        result(check.pass, `${check.name} — ${check.detail}`);
        if (!check.pass) allPassed = false;
      }
    }
  }

  section('Q1 verdict');
  if (allPassed) {
    result(true, 'ExifTool-WASM is a viable backend on real A6400 files');
  } else {
    result(false, 'at least one check failed — read the detail above before proceeding');
    note('A MakerNotes mismatch specifically means: do not build on this backend.');
  }

  return { failed: !allPassed };
}

function buildTags(location) {
  const tags = {
    'EXIF:GPSLatitude': String(Math.abs(location.latitude)),
    'EXIF:GPSLatitudeRef': location.latitude < 0 ? 'S' : 'N',
    'EXIF:GPSLongitude': String(Math.abs(location.longitude)),
    'EXIF:GPSLongitudeRef': location.longitude < 0 ? 'W' : 'E',
    'EXIF:GPSMapDatum': 'WGS-84',
    'XMP:GPSLatitude': String(location.latitude),
    'XMP:GPSLongitude': String(location.longitude),
  };

  if (location.altitude !== undefined) {
    tags['EXIF:GPSAltitude'] = String(Math.abs(location.altitude));
    tags['EXIF:GPSAltitudeRef'] = location.altitude < 0 ? '1' : '0';
  }

  return tags;
}

if (isMain(import.meta.url)) {
  const { failed } = await writeGpsChecks();
  process.exitCode = failed ? 1 : 0;
}
