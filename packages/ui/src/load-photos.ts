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

export async function loadPhotos(
  refs: readonly PhotoRef[],
  store: FileStore,
  backend: MetadataBackend,
  onProgress?: (progress: LoadProgress) => void,
): Promise<PhotoEntry[]> {
  const entries: PhotoEntry[] = [];

  for (const [index, ref] of refs.entries()) {
    onProgress?.({ done: index, total: refs.length, current: ref.name });

    try {
      const bytes = await store.read(ref);

      // Only the header is needed to read metadata, and a 6MB file costs measurably
      // more to push through the WASM boundary than a 100KB one.
      const stub = headerOnly(bytes);
      const tags = await readTags(backend, stub, ref.name, WANTED);
      entries.push(entryFromTags(ref, tags));
    } catch (error) {
      // A photo that cannot be read still belongs in the list, marked unusable, so the
      // user can see it rather than wonder why it vanished.
      entries.push(failedEntry(ref, error instanceof Error ? error.message : String(error)));
    }

    // Yield so the browser can paint the progress it was just given.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  onProgress?.({ done: refs.length, total: refs.length, current: '' });
  return entries;
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
