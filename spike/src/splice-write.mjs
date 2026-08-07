/**
 * Spike Q6 — write GPS with real ExifTool while passing it ~1.5% of the bytes.
 *
 * Where this comes from. Q3 measured ExifTool-WASM writing at 13.87 s/MB on a real
 * phone, 99% of it proportional to file size, which rules Android out. Q5 measured
 * piexifjs writing in 6 ms and corrupting the file — 116 MakerNote tags changed, 47
 * tags lost, and ExifTool itself reporting "Possibly incorrect maker notes offsets".
 * Fast and wrong is not a trade worth making with somebody's photographs.
 *
 * But the cost is avoidable rather than inherent. Writing GPS to a JPEG rewrites the
 * metadata segments at the front of the file; the remaining megabytes of
 * entropy-coded scan data only need copying verbatim. On these A6400 files the
 * headers are ~100KB of a ~6MB file — **1.5%**. ExifTool is being made to shovel the
 * other 98.5% through a WASI filesystem shim for no reason.
 *
 * So: hand ExifTool only the headers, let it do all the EXIF and MakerNote work
 * exactly as it does today, then splice its output back onto the original scan data
 * with a plain byte copy. The correctness Q1 established is inherited wholesale,
 * because the same ExifTool performs the same rewrite — the only difference is how
 * many bytes it is asked to carry.
 *
 * The load-bearing assumption is that the rewritten metadata does not depend on what
 * follows it. That is tested directly here rather than assumed, and separately
 * confirmed with native ExifTool: writing the same GPS to a 1.6% stub and to the full
 * file produced **byte-identical** APP1 segments, so the maker-note offsets are
 * relative to the TIFF header inside the segment, not to the file.
 *
 * Run with: npm run splice --workspace spike
 */

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  ensureOutputDir,
  formatBytes,
  formatMs,
  isMain,
  listFixtures,
  note,
  result,
  section,
} from './support.mjs';
import { patchZeroperl } from './patch-zeroperl.mjs';
import { compare, nativeExifToolVersion } from './verify.mjs';

const TEST_LOCATION = { latitude: 51.4778, longitude: -0.0015, altitude: 45.7 };
const SIGNED_LOCATION = { latitude: -33.8688, longitude: -70.6693 };

/**
 * Scan data kept in the stub after the SOS header.
 *
 * ExifTool needs a plausible image, not a complete one, but a stub truncated to
 * nothing at all is rejected outright as a corrupted JPEG — Q3's phone sweep hit
 * exactly that. A few KB is enough to look like a real scan.
 */
const SCAN_STUB_BYTES = 4096;

