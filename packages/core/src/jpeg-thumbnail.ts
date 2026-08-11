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
 * ## The layout, which is fixed and small
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
  try {
    return read(bytes);
  } catch {
    // A malformed header, or an offset past the end of a truncated head. Either way there is no
    // thumbnail to be had from these bytes, and the caller falls back to ExifTool.
    return undefined;
  }
}

function read(bytes: Uint8Array): Uint8Array | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 4 || view.getUint16(0) !== SOI) return undefined;

  const exif = findExifSegment(bytes, view);
  if (exif === undefined) return undefined;

  return thumbnailFromTiff(bytes, view, exif);
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

function thumbnailFromTiff(
  bytes: Uint8Array,
  view: DataView,
  tiff: number,
): Uint8Array | undefined {
  if (tiff + 8 > bytes.byteLength) return undefined;

  /*
   * `II` is little-endian and `MM` is big-endian, and the whole TIFF block follows whichever it
   * says — not the platform, and not the rest of the file. Sony writes `II`; getting this wrong
   * reads plausible-looking nonsense rather than failing, which is why it is checked explicitly
   * against both rather than assumed.
   */
  const order = view.getUint16(tiff);
  if (order !== 0x4949 && order !== 0x4d4d) return undefined;
  const little = order === 0x4949;

  if (view.getUint16(tiff + 2, little) !== 42) return undefined;

  const ifd0 = tiff + view.getUint32(tiff + 4, little);
  const ifd1 = nextIfd(bytes, view, ifd0, little, tiff);
  if (ifd1 === undefined) return undefined;

  const offset = entryValue(bytes, view, ifd1, little, 0x0201);
  const length = entryValue(bytes, view, ifd1, little, 0x0202);
  if (offset === undefined || length === undefined || length === 0) return undefined;

  // Both are relative to the TIFF header, not to the file. This is the line that hand-rolled
  // readers get wrong, and it fails by producing bytes from the middle of the image data.
  const start = tiff + offset;
  const end = start + length;
  if (start < tiff || end > bytes.byteLength) return undefined;

  const thumbnail = bytes.subarray(start, end);

  /*
   * Checked to be a JPEG before being handed back.
   *
   * The offsets came out of the file, so a file that is subtly wrong yields a subtly wrong slice —
   * and an `<img>` given rubbish shows a broken icon rather than reporting anything. Refusing here
   * means the caller falls back to ExifTool and gets the right picture instead of a broken one.
   */
  if (thumbnail.byteLength < 4) return undefined;
  const inner = new DataView(
    thumbnail.buffer, thumbnail.byteOffset, thumbnail.byteLength,
  );
  if (inner.getUint16(0) !== SOI) return undefined;
  if (inner.getUint16(thumbnail.byteLength - 2) !== EOI) return undefined;

  return thumbnail;
}

/** The offset of the IFD after this one, or `undefined` when there is none. */
function nextIfd(
  bytes: Uint8Array,
  view: DataView,
  ifd: number,
  little: boolean,
  tiff: number,
): number | undefined {
  if (ifd + 2 > bytes.byteLength) return undefined;

  const count = view.getUint16(ifd, little);
  const linkAt = ifd + 2 + count * 12;
  if (linkAt + 4 > bytes.byteLength) return undefined;

  const link = view.getUint32(linkAt, little);
  // Zero means "no more directories", which is what a photograph with no thumbnail says.
  if (link === 0) return undefined;

  const next = tiff + link;
  // A directory pointing at or before itself is a loop. Real files do not do this; corrupt ones do.
  return next > ifd && next + 2 <= bytes.byteLength ? next : undefined;
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
