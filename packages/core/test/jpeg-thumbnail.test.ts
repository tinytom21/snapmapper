import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { embeddedThumbnail } from '../src/jpeg-thumbnail.ts';

/**
 * Reading an embedded thumbnail by following offsets rather than invoking ExifTool.
 *
 * The real proof is `npm run thumb --workspace spike`, which compares this against ExifTool on
 * seven real A6400 frames and got byte-identical results on all of them. What is here instead is
 * every way the bytes can be *wrong* — truncation, loops, the other byte order, offsets past the
 * end — because those cannot be staged with a real camera and every one of them is a chance to
 * return plausible rubbish instead of nothing.
 */

/** A minimal but genuine EXIF JPEG carrying a thumbnail. */
function jpegWithThumbnail(options: {
  readonly thumbnail?: Uint8Array;
  readonly bigEndian?: boolean;
  readonly omitIfd1?: boolean;
  readonly thumbnailOffsetOverride?: number;
} = {}): Uint8Array {
  const thumbnail = options.thumbnail ?? new Uint8Array([0xff, 0xd8, 0x11, 0x22, 0xff, 0xd9]);
  const little = !options.bigEndian;

  // TIFF: header (8), IFD0 (2 + 1 entry + 4), IFD1 (2 + 2 entries + 4), then the thumbnail bytes.
  const ifd0At = 8;
  const ifd0Size = 2 + 12 + 4;
  const ifd1At = ifd0At + ifd0Size;
  const ifd1Size = 2 + 24 + 4;
  const thumbAt = ifd1At + ifd1Size;

  const tiff = new Uint8Array(thumbAt + thumbnail.byteLength);
  const view = new DataView(tiff.buffer);

  view.setUint16(0, little ? 0x4949 : 0x4d4d);
  view.setUint16(2, 42, little);
  view.setUint32(4, ifd0At, little);

  // IFD0: one harmless entry, then a link to IFD1 (or none).
  view.setUint16(ifd0At, 1, little);
  view.setUint16(ifd0At + 2, 0x010f, little); // Make
  view.setUint16(ifd0At + 4, 2, little);
  view.setUint32(ifd0At + 6, 1, little);
  view.setUint32(ifd0At + 10, 0, little);
  view.setUint32(ifd0At + 14, options.omitIfd1 ? 0 : ifd1At, little);

  // IFD1: where the thumbnail is, and how long.
  view.setUint16(ifd1At, 2, little);
  view.setUint16(ifd1At + 2, 0x0201, little);
  view.setUint16(ifd1At + 4, 4, little);
  view.setUint32(ifd1At + 6, 1, little);
  view.setUint32(ifd1At + 10, options.thumbnailOffsetOverride ?? thumbAt, little);

  view.setUint16(ifd1At + 14, 0x0202, little);
  view.setUint16(ifd1At + 16, 4, little);
  view.setUint32(ifd1At + 18, 1, little);
  view.setUint32(ifd1At + 22, thumbnail.byteLength, little);

  view.setUint32(ifd1At + 26, 0, little);
  tiff.set(thumbnail, thumbAt);

  // Wrap in `FFD8`, an APP1 holding `Exif\0\0` and the TIFF, then a start-of-scan.
  const exifHeader = new Uint8Array([0x45, 0x78, 0x69, 0x66, 0x00, 0x00]);
  const payload = exifHeader.byteLength + tiff.byteLength;

  const out = new Uint8Array(2 + 2 + 2 + payload + 2);
  const outView = new DataView(out.buffer);
  outView.setUint16(0, 0xffd8);
  outView.setUint16(2, 0xffe1);
  outView.setUint16(4, payload + 2);
  out.set(exifHeader, 6);
  out.set(tiff, 6 + exifHeader.byteLength);
  outView.setUint16(out.byteLength - 2, 0xffda);

  return out;
}

const THUMB = new Uint8Array([0xff, 0xd8, 0xaa, 0xbb, 0xcc, 0xff, 0xd9]);

