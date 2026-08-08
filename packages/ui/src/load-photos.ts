/**
 * Read a folder into session entries.
 *
 * Metadata reads cost ~0.5 s each through the WASM backend, so a 200-photo folder is a
 * minute and a half of waiting. That is why this reports progress per photo and yields
 * between files: a frozen window for ninety seconds reads as a crash.
 *
 * The cost is **per invocation**, not per byte, and everything here follows from that. Measured on
 * a real 6.9MB A6400 JPEG, median of nine interleaved runs (`spike/src/load-cost.mjs`):
 *
 *   - whole file, two calls — 1884 ms
 *   - 101KB header stub, two calls — 1921 ms, i.e. **no different**
 *   - 101KB header stub, one call — **1173 ms**
 *
 * So one invocation asking for the tags *and* the thumbnail is 1.64x faster than two, and that is
 * what `readTagsAndThumbnail` is for. Pushing sixty-eight times the bytes changed nothing, so the
 * header stub and `readHead` below are about disk and memory rather than about ExifTool.
 *
 * The next lever is much larger and is not taken here: the WASM wrapper mounts its input into a
 * virtual filesystem that accepts any number of files, so several photographs could share one
 * invocation and amortise the second that each currently costs. It needs reaching past the
 * package's public API, so it is its own piece of work.
 */

import {
  entryFromTags,
  failedEntry,
  readTagsAndThumbnail,
  type FileStore,
  type MetadataBackend,
  type PhotoEntry,
  type PhotoRef,
} from '@snapmapper/core';
import { buildHeaderStub, findScanStart } from '@snapmapper/core';

export interface LoadProgress {
  readonly done: number;
  readonly total: number;
  readonly current: string;
}

/** Tags worth asking for. A narrower request is less output to parse. */
const WANTED = [
  'EXIF:DateTimeOriginal',
  'EXIF:CreateDate',
  'EXIF:Orientation',
  'EXIF:Make',
  'EXIF:Model',
  'Composite:GPSLatitude',
  'Composite:GPSLongitude',
  'Composite:GPSAltitude',
];

/**
 * A photo's entry plus the bytes of its embedded thumbnail.
 *
 * Bytes rather than object URLs deliberately: creating a URL needs `URL.createObjectURL`,
 * which does not exist in Node, and a loader that reaches for browser globals cannot be
 * tested. Turning these into URLs — and revoking them — belongs to the component that
 * displays them.
 */
export interface LoadedPhotos {
  readonly entries: PhotoEntry[];
  /** JPEG bytes by photo name. ~6KB each on an A6400. */
  readonly thumbnails: Map<string, Uint8Array>;
}

export async function loadPhotos(
  refs: readonly PhotoRef[],
  store: FileStore,
  backend: MetadataBackend,
  onProgress?: (progress: LoadProgress) => void,
): Promise<LoadedPhotos> {
  const entries: PhotoEntry[] = [];
  const thumbnails = new Map<string, Uint8Array>();

  for (const [index, ref] of refs.entries()) {
    onProgress?.({ done: index, total: refs.length, current: ref.name });

    try {
      const stub = headerOnly(await readForMetadata(store, ref));

      /*
       * One invocation for both. The thumbnail is the camera's own embedded ~6KB JPEG, so it
       * costs a fraction of the call it now shares rather than a second call of its own — and
       * decoding a 24MP image to make one would cost far more than either.
       */
      const { tags, thumbnail } = await readTagsAndThumbnail(backend, stub, ref.name, WANTED);
      entries.push(entryFromTags(ref, tags));
      if (thumbnail && thumbnail.byteLength > 0) thumbnails.set(ref.name, thumbnail);
    } catch (error) {
      // A photo that cannot be read still belongs in the list, marked unusable, so the
      // user can see it rather than wonder why it vanished.
      entries.push(failedEntry(ref, error instanceof Error ? error.message : String(error)));
    }

    // Yield so the browser can paint the progress it was just given.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  onProgress?.({ done: refs.length, total: refs.length, current: '' });
  return { entries, thumbnails };
}

/**
 * How much of a photograph to read when only its metadata is wanted.
 *
 * An A6400's header is about 100KB, most of which is the ~400KB preview when there is one; 1MB is
 * comfortable margin for a camera that embeds more. A file whose header is somehow larger simply
 * falls back to `headerOnly` returning the truncated bytes, and ExifTool reads what it can — the
 * date and coordinates are in the first few kilobytes regardless.
 */
const METADATA_BYTES = 1024 * 1024;

/**
 * The bytes to hand the parser, reading as few as the store allows.
 *
 * Falls back to a whole-file read, because `readHead` is optional on `FileStore` — a store that
 * cannot seek is still a valid store, and this must not be the thing that stops one working.
 */
async function readForMetadata(store: FileStore, ref: PhotoRef): Promise<Uint8Array> {
  if (store.readHead) {
    try {
      return await store.readHead(ref, METADATA_BYTES);
    } catch {
      // A store that has the method but failed on this file: fall through to the whole thing
      // rather than failing a photograph over an optimisation.
    }
  }
  return store.read(ref);
}

/**
 * Turn thumbnail bytes into displayable object URLs.
 *
 * Separated from loading so the loader stays free of browser globals. The result must be
 * passed to `revokeThumbnailUrls` when it is replaced, or the blobs leak for the lifetime
 * of the page.
 */
export function toThumbnailUrls(thumbnails: Map<string, Uint8Array>): Map<string, string> {
  const urls = new Map<string, string>();
  for (const [name, bytes] of thumbnails) {
    urls.set(name, URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'image/jpeg' })));
  }
  return urls;
}

/** Release object URLs. They leak until revoked. */
export function revokeThumbnailUrls(urls: Map<string, string>): void {
  for (const url of urls.values()) URL.revokeObjectURL(url);
  urls.clear();
}

/**
 * The metadata portion of a JPEG, or the whole thing if its structure is unfamiliar.
 *
 * Falling back to the full file matters: a file we cannot parse should still get its
 * tags read and be *shown*. Refusing to parse only ever blocks a *write*.
 */
export function headerOnly(bytes: Uint8Array): Uint8Array {
  try {
    return buildHeaderStub(bytes, findScanStart(bytes));
  } catch {
    return bytes;
  }
}
