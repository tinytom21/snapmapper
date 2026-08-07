/**
 * `FileStore` over the File System Access API.
 *
 * The only platform-specific code in the desktop MVP, and deliberately small — the
 * `FileStore` interface exists so that a Tauri or Android implementation replaces just
 * this file.
 *
 * ## Two ways in, for two different situations
 *
 * **Pick files.** The OS file picker, multi-select. Use this when a folder holds hundreds or
 * thousands of photos, which a camera card does: reading metadata costs roughly half a second
 * per photo on a desktop and three seconds on a phone, so parsing a 1000-photo card before
 * the user can do anything would take the better part of an hour. Letting the OS picker narrow
 * the set first is the difference between unusable and instant.
 *
 * **Pick a folder.** One permission prompt covers everything inside it, which is much less
 * clicking when a whole folder really is the subject. Kept for small folders.
 *
 * The two differ in more than convenience, and it is worth knowing which you are paying for:
 * a directory handle can be asked for `readwrite` up front, but `showOpenFilePicker` has no
 * `mode` and yields read-only handles, so write access must be requested per file afterwards.
 * That request happens at pick time rather than at save time — a permission prompt appearing
 * halfway through writing fifty files is the worst possible moment for it.
 *
 * ## Atomicity
 *
 * `createWritable()` does the right thing here, and not by accident: Chromium writes to a swap
 * file alongside the target and moves it into place on `close()`. So a crash mid-save leaves
 * the original intact, which is the guarantee `writeAtomic` exists to make. `keepExistingData`
 * is left false so no tail of the old file can survive.
 *
 * ## The one contract this cannot honour
 *
 * `FileStore.writeAtomic` says the modification date is restored after a write. **The File
 * System Access API has no way to set a file's mtime**, so a geotagged photo will show today's
 * date. That is a real regression against GeoSetter, unavoidable in a browser, and fixed by a
 * native shell — see `MTIME_LIMITATION`, which the UI surfaces rather than hiding.
 */

import type { FileStore, FolderHandle, PhotoRef } from '@geotagger/core';
import { FileWriteError } from '@geotagger/core';

/**
 * Stated in one place so the UI can show it and a native shell can drop it.
 *
 * Not a footnote: it silently changes what the user sees in Explorer, and quietly failing to
 * mention it would be worse than the limitation itself.
 */
export const MTIME_LIMITATION =
  'Running in a browser, the file modification date cannot be preserved — geotagged '
  + 'photos will show today\'s date. A native desktop build fixes this.';

/**
 * Above this many JPEGs, a folder is not opened without asking.
 *
 * Reading metadata is roughly 0.5 s per photo on a desktop and 3 s on a phone, so a camera
 * card's worth would run for many minutes with no way to stop it. The picker is the right tool
 * at that size, and the UI says so rather than silently starting.
 */
export const LARGE_FOLDER_THRESHOLD = 200;

const JPEG_PATTERN = /\.jpe?g$/i;

export function isFileSystemAccessSupported(): boolean {
  return typeof globalThis.showDirectoryPicker === 'function'
    || typeof globalThis.showOpenFilePicker === 'function';
}

export function isFilePickerSupported(): boolean {
  return typeof globalThis.showOpenFilePicker === 'function';
}

export function isFolderPickerSupported(): boolean {
  return typeof globalThis.showDirectoryPicker === 'function';
}

/** A `FolderHandle` that also carries the live directory handle, when there is one. */
export interface BrowserFolder extends FolderHandle {
  /** Absent for a set of individually picked files — there is no folder to re-scan. */
  readonly directory?: FileSystemDirectoryHandle;
}

export interface PickedPhotos {
  readonly folder: BrowserFolder;
  readonly refs: PhotoRef[];
  /**
   * Files left out because another picked file already had that name.
   *
   * A session keys photos by filename, so two files called `DSC00119.JPG` from different
   * folders would be treated as one — and an edit meant for one could be written into the
   * other. Refusing the duplicate is the only safe option, and saying so is better than
   * silently dropping it.
   */
  readonly skippedDuplicates: readonly string[];
  /** Files the user declined to grant write access to. Readable, but not saveable. */
  readonly readOnly: readonly string[];
}

export interface BrowserFileStore extends FileStore {
  /** The OS file picker, multi-select. Best for a card holding hundreds of photos. */
  pickPhotos(options?: { add?: PhotoRef[] }): Promise<PickedPhotos | undefined>;
  /** The OS folder picker. One prompt covers the folder; best when it is small. */
  pickFolder(): Promise<BrowserFolder | undefined>;
  /** How many JPEGs a folder holds, without reading any metadata. */
  countFolder(folder: BrowserFolder): Promise<number>;
}

