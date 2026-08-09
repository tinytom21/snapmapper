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
  buildClearPlaceTags,
  buildGeotagTags,
  buildPlaceTags,
  buildSidecarTags,
  instantOf,
  isRawFile,
  pendingPhotos,
  readTags,
  sidecarName,
  verifyWrittenLocation,
  writeMetadataSpliced,
  writeXmpSidecar,
  FileWriteError,
  type BatchRunner,
  type Coordinates,
  type ExpectedLocation,
  type FileStore,
  type MetadataBackend,
  type PhotoEntry,
  type Place,
  type Session,
  type WriteVerification,
  type WrittenFile,
} from '@snapmapper/core';

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
  /** Where the bytes went. Worth showing, since it is not always the original's path. */
  readonly location?: string;
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

  /**
   * Needed only to save a **raw** photograph, whose location goes into an XMP sidecar.
   *
   * ExifTool creates a sidecar as a *file*, and the wrapper's write path cannot ask for one: it
   * always names its output `<uuid>.tmp`, and the extension is what decides the format. The batch
   * runner can name its own output and read it back, so that is the route. Absent, raw files fail
   * with a message saying so rather than being silently skipped.
   */
  readonly runner?: BatchRunner | undefined;
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
      const { warnings, verification, location } = await writeOne(
        session, entry, store, backend, verify, options.runner,
      );
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
          ...(location ? { location } : {}),
        });
        continue;
      }

      outcomes.push({
        name: entry.ref.name,
        ok: true,
        elapsedMs,
        warnings: [...warnings, ...(verification?.warnings ?? [])],
        ...(location ? { location } : {}),
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
  runner: BatchRunner | undefined,
): Promise<{
  warnings: readonly string[];
  verification: WriteVerification | undefined;
  location: string | undefined;
}> {
  const staged = session.edits.get(entry.ref.name);
  const place = session.places.get(entry.ref.name);
  // Either kind of staging is a reason to write. A photo geocoded but not moved has no entry in
  // `edits` at all, and returning here would silently drop the work.
  if (staged === undefined && place === undefined) {
    return { warnings: [], verification: undefined, location: undefined };
  }

  /*
   * A raw file takes an entirely different route, and never gets read or written.
   *
   * The sidecar is built from the tags alone — no source file — so this costs one invocation and
   * no I/O whatever the size of the ARW. It is also the only write path here that cannot damage
   * anything, because the file it produces did not exist a moment ago.
   */
  if (isRawFile(entry.ref.name)) {
    return writeSidecarFor(session, entry, store, backend, verify, runner, staged, place);
  }

  // One bulk read into bytes. Handing a Blob to the backend is the ~69x mistake.
  const original = await store.read(entry.ref);

  /*
   * Coordinates and place names are independent stagings and are merged into one write.
   *
   * One ExifTool invocation rather than two, which matters for the same reason it matters when
   * reading: the cost is per invocation. It also means a photo cannot end up with its city written
   * and its coordinates not, which is the state that would be hardest to notice and to explain.
   */
  const tags: Record<string, string> = {};

  if (staged !== undefined) {
    Object.assign(tags, staged === null
      ? buildClearLocationTags()
      : buildGeotagTags({
        coordinates: staged,
        // No instant means no GPSDateStamp/GPSTimeStamp, which is correct: a photo with
        // an unreadable date should get coordinates rather than a guessed GPS time.
        ...(instantOf(session, entry) ? { instant: instantOf(session, entry) as Date } : {}),
      }));
  }

  if (place !== undefined) {
    Object.assign(tags, place === null ? buildClearPlaceTags() : buildPlaceTags(place));
  }

  const written = await writeMetadataSpliced(backend, original, entry.ref.name, tags);

  const onDisk = await store.writeAtomic(entry.ref, written.bytes);

  return {
    warnings: written.warnings,
    location: onDisk.location,
    /*
     * Verification is about the coordinates, so a geocode-only write has nothing to compare.
     *
     * That is not a gap: the half of verification that catches real damage is ExifTool's own
     * structural warning on the read-back, and that runs whatever it was asked to check. Passing
     * `null` here would be wrong in a way that matters — `null` asserts the coordinates are
     * *absent*, so a geocode-only write would fail verification for leaving them alone.
     */
    verification: verify
      ? await verifyOne(entry, onDisk, backend, staged === undefined ? 'unchanged' : staged)
      : undefined,
  };
}

/**
 * Save a raw photograph's location as an XMP sidecar beside it.
 *
 * Deliberately not merged into `writeOne`'s body. Almost nothing is shared: no file is read, no
 * bytes are spliced, the destination is the photograph's own folder rather than the copy folder,
 * the tag set is XMP-only, and the verification asks a different question. Threading all of that
 * through the JPEG path as conditionals would make the one write path that has been carefully
 * measured harder to read, for no gain.
 */
async function writeSidecarFor(
  session: Session,
  entry: PhotoEntry,
  store: FileStore,
  backend: MetadataBackend,
  verify: boolean,
  runner: BatchRunner | undefined,
  staged: Coordinates | null | undefined,
  place: Place | null | undefined,
): Promise<{
  warnings: readonly string[];
  verification: WriteVerification | undefined;
  location: string | undefined;
}> {
  if (!store.writeSidecar) {
    throw new FileWriteError(entry.ref, 'this store cannot write beside a photograph');
  }
  if (!runner) {
    throw new FileWriteError(
      entry.ref,
      'the metadata engine needed for raw sidecars did not load; reload and try again',
    );
  }

  /*
   * Clearing a raw photograph's location means deleting its sidecar, which is not implemented — so
   * it refuses rather than writing a sidecar asserting 0,0 or an empty one that readers would treat
   * as authoritative. Removing the file is the correct behaviour and belongs with a confirmation.
   */
  if (staged === null) {
    throw new FileWriteError(
      entry.ref,
      `clearing a raw photograph's location means deleting ${sidecarName(entry.ref.name)}; `
      + 'do that in the file manager for now',
    );
  }

  const coordinates = staged ?? entry.existing;
  if (!coordinates) {
    throw new FileWriteError(entry.ref, 'no coordinates to write');
  }

  const bytes = await writeXmpSidecar(
    runner,
    buildSidecarTags(coordinates, place ?? undefined),
  );

  const name = sidecarName(entry.ref.name);
  const onDisk = await store.writeSidecar(entry.ref, name, bytes);

  return {
    warnings: [],
    location: onDisk.location,
    verification: verify ? await verifySidecar(entry, onDisk, backend, coordinates) : undefined,
  };
}

/**
 * Read the sidecar back off disk and check the coordinates survived.
 *
 * A separate check from `verifyOne`, because the question is different. `verifyWrittenLocation`
 * reads `Composite:GPSLatitude`, which an XMP file does not have — the value *is*
 * `XMP:GPSLatitude`, so there is nothing for ExifTool to compose it from and the comparison would
 * fail on a perfectly good sidecar.
 *
 * The structural-warning half of the usual verification has no counterpart here and needs none.
 * That half exists to catch maker notes wrecked by a rewrite; nothing was rewritten, and the file
 * is a few hundred bytes of XML that did not exist before.
 */
async function verifySidecar(
  entry: PhotoEntry,
  onDisk: WrittenFile,
  backend: MetadataBackend,
  expected: Coordinates,
): Promise<WriteVerification> {
  const after = await onDisk.read();
  const problems: string[] = [];

  try {
    const tags = await readTags(backend, after, sidecarName(entry.ref.name), [
      'XMP:GPSLatitude', 'XMP:GPSLongitude',
    ]);

    const latitude = Number(tags['XMP:GPSLatitude']);
    const longitude = Number(tags['XMP:GPSLongitude']);

    // The same tolerance the JPEG path uses: a rounding difference is not a wrong answer.
    if (!closeEnough(latitude, expected.latitude) || !closeEnough(longitude, expected.longitude)) {
      problems.push(
        `reads back as ${latitude}, ${longitude} rather than `
        + `${expected.latitude}, ${expected.longitude}`,
      );
    }
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
  }

  return { ok: problems.length === 0, problems, warnings: [] };
}

const VERIFY_TOLERANCE = 1e-6;

function closeEnough(got: number, want: number): boolean {
  return Number.isFinite(got) && Math.abs(got - want) < VERIFY_TOLERANCE;
}

/**
 * Read back what was written and check it says what was intended.
 *
 * Reads through the `WrittenFile` the store handed back, not through `store.read(ref)`. Those
 * are not the same file when copies are being saved, and verifying the *original* while the
 * copy was wrong would be a green tick on the wrong file — the worst kind. The store is the
 * only thing that knows where the bytes went, so it is the only thing that can be asked.
 */
async function verifyOne(
  entry: PhotoEntry,
  onDisk: WrittenFile,
  backend: MetadataBackend,
  expected: ExpectedLocation,
): Promise<WriteVerification> {
  const after = await onDisk.read();

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
