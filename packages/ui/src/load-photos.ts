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
 * **And the larger lever, now taken: several photographs share one invocation.** Measured at 43 ms
 * per photo in a batch of 28 against 354–592 ms alone — 8–14x, and a 200-photo card in about nine
 * seconds rather than something over a minute. `batch-runner.ts` drives zeroperl directly for it,
 * and `readManyTags` in core does the matching.
 *
 * Batching is strictly an optimisation over the one-at-a-time path, which is still here and still
 * correct. It is used when the runner can be built, per batch when that batch produced usable
 * records, and per photograph whenever either falls through — see `loadBatch`.
 */

import {
  entryFromTags,
  failedEntry,
  readManyTags,
  readTagsAndThumbnail,
  type BatchFile,
  type BatchRunner,
  type FileStore,
  type MetadataBackend,
  type PhotoEntry,
  type PhotoRef,
} from '@snapmapper/core';
import { buildHeaderStub, findScanStart } from '@snapmapper/core';

import { createBatchRunner } from './batch-runner.ts';

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

/**
 * How many photographs share one invocation.
 *
 * The measured curve keeps improving out to 28 files — 75 ms each at ten, 43 ms at twenty-eight —
 * but the per-photo gain flattens while the memory does not, and the cost of a batch that fails
 * wholesale is a retry of everything in it. Sixteen keeps the great majority of the win and holds
 * about 1.6MB of header stubs at a time, which is comfortable on a phone.
 *
 * It also bounds how coarse progress can get: a batch reports as one step, so this is the largest
 * jump the bar can make.
 */
const BATCH_SIZE = 16;

export async function loadPhotos(
  refs: readonly PhotoRef[],
  store: FileStore,
  backend: MetadataBackend,
  onProgress?: (progress: LoadProgress) => void,
  /**
   * The batch runner to use, when the caller already has one — and how a test supplies a fake.
   *
   * Omitted, one is built on demand and reused for the life of the page. Passed `null`, batching
   * is off and every photograph goes through the original one-at-a-time path, which is what the
   * tests of that path rely on.
   */
  batchRunner?: BatchRunner | null,
): Promise<LoadedPhotos> {
  const entries: PhotoEntry[] = [];
  const thumbnails = new Map<string, Uint8Array>();

  /*
   * One photograph does not need an interpreter booted to read it.
   *
   * Building the runner means instantiating the 24MB WASM into a *second* zeroperl instance — the
   * wrapper keeps its own for writing — so for a handful of files the setup costs more than the
   * batching saves. Above that it is repaid many times over on the first batch.
   */
  const runner = batchRunner === undefined
    ? (refs.length > 2 ? await createBatchRunner() : undefined)
    : (batchRunner ?? undefined);

  for (let start = 0; start < refs.length; start += BATCH_SIZE) {
    const chunk = refs.slice(start, start + BATCH_SIZE);
    onProgress?.({ done: start, total: refs.length, current: chunk[0]?.name ?? '' });

    const loaded = await loadBatch(chunk, store, backend, runner);
    for (const [index, result] of loaded.entries()) {
      const ref = chunk[index] as PhotoRef;
      entries.push(result.entry);
      if (result.thumbnail && result.thumbnail.byteLength > 0) {
        thumbnails.set(ref.name, result.thumbnail);
      }
    }

    // Yield so the browser can paint the progress it was just given.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  onProgress?.({ done: refs.length, total: refs.length, current: '' });
  return { entries, thumbnails };
}

interface LoadedOne {
  readonly entry: PhotoEntry;
  readonly thumbnail: Uint8Array | undefined;
}

/**
 * Read one batch, falling back a photograph at a time wherever batching did not answer.
 *
 * The fallback is per **photograph**, not per batch, and that is the point of `readManyTags`
 * returning a parallel array: one corrupt file in a batch of sixteen returns fifteen good records
 * and one failure, so only that one is retried alone. Retrying the whole batch would throw away
 * the win precisely when a card has a few bad frames on it — which is when a card usually has any.
 *
 * A retry that fails again is reported as a failed entry, which is what the one-at-a-time path
 * would have done. So a photograph is only ever marked unreadable after being read on its own.
 */
async function loadBatch(
  refs: readonly PhotoRef[],
  store: FileStore,
  backend: MetadataBackend,
  runner: BatchRunner | undefined,
): Promise<LoadedOne[]> {
  const stubs: (Uint8Array | undefined)[] = [];
  for (const ref of refs) {
    try {
      stubs.push(headerOnly(await readForMetadata(store, ref)));
    } catch {
      // Could not be read off disk at all. `readOne` will try again and report properly.
      stubs.push(undefined);
    }
  }

  let batched: Awaited<ReturnType<typeof readManyTags>> | undefined;
  if (runner) {
    const files: BatchFile[] = [];
    const positions: number[] = [];
    for (const [index, bytes] of stubs.entries()) {
      if (!bytes) continue;
      files.push({ name: refs[index]?.name ?? `photo-${index}`, bytes });
      positions.push(index);
    }

    try {
      const results = await readManyTags(runner, files, WANTED);
      // Spread back to the full width, so indexes line up with `refs` again.
      const spread: typeof results = new Array(refs.length);
      for (const [slot, position] of positions.entries()) {
        spread[position] = results[slot] as (typeof results)[number];
      }
      batched = spread;
    } catch {
      // The runner itself failed — a dead interpreter, an out-of-memory. Everything falls through.
    }
  }

  const out: LoadedOne[] = [];
  for (const [index, ref] of refs.entries()) {
    const result = batched?.[index];
    if (result?.ok) {
      out.push({ entry: entryFromTags(ref, result.tags), thumbnail: result.thumbnail });
      continue;
    }
    out.push(await readOne(ref, stubs[index], store, backend));
  }

  return out;
}

/** The original path: one photograph, one invocation, tags and thumbnail together. */
async function readOne(
  ref: PhotoRef,
  stub: Uint8Array | undefined,
  store: FileStore,
  backend: MetadataBackend,
): Promise<LoadedOne> {
  try {
    const bytes = stub ?? headerOnly(await readForMetadata(store, ref));

    /*
     * One invocation for both. The thumbnail is the camera's own embedded ~6KB JPEG, so it
     * costs a fraction of the call it now shares rather than a second call of its own — and
     * decoding a 24MP image to make one would cost far more than either.
     */
    const { tags, thumbnail } = await readTagsAndThumbnail(backend, bytes, ref.name, WANTED);
    return { entry: entryFromTags(ref, tags), thumbnail };
  } catch (error) {
    // A photo that cannot be read still belongs in the list, marked unusable, so the
    // user can see it rather than wonder why it vanished.
    return {
      entry: failedEntry(ref, error instanceof Error ? error.message : String(error)),
      thumbnail: undefined,
    };
  }
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
export async function readForMetadata(store: FileStore, ref: PhotoRef): Promise<Uint8Array> {
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
