/**
 * Independent verification using a *native* ExifTool install.
 *
 * Checking ExifTool-WASM's output with the same WASM build would only prove it
 * is self-consistent. Running a separate native ExifTool over the result is
 * what makes the check meaningful.
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** Large buffer: A6400 MakerNotes plus an embedded thumbnail can be sizeable. */
const MAX_BUFFER = 64 * 1024 * 1024;

/**
 * The native ExifTool to verify against.
 *
 * Windows installers put it in a per-user directory and only add it to the
 * registry's PATH, so an already-running shell will not find it. Set EXIFTOOL to
 * an absolute path to work around that without restarting anything.
 */
const EXIFTOOL = process.env.EXIFTOOL || 'exiftool';

export async function nativeExifToolVersion() {
  try {
    const { stdout } = await run(EXIFTOOL, ['-ver']);
    return stdout.trim();
  } catch {
    return null;
  }
}

/** All tags, group-prefixed, in numeric form. */
export async function readTags(filePath) {
  const { stdout } = await run(EXIFTOOL, ['-json', '-n', '-G', '-a', '-u', filePath], {
    maxBuffer: MAX_BUFFER,
  });
  return JSON.parse(stdout)[0];
}

/**
 * The raw MakerNotes block, and its hash.
 *
 * Sony packs autofocus, lens and white-balance data into MakerNotes using
 * offsets relative to the start of the *file*, so a writer that moves the block
 * without fixing those offsets silently corrupts it. The tags still read, which
 * is what makes that failure dangerous.
 *
 * Note carefully what this does and does not prove. Byte identity is **not** the
 * correct criterion, and the first run of this spike against real A6400 files
 * showed why: inserting a GPS IFD pointer adds one 12-byte IFD entry to IFD0,
 * which shifts MakerNotes 12 bytes later in the file. A correct writer must then
 * rewrite every absolute offset inside the block by +12. Measured on
 * DSC00119.JPG, exactly 41 of 37,664 bytes changed, and every one of them was a
 * value incremented by precisely 12.
 *
 * So bytes changing is the *expected* result, and bytes staying identical while
 * the block moves would be the corruption. What has to be proved instead is that
 * the content still decodes and that the offsets still resolve — see
 * `makerNotesIntegrity`.
 */
export async function makerNotesBlock(filePath) {
  try {
    const { stdout } = await run(EXIFTOOL, ['-b', '-MakerNotes', filePath], {
      encoding: 'buffer',
      maxBuffer: MAX_BUFFER,
    });
    if (!stdout || stdout.length === 0) return null;
    return { bytes: stdout, hash: createHash('sha256').update(stdout).digest('hex') };
  } catch {
    return null;
  }
}

/** Every MakerNote tag, decoded, in numeric form. */
async function readMakerNoteTags(filePath) {
  const { stdout } = await run(
    EXIFTOOL,
    ['-json', '-n', '-G1', '-a', '-u', '-MakerNotes:all', filePath],
    { maxBuffer: MAX_BUFFER },
  );
  const parsed = JSON.parse(stdout)[0] ?? {};
  delete parsed.SourceFile;
  return parsed;
}

/** A binary payload located by an absolute offset stored inside MakerNotes. */
async function binaryTagHash(filePath, tag) {
  try {
    const { stdout } = await run(EXIFTOOL, ['-b', `-${tag}`, filePath], {
      encoding: 'buffer',
      maxBuffer: MAX_BUFFER,
    });
    if (!stdout || stdout.length === 0) return null;
    return {
      size: stdout.length,
      hash: createHash('sha256').update(stdout).digest('hex'),
    };
  } catch {
    return null;
  }
}

/** ExifTool's own complaints. It is loud about maker-note offsets that do not add up. */
async function readWarnings(filePath) {
  try {
    const { stdout } = await run(EXIFTOOL, ['-a', '-u', '-warning', '-error', filePath], {
      maxBuffer: MAX_BUFFER,
    });
    return stdout.trim();
  } catch (error) {
    return `could not read warnings: ${error.message}`;
  }
}

