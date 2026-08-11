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
import { FileWriteError, sidecarName } from '@snapmapper/core';
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
  | {
    readonly kind: 'copy';
    readonly directory: FileSystemDirectoryHandle;
    readonly label: string;
    /**
     * The folder `directory` was derived from, kept so the output folder can be remade.
     *
     * A `FileSystemDirectoryHandle` does not survive its directory being deleted: every operation
     * on it then throws `NotFoundError`, and there is no way back to its parent through the API.
     * Somebody who tidies up by deleting `geotagged` between sessions would otherwise be left with
     * a destination that cannot be written to and cannot be repaired — twelve `NotFoundError`s at
     * the moment of saving, which is exactly what happened.
     *
     * Absent when the chosen folder *is* the output folder, because then there is no parent to
     * hold; that case recovers by asking instead. See `ensureDestination`.
     */
    readonly parent?: FileSystemDirectoryHandle;
  };

/**
 * Files a folder listing offers as photographs.
 *
 * Raw belongs here as well as JPEG, and leaving it out is how the sidecar feature would have
 * shipped inert: a raw photograph can only be *saved* from a folder — its sidecar has to be written
 * beside it, and the file picker gives no access to a parent — so a folder listing that hides ARW
 * hides the only route raw has. Verified against a real 24.9MB ILCE-6400 ARW.
 */
const PHOTO_PATTERN = /\.(jpe?g|arw)$/i;

export function isFileSystemAccessSupported(): boolean {
  return typeof globalThis.showDirectoryPicker === 'function'
    || typeof globalThis.showOpenFilePicker === 'function';
}

export function isFolderPickerSupported(): boolean {
  return typeof globalThis.showDirectoryPicker === 'function';
}

/** A `FolderHandle` that also carries the live directory handle, when there is one. */
export interface BrowserFolder extends FolderHandle {
  /** Absent for a set of individually picked files — there is no folder to re-scan. */
  readonly directory?: FileSystemDirectoryHandle;
}

export interface BrowserFileStore extends FileStore {
  /**
   * Everything in a folder, with a progress callback for a phone.
   *
   * Widens `FileStore.listFolder`, which takes no callback because nothing portable needs one.
   * A camera folder on Android is hundreds of round trips and the wait is long enough to look
   * like a failure without something on screen saying otherwise.
   */
  listFolder(
    folder: FolderHandle,
    onProgress?: (done: number, total: number) => void,
  ): Promise<PhotoRef[]>;

  /** The OS folder picker. The only way in — see `FolderChooser.tsx` for why. */
  pickFolder(): Promise<BrowserFolder | undefined>;

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
  /**
   * The first and last `bytes` of a track file, decoded as text.
   *
   * For reading the span of a file too big to want all of. A month of logging is tens of
   * megabytes and its span is in the first and last few kilobytes of it.
   */
  readTrackEnds(folder: TrackFolder, name: string, bytes: number): Promise<[string, string]>;

  /**
   * Names of the files an earlier session already wrote into the output folder.
   *
   * A directory enumeration and nothing more — no file is opened and no metadata is read, so this
   * costs the same whether the folder holds three copies or three thousand. That is what makes
   * "which of these have I already done" answerable before deciding what to actually read.
   *
   * Empty when saves are not going to a copy folder. In-place mode has no second file to consult:
   * the original *is* the copy, and its coordinates arrived with the ordinary metadata read.
   */
  listOutputNames(): Promise<ReadonlySet<string>>;

  /**
   * Check the output folder is still there, and remake it if it is not.
   *
   * Called immediately before saving, because a destination chosen last week may not exist today:
   * deleting `geotagged` is an ordinary bit of tidying, and a `FileSystemDirectoryHandle` does not
   * survive it. Every operation on the dead handle throws `NotFoundError`, so without this the
   * failure arrives once per photograph at the moment of writing — twelve identical errors, none
   * of them saying what to do, and no way out of it from inside the application.
   *
   * Recovery, in order of how little it disturbs anyone:
   *
   *   1. The folder is fine. Nothing happens.
   *   2. Remake it inside the folder it was derived from — no prompt, because the grant on that
   *      folder already covers creating things inside it.
   *   3. `fallbackParent`, which is how folder mode offers the photographs' own folder: it was
   *      read from moments ago, so it is certainly alive.
   *   4. Give up and return to `copy-pending`, which is a question the destination bar knows how
   *      to ask. Never a silent fall back to overwriting the originals.
   *
   * The result is stored, so the interface and the next save both see it.
   */
  ensureDestination(fallbackParent?: FileSystemDirectoryHandle): Promise<SaveDestination>;

  /**
   * The first bytes of a file in the output folder, by name.
   *
   * A head, like `readHead`, and for the same reason: only the header is needed to read GPS out of
   * a JPEG, and a phone should not pull seven megabytes off a card per photograph to find out where
   * it already is. `undefined` when there is no such file, which is the ordinary answer.
   */
  readOutputHead(name: string, maxBytes: number): Promise<Uint8Array | undefined>;

