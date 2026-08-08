/**
 * Remembering folders across visits.
 *
 * The track folder never changes — a logger writes into one place forever — and being asked for it
 * on every visit is a question with a permanent answer. Same for where copies go when the photos
 * were picked as individual files.
 *
 * **IndexedDB, not `localStorage`.** A `FileSystemDirectoryHandle` is not a string and has no
 * useful `toString`; it survives only through the structured clone algorithm, which IndexedDB uses
 * and `localStorage` does not. There is no way to do this with a JSON blob.
 *
 * Hand-rolled rather than a wrapper library. This needs `get`, `set` and `delete` on one store,
 * which is the sixty lines below — against a dependency in a bundle that is already the thing most
 * worth shrinking.
 *
 * ## Permission does not survive with the handle
 *
 * A restored handle is real but **not necessarily usable**: Chrome drops the grant when the tab
 * closes, so it comes back needing `requestPermission`, which only works inside a user gesture.
 * That shapes the interface — `remembered()` hands back the handle with its permission state, and
 * asking is a separate call the UI makes from a button. Requesting on load would throw, and
 * silently treating "needs asking" as "gone" would make the app forget a folder it has.
 *
 * Installed PWAs may keep the grant permanently, which is the case this is nicest in: nothing is
 * asked at all.
 */

const DATABASE = 'snapmapper';
const STORE = 'handles';
const VERSION = 1;

/** What a remembered folder is for. One row each. */
export type HandleSlot = 'track-folder' | 'output-folder';

export type PermissionState = 'granted' | 'prompt' | 'denied';

export interface RememberedFolder {
  readonly handle: FileSystemDirectoryHandle;
  /** `granted` means usable now; `prompt` means one click away. */
  readonly permission: PermissionState;
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('could not open the database'));
  });
}

async function transact<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const database = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const request = run(database.transaction(STORE, mode).objectStore(STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('the database request failed'));
    });
  } finally {
    database.close();
  }
}

/**
 * Store a folder for next time, or quietly fail to.
 *
 * Never throws, and that is the important part: this is a convenience wrapped around picking a
 * folder, and the *picking* must succeed whether or not it can be remembered. Private browsing
 * blocks IndexedDB outright, and a browser with no IndexedDB at all should lose the shortcut, not
 * the feature. The symptom of failure is being asked again next time, which is exactly what
 * happened before any of this existed.
 */
export async function rememberFolder(
  slot: HandleSlot,
  handle: FileSystemDirectoryHandle,
): Promise<void> {
  try {
    await transact('readwrite', (store) => store.put(handle, slot));
  } catch {
    // See above. Nothing here is worth interrupting a pick for.
  }
}

export async function forgetFolder(slot: HandleSlot): Promise<void> {
  try {
    await transact('readwrite', (store) => store.delete(slot));
  } catch {
    // Forgetting something that was never stored is not a failure worth reporting.
  }
}

/**
 * The folder remembered for a slot, if any, with whether it can be used without asking.
 *
 * Returns `null` rather than throwing on every failure path — private browsing, a blocked
 * database, a handle stored by a version that no longer makes sense. Not remembering a folder is a
 * mild inconvenience; an exception on start-up is a broken app.
 */
export async function rememberedFolder(slot: HandleSlot): Promise<RememberedFolder | null> {
  try {
    const handle = await transact<unknown>('readonly', (store) => store.get(slot));
    if (!handle || typeof (handle as FileSystemDirectoryHandle).queryPermission !== 'function') {
      return null;
    }

    const directory = handle as FileSystemDirectoryHandle;
    const permission = await directory.queryPermission({ mode: 'readwrite' });
    return { handle: directory, permission: permission as PermissionState };
  } catch {
    return null;
  }
}

/**
 * Ask for a remembered folder back. **Must be called from a user gesture.**
 *
 * Chrome refuses `requestPermission` outside one, and the failure is an exception rather than a
 * `denied` — which is why this is never called on load.
 */
export async function regrantFolder(handle: FileSystemDirectoryHandle): Promise<boolean> {
  try {
    if (await handle.queryPermission({ mode: 'readwrite' }) === 'granted') return true;
    return await handle.requestPermission({ mode: 'readwrite' }) === 'granted';
  } catch {
    return false;
  }
}

/** Whether folders can be remembered at all here. False in a browser without IndexedDB. */
export function canRememberFolders(): boolean {
  return typeof indexedDB !== 'undefined';
}
