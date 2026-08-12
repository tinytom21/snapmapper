import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { embeddedThumbnail, inspectThumbnail } from '../src/embedded-thumbnail.ts';

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

/**
 * Raw files, which are the same TIFF without the JPEG wrapper.
 *
 * The reason this is not a per-camera optimisation: an EXIF block inside a JPEG is a complete TIFF
 * document, and a TIFF/EP raw file *is* that document as the whole file. IFD0 links to IFD1 and
 * IFD1 carries `0x0201` and `0x0202` either way. Verified against a real ILCE-6400 ARW and native
 * ExifTool — `npm run raw-thumb --workspace spike`, 5 checks, 0 failures, byte-identical.
 *
 * What could not be verified here is other manufacturers: there is one raw fixture on this machine
 * and it is a Sony. NEF, CR2, PEF and SRW are the same TIFF/EP structure by specification, and
 * anything that is not — a DNG keeping its thumbnail in IFD0 as strips, a CR3, which is not TIFF at
 * all — finds no `0x0201`, declines, and falls back to ExifTool exactly as before.
 */
describe('a TIFF that is not wrapped in a JPEG', () => {
  /** A raw file: the TIFF at byte 0, with the thumbnail far past any first read. */
  function rawWithDistantIfd1(gap: number): Uint8Array {
    const thumbnail = new Uint8Array([0xff, 0xd8, 0x33, 0x44, 0xff, 0xd9]);
    const ifd0At = 8;
    const ifd1At = ifd0At + 2 + 12 + 4 + gap;
    const thumbAt = ifd1At + 2 + 24 + 4;

    const file = new Uint8Array(thumbAt + thumbnail.byteLength);
    const view = new DataView(file.buffer);
    view.setUint16(0, 0x4949);
    view.setUint16(2, 42, true);
    view.setUint32(4, ifd0At, true);

    view.setUint16(ifd0At, 1, true);
    view.setUint16(ifd0At + 2, 0x011a, true);
    view.setUint16(ifd0At + 4, 3, true);
    view.setUint32(ifd0At + 6, 1, true);
    view.setUint32(ifd0At + 10, 0, true);
    view.setUint32(ifd0At + 14, ifd1At, true);

    view.setUint16(ifd1At, 2, true);
    view.setUint16(ifd1At + 2, 0x0201, true);
    view.setUint16(ifd1At + 4, 4, true);
    view.setUint32(ifd1At + 6, 1, true);
    view.setUint32(ifd1At + 10, thumbAt, true);
    view.setUint16(ifd1At + 14, 0x0202, true);
    view.setUint16(ifd1At + 16, 4, true);
    view.setUint32(ifd1At + 18, 1, true);
    view.setUint32(ifd1At + 22, thumbnail.byteLength, true);
    view.setUint32(ifd1At + 26, 0, true);
    file.set(thumbnail, thumbAt);
    return file;
  }

  it('reads the thumbnail out of a bare TIFF, with no JPEG wrapper to find first', () => {
    const raw = rawWithDistantIfd1(0);
    assert.deepEqual(
      embeddedThumbnail(raw),
      new Uint8Array([0xff, 0xd8, 0x33, 0x44, 0xff, 0xd9]),
    );
  });

  it('says how far it needed to see when IFD1 is past the end of the head', () => {
    /*
     * The whole reason `needs` exists. A real ARW keeps IFD1 at byte 122906, past its full-size
     * preview, so the first read never reaches it — and a walk that only ever answered "nothing
     * here" would leave the window exactly where it was, for ever.
     */
    const raw = rawWithDistantIfd1(100_000);
    const head = raw.subarray(0, 48 * 1024);

    const lookup = inspectThumbnail(head);
    assert.equal(lookup.range, undefined, 'it cannot be found in this head');
    assert.ok(lookup.needs !== undefined, 'but it must say how far away it is');
    assert.ok(
      (lookup.needs as number) > head.byteLength,
      'and that must be past what was read, or nothing would grow',
    );
    // Reading that far must actually work, or the report is worse than useless.
    assert.ok(embeddedThumbnail(raw.subarray(0, (lookup.needs as number) + 4096)));
  });

  it('asks for nothing when the file simply has no thumbnail', () => {
    // A raw with one directory and no IFD1 link: an honest nothing, not a reason to read more.
    const lone = rawWithDistantIfd1(0).subarray(0, 26);
    const view = new DataView(lone.buffer, lone.byteOffset, lone.byteLength);
    view.setUint32(8 + 14, 0, true);
    assert.deepEqual(inspectThumbnail(lone), {});
  });

  it('still refuses bytes that are not a TIFF at all', () => {
    // A CR3 is ISO BMFF, and an MP4 begins the same way. Neither must be walked as a TIFF.
    assert.equal(embeddedThumbnail(new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70])), undefined);
  });
});
