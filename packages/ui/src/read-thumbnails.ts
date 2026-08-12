/**
 * Thumbnails for a folder listing, in batches, without reading anything else.
 *
 * Split from `load-photos.ts` because the question is different. That one builds session entries
 * and needs dates, coordinates and orientation; this one needs a picture and nothing at all
 * besides — so it asks ExifTool for no tags, only the embedded thumbnail, and never constructs a
 * `PhotoEntry`. A photograph fetched here is not "opened"; it has simply been looked at.
 *
 * The camera's own ~6KB JPEG, not a decoded and resized frame. Making one from the full image would
 * mean pulling 6.9MB off the card and decoding 24 megapixels per photograph, which is the opposite
 * of what a background feed should do to a phone.
 */

import { headerOnly } from './load-photos.ts';
import {
  THUMBNAIL_HEAD_BYTES,
  THUMBNAIL_LOCATE_BYTES,
  locateThumbnail,
  validJpeg,
  readManyTags,
  type BatchFile,
  type BatchRunner,
  type FileStore,
  type PhotoRef,
} from '@snapmapper/core';

/** One photograph's thumbnail, or the fact that it has none. */
export interface ThumbnailResult {
  readonly name: string;
  readonly bytes: Uint8Array | undefined;
}

export interface ThumbnailBatch {
  readonly results: readonly ThumbnailResult[];
  /**
   * Whether ExifTool had to be invoked for any of them.
   *
   * The caller throttles on this. A batch answered entirely by the byte reader costs a fraction of
   * a millisecond per photograph and needs no breather at all; one that fell back holds the main
   * thread for about 700 ms and does.
   */
  readonly usedExifTool: boolean;
  /** Where the time actually went, for the diagnostics report. */
  readonly timing: BatchTiming;
}

/**
 * What one batch cost, split by stage.
 *
 * Collected always rather than behind a flag, because the question it answers — *why is this not
 * faster* — only ever comes up on somebody else's hardware, where nothing can be attached. Reading
 * a card through a phone is a completely different machine from a desktop with the files on an SSD,
 * and guessing which stage dominates has now been wrong once.
 */
export interface BatchTiming {
  readonly files: number;
  /** Getting the header bytes off the card. Overlapped, so this is wall clock, not the sum. */
  readonly readMs: number;
  /** Following the EXIF offsets. Expected to be a fraction of a millisecond per file. */
  readonly parseMs: number;
  /** ExifTool, for whatever the byte reader declined. Zero for a folder of JPEGs. */
  readonly exifMs: number;
  /** How many the byte reader answered. */
  readonly fast: number;
  /** How many needed ExifTool. */
  readonly slow: number;
  /** Bytes pulled off the card. The lever, on a device where reading is the whole cost. */
  readonly bytesRead: number;
  /**
   * How many separate reads those bytes took.
   *
   * Reported alongside the bytes because the two point at different fixes and there is no way to
   * tell them apart from here. If the cost tracks the reads, the round trip dominates and fewer,
   * larger reads win; if it tracks the bytes, the transfer dominates and smaller windows win. The
   * one thing already known is that they do not overlap.
   *
   * **Answered, on two devices: the round trip.** A call costs about 110 ms whether it carries 43KB
   * or 128KB, so a second call is worth roughly seven times the bytes in the first. See
   * `thumbnail-window.ts`.
   */
  readonly reads: number;
  /**
   * How much of the head was read, and how deep the deepest thumbnail turned out to be.
   *
   * These are what tune the window. `deepestEnd` is known exactly even when the bytes were not
   * fetched, because the offsets live in the EXIF block rather than at the thumbnail itself.
   */
  readonly window: number;
  readonly deepestEnd: number;
}

