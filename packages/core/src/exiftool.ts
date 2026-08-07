/**
 * The metadata write path — one place, auditable, encoding what Phase 0 measured.
 *
 * Every rule here was paid for with a measurement, and each is easy to break by
 * accident:
 *
 *   1. **Never pass a `File` or `Blob` to the backend.** zeroperl reads Blob-backed
 *      files with `await blob.slice(...).arrayBuffer()` once per read syscall —
 *      thousands of allocations for one photo. Same phone, same 5.4MB file: 1.11 s
 *      with a `Uint8Array`, ~76 s with the `File`. A desktop hides it almost
 *      entirely (1.7×), which is exactly how it went unnoticed. The types here make
 *      it unrepresentable.
 *   2. **Splice; do not send the photograph.** Metadata is ~2% of an A6400 JPEG. On a
 *      phone that is 343 ms against 1.11 s.
 *   3. **`-n` only.** `-P` and `-overwrite_original` fail in the sandbox, which has no
 *      real filesystem. Restoring the modification date is `FileStore`'s job.
 *   4. **Never re-serialise EXIF ourselves.** `piexifjs` does, and drops 47 tags while
 *      leaving Sony maker-note offsets 53 bytes wrong. Real ExifTool does all metadata
 *      work here; we only move bytes it has already written.
 *   5. **A warning is not a failure.** The wrapper reports `success: false` for a bare
 *      warning, so one benign complaint would otherwise look like a failed write.
 */

import { REQUIRED_WRITE_ARGS, type TagSet } from './exif-tags.ts';
import { buildHeaderStub, findScanStart, spliceHeaders } from './jpeg.ts';

/**
 * The raw byte-in/byte-out transform this module drives.
 *
 * Deliberately narrow, so `core` does not depend on the WASM package directly and the
 * whole write path is testable without instantiating a Perl interpreter. Implemented
 * by `createWasmBackend` for real use.
 */
export interface MetadataBackend {
  /** Write tags to a JPEG and return the modified bytes. */
  write(input: BackendInput): Promise<BackendResult>;
  /** Run ExifTool for its output text, e.g. `-json`. */
  read(input: Omit<BackendInput, 'tags'>): Promise<BackendResult<string>>;
}

export interface BackendInput {
  /** Bytes. Never a Blob or File — see rule 1. */
  readonly bytes: Uint8Array;
  /** Filename ExifTool should see. Only the extension really matters. */
  readonly name: string;
  readonly tags?: TagSet;
  readonly args: readonly string[];
}

/**
 * Both fields are always present and explicitly nullable rather than optional.
 *
 * `exactOptionalPropertyTypes` is on, so an optional `data?: T` cannot be *set* to
 * `undefined` — only omitted. Since `ok: false` genuinely carries no data, and `ok:
 * true` can still carry a warning message, spelling both out is simpler than making
 * every construction site conditional.
 */
export interface BackendResult<T = Uint8Array> {
  readonly ok: boolean;
  readonly data: T | undefined;
  /** ExifTool's stderr. May contain warnings even on success. */
  readonly message: string | undefined;
}

export class MetadataWriteError extends Error {
  /**
   * ExifTool's own output, when there was any. Explicitly nullable rather than
   * optional, because `exactOptionalPropertyTypes` forbids assigning `undefined` to an
   * optional property.
   */
  readonly detail: string | undefined;

  constructor(message: string, detail?: string) {
    super(message);
    this.name = 'MetadataWriteError';
    this.detail = detail;
  }
}

export interface WriteResult {
  readonly bytes: Uint8Array;
  /** Bytes actually handed to ExifTool, versus the file size. Diagnostic. */
  readonly stubBytes: number;
  readonly totalBytes: number;
  /** Warnings ExifTool emitted that were judged benign. Worth surfacing in a log. */
  readonly warnings: readonly string[];
}

/**
 * Failures that are only ever warnings in this sandbox.
 *
 * ExifTool writes to a virtual filesystem, so anything about file times or erasing an
 * original is noise rather than a problem — the host owns both. Matched narrowly: a
 * broad "ignore warnings" rule would swallow the maker-note offset complaint that is
 * the single most important signal this application can receive.
 */
const BENIGN_PATTERNS: readonly RegExp[] = [
  /error setting file time/i,
  /\bminor\b.*file (modification|access|creation) date/i,
];

/**
 * The one signal never to ignore.
 *
 * This is how a corrupting writer announces itself. `piexifjs` produced exactly this
 * while otherwise looking like it had worked.
 */
const FATAL_PATTERNS: readonly RegExp[] = [
  /maker ?note/i,
  /possibly incorrect/i,
  /truncated/i,
  /corrupt/i,
  /bad (ifd|header|offset)/i,
];

