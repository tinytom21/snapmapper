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
  embeddedThumbnail,
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
  const readAt = performance.now();
  const heads = await Promise.all(refs.map(async (ref) => {
    try {
      return await readHead(store, ref);
    } catch {
      // Could not be read off disk at all. Not worth a retry: the chooser shows an empty tile and
      // opening the photograph properly will report it.
      return undefined;
    }
  }));
  const readMs = performance.now() - readAt;

  const parseAt = performance.now();
  for (const [index, ref] of refs.entries()) {
    const head = heads[index];
    if (!head) {
      results.push({ name: ref.name, bytes: undefined });
      continue;
    }

    const quick = embeddedThumbnail(head);
    if (quick) {
      results.push({ name: ref.name, bytes: quick });
      continue;
    }

    slow.push({ name: ref.name, bytes: headerOnly(head) });
  }
  const parseMs = performance.now() - parseAt;

  const timing = (exifMs: number): BatchTiming => ({
    files: refs.length,
    readMs: Math.round(readMs),
    parseMs: Math.round(parseMs * 100) / 100,
    exifMs: Math.round(exifMs),
    fast: results.filter((r) => r.bytes !== undefined).length,
    slow: slow.length,
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
async function readHead(store: FileStore, ref: PhotoRef): Promise<Uint8Array> {
  if (store.readHead) {
    try {
      return await store.readHead(ref, THUMBNAIL_HEAD_BYTES);
    } catch {
      // A store that has the method but failed on this file: fall through rather than lose the
      // photograph over an optimisation.
    }
  }
  return store.read(ref);
}
