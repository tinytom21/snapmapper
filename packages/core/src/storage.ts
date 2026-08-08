/**
 * The single seam between portable logic and each platform.
 *
 * Desktop implements this over the OS filesystem; Android over Storage Access
 * Framework document-tree URIs. Nothing else in the application touches files —
 * that is what keeps `core` portable and what makes the write path auditable in
 * one place.
 */

/**
 * An opaque platform handle to a granted folder.
 *
 * On Android this wraps a persisted SAF tree URI; on desktop, a path. Core code
 * only ever passes it back to the store that issued it.
 */
export interface FolderHandle {
  readonly id: string;
  /** For display only. Never parse this — SAF URIs are not paths. */
  readonly displayName: string;
}

export interface PhotoRef {
  readonly folder: FolderHandle;
  readonly name: string;
  readonly sizeBytes: number;
  /** Milliseconds since epoch. Preserved across writes. */
  readonly modifiedAtMs: number;
  /** Platform-specific locator — a full path, or a SAF document URI. */
  readonly locator: string;
}

/**
 * Where a photo's bytes ended up, and how to read them back.
 *
 * Returned by `writeAtomic` so that verification reads *what was written* rather than assuming
 * it landed on top of the original. A store may write a copy somewhere else entirely, and a
 * verification step that re-read the source would then be checking the wrong file — and passing
 * while the output was wrong, which is the worst kind of green tick.
 */
export interface WrittenFile {
  /** Where it went, for display in a result list. */
  readonly location: string;
  /** True when the original file was replaced rather than a copy being made. */
  readonly replacedOriginal: boolean;
  /** The bytes now on disk at that location. */
  read(): Promise<Uint8Array>;
}

export interface FileStore {
  listFolder(folder: FolderHandle): Promise<PhotoRef[]>;

  read(ref: PhotoRef): Promise<Uint8Array>;

  /**
   * The first `maxBytes` of a photo, for stores that can read part of a file.
   *
   * Optional, and callers must fall back to `read`. Reading metadata needs only the header — about
   * 100KB of a 7MB A6400 JPEG — so opening a card can touch a fraction of the bytes it does today.
   *
   * **This does not make ExifTool faster**, and it is worth being clear about that: measured, a
   * 101KB stub and the whole 6.9MB file cost the same to parse, because the cost is per
   * invocation. What this saves is the disk read and the allocation — which on a phone reading a
   * camera card, for hundreds of photographs, is the part that is not free.
   */
  readHead?(ref: PhotoRef, maxBytes: number): Promise<Uint8Array>;

  /**
   * Put a photo's new bytes on disk, without ever leaving a file partially written.
   *
   * Implementations MUST be atomic from the reader's point of view: write to a temporary file
   * and then move it into place, so that losing power or having the application killed
   * mid-save never leaves a truncated image. Photos on a camera card are routinely the only
   * copy in existence.
   *
   * A store may either replace the original or write a copy elsewhere; the returned
   * `WrittenFile` says which, and is the only correct way to read the result back.
   *
   * When a store does replace the original, `modifiedAtMs` on the ref should be restored:
   * geotagging is not an edit to the photograph, and tools that sort by file date should not
   * see one. Not every platform can — see `MTIME_LIMITATION` in the browser store.
   */
  writeAtomic(ref: PhotoRef, bytes: Uint8Array): Promise<WrittenFile>;
}

/**
 * Raised when a write fails for one file, so a batch can continue past it.
 *
 * Fields are assigned in the body rather than declared as parameter
 * properties: those require code generation, and this package is stripped
 * rather than compiled.
 */
export class FileWriteError extends Error {
  readonly ref: PhotoRef;

  constructor(ref: PhotoRef, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'FileWriteError';
    this.ref = ref;
  }
}
