/**
 * JPEG segment structure — just enough of it to separate metadata from photograph.
 *
 * This exists because of a measurement. Handing ExifTool a whole 6MB JPEG to write
 * GPS costs ~1.1 s on a phone; handing it only the ~100KB of metadata headers and
 * reattaching the original scan data costs ~340 ms, and on the Blob-input path it was
 * the difference between 76 s and under a second. Metadata is ~2% of an A6400 JPEG,
 * and the other 98% only needs copying.
 *
 * The safety of that trade was established in Phase 0 rather than assumed: writing the
 * same GPS to a 1.6% stub and to the full file produces **byte-identical** APP1
 * segments, so maker-note offsets are relative to the TIFF header inside the segment
 * and the metadata rewrite does not depend on what follows it. 184 checks across 7
 * real ILCE-6400 files, verified against a separate native ExifTool. See
 * `spike/README.md` Q6.
 *
 * A JPEG is a sequence of marker segments. Each starts with 0xFF, then a marker byte,
 * then (for most markers) a big-endian 16-bit length covering the length field itself.
 * Start Of Scan (0xFFDA) is the boundary: its header is followed immediately by
 * entropy-coded image data that runs to the end of the file.
 */

/** Bytes of scan data retained in a stub, after the SOS header. */
export const SCAN_STUB_BYTES = 4096;

const MARKER_PREFIX = 0xff;
const SOI = 0xd8;
const EOI = 0xd9;
const SOS = 0xda;
const TEM = 0x01;
const RST_FIRST = 0xd0;

export class JpegStructureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JpegStructureError';
  }
}

/**
 * Offset of the first byte of entropy-coded scan data.
 *
 * Everything before this is metadata and image parameters; everything after is the
 * photograph. Throws rather than guessing — a file we cannot parse is a file we must
 * not rewrite.
 */
export function findScanStart(bytes: Uint8Array): number {
  if (bytes.length < 4 || bytes[0] !== MARKER_PREFIX || bytes[1] !== SOI) {
    throw new JpegStructureError('not a JPEG — no SOI marker');
  }

  let offset = 2;
  while (offset < bytes.length - 1) {
    if (bytes[offset] !== MARKER_PREFIX) {
      throw new JpegStructureError(`expected a marker at offset ${offset}`);
    }

    const marker = bytes[offset + 1];

    // Fill bytes between segments are legal and encoded as repeated 0xFF.
    if (marker === MARKER_PREFIX) {
      offset += 1;
      continue;
    }

    if (marker === SOS) {
      const length = readUint16BE(bytes, offset + 2);
      if (length < 2) throw new JpegStructureError(`corrupt SOS length ${length}`);
      const scanStart = offset + 2 + length;
      if (scanStart > bytes.length) throw new JpegStructureError('SOS header runs past end of file');
      return scanStart;
    }

    // Standalone markers carry no length field.
    if (marker === TEM || (marker >= RST_FIRST && marker <= EOI)) {
      offset += 2;
      continue;
    }

    if (offset + 4 > bytes.length) throw new JpegStructureError('segment header runs past end of file');
    const length = readUint16BE(bytes, offset + 2);
    if (length < 2) throw new JpegStructureError(`corrupt segment length ${length} at ${offset}`);
    offset += 2 + length;
  }

  throw new JpegStructureError('no Start Of Scan marker found');
}

/**
 * A small but plausible JPEG carrying the original's metadata and little else.
 *
 * ExifTool needs something that looks like an image, not a complete one. A stub cut
 * off at the SOS header with no scan data at all is rejected outright as a corrupted
 * JPEG, which is why a few KB is kept.
 */
export function buildHeaderStub(bytes: Uint8Array, scanStart: number): Uint8Array {
  const kept = Math.min(scanStart + SCAN_STUB_BYTES, bytes.length);

  const stub = new Uint8Array(kept + 2);
  stub.set(bytes.subarray(0, kept), 0);
  stub[kept] = MARKER_PREFIX;
  stub[kept + 1] = EOI;
  return stub;
}

/**
 * Reattach the original scan data to rewritten metadata headers.
 *
 * Also the safety gate. The entire premise is that the photograph is untouched, so
 * this refuses to return a file whose scan data is not byte-for-byte the original's.
 * A silent mismatch here would be a corrupted photograph that still opens — the worst
 * failure available to this application, and the one worth paying a re-parse for.
 */
export function spliceHeaders(
  original: Uint8Array,
  originalScanStart: number,
  rewrittenStub: Uint8Array,
): Uint8Array {
  const rewrittenScanStart = findScanStart(rewrittenStub);
  const scan = original.subarray(originalScanStart);

  const out = new Uint8Array(rewrittenScanStart + scan.length);
  out.set(rewrittenStub.subarray(0, rewrittenScanStart), 0);
  out.set(scan, rewrittenScanStart);

  const check = findScanStart(out);
  if (check !== rewrittenScanStart) {
    throw new JpegStructureError(
      `spliced file disagrees about where the scan starts (${check} vs ${rewrittenScanStart})`,
    );
  }
  if (out.length - check !== scan.length) {
    throw new JpegStructureError('spliced scan data changed length');
  }

  return out;
}

/** How much of a file is metadata. Diagnostic only, but it is the whole argument. */
export function metadataFraction(bytes: Uint8Array): number {
  return findScanStart(bytes) / bytes.length;
}

function readUint16BE(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] << 8) | bytes[offset + 1]) >>> 0;
}
