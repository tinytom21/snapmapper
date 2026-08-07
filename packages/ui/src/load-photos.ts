/**
 * Read a folder into session entries.
 *
 * Metadata reads cost ~0.5 s each through the WASM backend, so a 200-photo folder is a
 * minute and a half of waiting. That is why this reports progress per photo and yields
 * between files: a frozen window for ninety seconds reads as a crash.
 *
 * Reading is also where the splice does not help — ExifTool must see the header, and the
 * cost is mostly fixed per invocation. `-fast2` is passed for the same reason it is
 * passed everywhere: not because it measured faster (it did not, materially) but because
 * scanning past the metadata is work with no purpose.
 */

import {
  entryFromTags,
  failedEntry,
  readTags,
  readThumbnail,
  type FileStore,
  type MetadataBackend,
  type PhotoEntry,
  type PhotoRef,
} from '@geotagger/core';
import { buildHeaderStub, findScanStart } from '@geotagger/core';

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
      const bytes = await store.read(ref);

      // Only the header is needed to read metadata, and a 6MB file costs measurably
      // more to push through the WASM boundary than a 100KB one.
      const stub = headerOnly(bytes);
      const tags = await readTags(backend, stub, ref.name, WANTED);
      entries.push(entryFromTags(ref, tags));

      // The camera already embedded a ~6KB JPEG of itself, so a thumbnail costs a small
      // extra ExifTool call rather than decoding a 24MP image. A missing thumbnail is
      // cosmetic, so it never fails the load.
      const thumbnail = await readThumbnail(backend, stub, ref.name);
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
function headerOnly(bytes: Uint8Array): Uint8Array {
  try {
    return buildHeaderStub(bytes, findScanStart(bytes));
  } catch {
    return bytes;
  }
}