/**
 * Read the embedded thumbnails of these photographs.
 *
 * **The fast path first, and it answers almost everything.** A JPEG's thumbnail is two offsets in
 * the EXIF block, so `embeddedThumbnail` slices it straight out of the header bytes — measured at
 * **0.165 ms per photograph against ExifTool's 634 ms**, and byte-identical to ExifTool on all
 * seven real A6400 fixtures (`npm run thumb --workspace spike`).
 *
 * ExifTool is kept for whatever the byte reader declines, which in practice means raw: an ARW is a
 * TIFF rather than a JPEG and its thumbnail lives somewhere the JPEG walk does not go. Correctness
 * comes from the fallback, speed from not needing it.
 *
 * **Never throws for a file it could not read.** This runs in the background while somebody is
 * choosing, so a corrupt frame must cost that frame's picture and nothing else.
 */
export async function readThumbnails(
  refs: readonly PhotoRef[],
  store: FileStore,
  /**
   * The interpreter, fetched only if it turns out to be needed.
   *
   * A function rather than a runner, because building one instantiates **24MB of WebAssembly** and
   * a folder of JPEGs never needs it at all — the byte reader answers every one. Taking a runner as
   * an argument meant booting zeroperl the moment the chooser opened, which is most of a second of
   * blocked main thread spent on a fallback that never fires.
   */
  getRunner: () => Promise<BatchRunner | undefined>,
  /**
   * How much of each head to read, fitted to the camera by the batches before this one.
   *
   * Defaults to the constant, so a single call still works; the feed passes the tuned value. See
   * `thumbnail-window.ts` for why this is not a fixed number any more.
   */
  window: number = THUMBNAIL_LOCATE_BYTES,
): Promise<ThumbnailBatch> {
  const results: ThumbnailResult[] = [];
  const slow: BatchFile[] = [];

  /*
   * **Read the heads together, not one after another.**
   *
   * This was a serial `for` loop with an `await` in it, and it made the whole fast path pointless:
   * removing a ~700 ms ExifTool call per batch of sixteen only to spend the same on sixteen
   * serialised card reads. Reported as exactly that — "I didn't notice any speed difference".
   *
   * The same mistake `listFolder` had, in the same shape. On a phone reading a card through a
   * reader one file access is tens of milliseconds — measured by the user at about 31 ms while
   * listing — so sixteen of them in a row is half a second whatever happens afterwards. Overlapped,
   * they cost about one.
   */
  let bytesRead = 0;
  let reads = 0;
  let parseMs = 0;
  let deepestEnd = 0;

  const readAt = performance.now();
  const found = await Promise.all(refs.map(async (ref) => {
    try {
      /*
       * A small head first, then the thumbnail's exact bytes.
       *
       * Measured on a phone, and it is the whole story: reading costs 128 to 148 ms per photograph
       * and parsing costs 0.01 ms. Worse, the reads **do not overlap** — the wall clock of a batch
       * came out at exactly sixteen times the per-file cost in both of the user's runs, so Chrome
       * on Android is serialising them below `Promise.all` and no amount of concurrency helps.
       *
       * **And the lever is round trips, not bytes** — measured since, on two devices: a call costs
       * about 110 ms whether it carries 43KB or 128KB. So the head is sized to contain the whole
       * thumbnail wherever possible, and `window` is fitted to the camera by the batches before
       * this one rather than guessed. The exact range below is now the exception, not the plan.
       */
      const head = await readSlice(store, ref, 0, window);
      bytesRead += head.byteLength;
      reads += 1;

      const parseAt = performance.now();
      const at = locateThumbnail(head);
      parseMs += performance.now() - parseAt;

      if (!at) return { ref, head };

      // Recorded whether or not the bytes were there: this is what sizes the next batch's window,
      // and it is exact, because the offsets are in the EXIF block rather than at the thumbnail.
      deepestEnd = Math.max(deepestEnd, at.start + at.length);

      // Already covered by the head — a small thumbnail in a small EXIF block.
      if (at.start + at.length <= head.byteLength) {
        const inside = validJpeg(head.subarray(at.start, at.start + at.length));
        return inside ? { ref, bytes: inside } : { ref, head };
      }

      if (!store.readRange) return { ref, head };

      const exact = await store.readRange(ref, at.start, at.start + at.length);
      bytesRead += exact.byteLength;
      reads += 1;
      const picture = validJpeg(exact);
      return picture ? { ref, bytes: picture } : { ref, head };
    } catch {
      // Could not be read off disk at all. Not worth a retry: the chooser shows an empty tile and
      // opening the photograph properly will report it.
      return { ref };
    }
  }));
  const readMs = performance.now() - readAt;

  for (const outcome of found) {
    if (outcome.bytes) {
      results.push({ name: outcome.ref.name, bytes: outcome.bytes });
      continue;
    }
    if (!outcome.head) {
      results.push({ name: outcome.ref.name, bytes: undefined });
      continue;
    }
    slow.push({ name: outcome.ref.name, bytes: headerOnly(outcome.head) });
  }

  const fastCount = results.length;

  const timing = (exifMs: number): BatchTiming => ({
    files: refs.length,
    readMs: Math.round(readMs),
    parseMs: Math.round(parseMs * 100) / 100,
    exifMs: Math.round(exifMs),
    /*
     * Counted *before* the fallback runs, not after.
     *
     * This used to filter the results at the end, so anything ExifTool found was counted as read
     * by the byte reader too — a report saying "640 by byte read, 248 by ExifTool" for 640
     * photographs, which does not add up and hid how often the fallback was firing.
     */
    fast: fastCount,
    slow: slow.length,
    bytesRead,
    reads,
    window,
    deepestEnd,
  });

  if (slow.length === 0) return { results, usedExifTool: false, timing: timing(0) };

  const exifAt = performance.now();
  const runner = await getRunner();
  if (!runner) {
    for (const file of slow) results.push({ name: file.name, bytes: undefined });
    return { results, usedExifTool: false, timing: timing(performance.now() - exifAt) };
  }

  try {
    // No tags at all — `-ThumbnailImage` and nothing else, so there is less output to parse and
    // nothing is computed that this screen would throw away.
    const read = await readManyTags(runner, slow, []);
    for (const [index, file] of slow.entries()) {
      const result = read[index];
      results.push({
        name: file.name,
        bytes: result?.ok && result.thumbnail?.byteLength ? result.thumbnail : undefined,
      });
    }
  } catch {
    // The runner itself died. The feed marks these done either way — retrying a dead interpreter
    // for every batch would spin.
    for (const file of slow) results.push({ name: file.name, bytes: undefined });
  }

  return { results, usedExifTool: true, timing: timing(performance.now() - exifAt) };
}

/**
 * The bytes to look in, and far fewer than the metadata path reads.
 *
 * An EXIF APP1 segment cannot exceed 65535 bytes by the format's own rules and is the first thing
 * in every camera file tried here — measured on a real A6400 frame, 45034 bytes starting at offset
 * 2. So 128KB finds the thumbnail with margin, against the 1MB a metadata read needs. On a phone
 * pulling two thousand photographs off a card reader that is the difference between 256MB of I/O
 * and two gigabytes.
 *
 * Raw is the exception and it does not matter: an ARW falls through to ExifTool regardless, and
 * ExifTool reads what it is given.
 */
async function readSlice(
  store: FileStore,
  ref: PhotoRef,
  start: number,
  end: number,
): Promise<Uint8Array> {
  if (start === 0 && store.readHead) {
    try {
      return await store.readHead(ref, end);
    } catch {
      // A store that has the method but failed on this file: fall through rather than lose the
      // photograph over an optimisation.
    }
  }
  if (store.readRange) {
    try {
      return await store.readRange(ref, start, end);
    } catch {
      // As above.
    }
  }

  const whole = await store.read(ref);
  return whole.subarray(start, Math.min(end, whole.byteLength));
}