export function createBrowserFileStore(): BrowserFileStore {
  /**
   * File handles by locator, so a write does not have to re-resolve by name.
   *
   * For folder mode the locator is `folderId/filename`; for picked files it carries a counter,
   * because two files can share a name and the map must not collide.
   */
  const handles = new Map<string, FileSystemFileHandle>();
  let pickCounter = 0;

  async function refFromHandle(
    handle: FileSystemFileHandle,
    folder: BrowserFolder,
    locator: string,
  ): Promise<PhotoRef> {
    const file = await handle.getFile();
    handles.set(locator, handle);

    return {
      folder,
      name: handle.name,
      sizeBytes: file.size,
      modifiedAtMs: file.lastModified,
      locator,
    };
  }

  return {
    async pickPhotos(options = {}): Promise<PickedPhotos | undefined> {
      if (!isFilePickerSupported()) {
        throw new Error('This browser has no file picker. Use Chrome or Edge.');
      }

      let picked: FileSystemFileHandle[];
      try {
        picked = await globalThis.showOpenFilePicker!({
          multiple: true,
          id: 'photos',
          types: [{ description: 'JPEG photos', accept: { 'image/jpeg': ['.jpg', '.jpeg'] } }],
        });
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') return undefined;
        throw error;
      }

      if (picked.length === 0) return undefined;

      const existing = options.add ?? [];
      const folder: BrowserFolder = {
        id: 'picked',
        displayName: 'Selected photos',
      };

      const taken = new Set(existing.map((ref) => ref.name));
      const refs: PhotoRef[] = [...existing];
      const skippedDuplicates: string[] = [];
      const readOnly: string[] = [];

      for (const handle of picked) {
        if (taken.has(handle.name)) {
          skippedDuplicates.push(handle.name);
          continue;
        }
        taken.add(handle.name);

        /*
         * Ask for write access now, not at save time.
         *
         * `showOpenFilePicker` yields read-only handles, so without this the first prompt
         * would appear partway through writing a batch — the worst moment to interrupt
         * somebody. A file that is refused stays in the list and readable; it simply cannot
         * be saved, and the UI says which.
         */
        if (!(await ensureWritable(handle))) readOnly.push(handle.name);

        refs.push(await refFromHandle(handle, folder, `picked:${pickCounter++}:${handle.name}`));
      }

      refs.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
      return { folder, refs, skippedDuplicates, readOnly };
    },

    async pickFolder(): Promise<BrowserFolder | undefined> {
      if (!isFolderPickerSupported()) {
        throw new Error('This browser has no folder picker. Use the file picker instead.');
      }

      try {
        // readwrite up front: one prompt covers the whole folder, rather than one appearing
        // per file at the moment the user has committed to saving.
        const handle = await globalThis.showDirectoryPicker({ mode: 'readwrite', id: 'photos' });
        return { id: handle.name, displayName: handle.name, directory: handle };
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') return undefined;
        throw error;
      }
    },

    async countFolder(folder: BrowserFolder): Promise<number> {
      const directory = folder.directory;
      if (!directory) return 0;

      let count = 0;
      // Enumeration only — no metadata is read, so this is fast even for thousands of files.
      for await (const [name, handle] of directory.entries()) {
        if (handle.kind === 'file' && JPEG_PATTERN.test(name)) count += 1;
      }
      return count;
    },

    async listFolder(folder: FolderHandle): Promise<PhotoRef[]> {
      const directory = (folder as BrowserFolder).directory;
      if (!directory) {
        // A picked set has no folder to enumerate; its refs came from the picker.
        return [];
      }

      const refs: PhotoRef[] = [];

      for await (const [name, handle] of directory.entries()) {
        if (handle.kind !== 'file' || !JPEG_PATTERN.test(name)) continue;
        refs.push(await refFromHandle(handle, folder as BrowserFolder, `${folder.id}/${name}`));
      }

      // Camera filenames sort chronologically, which is the order people expect.
      refs.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
      return refs;
    },

    async read(ref: PhotoRef): Promise<Uint8Array> {
      const handle = handles.get(ref.locator);
      if (!handle) throw new Error(`no handle for ${ref.name}; open it again`);

      const file = await handle.getFile();
      // One bulk read. Never hand the Blob onwards — see the note in core's exiftool.ts;
      // per-syscall Blob slicing costs ~69x on a phone.
      return new Uint8Array(await file.arrayBuffer());
    },

    async writeAtomic(ref: PhotoRef, bytes: Uint8Array): Promise<void> {
      const handle = handles.get(ref.locator);
      if (!handle) throw new FileWriteError(ref, 'no file handle; open it again');

      if (!(await ensureWritable(handle))) {
        throw new FileWriteError(ref, 'permission to write was refused');
      }

      let writable: FileSystemWritableFileStream;
      try {
        // Chromium writes to a swap file and moves it into place on close, so an interrupted
        // save leaves the original untouched.
        writable = await handle.createWritable({ keepExistingData: false });
      } catch (error) {
        throw new FileWriteError(ref, describe(error), { cause: error });
      }

      try {
        // TS 5.7 made Uint8Array generic over its buffer, and lib.dom types this parameter as
        // ArrayBufferView<ArrayBuffer>. The bytes are always backed by a real ArrayBuffer, so
        // this is a typing artefact rather than a risk.
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

      // Restoring ref.modifiedAtMs belongs here, and cannot be done: the File System Access
      // API exposes no way to set a modification time. See MTIME_LIMITATION.
    },
  };
}

/** True when we may write to this handle, asking the user if we do not already know. */
async function ensureWritable(handle: FileSystemFileHandle): Promise<boolean> {
  try {
    if (await handle.queryPermission({ mode: 'readwrite' }) === 'granted') return true;
    return await handle.requestPermission({ mode: 'readwrite' }) === 'granted';
  } catch {
    // An implementation without these methods grants whatever the picker gave; let the write
    // itself be the test rather than refusing pre-emptively.
    return true;
  }
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
