/**
 * The camera's embedded thumbnail, read straight out of the bytes.
 *
 * ExifTool can do this and does it correctly, but it costs an invocation: **~45 ms per photograph
 * even batched sixteen at a time**, and the interpreter runs on the main thread, so filling a day
 * of sixty photographs in the chooser is four seconds of a stuttering interface. This does the same
 * job in microseconds, because finding an EXIF thumbnail is not interpretation — it is following
 * two offsets.
 *
 * ## Why this is allowed, when re-serialising EXIF is banned outright
 *
 * The rule in this project is *never re-serialise EXIF yourself*, and it exists because `piexifjs`
 * and exiv2 both corrupt Sony maker notes by rewriting IFDs they do not fully understand. That is a
 * rule about **writing**. This only ever reads: it walks to IFD1, takes an offset and a length, and
 * copies those bytes out. Nothing is rewritten, no file is opened for writing, and the worst
 * possible outcome is a wrong picture in a chooser — never a damaged photograph.
 *
 * It is also completely optional. Anything this cannot parse falls back to ExifTool, so the only
 * consequence of a format it does not understand is the old speed.
 *
 * ## The layout, which is fixed and small — and the same for raw
 *
 * **A TIFF/EP raw file is the same document, unwrapped.** There is no JPEG around it, so the TIFF
 * header sits at byte 0 — and from there the walk is identical: IFD0 to IFD1 to the same two tags.
 * That is a property of the format rather than of a manufacturer, which is why this file is no
 * longer called `jpeg-thumbnail.ts`. ARW, NEF, CR2, PEF and SRW are all TIFF/EP.
 *
 * The one structural difference costs a design decision rather than a special case. In a JPEG the
 * directories are packed into one segment near the front, so a modest head holds all of them. In a
 * raw file they are spread through the real file — measured on an ILCE-6400 ARW, **IFD0 at byte 8
 * and IFD1 at byte 122906**, with a 432KB preview image between them — so the first read routinely
 * falls short. Hence `ThumbnailLookup.needs`.
 *
 * A JPEG is `FFD8` then a chain of segments. The EXIF one is `FFE1` carrying `Exif\0\0` and then a
 * whole TIFF file: a byte-order mark, the magic 42, and an offset to IFD0. IFD0's chain points at
 * IFD1, which is the thumbnail's directory, and two of its tags say where the thumbnail is
 * (`0x0201`) and how long it is (`0x0202`) — both relative to the start of the TIFF header rather
 * than to the file, which is the detail that makes hand-rolled readers wrong.
 *
 * Every offset here comes from the file being read, so **every single one is bounds-checked**. A
 * truncated header is the normal case rather than an exceptional one: the caller passes the first
 * hundred kilobytes or so, not the whole photograph.
 */

/** A JPEG starts `FFD8` and ends `FFD9`. Used to refuse anything that is not one. */
const SOI = 0xffd8;
const EOI = 0xffd9;

/**
 * Bytes of the embedded thumbnail, or `undefined` if there is not one to be had.
 *
 * Never throws, whatever it is given. It is handed arbitrary bytes off a camera card — including
 * truncated heads, files that are not JPEGs at all, and whatever a card with a failing controller
 * produces — and a background feed must not die on any of them.
 */
export function embeddedThumbnail(bytes: Uint8Array): Uint8Array | undefined {
  const at = locateThumbnail(bytes);
  if (!at || at.start + at.length > bytes.byteLength) return undefined;

  return validJpeg(bytes.subarray(at.start, at.start + at.length));
}

/** Where the thumbnail is in the file, as a byte range. */
export interface ThumbnailRange {
  /** Offset from the start of the *file*, not of the EXIF block. */
  readonly start: number;
  readonly length: number;
}

