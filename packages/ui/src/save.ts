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
  VERIFY_ARGS,
  VERIFY_TAGS,
  buildClearLocationTags,
  buildGeotagTags,
  instantOf,
  pendingPhotos,
  verifyWrittenLocation,
  writeMetadataSpliced,
  type Coordinates,
  type FileStore,
  type MetadataBackend,
  type PhotoEntry,
  type Session,
  type WriteVerification,
} from '@geotagger/core';

import { headerOnly } from './load-photos.ts';

export interface SaveOutcome {
  readonly name: string;
  readonly ok: boolean;
  readonly message?: string;
  readonly elapsedMs: number;
  /** Warnings ExifTool raised that were judged benign. Worth showing, not alarming. */
  readonly warnings: readonly string[];
  /**
   * Set when the file was written but did not read back as intended.
   *
   * Distinguished from an ordinary failure because the file on disk **has changed**. Saying
   * only "failed" would imply nothing happened, which would be the wrong thing to believe.
   */
  readonly writtenButUnverified?: boolean;
}

export interface SaveOptions {
  /**
   * Read every file back after writing and confirm it says what was intended.
   *
   * On by default. It costs one extra metadata read per photo — a few hundred milliseconds
   * against a write of one to two seconds — and it is the difference between "the write
   * returned successfully" and "the photograph now has the right location in it". For
   * irreplaceable files that is worth paying for every time.
   */
  readonly verify?: boolean;
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
  options: SaveOptions = {},
): Promise<{ outcomes: SaveOutcome[]; savedNames: string[] }> {
  const verify = options.verify !== false;
  const pending = pendingPhotos(session);
  const outcomes: SaveOutcome[] = [];
  const savedNames: string[] = [];

  for (const [index, entry] of pending.entries()) {
    onProgress?.({ done: index, total: pending.length, current: entry.ref.name });

    const started = performance.now();
    try {
      const { warnings, verification } = await writeOne(session, entry, store, backend, verify);
      const elapsedMs = performance.now() - started;

      if (verification && !verification.ok) {
        // The bytes are on disk. Reporting a bare failure would suggest otherwise, so this
        // says what actually happened, and does not count the photo as saved — leaving it
        // visibly pending rather than silently accepted.
        outcomes.push({
          name: entry.ref.name,
          ok: false,
          writtenButUnverified: true,
          message: 'written, but does not read back as expected: '
            + verification.problems.join('; '),
          elapsedMs,
          warnings: verification.warnings,
        });
        continue;
      }

      outcomes.push({
        name: entry.ref.name,
        ok: true,
        elapsedMs,
        warnings: [...warnings, ...(verification?.warnings ?? [])],
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
  verify: boolean,
): Promise<{ warnings: readonly string[]; verification: WriteVerification | undefined }> {
  const staged = session.edits.get(entry.ref.name);
  if (staged === undefined) return { warnings: [], verification: undefined };

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

  return {
    warnings: written.warnings,
    verification: verify ? await verifyOne(entry, store, backend, staged) : undefined,
  };
}

/**
 * Read the file back off disk and check it says what was intended.
 *
 * Deliberately re-reads through the `FileStore` rather than inspecting the bytes just
 * written. Those bytes are what we *believe* we wrote; the file is what the next program to
 * open it will see, and the gap between the two is exactly what needs checking — a failed
 * rename, a partial write, or a store that quietly wrote somewhere else.
 */
async function verifyOne(
  entry: PhotoEntry,
  store: FileStore,
  backend: MetadataBackend,
  expected: Coordinates | null,
): Promise<WriteVerification> {
  const after = await store.read(entry.ref);

  // Only the metadata is needed, so this reads a ~100KB stub rather than pushing the whole
  // photograph back through ExifTool.
  const result = await backend.read({
    bytes: headerOnly(after),
    name: entry.ref.name,
    args: [...VERIFY_ARGS, ...VERIFY_TAGS.map((tag) => '-' + tag)],
  });

  if (!result.data) {
    return {
      ok: false,
      problems: ['could not read the file back: ' + (result.message ?? 'no output')],
      warnings: [],
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.data);
  } catch {
    return { ok: false, problems: ['the file did not read back as valid metadata'], warnings: [] };
  }

  if (!Array.isArray(parsed) || typeof parsed[0] !== 'object' || parsed[0] === null) {
    return { ok: false, problems: ['no metadata could be read back from the file'], warnings: [] };
  }

  return verifyWrittenLocation(parsed[0] as Record<string, string | number | undefined>, expected);
}