  /**
   * The XMP sidecar beside a photograph, whole, or `undefined` if there is none.
   *
   * Whole rather than a head because a sidecar is a few hundred bytes of XML. Needs the
   * photograph's folder, so it answers `undefined` for individually picked files — the same
   * limitation that stops `writeSidecar` working there.
   */
  readSidecar(ref: PhotoRef): Promise<Uint8Array | undefined>;
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

  /*
   * The `File` objects already obtained while listing, by locator.
   *
   * `listFolder` calls `getFile()` on every entry to learn its size and date, and a thumbnail read
   * then called it a second time. On a phone that is a wasted round trip per photograph —
   * measured at about 31 ms each while listing — and there are thousands of them. A `File` is a
   * lightweight handle, so keeping them costs nothing next to what re-fetching them costs.
   *
   * Held rather than trusted: `getFile()` is still there for anything not listed, and a stale
   * `File` on a card that has been swapped out fails the same way a stale handle does.
   */
  const files = new Map<string, File>();
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
    files.set(locator, file);

    return {
      folder,
      name: handle.name,
      sizeBytes: file.size,
      modifiedAtMs: file.lastModified,
      locator,
    };
  }

  /**
   * Bytes from `start` to `end`, using the `File` captured while listing where there is one.
   *
   * `Blob.slice` is a view, so only these bytes leave the card — and one `arrayBuffer()` on the
   * slice, never on the Blob itself, which is the ~69x penalty recorded in core's `exiftool.ts`.
   */
  async function readSlice(ref: PhotoRef, start: number, end: number): Promise<Uint8Array> {
    let file = files.get(ref.locator);
    if (!file) {
      const handle = handles.get(ref.locator);
      if (!handle) throw new Error(`no handle for ${ref.name}; open it again`);
      file = await handle.getFile();
      files.set(ref.locator, file);
    }

    return new Uint8Array(await file.slice(start, end).arrayBuffer());
  }

  return {
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

    /**
     * Every photograph in a folder, with its size and date. No metadata is read.
     *
     * **Enumerate first, then fetch in overlapping batches.** This used to `await getFile()` inside
     * the `entries()` iteration, which serialises two round trips per file and stalls the iterator
     * on each one. On a desktop that is invisible. On Android it is not: a whole camera folder
     * reported as *"nothing seemed to happen"* — 322 files, each waiting for the one before, with
     * no progress shown. Measured even on OPFS, where a round trip is as cheap as it ever gets:
     * **81 ms serial against 14 ms in batches of 32, a 5.8x difference**, and SAF round trips are
     * far dearer than OPFS ones so the real gap is wider.
     *
     * Batches of 32 rather than all at once: unbounded parallelism on a phone is a good way to
     * find out what a file-provider's limits are. 32 measured the same as 64.
     */
    async listFolder(
      folder: FolderHandle,
      onProgress?: (done: number, total: number) => void,
    ): Promise<PhotoRef[]> {
      const directory = (folder as BrowserFolder).directory;
      if (!directory) return [];

      const found: [string, FileSystemFileHandle][] = [];
      for await (const [name, handle] of directory.entries()) {
        if (handle.kind !== 'file' || !PHOTO_PATTERN.test(name)) continue;
        found.push([name, handle as FileSystemFileHandle]);
      }

      const refs: PhotoRef[] = [];
      const BATCH = 32;
      for (let at = 0; at < found.length; at += BATCH) {
        const chunk = found.slice(at, at + BATCH);
        refs.push(...await Promise.all(chunk.map(
          ([name, handle]) => refFromHandle(handle, folder as BrowserFolder, `${folder.id}/${name}`),
        )));
        onProgress?.(refs.length, found.length);
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

    async readTrackEnds(
      folder: TrackFolder,
      name: string,
      bytes: number,
    ): Promise<[string, string]> {
      const handle = await folder.directory.getFileHandle(name);
      const file = await handle.getFile();

      if (file.size <= bytes * 2) {
        const whole = await file.text();
        return [whole, ''];
      }

      /*
       * `Blob.slice` is a view, not a copy — only the sliced bytes are read from disk. This is the
       * difference between touching 256KB and 30MB for a file the logger appends to all month.
       *
       * A slice will usually cut through the middle of a tag at both joins. That is harmless here:
       * `gpxSpan` matches whole `<time>…</time>` elements, so a severed one simply does not match.
       */
      return Promise.all([
        file.slice(0, bytes).text(),
        file.slice(file.size - bytes).text(),
      ]);
    },

    async read(ref: PhotoRef): Promise<Uint8Array> {
      const handle = handles.get(ref.locator);
      if (!handle) throw new Error(`no handle for ${ref.name}; open it again`);

      const file = await handle.getFile();
      // One bulk read. Never hand the Blob onwards — see the note in core's exiftool.ts;
      // per-syscall Blob slicing costs ~69x on a phone.
      return new Uint8Array(await file.arrayBuffer());
    },

    async readHead(ref: PhotoRef, maxBytes: number): Promise<Uint8Array> {
      return readSlice(ref, 0, maxBytes);
    },

    /**
     * An exact range of a file.
     *
     * For fetching a thumbnail once its offsets are known, rather than reading a hundred kilobytes
     * hoping to have covered it. On a phone that is the whole cost — measured at 128 to 148 ms per
     * photograph for a 128KB head, against 0.01 ms to parse it.
     */
    async readRange(ref: PhotoRef, start: number, end: number): Promise<Uint8Array> {
      return readSlice(ref, start, end);
    },

    /**
     * The sidecar goes next to the photograph, whatever the save destination is.
     *
     * Raw files are never copied and never written to, so there is nothing in the `geotagged`
     * folder for a sidecar to sit beside — and a sidecar away from its raw file is one no reader
     * will ever look for.
     *
     * Needs the photograph's *folder*, which only exists when a folder was opened.
     * `showOpenFilePicker` gives no access to a file's parent by design, so in that mode this
     * refuses with an explanation rather than quietly putting the file somewhere useless.
     */
    async writeSidecar(ref: PhotoRef, name: string, bytes: Uint8Array): Promise<WrittenFile> {
      const directory = (ref.folder as Partial<BrowserFolder>).directory;
      if (!directory) {
        throw new FileWriteError(
          ref,
          'a sidecar has to be written next to the raw file, and picking individual files gives '
          + 'no access to their folder. Use "Open whole folder…" to geotag raw photographs.',
        );
      }

      let output: FileSystemFileHandle;
      try {
        output = await directory.getFileHandle(name, { create: true });
      } catch (error) {
        throw new FileWriteError(ref, describe(error), { cause: error });
      }

      await writeBytes(ref, output, bytes);

      return {
        location: `${ref.folder.displayName}/${name}`,
        // The raw file itself was not touched, which is the entire point of a sidecar.
        replacedOriginal: false,
        read: async () => new Uint8Array(await (await output.getFile()).arrayBuffer()),
      };
    },

    async listOutputNames(): Promise<ReadonlySet<string>> {
      const names = new Set<string>();
      // In-place and copy-pending both have nothing to list: no second file exists yet.
      if (destination.kind !== 'copy') return names;

      try {
        for await (const [name, handle] of destination.directory.entries()) {
          if (handle.kind === 'file') names.add(name);
        }
      } catch {
        /*
         * The folder has been deleted since it was chosen. That is a real problem and it is
         * reported at *save* time, where it can be repaired — see `ensureDestination`. Here the
         * honest answer is simply that no earlier copies were found, which is true.
         *
         * It used to propagate, and the result was an alarming red banner about an operation
         * nobody had asked for, at the moment of opening a card.
         */
      }
      return names;
    },

    async ensureDestination(
      fallbackParent?: FileSystemDirectoryHandle,
    ): Promise<SaveDestination> {
      if (destination.kind !== 'copy') return destination;

      /*
       * Enumerating is the probe, and it has to be an operation that touches the directory itself.
       * `getFileHandle` for some name throws `NotFoundError` whether the folder is missing or
       * merely does not contain that file, so it cannot tell the two apart. Asking for the first
       * entry costs nothing on a folder that exists — the iterator is lazy — and throws on one
       * that does not.
       */
      try {
        await destination.directory.entries().next();
        return destination;
      } catch {
        // Gone. Fall through and try to put it back.
      }

      for (const parent of [destination.parent, fallbackParent]) {
        if (!parent) continue;
        try {
          const remade = await prepareOutput(parent);
          destination = remade;
          return remade;
        } catch {
          // That folder has been deleted too, or the grant has lapsed. Try the next.
        }
      }

      destination = { kind: 'copy-pending' };
      return destination;
    },

    async readOutputHead(name: string, maxBytes: number): Promise<Uint8Array | undefined> {
      if (destination.kind !== 'copy') return undefined;

      try {
        const handle = await destination.directory.getFileHandle(name);
        const file = await handle.getFile();
        // `Blob.slice` is a view, so only these bytes leave the disk — and one `arrayBuffer()`
        // on the slice, never on the Blob, for the reason in core's exiftool.ts.
        return new Uint8Array(await file.slice(0, maxBytes).arrayBuffer());
      } catch {
        // Gone between the listing and the read, or never there. Not an error worth raising:
        // the answer to "is there a prior copy of this" is simply no.
        return undefined;
      }
    },

    async readSidecar(ref: PhotoRef): Promise<Uint8Array | undefined> {
      const directory = (ref.folder as Partial<BrowserFolder>).directory;
      if (!directory) return undefined;

      try {
        const handle = await directory.getFileHandle(sidecarName(ref.name));
        return new Uint8Array(await (await handle.getFile()).arrayBuffer());
      } catch {
        return undefined;
      }
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
  return { kind: 'copy', directory, label: `${chosen.name}/${OUTPUT_FOLDER_NAME}`, parent: chosen };
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
