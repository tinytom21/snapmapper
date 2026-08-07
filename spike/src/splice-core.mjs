/**
 * The header-splice, shared by the Node verification and the browser measurement.
 *
 * Deliberately one implementation rather than two. The Node run is what *proves* the
 * splice is safe (184 checks against a native ExifTool) and the browser run is what
 * measures how fast it is on a phone; if those two ran different code, the measurement
 * would not be evidence about the thing being verified.
 *
 * Plain `Uint8Array` only — no `Buffer`, no `node:` imports — so the same file loads
 * in a webview.
 *
 * The idea: writing GPS to a JPEG rewrites the metadata segments at the front of the
 * file, and the entropy-coded scan data that follows only needs copying verbatim. On a
 * Sony A6400 JPEG the metadata is ~1.5% of the file. Hand ExifTool a stub of just that
 * much, let it do every bit of the EXIF and MakerNote work unchanged, then reattach the
 * original scan data.
 */

/**
 * Scan bytes retained in the stub after the SOS header.
 *
 * ExifTool needs something that looks like an image, not a complete one. A stub cut
 * off at the SOS header with no scan data at all is rejected as a corrupted JPEG.
 */
export const SCAN_STUB_BYTES = 4096;

/**
 * Offset of the first byte of entropy-coded scan data — just past the SOS header.
 *
 * Everything before it is metadata and image parameters; everything after is the
 * photograph. That boundary is what makes the splice possible.
 */
export function findScanStart(bytes) {
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
      return offset + 2 + readUint16BE(bytes, offset + 2);
    }

    // Standalone markers carry no length field.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      offset += 2;
      continue;
    }

    const length = readUint16BE(bytes, offset + 2);
    if (length < 2) throw new Error(`corrupt segment length ${length} at ${offset}`);
    offset += 2 + length;
  }

  throw new Error('no Start Of Scan marker found');
}

/** A minimal but plausible JPEG carrying the original's metadata, and little else. */
export function buildHeaderStub(bytes, scanStart) {
  const kept = Math.min(scanStart + SCAN_STUB_BYTES, bytes.length);
  const stub = new Uint8Array(kept + 2);
  stub.set(bytes.subarray(0, kept), 0);
  stub[kept] = 0xff; // EOI, so the stub terminates properly
  stub[kept + 1] = 0xd9;
  return stub;
}

/**
 * Reattach original scan data to ExifTool's rewritten headers.
 *
 * Also the safety check. The whole point is that the photograph is untouched, so this
 * refuses to produce a file whose scan data is not byte-for-byte the original's. A
 * silent mismatch here would be the worst possible outcome — a corrupted photo that
 * still reads as valid.
 */
export function spliceHeaders(originalBytes, originalScanStart, rewrittenStub) {
  const rewrittenScanStart = findScanStart(rewrittenStub);

  const scan = originalBytes.subarray(originalScanStart);
  const out = new Uint8Array(rewrittenScanStart + scan.length);
  out.set(rewrittenStub.subarray(0, rewrittenScanStart), 0);
  out.set(scan, rewrittenScanStart);

  // Assert rather than trust: the reattached scan must start exactly where this file
  // says it does, and must be the original bytes.
  const check = findScanStart(out);
  if (check !== rewrittenScanStart) {
    throw new Error(
      `spliced file disagrees about where the scan starts (${check} vs ${rewrittenScanStart})`,
    );
  }
  if (out.length - check !== scan.length) {
    throw new Error('spliced scan data changed length');
  }

  return out;
}

/** One call: stub, write, splice. `write` takes a Uint8Array and resolves to one. */
export async function spliceWrite(originalBytes, write) {
  const scanStart = findScanStart(originalBytes);
  const stub = buildHeaderStub(originalBytes, scanStart);
  const rewritten = await write(stub);
  return {
    bytes: spliceHeaders(originalBytes, scanStart, rewritten),
    stubBytes: stub.length,
    totalBytes: originalBytes.length,
  };
}

function readUint16BE(bytes, offset) {
  return (bytes[offset] << 8) | bytes[offset + 1];
}