export async function spliceChecks() {
  section('Native ExifTool (the independent verifier)');

  const nativeVersion = await nativeExifToolVersion();
  if (!nativeVersion) {
    result(false, 'exiftool not found — set EXIFTOOL to an absolute path');
    return { failed: true };
  }
  result(true, `ExifTool ${nativeVersion}`);

  const fixtures = await listFixtures();
  if (fixtures.length === 0) {
    result(false, 'no fixtures — see spike/fixtures/README.md');
    return { failed: true };
  }

  await patchZeroperl();
  const pkg = await import('@uswriting/exiftool');
  const outputDir = await ensureOutputDir();

  let allPassed = true;
  const timings = [];
  const ratios = [];

  for (const fixturePath of fixtures) {
    const name = path.basename(fixturePath);
    section(name);

    const originalBytes = await readFile(fixturePath);

    let headerEnd;
    try {
      headerEnd = findScanStart(originalBytes);
    } catch (error) {
      result(false, `could not parse JPEG structure: ${error.message}`);
      allPassed = false;
      continue;
    }

    const ratio = (100 * headerEnd) / originalBytes.byteLength;
    ratios.push(ratio);
    note(
      `${formatBytes(originalBytes.byteLength)} total, `
      + `${formatBytes(headerEnd)} of headers (${ratio.toFixed(1)}%)`,
    );

    for (const [label, location] of [
      ['Greenwich', TEST_LOCATION],
      ['southern + western', SIGNED_LOCATION],
    ]) {
      const outputPath = path.join(
        outputDir,
        `splice-${label.replace(/\W+/g, '-')}-${name}`,
      );

      const started = performance.now();

      // 1. A stub carrying every metadata segment and a token amount of scan data.
      const stub = Buffer.concat([
        originalBytes.subarray(0, headerEnd + SCAN_STUB_BYTES),
        Buffer.from([0xff, 0xd9]),
      ]);

      // 2. Real ExifTool does all the real work, on 1.5% of the bytes.
      let output;
      try {
        output = await pkg.writeMetadata({ name, data: stub }, buildTags(location), {
          args: ['-n'],
        });
      } catch (error) {
        result(false, `${label}: writeMetadata threw — ${error.message}`);
        allPassed = false;
        continue;
      }

      if (!output?.success) {
        result(false, `${label}: write failed — ${output?.error ?? 'no data'}`);
        allPassed = false;
        continue;
      }

      // 3. Splice: rewritten headers, then the original scan data untouched.
      const rewritten = Buffer.from(output.data);
      let taggedBytes;
      try {
        const rewrittenHeaderEnd = findScanStart(rewritten);
        taggedBytes = Buffer.concat([
          rewritten.subarray(0, rewrittenHeaderEnd),
          originalBytes.subarray(headerEnd),
        ]);
      } catch (error) {
        result(false, `${label}: could not parse ExifTool's output: ${error.message}`);
        allPassed = false;
        continue;
      }

      const elapsed = performance.now() - started;
      timings.push(elapsed);

      await writeFile(outputPath, taggedBytes);
      note(`${label}: ${formatMs(elapsed)} -> ${path.basename(outputPath)}`);

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

  section('Cost');

  if (timings.length > 0) {
    timings.sort((a, b) => a - b);
    const median = timings[Math.floor(timings.length / 2)];
    const meanRatio = ratios.reduce((sum, r) => sum + r, 0) / ratios.length;

    note(`median write: ${formatMs(median)} (whole file through WASM: ~2 s)`);
    note(`bytes handed to ExifTool: ${meanRatio.toFixed(1)}% of the file`);
    note('');
    note('Projection for the phone measured in Q3 (521 ms fixed + 13.87 s/MB):');
    const phoneMs = 521 + 13_870 * 0.107; // ~107KB of headers
    note(`  per photo: ${formatMs(phoneMs)}, against ${formatMs(76_430)} for the whole file`);
    note(`  20 photos: ${formatMs(phoneMs * 20)}, against ${formatMs(76_430 * 20)}`);
  }

  section('Q6 verdict');

  if (allPassed) {
    result(true, 'splicing passes every check Q1 applies, on 1.5% of the bytes');
    note('This keeps real ExifTool — and so keeps the correctness Q1 proved —');
    note('while removing the per-megabyte cost that ruled Android out.');
  } else {
    result(false, 'splicing damaged something — read the failures above');
  }

  return { failed: !allPassed };
}

/**
 * Offset of the first byte of entropy-coded scan data, i.e. just past the SOS header.
 *
 * Everything before this point is metadata and image parameters; everything after is
 * the photograph. That boundary is what makes the splice possible.
 */
function findScanStart(bytes) {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error('not a JPEG — no SOI marker');

  let offset = 2;
  while (offset < bytes.length - 1) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }

    const marker = bytes[offset + 1];

    // Padding between segments is legal and encoded as repeated 0xFF.
    if (marker === 0xff) {
      offset += 1;
      continue;
    }

    // Start Of Scan: its header is followed immediately by the compressed data.
    if (marker === 0xda) {
      return offset + 2 + bytes.readUInt16BE(offset + 2);
    }

    // Standalone markers carry no length field.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      offset += 2;
      continue;
    }

    const length = bytes.readUInt16BE(offset + 2);
    if (length < 2) throw new Error(`corrupt segment length ${length} at ${offset}`);
    offset += 2 + length;
  }

  throw new Error('no Start Of Scan marker found');
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
    'XMP:GPSMapDatum': 'WGS-84',
  };

  if (location.altitude !== undefined) {
    tags['EXIF:GPSAltitude'] = String(Math.abs(location.altitude));
    tags['EXIF:GPSAltitudeRef'] = location.altitude < 0 ? '1' : '0';
  }

  return tags;
}

if (isMain(import.meta.url)) {
  const { failed } = await spliceChecks();
  process.exitCode = failed ? 1 : 0;
}
