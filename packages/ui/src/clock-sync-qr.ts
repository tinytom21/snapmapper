/**
 * Reading the application's own clock back out of a photograph of the screen.
 *
 * The flow: the app shows a QR code carrying the current instant, refreshed several times
 * a second. The user photographs the monitor with the camera whose clock is in question.
 * That photograph now contains, in its pixels, the true time — and in its EXIF, the
 * camera's own idea of the time. The difference is the drift.
 *
 * Why a QR rather than a readable clock face and OCR: a QR carries its own error
 * correction, so a code either decodes to exactly what was displayed or fails to decode at
 * all. **A misread cannot silently produce a plausible wrong time.** That property is worth
 * a lot here, because the result shifts the GPS timestamp of every photo in the session,
 * and a quietly wrong offset would be very hard to notice.
 *
 * Also, conveniently, a QR is designed to survive being photographed off a screen: glare,
 * moiré, perspective and scaling are what its finder patterns exist for.
 */

import { parseSyncPayload } from '@snapmapper/core';
import * as jsQRModule from 'jsqr';

/**
 * The decoder, reached past a types/runtime mismatch in the package.
 *
 * jsqr ships a webpack UMD bundle where `module.exports` is the decode function itself,
 * carrying both an `__esModule` marker and a `.default` that is the same function
 * (verified: `typeof require('jsqr') === 'function'` and `.default` is a function too).
 * Its declarations say `export default`, but under NodeNext a CommonJS namespace's
 * `.default` is modelled as the whole namespace — so neither a default import nor
 * `namespace.default` typechecks, even though both work.
 *
 * Declaring the signature we actually depend on is better than an `any` here: it is the
 * bit that has to keep working, so it should still be checked at every call.
 */
type DecodeQr = (
  data: Uint8ClampedArray,
  width: number,
  height: number,
  options?: { inversionAttempts?: 'dontInvert' | 'onlyInvert' | 'attemptBoth' | 'invertFirst' },
) => { data: string } | null;

const jsQR = (jsQRModule as unknown as { default: DecodeQr }).default;

export type SyncScanResult =
  | { readonly kind: 'found'; readonly trueInstant: Date }
  | { readonly kind: 'no-code'; readonly message: string }
  | { readonly kind: 'foreign-code'; readonly message: string };

/**
 * Widths the image is tried at.
 *
 * A 24MP photograph is far more pixels than a QR decoder needs, and downscaling both
 * speeds it up and suppresses the moiré that photographing a screen produces. Several
 * sizes are tried because the right one depends on how much of the frame the monitor
 * fills — a code shot from across a desk needs more resolution than one filling it.
 */
const PREFERRED_WIDTHS = [1600, 1000, 640];

/** Above this, a full-resolution attempt costs more than it is worth. */
const NATIVE_ATTEMPT_LIMIT = 2000;

/**
 * The widths actually attempted for one image, deduplicated.
 *
 * Clamped to the image rather than filtered against it. An earlier version skipped any
 * preferred width larger than the image, which meant a *small* image — every preferred
 * width exceeding it — got no attempts at all and reported "no code found" for a picture
 * with a perfectly good code in it. The easy case failed while the hard ones passed.
 */
export function scanWidthsFor(imageWidth: number): number[] {
  const widths = new Set<number>();
  for (const width of PREFERRED_WIDTHS) widths.add(Math.min(width, imageWidth));
  if (imageWidth <= NATIVE_ATTEMPT_LIMIT) widths.add(imageWidth);
  return [...widths];
}

/**
 * Find the application's clock code in a photograph.
 *
 * Takes bytes rather than a `Blob` for consistency with the rest of the write path, though
 * here it genuinely does not matter — `createImageBitmap` is a single bulk decode either
 * way.
 */
export async function scanForSyncCode(jpegBytes: Uint8Array): Promise<SyncScanResult> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(new Blob([jpegBytes as BlobPart], { type: 'image/jpeg' }));
  } catch (error) {
    return {
      kind: 'no-code',
      message: `could not decode the photo: ${error instanceof Error ? error.message : error}`,
    };
  }

  try {
    let sawSomething = false;

    for (const width of scanWidthsFor(bitmap.width)) {
      const decoded = decodeAt(bitmap, width);
      if (!decoded) continue;

      sawSomething = true;
      const instant = parseSyncPayload(decoded);
      if (instant) return { kind: 'found', trueInstant: instant };
    }

    return sawSomething
      ? {
        kind: 'foreign-code',
        message: 'found a QR code, but not this application\'s clock — is it the right photo?',
      }
      : {
        kind: 'no-code',
        message: 'no QR code found. Fill more of the frame with the screen, avoid glare, '
          + 'and make sure the code was on screen when the shutter fired.',
      };
  } finally {
    bitmap.close();
  }
}

/** Decode at one scale. Returns the code's text, or null. */
function decodeAt(bitmap: ImageBitmap, targetWidth: number): string | null {
  const scale = Math.min(1, targetWidth / bitmap.width);
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;

  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return null;

  context.drawImage(bitmap, 0, 0, width, height);
  const { data } = context.getImageData(0, 0, width, height);

  // Both inversion attempts: a code photographed off a bright screen can come back with
  // reversed contrast depending on exposure.
  const result = jsQR(data, width, height, { inversionAttempts: 'attemptBoth' });
  return result?.data ?? null;
}