/**
 * Write metadata into a JPEG, giving ExifTool only the metadata.
 *
 * Returns new bytes; never mutates the input. The caller is responsible for getting
 * them onto disk atomically — see `FileStore.writeAtomic`.
 */
export async function writeMetadataSpliced(
  backend: MetadataBackend,
  original: Uint8Array,
  name: string,
  tags: TagSet,
): Promise<WriteResult> {
  if (!(original instanceof Uint8Array)) {
    // Rule 1, enforced at runtime as well as in the types: a Blob that reaches the
    // backend costs ~69× on a phone, and the symptom is only slowness, so nothing
    // else would ever catch it.
    throw new MetadataWriteError(
      'writeMetadataSpliced needs a Uint8Array; read the Blob to bytes first',
    );
  }

  const scanStart = findScanStart(original);
  const stub = buildHeaderStub(original, scanStart);

  const result = await backend.write({
    bytes: stub,
    name,
    tags,
    args: REQUIRED_WRITE_ARGS,
  });

  const warnings = classify(result.message);

  if (!result.ok && warnings.fatal.length === 0 && !result.data) {
    throw new MetadataWriteError('ExifTool did not return a file', result.message);
  }
  if (warnings.fatal.length > 0) {
    throw new MetadataWriteError(
      `ExifTool reported a problem with the metadata: ${warnings.fatal.join('; ')}`,
      result.message,
    );
  }
  if (!result.data || result.data.byteLength === 0) {
    throw new MetadataWriteError('ExifTool returned no bytes', result.message);
  }

  // spliceHeaders re-parses its own output and refuses to hand back a file whose scan
  // data moved, so a corrupted photograph cannot escape this call quietly.
  const bytes = spliceHeaders(original, scanStart, result.data);

  return {
    bytes,
    stubBytes: stub.byteLength,
    totalBytes: original.byteLength,
    warnings: warnings.benign,
  };
}

/**
 * Sort ExifTool's output into what can be ignored and what must stop the write.
 *
 * The default is *not* benign. Anything unrecognised counts as fatal, because the
 * failure this guards against — silently corrupted maker notes — is invisible until
 * somebody opens the photo in Lightroom months later.
 */
export function classify(message: string | undefined): {
  benign: string[];
  fatal: string[];
} {
  const benign: string[] = [];
  const fatal: string[] = [];

  if (!message) return { benign, fatal };

  for (const rawLine of message.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '') continue;

    // ExifTool's own success line.
    if (/^\s*\d+ image files? (updated|created)\s*$/i.test(line)) continue;

    if (FATAL_PATTERNS.some((pattern) => pattern.test(line))) {
      fatal.push(line);
      continue;
    }
    if (BENIGN_PATTERNS.some((pattern) => pattern.test(line))) {
      benign.push(line);
      continue;
    }

    fatal.push(line);
  }

  return { benign, fatal };
}

/** Tags read back from a file, as ExifTool's `-json` reports them. */
export type TagValues = Record<string, string | number | undefined>;

/**
 * Read metadata for display.
 *
 * `-fast2` is deliberate: it stops ExifTool scanning past the metadata, which is all
 * a listing needs. Note it does *not* speed reads up measurably on this backend
 * (measured: 609 ms versus 673 ms), so this is about not doing pointless work rather
 * than about a win.
 */
export async function readTags(
  backend: MetadataBackend,
  bytes: Uint8Array,
  name: string,
  tags: readonly string[] = [],
): Promise<TagValues> {
  const result = await backend.read({
    bytes,
    name,
    // `-G`, family 0 only. `-G0:1` looks more informative and silently breaks every
    // lookup: it emits `EXIF:ExifIFD:DateTimeOriginal` and `EXIF:GPS:GPSDateStamp`
    // rather than `EXIF:DateTimeOriginal`, and it duplicates tags that appear in both
    // IFD0 and IFD1. Measured against ExifTool 13.59. The failure is quiet — dates
    // simply never resolve — and it hides behind `Composite:*`, which has no family-1
    // subgroup and so keeps working.
    args: ['-json', '-n', '-G', '-fast2', ...tags.map((tag) => `-${tag}`)],
  });

  if (!result.data) {
    throw new MetadataWriteError('could not read metadata', result.message);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.data);
  } catch {
    throw new MetadataWriteError('ExifTool did not return JSON', result.data.slice(0, 200));
  }

  if (!Array.isArray(parsed) || parsed.length === 0 || typeof parsed[0] !== 'object') {
    throw new MetadataWriteError('ExifTool returned no metadata for this file');
  }

  const values = { ...(parsed[0] as TagValues) };
  delete values.SourceFile;
  return values;
}