/**
 * What a walk found, or how far it would have had to see to find anything.
 *
 * `needs` exists because of raw. In a JPEG the whole EXIF block is one segment near the front, so a
 * modest head either contains the directories or the file has none. In a TIFF/EP raw file the
 * directories are scattered through the real file: measured on a 24.9MB ILCE-6400 ARW, **IFD0 is at
 * byte 8 and IFD1 is at byte 122906**, with the full-size preview image in between.
 *
 * Without this the caller cannot get started — a window too small to reach IFD1 finds nothing, and
 * finding nothing teaches it nothing, so it would go on reading exactly as far as it did before,
 * for ever. Reporting the offset the walk was reaching for turns one failed read into the size of
 * the read that will work.
 */
export interface ThumbnailLookup {
  readonly range?: ThumbnailRange;
  /** The furthest byte the walk needed and did not have. Absent when there is simply nothing here. */
  readonly needs?: number;
}

/**
 * Where the thumbnail is, without needing the thumbnail itself to be present.
 *
 * Split out from `embeddedThumbnail` because of what a phone measured: reads are the whole cost,
 * and they do not overlap. The offsets live in the first few kilobytes, so a small head is enough
 * to *find* the thumbnail, and the bytes themselves can then be fetched as an exact range — about
 * 22KB read per photograph instead of 128KB.
 *
 * Never throws, whatever it is given. It is handed arbitrary bytes off a camera card.
 */
export function locateThumbnail(bytes: Uint8Array): ThumbnailRange | undefined {
  return inspectThumbnail(bytes).range;
}

/**
 * The same walk, but also saying how far it needed to see when it came up short.
 *
 * Separate from `locateThumbnail` so the common caller stays a one-liner; the feed uses this one,
 * because on raw the first window is never large enough and the report is what sizes the next.
 *
 * Never throws, whatever it is given.
 */
export function inspectThumbnail(bytes: Uint8Array): ThumbnailLookup {
  try {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes.byteLength < 4) return {};

    /*
     * A raw file **is** the TIFF, with no JPEG wrapper around it.
     *
     * That is the entire difference, and it is worth being precise about why this is not a
     * per-camera optimisation. An EXIF block inside a JPEG is a complete TIFF document; a
     * TIFF/EP raw file is the same document as the whole file. Either way IFD0 links to IFD1 and
     * IFD1 carries `0x0201` and `0x0202`. Verified against a real 24.9MB ILCE-6400 ARW: the
     * thumbnail is in IFD1 at offset 123180, length 8053 — the same two tags, in the same place in
     * the structure, as every JPEG here.
     *
     * ARW, NEF, CR2, PEF and SRW are all TIFF/EP and all write those tags. Anything that is not —
     * a DNG keeping its thumbnail in IFD0 as uncompressed strips, a CR3, which is not TIFF at all —
     * simply finds no `0x0201`, declines, and falls back to ExifTool as before. So the worst case
     * for a format nobody here can test is the speed it already had.
     */
    if (view.getUint16(0) === SOI) {
      const exif = findExifSegment(bytes, view);
      return exif === undefined ? {} : rangeFromTiff(bytes, view, exif);
    }

    return rangeFromTiff(bytes, view, 0);
  } catch {
    // A malformed header, or an offset past the end of a truncated head. Either way there is
    // nothing to be had from these bytes, and the caller falls back to ExifTool.
    return {};
  }
}

/**
 * The bytes, if they really are a JPEG.
 *
 * The offsets came out of the file, so a file that is subtly wrong yields a subtly wrong slice —
 * and an `<img>` given rubbish shows a broken icon rather than reporting anything. Refusing here
 * means the caller falls back to ExifTool and gets the right picture instead of a broken one.
 */
export function validJpeg(bytes: Uint8Array): Uint8Array | undefined {
  if (bytes.byteLength < 4) return undefined;

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint16(0) !== SOI) return undefined;
  if (view.getUint16(bytes.byteLength - 2) !== EOI) return undefined;

  return bytes;
}

