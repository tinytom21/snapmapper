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

import type { FileStore, FolderHandle, PhotoRef, WrittenFile } from '@snapmapper/core';
import { FileWriteError } from '@snapmapper/core';
import {
  forgetFolder,
  regrantFolder,
  rememberFolder,
  rememberedFolder,
} from './handle-store.ts';

/**
 * Stated in one place so the UI can show it and a native shell can drop it.
 *
 * Not a footnote: it silently changes what the user sees in Explorer, and quietly failing to
 * mention it would be worse than the limitation itself.
 */
export const MTIME_LIMITATION =
  'Running in a browser, the file modification date cannot be preserved — a geotagged '
  + 'photo will show today\'s date. A native desktop build fixes this.';

/** Only worth saying when the originals are being overwritten. Copies keep theirs. */
export const MTIME_LIMITATION_IN_PLACE =
  MTIME_LIMITATION + ' Saving copies avoids it: the originals keep their dates.';

/**
 * Subfolder that copies are written into.
 *
 * Always a subfolder, never the chosen folder itself, so that a copy can never land on top of
 * an original — which is what would happen if somebody chose the photos' own folder as the
 * destination. The one exception is a folder already named this, where nesting would be silly;
 * the interface says when that happens rather than being quietly clever.
 */
export const OUTPUT_FOLDER_NAME = 'geotagged';

/**
 * How a save reaches the disk.
 *
 * `copy` is the default, and it is the safer of the two by some distance:
 *
 *   - The originals are never opened for writing, so they cannot be damaged by a bug here.
 *   - It needs **no write permission on the picked files at all**, which removes the
 *     per-file permission prompt that picking a dozen photos otherwise costs.
 *   - Ungeotagged photos stay visibly ungeotagged, because the output folder is separate.
 *
 * `in-place` is what GeoSetter does and what some workflows expect, so it stays available.
 */
export type SaveDestination =
  /** Overwrite the photos themselves. Needs write permission on each one. */
  | { readonly kind: 'in-place' }
  /**
   * Copies are wanted, but no output folder has been chosen yet.
   *
   * The starting state, and it exists to break a chicken-and-egg problem: whether the picker
   * needs to ask for write permission on each file depends on where saves will go, and that is
   * decided before a folder can be chosen. Starting here means the per-file prompts are never
   * asked for, and the folder is settled straight afterwards.
   *
   * Saving in this state is refused rather than quietly falling back to overwriting originals,
   * which would be the opposite of what was asked for.
   */
  | { readonly kind: 'copy-pending' }
  | { readonly kind: 'copy'; readonly directory: FileSystemDirectoryHandle; readonly label: string };

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
  /**
   * The OS file picker, multi-select. Best for a card holding hundreds of photos.
   *
   * Write permission on the picked files is requested only when saving in place. In copy mode
   * the originals are never written to, so asking would be a prompt per file for nothing.
   */
  pickPhotos(options?: { add?: PhotoRef[] }): Promise<PickedPhotos | undefined>;
  /** The OS folder picker. One prompt covers the folder; best when it is small. */
  pickFolder(): Promise<BrowserFolder | undefined>;
  /** How many JPEGs a folder holds, without reading any metadata. */
  countFolder(folder: BrowserFolder): Promise<number>;

  /**
   * Ask for a folder to write copies into, and prepare the subfolder inside it.
   *
   * One prompt, covering every save for the rest of the session.
   */
  pickOutputFolder(): Promise<SaveDestination | undefined>;
  /**
   * Use a folder already granted — the one opened in folder mode — as the destination.
   *
   * Costs no further prompt, because the folder grant already covers creating things inside it.
   * This is what makes "a geotagged folder beside the photos" automatic.
   */
  outputFolderWithin(folder: BrowserFolder): Promise<SaveDestination | undefined>;

  setDestination(destination: SaveDestination): void;
  getDestination(): SaveDestination;

  /**
   * Ask for the folder the GPS logger writes into, and remember it for good.
   *
   * A permanent answer to a permanent question: the logger writes into one folder forever, so
   * being asked on every visit is friction with no purpose.
   */
  pickTrackFolder(): Promise<TrackFolder | undefined>;
  /** The remembered track folder, if there is one and it is usable. */
  restoreTrackFolder(): Promise<TrackFolder | undefined>;
  /** Re-grant a remembered folder. Must be called from a user gesture — see `handle-store.ts`. */
  regrantTrackFolder(): Promise<TrackFolder | undefined>;
  forgetTrackFolder(): Promise<void>;
  /** Every `.gpx` in the track folder, newest first. Names and sizes only; nothing is read. */
  listTracks(folder: TrackFolder): Promise<readonly TrackFileRef[]>;
  /** The text of one track file. */
  readTrack(folder: TrackFolder, name: string): Promise<string>;

  /** The remembered output folder, so copies are asked about once ever rather than once a visit. */
  restoreOutputFolder(): Promise<SaveDestination | undefined>;
}

