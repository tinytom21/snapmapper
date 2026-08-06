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
 * SHA-256 of the raw MakerNotes block.
 *
 * This is the load-bearing check. Sony packs autofocus, lens and white-balance
 * data into MakerNotes using offsets relative to the start of the file, so a
 * writer that moves things around without fixing those offsets silently
 * corrupts them. The tags still *read*, which is what makes it dangerous — only
 * a byte comparison catches it.
 */
export async function makerNotesHash(filePath) {
  try {
    const { stdout } = await run(EXIFTOOL, ['-b', '-MakerNotes', filePath], {
      encoding: 'buffer',
      maxBuffer: MAX_BUFFER,
    });
    if (!stdout || stdout.length === 0) return null;
    return createHash('sha256').update(stdout).digest('hex');
  } catch {
    return null;
  }
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
  const [originalMakerNotes, taggedMakerNotes] = await Promise.all([
    makerNotesHash(originalPath),
    makerNotesHash(taggedPath),
  ]);

  add(
    'Sony MakerNotes byte-identical',
    originalMakerNotes !== null && originalMakerNotes === taggedMakerNotes,
    originalMakerNotes === null
      ? 'original had no MakerNotes — is this really an A6400 file?'
      : `${short(originalMakerNotes)} -> ${short(taggedMakerNotes)}`,
  );

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