describe('reading an embedded thumbnail', () => {
  it('finds it in a little-endian file, which is what Sony writes', () => {
    const found = embeddedThumbnail(jpegWithThumbnail({ thumbnail: THUMB }));
    assert.deepEqual(found && [...found], [...THUMB]);
  });

  it('finds it in a big-endian file too', () => {
    // The TIFF block follows its own byte-order mark, not the platform's. Reading the wrong way
    // round yields plausible nonsense rather than an error, so both are checked explicitly.
    const found = embeddedThumbnail(jpegWithThumbnail({ thumbnail: THUMB, bigEndian: true }));
    assert.deepEqual(found && [...found], [...THUMB]);
  });

  it('returns nothing when there is no second directory', () => {
    // A photograph with no thumbnail at all: IFD0 links to zero.
    assert.equal(embeddedThumbnail(jpegWithThumbnail({ omitIfd1: true })), undefined);
  });

  it('refuses an offset that runs past the end', () => {
    /*
     * The normal case, not an exotic one: the caller passes the first 128KB of a 7MB file, so an
     * offset into the body is *expected* to be out of range. Returning the tail of the buffer
     * instead would put a fragment of image data into an `<img>`.
     */
    const whole = jpegWithThumbnail({ thumbnail: THUMB });
    assert.equal(embeddedThumbnail(whole.subarray(0, whole.byteLength - 4)), undefined);
  });

  it('refuses bytes that are not a JPEG at all', () => {
    assert.equal(embeddedThumbnail(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])), undefined);
    assert.equal(embeddedThumbnail(new Uint8Array(0)), undefined);
  });

  it('refuses a slice that is not itself a JPEG', () => {
    /*
     * The offsets came out of the file, so a file that is subtly wrong gives a subtly wrong slice.
     * An `<img>` fed rubbish shows a broken icon and reports nothing, so this has to be caught
     * here — where the caller can fall back to ExifTool and get the right picture.
     */
    const bad = embeddedThumbnail(jpegWithThumbnail({ thumbnailOffsetOverride: 8 }));
    assert.equal(bad, undefined);
  });

  it('survives a directory chain that points at itself', () => {
    // Real files do not do this. Corrupt ones do, and a background feed must not hang on one.
    const looped = jpegWithThumbnail({ thumbnail: THUMB });
    // Point IFD0's "next" link back at IFD0.
    const view = new DataView(looped.buffer);
    view.setUint32(12 + 8 + 2 + 12, 8, true);
    assert.equal(embeddedThumbnail(looped), undefined);
  });

  it('skips an APP1 that is XMP rather than EXIF', () => {
    // Cameras write both, XMP first on some bodies. Matching `FFE1` alone reads the wrong one.
    const real = jpegWithThumbnail({ thumbnail: THUMB });
    /*
     * Twelve bytes: the two marker bytes, then a length of 10 covering the length field itself and
     * eight of payload. Getting that arithmetic wrong in the *fixture* made this fail first time —
     * the walker stepped two bytes short and landed inside the real EXIF marker, and the parser
     * correctly declined rather than returning nonsense.
     */
    const xmp = new Uint8Array([
      0xff, 0xe1, 0x00, 0x0a, 0x68, 0x74, 0x74, 0x70, 0x3a, 0x2f, 0x2f, 0x00,
    ]);

    const combined = new Uint8Array(2 + xmp.byteLength + (real.byteLength - 2));
    combined.set([0xff, 0xd8], 0);
    combined.set(xmp, 2);
    combined.set(real.subarray(2), 2 + xmp.byteLength);

    const found = embeddedThumbnail(combined);
    assert.deepEqual(found && [...found], [...THUMB]);
  });

  it('never throws, whatever it is given', () => {
    // It is handed arbitrary bytes off a camera card, and a background feed must not die on one.
    for (const bytes of [
      new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff]),
      new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x00]),
      new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x08, 0x45, 0x78, 0x69, 0x66]),
    ]) {
      assert.doesNotThrow(() => embeddedThumbnail(bytes));
    }
  });
});
