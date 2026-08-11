import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import {
  createBrowserFileStore,
  type BrowserFolder,
} from '../src/browser-file-store.ts';

/**
 * The picker cannot be driven from a test — it is an operating system dialog — but everything
 * around it can be, and that is where the risk is. The duplicate-name guard in particular is a
 * correctness safeguard, not a nicety: photos are keyed by filename, so two files sharing a
 * name would be treated as one, and an edit meant for one could be written into the other.
 */

const originalOpenPicker = globalThis.showOpenFilePicker;
const originalDirectoryPicker = (globalThis as Record<string, unknown>).showDirectoryPicker;

afterEach(() => {
  globalThis.showOpenFilePicker = originalOpenPicker;
  (globalThis as Record<string, unknown>).showDirectoryPicker = originalDirectoryPicker;
});

interface FakeHandleOptions {
  writable?: boolean;
  size?: number;
  lastModified?: number;
}

function fakeFileHandle(name: string, options: FakeHandleOptions = {}) {
  let getFileCalls = 0;
  let permissionRequests = 0;

  const handle = {
    kind: 'file' as const,
    name,
    async getFile() {
      getFileCalls += 1;
      return {
        size: options.size ?? 1234,
        lastModified: options.lastModified ?? 1_700_000_000_000,
        async arrayBuffer() {
          return new Uint8Array([0xff, 0xd8, 0xff, 0xd9]).buffer;
        },
      };
    },
    async queryPermission() {
      permissionRequests += 1;
      return options.writable === false ? 'prompt' : 'granted';
    },
    async requestPermission() {
      permissionRequests += 1;
      return options.writable === false ? 'denied' : 'granted';
    },
    get getFileCalls() {
      return getFileCalls;
    },
    /** How many times write permission was asked about. Zero is the goal in copy mode. */
    get permissionRequests() {
      return permissionRequests;
    },
  };

  return handle as unknown as FileSystemFileHandle
    & { getFileCalls: number; permissionRequests: number };
}

function stubFilePicker(handles: readonly unknown[]) {
  globalThis.showOpenFilePicker = (async () => handles) as typeof showOpenFilePicker;
}

function fakeDirectory(names: readonly string[]) {
  const handles = names.map((name) => fakeFileHandle(name));
  return {
    handles,
    directory: {
      name: '100MSDCF',
      kind: 'directory' as const,
      async *entries() {
        for (const handle of handles) yield [handle.name, handle];
      },
    } as unknown as FileSystemDirectoryHandle,
  };
}

describe('listFolder', () => {
  it('lists JPEGs in numeric filename order', async () => {
    const { directory } = fakeDirectory(['DSC00121.JPG', 'DSC00119.JPG', 'x.txt', 'DSC00120.JPG']);
    const folder: BrowserFolder = { id: 'f', displayName: '100MSDCF', directory };

    const refs = await createBrowserFileStore().listFolder(folder);

    assert.deepEqual(
      refs.map((ref) => ref.name),
      ['DSC00119.JPG', 'DSC00120.JPG', 'DSC00121.JPG'],
    );
  });

  it('returns nothing for a picked selection rather than throwing', async () => {
    // A picked set has no folder to enumerate, and asking is not a programming error.
    const folder: BrowserFolder = { id: 'picked', displayName: 'Selected photos' };
    assert.deepEqual(await createBrowserFileStore().listFolder(folder), []);
  });
});

/**
 * A directory handle that records what was created inside it.
 *
 * `pickOutputFolder` cannot be driven — it opens an operating-system dialog — but the part that
 * decides *where* copies land is ours, and it got this wrong in front of the user.
 */
function fakeOutputDirectory(name: string) {
  const created: string[] = [];
  const handle = {
    kind: 'directory' as const,
    name,
    async getDirectoryHandle(child: string) {
      created.push(child);
      return fakeOutputDirectory(child).handle;
    },
    async queryPermission() { return 'granted'; },
    async requestPermission() { return 'granted'; },
  };
  return { handle, created };
}

describe('choosing where copies go', () => {
  /*
   * Driven through `outputFolderWithin`, which is the only route now: copies go into the folder
   * the photographs came from, and that folder was granted when it was opened. There is no
   * separate "choose a destination" dialog left to drive, which is the point of the change.
   */
  const pick = async (folderName: string) => {
    const chosen = fakeOutputDirectory(folderName);
    const store = createBrowserFileStore();
    const destination = await store.outputFolderWithin({
      id: folderName,
      displayName: folderName,
      directory: chosen.handle as unknown as FileSystemDirectoryHandle,
    });
    return { destination, created: chosen.created };
  };

  it('creates a geotagged folder inside the folder you pick', () => {
    return pick('100MSDCF').then(({ destination, created }) => {
      assert.deepEqual(created, ['geotagged']);
      assert.equal(destination?.kind, 'copy');
      assert.equal(destination?.kind === 'copy' && destination.label, '100MSDCF/geotagged');
    });
  });

  it('uses a folder that is already the geotagged one, whatever its capitalisation', async () => {
    // Reported from the app: picking a folder named `Geotagged` produced `Geotagged/geotagged` —
    // a second copy of a folder that was already there, one capital letter apart. Folder names on
    // Windows and macOS are case-insensitive.
    for (const name of ['geotagged', 'Geotagged', 'GEOTAGGED']) {
      const { destination, created } = await pick(name);
      assert.deepEqual(created, [], `${name} should not have had a folder created inside it`);
      assert.equal(destination?.kind === 'copy' && destination.label, name);
    }
  });
});

