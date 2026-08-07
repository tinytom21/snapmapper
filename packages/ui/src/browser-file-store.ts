/**
 * `FileStore` over the File System Access API.
 *
 * The only platform-specific code in the desktop MVP, and deliberately small — the
 * `FileStore` interface exists so that a Tauri or Android implementation replaces just
 * this file. Desktop Chromium has `showDirectoryPicker`; Android Chrome does not, which
 * is why a pure PWA was ruled out for the phone but is perfectly good for a desktop
 * MVP with a faster iteration loop.
 *
 * ## Atomicity
 *
 * `createWritable()` does the right thing here, and not by accident: Chromium writes to
 * a swap file alongside the target and moves it into place on `close()`. So a crash
 * mid-save leaves the original intact, which is the guarantee `writeAtomic` exists to
 * make. `keepExistingData` is left false so no tail of the old file can survive.
 *
 * ## The one contract this cannot honour
 *
 * `FileStore.writeAtomic` says the modification date is restored after a write. **The
 * File System Access API has no way to set a file's mtime**, so a geotagged photo will
 * show today's date in Explorer. That is a real regression against GeoSetter, it is
 * unavoidable in a browser, and a native shell fixes it — see `MTIME_LIMITATION`, which
 * the UI surfaces rather than hiding.
 */

import type { FileStore, FolderHandle, PhotoRef } from '@geotagger/core';
import { FileWriteError } from '@geotagger/core';

/**
 * Stated in one place so the UI can show it and a native shell can drop it.
 *
 * Not a footnote: it silently changes what the user sees in Explorer, and quietly
 * failing to mention it would be worse than the limitation itself.
 */
export const MTIME_LIMITATION =
  'Running in a browser, the file modification date cannot be preserved — geotagged '
  + 'photos will show today\'s date. A native desktop build fixes this.';

const JPEG_PATTERN = /\.jpe?g$/i;

export function isFileSystemAccessSupported(): boolean {
  return typeof globalThis.showDirectoryPicker === 'function';
}

/**
 * Ask for a folder.
 *
 * `mode: 'readwrite'` up front is deliberate: asking for read access and then
 * escalating at save time means a permission prompt appearing at the exact moment the
 * user has committed to writing 50 files, which is the worst possible time to be asked.
 */
export async function pickFolder(): Promise<BrowserFolder | undefined> {
  if (!isFileSystemAccessSupported()) {
    throw new Error(
      'This browser has no File System Access API. Use Chrome or Edge on the desktop.',
    );
  }

  try {
    const handle = await globalThis.showDirectoryPicker({ mode: 'readwrite', id: 'photos' });
    return { id: handle.name, displayName: handle.name, directory: handle };
  } catch (error) {
    // The user cancelling the picker is not an error worth reporting.
    if (error instanceof DOMException && error.name === 'AbortError') return undefined;
    throw error;
  }
}

/** A `FolderHandle` that also carries the live directory handle. */
export interface BrowserFolder extends FolderHandle {
  readonly directory: FileSystemDirectoryHandle;
}

export function createBrowserFileStore(): FileStore {
  /**
   * File handles, kept so a write does not have to re-resolve by name.
   *
   * Keyed by locator, which for this store is `folderId/filename`. Populated by
   * `listFolder`, which is always the first thing to run.
   */
  const handles = new Map<string, FileSystemFileHandle>();

  return {
    async listFolder(folder: FolderHandle): Promise<PhotoRef[]> {
      const directory = (folder as BrowserFolder).directory;
      if (!directory) throw new Error('this FileStore needs a folder from pickFolder()');

      const refs: PhotoRef[] = [];

      for await (const [name, handle] of directory.entries()) {
        if (handle.kind !== 'file' || !JPEG_PATTERN.test(name)) continue;

        const file = await handle.getFile();
        const locator = `${folder.id}/${name}`;
        handles.set(locator, handle);

        refs.push({
          folder,
          name,
          sizeBytes: file.size,
          modifiedAtMs: file.lastModified,
          locator,
        });
      }

      // Camera filenames sort chronologically, which is the order people expect.
      refs.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
      return refs;
    },

    async read(ref: PhotoRef): Promise<Uint8Array> {
      const handle = handles.get(ref.locator);
      if (!handle) throw new Error(`no handle for ${ref.name}; list the folder first`);

      const file = await handle.getFile();
      // One bulk read. Never hand the Blob onwards — see the note in core's
      // exiftool.ts; per-syscall Blob slicing costs ~69x on a phone.
      return new Uint8Array(await file.arrayBuffer());
    },

    async writeAtomic(ref: PhotoRef, bytes: Uint8Array): Promise<void> {
      const handle = handles.get(ref.locator);
      if (!handle) throw new FileWriteError(ref, 'no file handle; list the folder first');

      let writable: FileSystemWritableFileStream;
      try {
        // Chromium writes to a swap file and moves it into place on close, so an
        // interrupted save leaves the original untouched.
        writable = await handle.createWritable({ keepExistingData: false });
      } catch (error) {
        throw new FileWriteError(ref, describe(error), { cause: error });
      }

      try {
        // TS 5.7 made Uint8Array generic over its buffer, and lib.dom types this
        // parameter as ArrayBufferView<ArrayBuffer>. The bytes are always backed by a
        // real ArrayBuffer, so this is a typing artefact rather than a risk.
        await writable.write(bytes as unknown as ArrayBufferView<ArrayBuffer>);
        await writable.close();
      } catch (error) {
        // Abort so the swap file is discarded rather than left behind.
        try {
          await writable.abort();
        } catch {
          // Nothing useful to do; the original is still intact either way.
        }
        throw new FileWriteError(ref, describe(error), { cause: error });
      }

      // Restoring ref.modifiedAtMs belongs here, and cannot be done: the File System
      // Access API exposes no way to set a modification time. See MTIME_LIMITATION.
    },
  };
}

function describe(error: unknown): string {
  if (error instanceof DOMException) {
    if (error.name === 'NotAllowedError') return 'permission to write was refused';
    if (error.name === 'NoModificationAllowedError') return 'the file is locked by another program';
    if (error.name === 'QuotaExceededError') return 'the disk is full';
    return `${error.name}: ${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}
