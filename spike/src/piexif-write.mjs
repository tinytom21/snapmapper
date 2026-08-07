/**
 * Spike Q5 — can a pure-JS writer replace ExifTool on Android?
 *
 * ExifTool-WASM is ruled out for Android writes: 13.87 s/MB on a real phone against
 * 0.26 s/MB on the desktop, with 99% of the cost in the bytes, so batching cannot
 * help. `piexifjs` is the escape hatch the plan named — ~30KB of plain JS, no WASM.
 *
 * The question is not whether it is fast. It obviously is: writing GPS to a JPEG
 * means rewriting one APP1 segment near the front of the file and copying the rest
 * verbatim, which is memcpy work. The question is whether it is **safe**, and there
 * is specific reason to doubt it: piexifjs parses EXIF into a dictionary and
 * re-serialises the whole APP1 from scratch. That is precisely the operation that
 * corrupts offset-relative maker notes, and it is why exiv2 is already banned in this
 * project (KDE #326408).
 *
 * Q1 has since told us exactly what a correct write looks like on these files. When
 * ExifTool inserted a GPS IFD pointer it shifted MakerNotes 12 bytes later and
 * rewrote every internal absolute offset by +12 — 41 bytes of 37,664, and nothing
 * else. A writer that re-serialises without knowing which of those bytes are offsets
 * will leave them pointing 12 bytes short.
 *
 * So this runs piexifjs through the *same* verification as Q1: every MakerNote tag
 * decoding identically, the embedded preview and thumbnail still resolving
 * byte-identically, and no new ExifTool warnings. Byte-level equality is not the
 * test — see verify.mjs.
 *
 * Run with: npm run piexif --workspace spike
 */

import { readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';

import piexif from 'piexifjs';

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
import { compare, nativeExifToolVersion } from './verify.mjs';

/** Same locations Q1 used, so the two runs are directly comparable. */
const TEST_LOCATION = { latitude: 51.4778, longitude: -0.0015, altitude: 45.7 };
const SIGNED_LOCATION = { latitude: -33.8688, longitude: -70.6693 };

/**
 * piexifjs works on "binary strings" — one character per byte. latin1 is the
 * encoding that maps bytes to code points 1:1 without mangling anything.
 */
const BINARY = 'latin1';

export async function piexifChecks() {
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

  const outputDir = await ensureOutputDir();
  let allPassed = true;
  const timings = [];

  for (const fixturePath of fixtures) {
    const name = path.basename(fixturePath);
    section(name);

    const originalStat = await stat(fixturePath);
    const originalBytes = await readFile(fixturePath);
    note(`${formatBytes(originalBytes.byteLength)} on disk`);

    for (const [label, location] of [
      ['Greenwich', TEST_LOCATION],
      ['southern + western', SIGNED_LOCATION],
    ]) {
      const outputPath = path.join(
        outputDir,
        `piexif-${label.replace(/\W+/g, '-')}-${name}`,
      );

      let taggedBytes;
      const started = performance.now();
      try {
        taggedBytes = writeGpsWithPiexif(originalBytes, location);
      } catch (error) {
        result(false, `${label}: piexifjs threw — ${error.message}`);
        allPassed = false;
        continue;
      }
      const elapsed = performance.now() - started;
      timings.push(elapsed);

      await writeFile(outputPath, taggedBytes);
      note(`${label}: wrote in ${formatMs(elapsed)} -> ${path.basename(outputPath)}`);

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

    // Geotagging is not an edit to the photograph; the host restores mtime. Noted
    // here only so the comparison with Q1 is like for like.
    void originalStat;
  }

  section('Speed, for contrast');

  if (timings.length > 0) {
    timings.sort((a, b) => a - b);
    const median = timings[Math.floor(timings.length / 2)];
    note(`median write: ${formatMs(median)}`);
    note(`ExifTool-WASM on the same desktop: ~2 s for these files`);
    note(`ExifTool-WASM on a phone: ~76 s for 5.4MB`);
    note(`20 photos at this rate: ${formatMs(median * 20)}`);
  }

  section('Q5 verdict');

  if (allPassed) {
    result(true, 'piexifjs preserves everything Q1 checks — a viable Android write path');
    note('Still verify on more files, and note it is JPEG-only: no ARW, no video.');
  } else {
    result(false, 'piexifjs damages the file — read the failures above');
    note('This is the exiv2 failure mode: re-serialising EXIF without fixing');
    note('offset-relative maker notes. Fast is not the same as safe.');
  }

  return { failed: !allPassed, findings: { medianMs: timings[Math.floor(timings.length / 2)] } };
}

/**
 * Write GPS with piexifjs, as an application would.
 *
 * Deliberately the straightforward, documented usage — load, mutate the GPS IFD,
 * dump, insert. If the obvious approach damages the file, that is the finding; the
 * point is not to nurse it through with private knowledge of its internals.
 */
function writeGpsWithPiexif(originalBytes, location) {
  const jpegString = originalBytes.toString(BINARY);

  const exif = piexif.load(jpegString);

  // piexifjs stores GPS coordinates as unsigned DMS rationals plus a ref, which is
  // the EXIF representation, so the sign has to be split off exactly as gps.ts does.
  const gps = exif.GPS ?? {};

  gps[piexif.GPSIFD.GPSLatitudeRef] = location.latitude < 0 ? 'S' : 'N';
  gps[piexif.GPSIFD.GPSLatitude] = piexif.GPSHelper.degToDmsRational(Math.abs(location.latitude));
  gps[piexif.GPSIFD.GPSLongitudeRef] = location.longitude < 0 ? 'W' : 'E';
  gps[piexif.GPSIFD.GPSLongitude] = piexif.GPSHelper.degToDmsRational(Math.abs(location.longitude));
  gps[piexif.GPSIFD.GPSMapDatum] = 'WGS-84';

  if (location.altitude !== undefined) {
    gps[piexif.GPSIFD.GPSAltitudeRef] = location.altitude < 0 ? 1 : 0;
    // Rationals are [numerator, denominator]; 100 keeps two decimals of metres.
    gps[piexif.GPSIFD.GPSAltitude] = [Math.round(Math.abs(location.altitude) * 100), 100];
  }

  exif.GPS = gps;

  const exifBytes = piexif.dump(exif);
  const tagged = piexif.insert(exifBytes, jpegString);

  return Buffer.from(tagged, BINARY);
}

if (isMain(import.meta.url)) {
  const { failed } = await piexifChecks();
  process.exitCode = failed ? 1 : 0;
}
