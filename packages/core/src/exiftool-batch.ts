/**
 * Reading several photographs in one ExifTool invocation.
 *
 * ## The measurement this exists for
 *
 * `spike/src/load-cost.mjs` established that a read costs about a second **per invocation** and
 * almost nothing per byte: pushing sixty-eight times the data through made no measurable
 * difference. `spike/src/batch-read.mjs` then took the obvious next step and shared one invocation
 * between several files:
 *
 * | files in one invocation | total | per photo |
 * |---|---|---|
 * | 1 | 354–592 ms | 354–592 ms |
 * | 5 | 619 ms | 124 ms |
 * | 10 | 750 ms | 75 ms |
 * | 28 | 1196 ms | **43 ms** |
 *
 * A 200-photo card goes from something over a minute to about nine seconds, and roughly six times
 * those figures on a phone.
 *
 * ## The two traps, both proved rather than guessed
 *
 * **A non-zero exit is not a total failure.** With a corrupt file in the middle of five, ExifTool
 * returned five records — the good four entirely intact — reported `Error: File format error` on
 * stderr naming the culprit, and exited 1. Treating that as a failed batch would discard four
 * perfectly good photographs because of a fifth. This is the same lesson as the existing "the
 * wrapper reports `success: false` for a bare warning", one level up.
 *
 * **Results are matched by `SourceFile`, never by index.** ExifTool emits one record per file it
 * could read, so a batch where one file failed returns fewer records than it was given, and
 * position `n` in the output is not file `n` in the input. Matching by index there would attach
 * every photograph after the failure to the wrong metadata — coordinates and dates silently
 * belonging to a different picture, which is the worst class of bug this app can have and would
 * look like nothing at all.
 *
 * The paths come back from the runner rather than being reconstructed here, because two
 * photographs picked from different folders can share a filename and the runner is the only thing
 * that knows how it kept them apart.
 */

import { MetadataWriteError, decodeBase64, type TagValues } from './exiftool.ts';

/** A file to mount into the batch: bytes plus the name ExifTool should see. */
export interface BatchFile {
  readonly name: string;
  /** Bytes. Never a Blob or File — see rule 1 in `exiftool.ts`. */
  readonly bytes: Uint8Array;
}

/** What one invocation produced. Deliberately raw: interpretation happens here, not in the host. */
export interface BatchRun {
  readonly stdout: string;
  readonly stderr: string;
  /**
   * The paths the runner mounted each file at, in the order the files were given.
   *
   * The runner owns naming because it owns collision handling; this module only needs the mapping
   * back. `SourceFile` in ExifTool's output is one of these strings.
   */
  readonly paths: readonly string[];
  readonly exitCode: number | undefined;
  /**
   * Files ExifTool wrote, by the path they were asked for under.
   *
   * Only populated when `run` was given `outputs`. This exists for the XMP sidecar, which ExifTool
   * produces as a *file* rather than on stdout — and which the wrapper's own write path cannot
   * make, because it always names its output `<uuid>.tmp` and the extension is what decides the
   * format. Absent for an ordinary read.
   */
  readonly produced?: ReadonlyMap<string, Uint8Array>;
}

/**
 * Mount N files and run ExifTool over all of them at once.
 *
 * Abstract so that `core` keeps its no-platform-dependencies rule and so the mapping logic below —
 * which is where a mistake is invisible — can be tested without booting a Perl interpreter.
 */
export interface BatchRunner {
  /**
   * `outputs` names paths to read back out of the virtual filesystem after the run, for the case
   * where ExifTool's answer is a file rather than stdout. `files` may be empty: a sidecar is built
   * from tags alone and needs nothing mounted.
   */
  run(
    files: readonly BatchFile[],
    args: readonly string[],
    outputs?: readonly string[],
  ): Promise<BatchRun>;
}

/** One photograph's outcome. Parallel to the input, so a caller never has to match anything up. */
export type BatchTagResult =
  | { readonly ok: true; readonly tags: TagValues; readonly thumbnail: Uint8Array | undefined }
  | { readonly ok: false; readonly error: string };

/** ExifTool's marker for a binary value inside `-json` output under `-b`. */
const BASE64_PREFIX = 'base64:';

/**
 * Read tags and the embedded thumbnail for many photographs in one invocation.
 *
 * The argument list is the single-file one from `readTagsAndThumbnail` with several paths on the
 * end. `-n` and `-b` remain independent — one renders numbers, the other base64s binary — so the
 * thumbnails ride along rather than costing a second pass.
 *
 * Returns an array **parallel to `files`**, so the caller indexes it directly and the
 * match-by-SourceFile problem stays contained in here.
 */