/** Where the TIFF header inside the `Exif\0\0` segment begins, as a file offset. */
function findExifSegment(bytes: Uint8Array, view: DataView): number | undefined {
  let at = 2;

  while (at + 4 <= bytes.byteLength) {
    if (bytes[at] !== 0xff) return undefined;

    const marker = bytes[at + 1] as number;
    // Start of scan: the image data begins and there are no more headers to walk.
    if (marker === 0xda) return undefined;

    const length = view.getUint16(at + 2);
    // A segment shorter than its own length field is a malformed file, and following it would
    // loop for ever or read backwards.
    if (length < 2) return undefined;

    if (marker === 0xe1 && at + 4 + 6 <= bytes.byteLength) {
      const header = bytes.subarray(at + 4, at + 10);
      // `Exif\0\0`. An APP1 can also be XMP, which begins with a namespace URI instead.
      if (header[0] === 0x45 && header[1] === 0x78 && header[2] === 0x69 && header[3] === 0x66
        && header[4] === 0x00 && header[5] === 0x00) {
        return at + 10;
      }
    }

    at += 2 + length;
  }

  return undefined;
}

function rangeFromTiff(
  bytes: Uint8Array,
  view: DataView,
  tiff: number,
): ThumbnailLookup {
  if (tiff + 8 > bytes.byteLength) return {};

  /*
   * `II` is little-endian and `MM` is big-endian, and the whole TIFF block follows whichever it
   * says — not the platform, and not the rest of the file. Sony writes `II`; getting this wrong
   * reads plausible-looking nonsense rather than failing, which is why it is checked explicitly
   * against both rather than assumed.
   */
  const order = view.getUint16(tiff);
  if (order !== 0x4949 && order !== 0x4d4d) return {};
  const little = order === 0x4949;

  if (view.getUint16(tiff + 2, little) !== 42) return {};

  const ifd0 = tiff + view.getUint32(tiff + 4, little);
  const step = nextIfd(bytes, view, ifd0, little, tiff);
  if (step.needs !== undefined) return { needs: step.needs };
  const ifd1 = step.at;
  if (ifd1 === undefined) return {};

  // The directory has to be wholly present before its entries can be searched. On a raw file this
  // is the usual outcome of the first read, and saying how far it reaches is what fixes the second.
  const ifd1End = directoryEnd(bytes, view, ifd1, little);
  if (ifd1End === undefined) return { needs: ifd1 + IFD_SLACK_BYTES };
  if (ifd1End > bytes.byteLength) return { needs: ifd1End };

  const offset = entryValue(bytes, view, ifd1, little, 0x0201);
  const length = entryValue(bytes, view, ifd1, little, 0x0202);
  if (offset === undefined || length === undefined || length === 0) return {};

  /*
   * Both are relative to the TIFF header, not to the file. This is the line hand-rolled readers get
   * wrong, and it fails by producing bytes from the middle of the image data.
   *
   * The range is returned even when it lies past the end of what was read — that is the *expected*
   * case for a small head, and the caller fetches exactly these bytes rather than reading more of
   * the file speculatively.
   */
  const start = tiff + offset;
  if (start < tiff) return {};

  // A thumbnail larger than any camera writes means the offsets were misread. Refusing beats
  // asking the card for a hundred megabytes.
  if (length > MAX_THUMBNAIL_BYTES) return {};

  return { range: { start, length } };
}

/**
 * Slack for a directory whose own entry count could not be read.
 *
 * 1KB holds an 85-entry IFD, which is more than any of these files carry. It is only ever used to
 * size the *next* read, and that read then measures the directory properly.
 */
const IFD_SLACK_BYTES = 1024;

/** The byte after this directory's last entry, or `undefined` if even its count is out of reach. */
function directoryEnd(
  bytes: Uint8Array,
  view: DataView,
  ifd: number,
  little: boolean,
): number | undefined {
  if (ifd + 2 > bytes.byteLength) return undefined;
  return ifd + 2 + view.getUint16(ifd, little) * 12 + 4;
}

/**
 * The largest a thumbnail is allowed to claim to be.
 *
 * An embedded EXIF thumbnail is a 160x120-ish JPEG — the seven real A6400 fixtures run 4.5KB to
 * 6KB. A megabyte is far past anything real and still small enough that a misread offset cannot
 * turn into a huge read over a slow card.
 */
