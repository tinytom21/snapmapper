/**
 * File System Access API surface TypeScript's DOM library still does not describe.
 *
 * `showDirectoryPicker` and the async-iteration helpers on a directory handle are
 * shipped in Chromium and specified, but absent from `lib.dom`. Declared here rather
 * than reached for with `any`, so the shape of what we depend on stays written down —
 * this is the API the whole desktop file story rests on.
 */

/**
 * Yields the concrete handle union rather than the `FileSystemHandle` base, so that
 * checking `kind === 'file'` narrows to `FileSystemFileHandle` as it should. The base
 * type's `kind` is the wide `FileSystemHandleKind`, which narrows nothing.
 */
type FileSystemChildHandle = FileSystemFileHandle | FileSystemDirectoryHandle;

interface FileSystemDirectoryHandle {
  entries(): AsyncIterableIterator<[string, FileSystemChildHandle]>;
  keys(): AsyncIterableIterator<string>;
  values(): AsyncIterableIterator<FileSystemChildHandle>;
}

/**
 * Permission methods, absent from `lib.dom`.
 *
 * These matter because the two pickers grant different things. A directory handle can be
 * asked for `readwrite` up front, so one prompt covers everything inside it. A handle from
 * `showOpenFilePicker` is **read-only** — `FilePickerOptions` has no `mode` — so write access
 * has to be requested afterwards, per file.
 */
interface FileSystemHandlePermissionDescriptor {
  mode?: 'read' | 'readwrite';
}

interface FileSystemHandle {
  queryPermission(
    descriptor?: FileSystemHandlePermissionDescriptor,
  ): Promise<'granted' | 'denied' | 'prompt'>;
  requestPermission(
    descriptor?: FileSystemHandlePermissionDescriptor,
  ): Promise<'granted' | 'denied' | 'prompt'>;
}

interface FilePickerAcceptType {
  description?: string;
  accept: Record<string, string | string[]>;
}

interface OpenFilePickerOptions {
  multiple?: boolean;
  excludeAcceptAllOption?: boolean;
  types?: FilePickerAcceptType[];
  id?: string;
  startIn?: FileSystemHandle | 'desktop' | 'documents' | 'downloads' | 'pictures' | 'videos' | 'music';
}

declare function showOpenFilePicker(
  options?: OpenFilePickerOptions,
): Promise<FileSystemFileHandle[]>;

declare namespace globalThis {
  // eslint-disable-next-line no-var
  var showOpenFilePicker: ((options?: OpenFilePickerOptions) => Promise<FileSystemFileHandle[]>)
    | undefined;
}

interface DirectoryPickerOptions {
  /** `readwrite` asks for write permission up front, rather than at save time. */
  mode?: 'read' | 'readwrite';
  /** Lets the browser remember the last folder per purpose. */
  id?: string;
  startIn?: FileSystemHandle | 'desktop' | 'documents' | 'downloads' | 'pictures' | 'videos' | 'music';
}

declare function showDirectoryPicker(
  options?: DirectoryPickerOptions,
): Promise<FileSystemDirectoryHandle>;

interface Window {
  showDirectoryPicker?: typeof showDirectoryPicker;
}

declare namespace globalThis {
  // eslint-disable-next-line no-var
  var showDirectoryPicker: typeof globalThis extends { showDirectoryPicker: infer T }
    ? T
    : ((options?: DirectoryPickerOptions) => Promise<FileSystemDirectoryHandle>) | undefined;
}