export async function readManyTags(
  runner: BatchRunner,
  files: readonly BatchFile[],
  tags: readonly string[] = [],
  thumbnailTag = 'ThumbnailImage',
): Promise<BatchTagResult[]> {
  if (files.length === 0) return [];

  for (const file of files) {
    if (!(file.bytes instanceof Uint8Array)) {
      throw new MetadataWriteError(
        `readManyTags needs a Uint8Array for ${file.name}; read the Blob to bytes first`,
      );
    }
  }

  const run = await runner.run(files, [
    '-json', '-n', '-b', '-G', '-fast2',
    ...tags.map((tag) => `-${tag}`),
    `-${thumbnailTag}`,
  ]);

  /*
   * No JSON at all is the one case that really is a whole-batch failure: ExifTool did not get far
   * enough to report on anything. Every photograph in the batch is marked with the same reason,
   * and the caller is free to retry them one at a time — which `loadPhotos` does.
   */
  const records = parseRecords(run.stdout);
  if (records === undefined) {
    const reason = run.stderr.trim() || 'ExifTool returned no output';
    return files.map(() => ({ ok: false, error: reason }));
  }

  const byPath = new Map<string, Record<string, unknown>>();
  for (const record of records) {
    const source = record['SourceFile'];
    if (typeof source === 'string') byPath.set(source, record);
  }

  const errors = errorsByPath(run.stderr);

  return files.map((file, index) => {
    const at = run.paths[index];
    const record = at === undefined ? undefined : byPath.get(at);

    const split = record ? splitRecord(record) : undefined;

    /*
     * A record is not the same as a successful read, and this is the trap the batch path has that
     * the single-file path does not.
     *
     * Given a file that is not a JPEG at all, ExifTool emits `{"SourceFile": "/1_broken.jpg"}` —
     * a record with nothing whatsoever in it — alongside `Error: File format error` on stderr.
     * Measured; see `spike/src/batch-verify.mjs`. Reading only the record count, that file looks
     * like a photograph that simply has no date and no coordinates, so the loader would list it as
     * an ordinary unplaced photo rather than as one it could not read. The user would then place
     * it by hand and the write would be what failed.
     *
     * The single-file path never sees this, because the wrapper treats any stderr as a failure and
     * throws. So the emptiness has to be caught here, and it is caught on the *content* rather
     * than on the exit code, which is 1 for the whole batch however many files were fine.
     */
    if (!split || (Object.keys(split.tags).length === 0 && !split.thumbnail)) {
      return {
        ok: false,
        error: (at === undefined ? undefined : errors.get(at))
          ?? `ExifTool returned no metadata for ${file.name}`,
      };
    }

    return { ok: true, ...split };
  });
}

/** `undefined` when there was no parseable JSON array at all — see the caller. */
function parseRecords(stdout: string): Record<string, unknown>[] | undefined {
  const text = stdout.trim();
  if (text === '') return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }

  if (!Array.isArray(parsed)) return undefined;
  return parsed.filter(
    (item): item is Record<string, unknown> => typeof item === 'object' && item !== null,
  );
}

/**
 * Attribute stderr lines to the files they name.
 *
 * ExifTool writes `Error: File format error - /2_broken.jpg`, so the path is the tail of the line.
 * Matched by suffix rather than by parsing the message, because the message wording varies by
 * failure and the path does not — and an unattributed line is simply dropped rather than being
 * shown against the wrong photograph.
 */
export function errorsByPath(stderr: string): Map<string, string> {
  const found = new Map<string, string>();

  for (const rawLine of stderr.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '') continue;
    // ExifTool's own tally, not a problem with any one file.
    if (/^\s*\d+ image files? (read|updated|created)\s*$/i.test(line)) continue;

    const match = /\s-\s(\/\S.*)$/.exec(line);
    if (!match?.[1]) continue;

    const path = match[1].trim();
    if (!found.has(path)) found.set(path, line);
  }

  return found;
}

/**
 * Split a record into tag values and the thumbnail bytes.
 *
 * The thumbnail has to be lifted *out* of the values, exactly as `readTagsAndThumbnail` does: left
 * in place it is a several-kilobyte base64 string that every session would then carry around for
 * the life of the page, and a photo entry is meant to be small enough that copying a session on
 * every edit is free.
 */
function splitRecord(record: Record<string, unknown>): {
  tags: TagValues;
  thumbnail: Uint8Array | undefined;
} {
  const tags: TagValues = {};
  let thumbnail: Uint8Array | undefined;

  for (const [key, value] of Object.entries(record)) {
    if (key === 'SourceFile') continue;

    if (typeof value === 'string' && value.startsWith(BASE64_PREFIX)) {
      thumbnail ??= decodeBase64(value.slice(BASE64_PREFIX.length));
      continue;
    }
    if (typeof value === 'string' || typeof value === 'number') tags[key] = value;
  }

  return { tags, thumbnail };
}