export interface TrackFolder {
  readonly directory: FileSystemDirectoryHandle;
  readonly displayName: string;
  /** True when it came back from storage still needing permission. */
  readonly needsPermission: boolean;
}

export interface TrackFileRef {
  readonly name: string;
  readonly sizeBytes: number;
  readonly modifiedAtMs: number;
}

const TRACK_PATTERN = /\.gpx$/i;

export function createBrowserFileStore(): BrowserFileStore {
  /**
   * File handles by locator, so a write does not have to re-resolve by name.
   *
   * For folder mode the locator is `folderId/filename`; for picked files it carries a counter,
   * because two files can share a name and the map must not collide.
   */
  const handles = new Map<string, FileSystemFileHandle>();
  let pickCounter = 0;
  // Copies by default: safer, and it removes the per-file write prompt.
  let destination: SaveDestination = { kind: 'copy-pending' };

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
         * Ask for write access only if the originals are going to be written to.
         *
         * `showOpenFilePicker` yields read-only handles, so saving in place needs a prompt per
         * file — and asked here rather than at save time, because a permission dialog appearing
         * partway through writing a batch is the worst moment to interrupt somebody. When
         * saving copies the originals are never opened for writing, so there is nothing to ask
         * for and the prompts vanish entirely.
         */
        if (destination.kind === 'in-place' && !(await ensureWritable(handle))) {
          readOnly.push(handle.name);
        }

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

    setDestination(next: SaveDestination): void {
      destination = next;
    },

    getDestination(): SaveDestination {
      return destination;
    },

    async pickOutputFolder(): Promise<SaveDestination | undefined> {
      if (!isFolderPickerSupported()) {
        throw new Error('This browser has no folder picker, so copies cannot be saved.');
      }

      try {
        const chosen = await globalThis.showDirectoryPicker({
          mode: 'readwrite',
          id: 'output',
        });

        /*
         * Remembered, so this is asked once ever rather than once a visit.
         *
         * Only here, and not in `outputFolderWithin`. That one derives the destination from the
         * folder of photographs currently open, which is a different folder every shoot — storing
         * it would mean the next card's copies landed beside the last card's.
         */
        await rememberFolder('output-folder', chosen);
        return await prepareOutput(chosen);
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') return undefined;
        throw error;
      }
    },

    async outputFolderWithin(folder: BrowserFolder): Promise<SaveDestination | undefined> {
      if (!folder.directory) return undefined;
      return prepareOutput(folder.directory);
    },

    // --- The track folder ----------------------------------------------------

    async pickTrackFolder(): Promise<TrackFolder | undefined> {
      if (!isFolderPickerSupported()) {
        throw new Error('This browser has no folder picker, so a track folder cannot be chosen.');
      }

      try {
        // `read` is enough and is the right thing to ask for: nothing here ever writes a track,
        // and asking for more permission than a feature needs is how people learn to click
        // through prompts without reading them.
        const directory = await globalThis.showDirectoryPicker({ mode: 'read', id: 'tracks' });
        await rememberFolder('track-folder', directory);
        return { directory, displayName: directory.name, needsPermission: false };
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') return undefined;
        throw error;
      }
    },

    async restoreTrackFolder(): Promise<TrackFolder | undefined> {
      const remembered = await rememberedFolder('track-folder');
      if (!remembered || remembered.permission === 'denied') return undefined;

      return {
        directory: remembered.handle,
        displayName: remembered.handle.name,
        // Reported rather than resolved: `requestPermission` needs a user gesture, and calling it
        // here would throw. The UI turns this into one button.
        needsPermission: remembered.permission !== 'granted',
      };
    },

    async regrantTrackFolder(): Promise<TrackFolder | undefined> {
      const remembered = await rememberedFolder('track-folder');
      if (!remembered) return undefined;
      if (!(await regrantFolder(remembered.handle))) return undefined;

      return {
        directory: remembered.handle,
        displayName: remembered.handle.name,
        needsPermission: false,
      };
    },

    forgetTrackFolder(): Promise<void> {
      return forgetFolder('track-folder');
    },

    async listTracks(folder: TrackFolder): Promise<readonly TrackFileRef[]> {
      const found: TrackFileRef[] = [];

      for await (const [name, handle] of folder.directory.entries()) {
        if (handle.kind !== 'file' || !TRACK_PATTERN.test(name)) continue;
        const file = await (handle as FileSystemFileHandle).getFile();
        found.push({ name, sizeBytes: file.size, modifiedAtMs: file.lastModified });
      }

      // Newest first. A logger's folder grows without limit, and the day you want is nearly
      // always near the end of it — which matters for the span cache, not for correctness.
      found.sort((a, b) => b.modifiedAtMs - a.modifiedAtMs);
      return found;
    },

    async readTrack(folder: TrackFolder, name: string): Promise<string> {
      const handle = await folder.directory.getFileHandle(name);
      return (await handle.getFile()).text();
    },

    async restoreOutputFolder(): Promise<SaveDestination | undefined> {
      /*
       * Only when the grant survived.
       *
       * A remembered output folder that still needs permission is worse than none: the app would
       * report a destination it cannot write to, and the failure would arrive at the moment of
       * saving. Falling back to `copy-pending` means the question is asked before anything is
       * staged, which is the right time for it.
       */
      const remembered = await rememberedFolder('output-folder');
      if (!remembered || remembered.permission !== 'granted') return undefined;

      return prepareOutput(remembered.handle);
    },

    async read(ref: PhotoRef): Promise<Uint8Array> {
      const handle = handles.get(ref.locator);
      if (!handle) throw new Error(`no handle for ${ref.name}; open it again`);

      const file = await handle.getFile();
      // One bulk read. Never hand the Blob onwards — see the note in core's exiftool.ts;
      // per-syscall Blob slicing costs ~69x on a phone.
      return new Uint8Array(await file.arrayBuffer());
    },

    async writeAtomic(ref: PhotoRef, bytes: Uint8Array): Promise<WrittenFile> {
      if (destination.kind === 'copy-pending') {
        // Never silently fall back to overwriting the originals. That is the one outcome the
        // person who asked for copies would least want.
        throw new FileWriteError(
          ref,
          `choose a folder for the ${OUTPUT_FOLDER_NAME} copies before saving`,
        );
      }

      if (destination.kind === 'copy') {
        const target = destination;

        let output: FileSystemFileHandle;
        try {
          output = await target.directory.getFileHandle(ref.name, { create: true });
        } catch (error) {
          throw new FileWriteError(ref, describe(error), { cause: error });
        }

        await writeBytes(ref, output, bytes);

        return {
          location: `${target.label}/${ref.name}`,
          replacedOriginal: false,
          read: async () => new Uint8Array(await (await output.getFile()).arrayBuffer()),
        };
      }

      const handle = handles.get(ref.locator);
      if (!handle) throw new FileWriteError(ref, 'no file handle; open it again');

      if (!(await ensureWritable(handle))) {
        throw new FileWriteError(ref, 'permission to write was refused');
      }

      await writeBytes(ref, handle, bytes);

      // Restoring ref.modifiedAtMs belongs here, and cannot be done: the File System Access
      // API exposes no way to set a modification time. See MTIME_LIMITATION.
      return {
        location: ref.name,
        replacedOriginal: true,
        read: async () => new Uint8Array(await (await handle.getFile()).arrayBuffer()),
      };
    },
  };
}

