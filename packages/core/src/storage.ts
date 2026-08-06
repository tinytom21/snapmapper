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

export interface FileStore {
  listFolder(folder: FolderHandle): Promise<PhotoRef[]>;

  read(ref: PhotoRef): Promise<Uint8Array>;

  /**
   * Replace a file's contents without ever leaving it partially written.
   *
   * Implementations MUST write to a temporary file in the same directory and
   * then replace the original, so that losing power or having the app killed
   * mid-save leaves the original intact. Photos on a camera card are routinely
   * the only copy in existence.
   *
   * `modifiedAtMs` on the ref is restored after the write: geotagging is not an
   * edit to the photograph, and tools that sort by file date should not see one.
   */
  writeAtomic(ref: PhotoRef, bytes: Uint8Array): Promise<void>;
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