const MAX_THUMBNAIL_BYTES = 1024 * 1024;

/**
 * The offset of the IFD after this one — or how far away it is, when it is out of reach.
 *
 * The second answer is what makes raw work. IFD0 sits at the front of an ARW and IFD1 at byte
 * 122906, so a first read of any sensible size lands here with the link in hand and the directory
 * it points at nowhere in the buffer. Returning nothing would be true and useless; returning the
 * offset lets the next read be exactly large enough.
 */
function nextIfd(
  bytes: Uint8Array,
  view: DataView,
  ifd: number,
  little: boolean,
  tiff: number,
): { at?: number; needs?: number } {
  if (ifd + 2 > bytes.byteLength) return {};

  const count = view.getUint16(ifd, little);
  const linkAt = ifd + 2 + count * 12;
  if (linkAt + 4 > bytes.byteLength) return { needs: linkAt + 4 };

  const link = view.getUint32(linkAt, little);
  // Zero means "no more directories", which is what a photograph with no thumbnail says.
  if (link === 0) return {};

  const next = tiff + link;
  // A directory pointing at or before itself is a loop. Real files do not do this; corrupt ones do.
  if (next <= ifd) return {};

  return next + 2 <= bytes.byteLength ? { at: next } : { needs: next + IFD_SLACK_BYTES };
}

/**
 * The value of a LONG or SHORT tag in this directory.
 *
 * Only the two forms the thumbnail tags actually take. A LONG fits in the entry's own four bytes,
 * so there is no indirection to follow and no second bounds check to get wrong.
 */
function entryValue(
  bytes: Uint8Array,
  view: DataView,
  ifd: number,
  little: boolean,
  wanted: number,
): number | undefined {
  if (ifd + 2 > bytes.byteLength) return undefined;
  const count = view.getUint16(ifd, little);

  for (let index = 0; index < count; index += 1) {
    const entry = ifd + 2 + index * 12;
    if (entry + 12 > bytes.byteLength) return undefined;

    if (view.getUint16(entry, little) !== wanted) continue;

    const type = view.getUint16(entry + 2, little);
    if (type === 4) return view.getUint32(entry + 8, little);
    // A SHORT sits in the first two bytes of the value field, whichever way round the file is.
    if (type === 3) return view.getUint16(entry + 8, little);
    return undefined;
  }

  return undefined;
}

/**
 * How much of a photograph to read to find its thumbnail.
 *
 * An EXIF APP1 segment is limited to 65535 bytes by the JPEG format itself, and it is the first
 * segment in every camera file this has been tried against — measured on a real A6400 frame, the
 * EXIF block is 45034 bytes starting at offset 2. 128KB is comfortable margin for a camera that
 * puts something before it.
 *
 * Eight times less than the 1MB the metadata path reads, which on a phone pulling a thousand
 * photographs off a card reader is the difference between 128MB and a gigabyte of I/O.
 */
export const THUMBNAIL_HEAD_BYTES = 128 * 1024;

/**
 * The first read of the two-stage path, sized from where the thumbnail actually is.
 *
 * 16KB was the first guess and it was wrong on every real file — measured on the seven A6400
 * fixtures, **IFD1 sits at about 38.8KB and the thumbnail runs from 39KB to 45KB**, because Sony's
 * MakerNote occupies the space between IFD0 and IFD1. A window that cannot reach IFD1 cannot even
 * locate the thumbnail, so all seven silently fell through to ExifTool and the fast path was off.
 *
 * 48KB locates *and* holds the picture in a single read for those files, which is what matters on
 * a device where reads do not overlap, and is still 2.7x less than the 128KB this used to pull off
 * the card per photograph.
 *
 * Here rather than in the UI so that the spike measuring it and the app doing it cannot drift
 * apart — which they did, and the spike went on reporting a 16KB window after the app had moved.
 */
export const THUMBNAIL_LOCATE_BYTES = 48 * 1024;
