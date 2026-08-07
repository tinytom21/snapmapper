/**
 * The save. Reads bytes, writes metadata, replaces the file — one photo at a time.
 *
 * Sequential on purpose. The WASM module keeps one Perl interpreter, so concurrent calls
 * would contend rather than parallelise, and a predictable one-at-a-time progress
 * report is worth more than a speculative speed-up. At ~340 ms per photo on a phone and
 * under 2 s on a desktop, a realistic 10–50 photo session is seconds, not minutes.
 *
 * Every photo gets its own result. Geotagging 50 files and reporting one aggregate
 * "done" is not acceptable when a single file can fail for its own reasons — locked by
 * another program, read-only card, unparseable JPEG.
 */

import {
  buildClearLocationTags,
  buildGeotagTags,
  instantOf,
  pendingPhotos,
  writeMetadataSpliced,
  type FileStore,
  type MetadataBackend,
  type PhotoEntry,
  type Session,
} from '@geotagger/core';

export interface SaveOutcome {
  readonly name: string;
  readonly ok: boolean;
  readonly message?: string;
  readonly elapsedMs: number;
  /** Warnings ExifTool raised that were judged benign. Worth showing, not alarming. */
  readonly warnings: readonly string[];
}

export interface SaveProgress {
  readonly done: number;
  readonly total: number;
  readonly current: string;
}

/**
 * Write every staged edit.
 *
 * Never throws for a single file's failure: one bad photo must not abandon the other
 * forty-nine, and the caller needs the whole picture to show a result list. Only the
 * names that actually succeeded are returned as saved, so `markSaved` leaves the rest
 * visibly pending.
 */
export async function saveSession(
  session: Session,
  store: FileStore,
  backend: MetadataBackend,
  onProgress?: (progress: SaveProgress) => void,
): Promise<{ outcomes: SaveOutcome[]; savedNames: string[] }> {
  const pending = pendingPhotos(session);
  const outcomes: SaveOutcome[] = [];
  const savedNames: string[] = [];

  for (const [index, entry] of pending.entries()) {
    onProgress?.({ done: index, total: pending.length, current: entry.ref.name });

    const started = performance.now();
    try {
      const warnings = await writeOne(session, entry, store, backend);
      outcomes.push({
        name: entry.ref.name,
        ok: true,
        elapsedMs: performance.now() - started,
        warnings,
      });
      savedNames.push(entry.ref.name);
    } catch (error) {
      outcomes.push({
        name: entry.ref.name,
        ok: false,
        message: error instanceof Error ? error.message : String(error),
        elapsedMs: performance.now() - started,
        warnings: [],
      });
    }
  }

  onProgress?.({ done: pending.length, total: pending.length, current: '' });
  return { outcomes, savedNames };
}

async function writeOne(
  session: Session,
  entry: PhotoEntry,
  store: FileStore,
  backend: MetadataBackend,
): Promise<readonly string[]> {
  const staged = session.edits.get(entry.ref.name);
  if (staged === undefined) return [];

  // One bulk read into bytes. Handing a Blob to the backend is the ~69x mistake.
  const original = await store.read(entry.ref);

  const tags = staged === null
    ? buildClearLocationTags()
    : buildGeotagTags({
      coordinates: staged,
      // No instant means no GPSDateStamp/GPSTimeStamp, which is correct: a photo with
      // an unreadable date should get coordinates rather than a guessed GPS time.
      ...(instantOf(session, entry) ? { instant: instantOf(session, entry) as Date } : {}),
    });

  const written = await writeMetadataSpliced(backend, original, entry.ref.name, tags);

  await store.writeAtomic(entry.ref, written.bytes);
  return written.warnings;
}