/**
 * Whether Sony MakerNotes survived, judged on content rather than on bytes.
 *
 * Three independent angles, because no single one of them is sufficient:
 *
 *   1. Every MakerNote tag decodes to the same value. Catches lost or garbled
 *      fields.
 *   2. The embedded preview and thumbnail — both reached through absolute file
 *      offsets held in MakerNotes — extract byte-identically. This is the check
 *      that actually proves the offsets were repaired, because a stale offset
 *      yields truncated or garbage bytes rather than a clean failure.
 *   3. ExifTool reports no new warnings. It validates maker-note offset
 *      plausibility itself and says so when they look wrong.
 */
export async function makerNotesIntegrity(originalPath, taggedPath) {
  const checks = [];

  const [originalBlock, taggedBlock] = await Promise.all([
    makerNotesBlock(originalPath),
    makerNotesBlock(taggedPath),
  ]);

  if (originalBlock === null) {
    checks.push({
      name: 'Sony MakerNotes present',
      pass: false,
      detail: 'the original has no MakerNotes — is this really a Sony file?',
    });
    return checks;
  }

  if (taggedBlock === null) {
    checks.push({
      name: 'Sony MakerNotes survived at all',
      pass: false,
      detail: 'MakerNotes are GONE from the tagged file — stop, the backend is destroying them',
    });
    return checks;
  }

  // 1. Content.
  const [originalTags, taggedTags] = await Promise.all([
    readMakerNoteTags(originalPath),
    readMakerNoteTags(taggedPath),
  ]);

  const changed = Object.keys(originalTags).filter(
    (tag) => JSON.stringify(originalTags[tag]) !== JSON.stringify(taggedTags[tag]),
  );
  const missing = Object.keys(originalTags).filter((tag) => !(tag in taggedTags));

  checks.push({
    name: 'Every MakerNote tag decodes to the same value',
    pass: changed.length === 0 && missing.length === 0,
    detail: changed.length === 0 && missing.length === 0
      ? `all ${Object.keys(originalTags).length} tags identical`
      : `${changed.length} changed, ${missing.length} missing: ${[...changed, ...missing].slice(0, 8).join(', ')}`,
  });

  // 2. The offsets actually resolve.
  for (const tag of ['PreviewImage', 'ThumbnailImage']) {
    const [before, after] = await Promise.all([
      binaryTagHash(originalPath, tag),
      binaryTagHash(taggedPath, tag),
    ]);

    if (before === null) {
      checks.push({ name: `${tag} offset resolves`, pass: true, detail: 'not present in the original — skipped' });
      continue;
    }

    checks.push({
      name: `${tag} still resolves byte-identically`,
      pass: after !== null && before.hash === after.hash && before.size === after.size,
      detail: after === null
        ? 'could not be extracted from the tagged file — a stale offset'
        : `${before.size} B ${short(before.hash)} -> ${after.size} B ${short(after.hash)}`,
    });
  }

  // 3. ExifTool's own verdict.
  const [originalWarnings, taggedWarnings] = await Promise.all([
    readWarnings(originalPath),
    readWarnings(taggedPath),
  ]);

  checks.push({
    name: 'No new ExifTool warnings',
    pass: taggedWarnings === originalWarnings,
    detail: taggedWarnings === originalWarnings
      ? taggedWarnings === '' ? 'none, before or after' : `unchanged: ${truncate(taggedWarnings)}`
      : `new: ${truncate(taggedWarnings)}`,
  });

  // Quantify the byte drift. A correct writer touches only the offset fields — Q1
  // measured 41 bytes of 37,664, or 0.11% — so a small drift is expected and a large
  // one is a rewrite. Calling any drift "expected" would have described piexifjs
  // mangling 63% of the block as normal, which is why this is now graded.
  const identical = originalBlock.hash === taggedBlock.hash;
  let drift = 'identical';
  let driftAcceptable = true;

  if (!identical) {
    if (originalBlock.bytes.length !== taggedBlock.bytes.length) {
      drift = `LENGTH CHANGED: ${originalBlock.bytes.length} -> ${taggedBlock.bytes.length} B`
        + ' — the block was rebuilt, not adjusted';
      driftAcceptable = false;
    } else {
      let differing = 0;
      for (let i = 0; i < originalBlock.bytes.length; i++) {
        if (originalBlock.bytes[i] !== taggedBlock.bytes[i]) differing++;
      }
      const percent = (100 * differing) / originalBlock.bytes.length;
      // 2% is generous: offset fixups are a handful of 2- and 4-byte fields.
      driftAcceptable = percent < 2;
      drift = `${differing} of ${originalBlock.bytes.length} bytes (${percent.toFixed(2)}%)`
        + (driftAcceptable
          ? ' — consistent with offset fixups only'
          : ' — far too much for offset fixups; the block was re-serialised');
    }
  }

  checks.push({ name: 'MakerNotes byte drift is offset-sized', pass: driftAcceptable, detail: drift });

  return checks;
}

