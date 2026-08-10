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
 * Above this many JPEGs, a folder is not opened without asking.
 *
 * Reading metadata is roughly 0.5 s per photo on a desktop and 3 s on a phone, so a camera
 * card's worth would run for many minutes with no way to stop it. The picker is the right tool
 * at that size, and the UI says so rather than silently starting.
 */
export const LARGE_FOLDER_THRESHOLD = 200;

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
  pickPhotos(options?: { add?: PhotoRef[]; raw?: boolean }): Promise<PickedPhotos | undefined>;

  /**
   * Attach a folder to already-picked files, so their sidecars have somewhere to go.
   *
   * Raw picked through the file picker has no parent — `showOpenFilePicker` gives none by design —
   * and a sidecar has to be written beside its raw file or no reader will ever look for it. So the
   * folder is asked for as a *second, separately-gestured* step and grafted on here.
   *
   * It cannot be chained onto the pick: a picker only opens while a user gesture is in flight, and
   * the first dialog spends it. See the note in CLAUDE.md — this failed with "Must be handling a
   * user gesture to show a file picker" on desktop and phone alike.
   *
   * **Every file is checked against the folder by name**, and any that is not in it is reported
   * rather than adopted. Choosing the wrong folder is an easy mistake and a silent one: the
   * sidecars would be written somewhere plausible, next to nothing, and Lightroom would show no
   * change with no error anywhere.
   */
  adoptFolder(refs: readonly PhotoRef[]): Promise<{
    refs: PhotoRef[];
    folder: BrowserFolder;
    missing: string[];
  } | undefined>;
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
  /**
   * The first and last `bytes` of a track file, decoded as text.
   *
   * For reading the span of a file too big to want all of. A month of logging is tens of
   * megabytes and its span is in the first and last few kilobytes of it.
   */
  readTrackEnds(folder: TrackFolder, name: string, bytes: number): Promise<[string, string]>;

  /** The remembered output folder, so copies are asked about once ever rather than once a visit. */
  restoreOutputFolder(): Promise<SaveDestination | undefined>;

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
    async adoptFolder(refs: readonly PhotoRef[]) {
      if (!isFolderPickerSupported()) {
        throw new Error('This browser cannot open a folder. Use Chrome or Edge.');
      }

      let directory: FileSystemDirectoryHandle;
      try {
        directory = await globalThis.showDirectoryPicker!({ id: 'photos', mode: 'readwrite' });
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') return undefined;
        throw error;
      }

      /*
       * Verified by name against what is actually in the folder.
       *
       * The whole point of this step is that sidecars land beside their raw files. A folder that
       * does not contain them would still *work* — files would be written, no error raised — and
       * the photographs would simply never gain a location as far as any reader is concerned.
       * Silent, and discovered weeks later.
       */
      const present = new Set<string>();
      for await (const [name, handle] of directory.entries()) {
        if (handle.kind === 'file') present.add(name);
      }

      const folder: BrowserFolder = {
        id: directory.name,
        displayName: directory.name,
        directory,
      };

      const missing = refs.filter((ref) => !present.has(ref.name)).map((ref) => ref.name);

      // The handle map is keyed by locator, and the locators do not change — the files are the same
      // files, they have simply acquired a parent. Only the folder is replaced.
      return {
        refs: refs.map((ref) => ({ ...ref, folder })),
        folder,
        missing,
      };
    },

    async pickPhotos(options = {}): Promise<PickedPhotos | undefined> {
      if (!isFilePickerSupported()) {
        throw new Error('This browser has no file picker. Use Chrome or Edge.');
      }

      let picked: FileSystemFileHandle[];
      try {
        picked = await globalThis.showOpenFilePicker!({
          multiple: true,
          id: 'photos',
          /*
           * One format at a time, never both.
           *
           * A card holds a RAW+JPEG pair for every frame, so a picker offering both shows each
           * photograph twice and you have to read extensions to tell which is which. People work
           * in one format per session; the choice belongs on the button that opens the dialog, not
           * inside it.
           *
           * `excludeAcceptAllOption` is what makes that real rather than a hint: without it the
           * dialog still shows an "All files" entry and the other format comes back through it.
           * `describePicked` stays as a backstop for whatever gets through anyway.
           */
          types: [options.raw
            ? { description: 'Sony raw photos', accept: { 'image/x-sony-arw': ['.arw'] } }
            : { description: 'JPEG photos', accept: { 'image/jpeg': ['.jpg', '.jpeg'] } }],
          excludeAcceptAllOption: true,
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
        if (handle.kind === 'file' && PHOTO_PATTERN.test(name)) count += 1;
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
        if (handle.kind !== 'file' || !PHOTO_PATTERN.test(name)) continue;
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

      /*
       * Confirm the folder is still on disk before reporting it as the destination.
       *
       * `prepareOutput` reads the name off the handle and, for a folder already called
       * `geotagged`, returns without touching the disk at all — so a folder deleted since it was
       * chosen restores as a perfectly convincing destination, and only fails at the moment of
       * saving. Asked here, the answer is simply that there is no remembered folder, and the
       * destination bar asks for one.
       */
      try {
        await remembered.handle.entries().next();
      } catch {
        await forgetFolder('output-folder');
        return undefined;
      }

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

    async readHead(ref: PhotoRef, maxBytes: number): Promise<Uint8Array> {
      const handle = handles.get(ref.locator);
      if (!handle) throw new Error(`no handle for ${ref.name}; open it again`);

      const file = await handle.getFile();
      // `Blob.slice` is a view: only these bytes are read from the card. One `arrayBuffer()` on
      // the slice, never the Blob itself — see the note in core's exiftool.ts about per-syscall
      // slicing, which is a ~69x penalty on a phone.
      return new Uint8Array(await file.slice(0, maxBytes).arrayBuffer());
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

      /*
       * Forgotten as well as abandoned. A remembered handle to a folder that no longer exists is
       * restored happily on the next launch — `prepareOutput` reads the *name* off the handle and
       * never touches the disk — so the destination bar would go on naming a folder that is not
       * there until the next save failed. Forgetting it means the question is asked once.
       */
      await forgetFolder('output-folder');
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