/**
 * Create or reuse the output subfolder inside a chosen folder.
 *
 * Always a subfolder, so a copy can never overwrite an original — which is exactly what would
 * happen if somebody chose the photos' own folder. A folder already named `geotagged` is used
 * directly, because nesting one inside another would be daft; the label says which happened so
 * the interface can be honest about where files went.
 */
async function prepareOutput(chosen: FileSystemDirectoryHandle): Promise<SaveDestination> {
  /*
   * Case-insensitively, because folder names on Windows and macOS are.
   *
   * Picking a folder already called `Geotagged` produced `Geotagged/geotagged` — the app solemnly
   * creating a second copy of a folder that was already there, one capital letter apart.
   */
  if (chosen.name.toLowerCase() === OUTPUT_FOLDER_NAME.toLowerCase()) {
    return { kind: 'copy', directory: chosen, label: chosen.name };
  }

  const directory = await chosen.getDirectoryHandle(OUTPUT_FOLDER_NAME, { create: true });
  return { kind: 'copy', directory, label: `${chosen.name}/${OUTPUT_FOLDER_NAME}` };
}

/**
 * Write bytes to a handle atomically.
 *
 * Chromium's `createWritable` writes to a swap file and moves it into place on `close()`, so an
 * interrupted save never leaves a truncated image — the guarantee that matters most here.
 */
async function writeBytes(
  ref: PhotoRef,
  handle: FileSystemFileHandle,
  bytes: Uint8Array,
): Promise<void> {
  let writable: FileSystemWritableFileStream;
  try {
    writable = await handle.createWritable({ keepExistingData: false });
  } catch (error) {
    throw new FileWriteError(ref, describe(error), { cause: error });
  }

  try {
    // TS 5.7 made Uint8Array generic over its buffer, and lib.dom types this parameter as
    // ArrayBufferView<ArrayBuffer>. The bytes are always backed by a real ArrayBuffer, so this
    // is a typing artefact rather than a risk.
    await writable.write(bytes as unknown as ArrayBufferView<ArrayBuffer>);
    await writable.close();
  } catch (error) {
    // Abort so the swap file is discarded rather than left behind.
    try {
      await writable.abort();
    } catch {
      // Nothing useful to do; the target is no worse off either way.
    }
    throw new FileWriteError(ref, describe(error), { cause: error });
  }
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
