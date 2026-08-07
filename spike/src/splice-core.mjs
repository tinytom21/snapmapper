/**
 * The splice, as used by the spike — now a thin shim over the real implementation in
 * `packages/core/src/jpeg.ts`.
 *
 * It started life here, because Phase 0 is where it was invented and proven. Now that
 * it is shipping code it belongs in core, and this file exists only so the two spike
 * callers keep working:
 *
 *   - `splice-write.mjs`, which verifies against a native ExifTool on real A6400 files
 *   - `browser/index.html`, which measures on a phone
 *
 * Keeping them pointed at core is the point. The 184-check verification is what
 * licenses the write path, so it has to exercise the code that actually ships — not a
 * copy that has since drifted from it.
 */

export {
  SCAN_STUB_BYTES,
  buildHeaderStub,
  findScanStart,
  spliceHeaders,
} from '../../packages/core/src/jpeg.ts';

import { buildHeaderStub, findScanStart, spliceHeaders } from '../../packages/core/src/jpeg.ts';

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
