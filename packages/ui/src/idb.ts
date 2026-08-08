/**
 * The one place the app's IndexedDB database is opened.
 *
 * There are two things worth keeping across visits — the remembered folders and the staged edits —
 * and they were briefly opened as two independent databases-by-accident: same name, two `VERSION`
 * constants, two `onupgradeneeded` handlers each creating only its own store.
 *
 * That does not merely risk drifting. It breaks outright, in a way that is hard to read from the
 * symptom: whichever module opens first wins, and a module that then asks for a *lower* version
 * gets a `VersionError`, while one that asks for the same version but expects a store the first
 * did not create gets an exception at transaction time rather than at open time — so the failure
 * surfaces somewhere unrelated to the cause.
 *
 * So the schema lives here, both stores are created together, and nothing else calls
 * `indexedDB.open`.
 */

/** Bump when a store is added. Both stores are created by the upgrade regardless of who opens. */
const DATABASE = 'snapmapper';
const VERSION = 2;

/** Directory handles, which survive only through structured clone. See `handle-store.ts`. */
export const HANDLE_STORE = 'handles';
/** Staged edits, so a killed tab does not take them. See `session-backup.ts`. */
export const SESSION_STORE = 'sessions';

const STORES = [HANDLE_STORE, SESSION_STORE] as const;

export function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, VERSION);

    request.onupgradeneeded = () => {
      const database = request.result;
      // Every store, every time. An upgrade from any earlier version must arrive at the same
      // schema, and `contains` makes that idempotent.
      for (const store of STORES) {
        if (!database.objectStoreNames.contains(store)) database.createObjectStore(store);
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('could not open the database'));
    // Another tab holding an older version open blocks the upgrade indefinitely. Rejecting lets
    // callers fall back to their without-storage behaviour rather than hanging forever.
    request.onblocked = () => reject(new Error('another tab is holding the database open'));
  });
}

/** Run one request against one store, closing the connection afterwards either way. */
export async function transact<T>(
  storeName: string,
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const database = await openDatabase();
  try {
    return await new Promise<T>((resolve, reject) => {
      const request = run(database.transaction(storeName, mode).objectStore(storeName));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('the database request failed'));
    });
  } finally {
    database.close();
  }
}

/** Whether anything can be remembered here at all. False in a browser without IndexedDB. */
export function canPersist(): boolean {
  return typeof indexedDB !== 'undefined';
}
