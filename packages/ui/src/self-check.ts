/**
 * Does the metadata write path work *in this shell*?
 *
 * Not a substitute for the test suite. It answers a different and narrower question that
 * unit tests cannot: whether the 24MB WASM binary loads, whether this origin is a secure
 * context, and whether a real ExifTool write completes — here, in this browser or
 * webview, on this device.
 *
 * Phase 0 produced three failures that only ever appear at runtime and only on some
 * platforms:
 *
 *   - the WASM 404ing because it is not served next to the page
 *   - `crypto.randomUUID` missing outside a secure context, which breaks writes while
 *     leaving reads working
 *   - a `Blob` input costing ~69× more than bytes
 *
 * Every one of those passed a code review and failed on a device. Running this first on
 * Android will save the same day twice.
 *
 * Uses a canvas-generated JPEG, so it needs no fixtures and touches none of the user's
 * photographs. It therefore proves the *plumbing*, not Sony MakerNote correctness — that
 * is established against real files by `spike/src/splice-write.mjs` and a native ExifTool.
 */

import {
  buildGeotagTags,
  createWasmBackend,
  metadataFraction,
  readTags,
  writeMetadataSpliced,
} from '@geotagger/core';

export interface SelfCheckResult {
  readonly ok: boolean;
  readonly secureContext: boolean;
  readonly checks: readonly { name: string; ok: boolean; detail: string }[];
}

export async function runSelfCheck(): Promise<SelfCheckResult> {
  const checks: { name: string; ok: boolean; detail: string }[] = [];
  const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });

  // A secure context is required for crypto.randomUUID, which the backend uses to name
  // its temp file. Without it reads work and every write throws — a confusing failure.
  add(
    'Secure context (writes need crypto.randomUUID)',
    window.isSecureContext && typeof crypto.randomUUID === 'function',
    window.isSecureContext ? 'yes' : 'NO — writes will fail; serve over https or localhost',
  );

  let backend;
  try {
    const started = performance.now();
    const wasm = await import('@uswriting/exiftool');
    backend = createWasmBackend(wasm);
    add('WASM module loads', true, `${Math.round(performance.now() - started)} ms`);
  } catch (error) {
    add('WASM module loads', false, message(error));
    return { ok: false, secureContext: window.isSecureContext, checks };
  }

  const jpeg = await syntheticJpeg();
  add('Test JPEG built', true, `${(jpeg.length / 1024).toFixed(0)} KB`);

  try {
    add(
      'JPEG structure parsed',
      true,
      `metadata is ${(100 * metadataFraction(jpeg)).toFixed(1)}% of the file`,
    );
  } catch (error) {
    add('JPEG structure parsed', false, message(error));
  }

  try {
    const started = performance.now();
    const written = await writeMetadataSpliced(
      backend,
      jpeg,
      'self-check.jpg',
      buildGeotagTags({
        coordinates: { latitude: 51.4778, longitude: -0.0015, altitude: 45.7 },
        instant: new Date('2024-05-17T14:32:08.000Z'),
      }),
    );
    const elapsed = Math.round(performance.now() - started);

    add(
      'GPS written via splice',
      true,
      `${elapsed} ms, ExifTool saw ${(written.stubBytes / 1024).toFixed(0)} KB`
      + ` of ${(written.totalBytes / 1024).toFixed(0)} KB`,
    );

    const values = await readTags(backend, written.bytes, 'self-check.jpg', [
      'Composite:GPSLatitude', 'Composite:GPSLongitude', 'EXIF:GPSDateStamp',
    ]);

    const latitude = Number(values['Composite:GPSLatitude']);
    add(
      'Coordinates read back',
      Math.abs(latitude - 51.4778) < 1e-6,
      `${values['Composite:GPSLatitude']}, ${values['Composite:GPSLongitude']}`
      + ` on ${values['EXIF:GPSDateStamp']}`,
    );

    for (const warning of written.warnings) add('Benign warning', true, warning);
  } catch (error) {
    add('GPS written via splice', false, message(error));
  }

  return {
    ok: checks.every((check) => check.ok),
    secureContext: window.isSecureContext,
    checks,
  };
}

/** A JPEG with photographic entropy, so it compresses like a real one. */
async function syntheticJpeg(): Promise<Uint8Array> {
  const canvas = document.createElement('canvas');
  canvas.width = 1200;
  canvas.height = 800;

  const context = canvas.getContext('2d');
  if (!context) throw new Error('no 2d canvas context');

  const image = context.createImageData(canvas.width, canvas.height);
  let seed = 20260807;
  for (let i = 0; i < image.data.length; i += 4) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const value = (seed >> 16) & 255;
    image.data[i] = value;
    image.data[i + 1] = (value * 5 + 30) & 255;
    image.data[i + 2] = (value * 11 + 70) & 255;
    image.data[i + 3] = 255;
  }
  context.putImageData(image, 0, 0);

  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, 'image/jpeg', 0.9));
  if (!blob) throw new Error('canvas produced no JPEG');

  // One bulk read, never a Blob handed onwards.
  return new Uint8Array(await blob.arrayBuffer());
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