/**
 * A folder that can be deleted out from under its handle, as a real one can be.
 *
 * Every operation on a `FileSystemDirectoryHandle` whose directory has gone throws
 * `NotFoundError`, and there is no way back to the parent through the API — which is what turned
 * "I tidied up and deleted geotagged" into twelve identical write failures with no way out.
 */
function deletableDirectory(name: string) {
  let alive = true;
  const created: string[] = [];
  const children: { remove: () => void }[] = [];

  const handle = {
    kind: 'directory' as const,
    name,
    async *entries(): AsyncGenerator<[string, unknown]> {
      if (!alive) throw new DOMException('gone', 'NotFoundError');
      // An empty folder that exists must not look like one that does not.
    },
    async getDirectoryHandle(child: string) {
      if (!alive) throw new DOMException('gone', 'NotFoundError');
      created.push(child);
      const made = deletableDirectory(child);
      children.push(made);
      return made.handle;
    },
    async queryPermission() { return 'granted'; },
    async requestPermission() { return 'granted'; },
  } as unknown as FileSystemDirectoryHandle;

  // Deleting a folder deletes what is inside it. Without cascading, a test that removes the
  // parent leaves the child handle answering happily, which is not a filesystem anyone has.
  const remove = () => {
    alive = false;
    for (const child of children) child.remove();
  };

  return { handle, created, remove, children };
}

describe('an output folder that has been deleted', () => {
  async function chooseInto(parentName: string) {
    const parent = deletableDirectory(parentName);
    const store = createBrowserFileStore();
    const chosen = await store.outputFolderWithin({
      id: parentName, displayName: parentName, directory: parent.handle,
    });
    if (chosen) store.setDestination(chosen);
    return { store, parent };
  }

  it('leaves a healthy destination completely alone', async () => {
    const { store } = await chooseInto('100MSDCF');
    const before = store.getDestination();

    assert.equal((await store.ensureDestination()).kind, 'copy');
    assert.equal(store.getDestination(), before);
  });

  it('remakes it inside the folder it was chosen in, with no prompt', async () => {
    // The common case, and it should be invisible: the grant on the chosen folder already covers
    // creating things inside it, so nothing needs to be asked.
    const { store, parent } = await chooseInto('100MSDCF');
    assert.deepEqual(parent.created, ['geotagged']);

    // Delete the geotagged folder, as somebody tidying up would.
    parent.children[0]?.remove();

    const repaired = await store.ensureDestination();
    assert.equal(repaired.kind, 'copy');
    assert.deepEqual(parent.created, ['geotagged', 'geotagged']);
  });

  it('falls back to the folder the photographs came from', async () => {
    // Folder mode's escape hatch: that folder was read from moments ago, so it is certainly alive.
    const { store, parent } = await chooseInto('Pictures');
    parent.remove();

    const photos = deletableDirectory('100MSDCF');
    const repaired = await store.ensureDestination(photos.handle);

    assert.equal(repaired.kind, 'copy');
    assert.deepEqual(photos.created, ['geotagged']);
  });

  it('asks again rather than quietly overwriting the originals', async () => {
    /*
     * The case the user hit: a folder *called* `Geotagged` was chosen directly, so there is no
     * parent to remake it in, and the files were picked so there is no photograph folder either.
     * Returning to `copy-pending` is what puts the question back in the destination bar; falling
     * back to writing over the originals would be the opposite of what was asked for.
     */
    const chosen = deletableDirectory('Geotagged');
    const store = createBrowserFileStore();
    const picked = await store.outputFolderWithin({
      id: 'Geotagged', displayName: 'Geotagged', directory: chosen.handle,
    });
    if (picked) store.setDestination(picked);
    assert.deepEqual(chosen.created, [], 'a folder already named geotagged is used directly');

    chosen.remove();

    assert.equal((await store.ensureDestination()).kind, 'copy-pending');
    assert.equal(store.getDestination().kind, 'copy-pending');
  });

  it('reports no earlier copies rather than throwing, when the folder is gone', async () => {
    // At load time this is not the moment to raise it — and it used to produce an alarming red
    // banner about an operation nobody had asked for, over a card that had just been opened.
    const chosen = deletableDirectory('Geotagged');
    const store = createBrowserFileStore();
    const picked = await store.outputFolderWithin({
      id: 'Geotagged', displayName: 'Geotagged', directory: chosen.handle,
    });
    if (picked) store.setDestination(picked);
    chosen.remove();

    assert.equal((await store.listOutputNames()).size, 0);
  });
});
