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

import {
  headerOnly,
  readForMetadata,
} from './load-photos.ts';
import {
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

/**
 * Read the embedded thumbnails of these photographs in one invocation.
 *
 * **Never throws for a file it could not read.** This runs in the background while somebody is
 * choosing, so a corrupt frame must cost that frame's picture and nothing else — an exception here
 * would stop the feed and leave the rest of a card permanently blank. Every photograph comes back,
 * with `bytes` undefined where there was nothing to find.
 */
export async function readThumbnails(
  refs: readonly PhotoRef[],
  store: FileStore,
  runner: BatchRunner,
): Promise<ThumbnailResult[]> {
  const files: BatchFile[] = [];
  const missing: ThumbnailResult[] = [];

  for (const ref of refs) {
    try {
      files.push({ name: ref.name, bytes: headerOnly(await readForMetadata(store, ref)) });
    } catch {
      // Could not be read off disk at all. Not worth a retry: the chooser shows a blank tile and
      // opening the photograph properly will report it.
      missing.push({ name: ref.name, bytes: undefined });
    }
  }

  if (files.length === 0) return missing;

  try {
    // No tags at all — `-ThumbnailImage` and nothing else, so there is less output to parse and
    // nothing is computed that this screen would throw away.
    const results = await readManyTags(runner, files, []);
    return [
      ...files.map((file, index) => {
        const result = results[index];
        return {
          name: file.name,
          bytes: result?.ok && result.thumbnail?.byteLength ? result.thumbnail : undefined,
        };
      }),
      ...missing,
    ];
  } catch {
    // The runner itself died. Everything in this batch is unknown rather than absent, but the feed
    // marks them done either way — retrying a dead interpreter for every batch would spin.
    return [...files.map((file) => ({ name: file.name, bytes: undefined })), ...missing];
  }
}