function truncate(value, limit = 140) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/**
 * SHA-256 of the compressed image data, proving the photograph itself is
 * untouched.
 *
 * Everything from the Start Of Scan marker to the end of the file is entropy-
 * coded image data. All metadata lives in segments before it, so hashing from
 * SOS onward isolates the pixels from anything a metadata writer should be
 * touching.
 */
export function imageDataHash(bytes) {
  const buffer = Buffer.isBuffer(bytes)
    ? bytes
    : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  if (buffer[0] !== 0xff || buffer[1] !== 0xd8) {
    throw new Error('Not a JPEG — no SOI marker');
  }

  let offset = 2;
  while (offset < buffer.length - 1) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }

    const marker = buffer[offset + 1];

    // Padding between segments is legal and encoded as repeated 0xFF.
    if (marker === 0xff) {
      offset += 1;
      continue;
    }

    if (marker === 0xda) {
      return createHash('sha256').update(buffer.subarray(offset)).digest('hex');
    }

    // Standalone markers carry no length field.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      offset += 2;
      continue;
    }

    const length = buffer.readUInt16BE(offset + 2);
    if (length < 2) throw new Error(`Corrupt segment length ${length} at ${offset}`);
    offset += 2 + length;
  }

  throw new Error('No Start Of Scan marker found');
}

/**
 * Compare a tagged file against its original and report what actually changed.
 *
 * Returns a list of check results rather than throwing, so a failing spike
 * still prints the full picture instead of stopping at the first problem.
 */
export async function compare({ originalPath, taggedPath, originalBytes, taggedBytes, expected }) {
  const checks = [];
  const add = (name, pass, detail) => checks.push({ name, pass, detail });

  const [originalTags, taggedTags] = await Promise.all([
    readTags(originalPath),
    readTags(taggedPath),
  ]);

  // --- The coordinates actually landed, and a second implementation agrees ---
  //
  // Group-prefixed EXIF:GPSLatitude is the raw tag, and EXIF stores it
  // *unsigned* with the hemisphere in a separate ref — so even under -n it reads
  // back as 33.8688 for a southern location, never -33.8688. Composite:* is
  // ExifTool's derived signed value, which is what consumers actually resolve.
  // Comparing the raw tag against a signed expectation fails every southern and
  // western case, which is exactly the case worth testing.
  const readBack = {
    latitude: taggedTags['Composite:GPSLatitude'],
    longitude: taggedTags['Composite:GPSLongitude'],
    magnitudeLatitude: taggedTags['EXIF:GPSLatitude'],
    magnitudeLongitude: taggedTags['EXIF:GPSLongitude'],
    latitudeRef: taggedTags['EXIF:GPSLatitudeRef'],
    longitudeRef: taggedTags['EXIF:GPSLongitudeRef'],
  };

  const latitudeOk = closeEnough(readBack.latitude, expected.latitude);
  const longitudeOk = closeEnough(readBack.longitude, expected.longitude);

  add(
    'GPS coordinates round-trip signed',
    latitudeOk && longitudeOk,
    `wrote ${expected.latitude}, ${expected.longitude} — read back ${readBack.latitude}, ${readBack.longitude}`,
  );

  // Checked separately, because a writer that puts a signed value into the raw
  // unsigned tag can still produce a correct Composite reading in ExifTool while
  // confusing readers that combine magnitude and ref themselves.
  const magnitudeOk = closeEnough(readBack.magnitudeLatitude, Math.abs(expected.latitude))
    && closeEnough(readBack.magnitudeLongitude, Math.abs(expected.longitude));
  add(
    'EXIF stores unsigned magnitudes, as the spec requires',
    magnitudeOk,
    `${readBack.magnitudeLatitude}, ${readBack.magnitudeLongitude}`,
  );

  const expectedLatitudeRef = expected.latitude < 0 ? 'S' : 'N';
  const expectedLongitudeRef = expected.longitude < 0 ? 'W' : 'E';
  add(
    'Hemisphere refs written and correct',
    readBack.latitudeRef === expectedLatitudeRef
      && readBack.longitudeRef === expectedLongitudeRef,
    `${readBack.latitudeRef ?? 'missing'} / ${readBack.longitudeRef ?? 'missing'}`
      + ` (expected ${expectedLatitudeRef} / ${expectedLongitudeRef})`,
  );

  add(
    'XMP mirrors EXIF',
    closeEnough(taggedTags['XMP:GPSLatitude'], expected.latitude),
    `XMP:GPSLatitude = ${taggedTags['XMP:GPSLatitude'] ?? 'missing'} (Lightroom reads this one)`,
  );

  // --- Nothing else moved ---
  //
  // Judged on decoded content and resolvable offsets, not on raw byte identity,
  // which a correct writer necessarily breaks. See makerNotesIntegrity.
  checks.push(...(await makerNotesIntegrity(originalPath, taggedPath)));

  let imageOk = false;
  let imageDetail = '';
  try {
    const before = imageDataHash(originalBytes);
    const after = imageDataHash(taggedBytes);
    imageOk = before === after;
    imageDetail = `${short(before)} -> ${short(after)}`;
  } catch (error) {
    imageDetail = `could not hash image data: ${error.message}`;
  }
  add('Compressed image data unchanged', imageOk, imageDetail);

  add(
    'DateTimeOriginal preserved',
    originalTags['EXIF:DateTimeOriginal'] === taggedTags['EXIF:DateTimeOriginal'],
    `${originalTags['EXIF:DateTimeOriginal']} -> ${taggedTags['EXIF:DateTimeOriginal']}`,
  );

  add(
    'Orientation preserved',
    originalTags['EXIF:Orientation'] === taggedTags['EXIF:Orientation'],
    `${originalTags['EXIF:Orientation']} -> ${taggedTags['EXIF:Orientation']}`,
  );

  // Losing a tag is the failure mode that only shows up months later, in a
  // different application, on a file that can no longer be re-tagged.
  const lost = Object.keys(originalTags).filter(
    (tag) => !(tag in taggedTags) && !tag.startsWith('File:') && !tag.startsWith('SourceFile'),
  );
  add(
    'No tags dropped',
    lost.length === 0,
    lost.length === 0 ? 'none' : `${lost.length} lost: ${lost.slice(0, 12).join(', ')}`,
  );

  return checks;
}

function closeEnough(actual, expected, tolerance = 1e-6) {
  const value = typeof actual === 'string' ? Number(actual) : actual;
  return typeof value === 'number' && Number.isFinite(value)
    && Math.abs(value - expected) < tolerance;
}

function short(hash) {
  return hash ? hash.slice(0, 12) : 'none';
}
