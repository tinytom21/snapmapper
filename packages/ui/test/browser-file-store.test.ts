import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import {
  LARGE_FOLDER_THRESHOLD,
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

describe('pickPhotos', () => {
  it('returns a ref per picked file, sorted by name', async () => {
    stubFilePicker([
      fakeFileHandle('DSC00120.JPG'),
      fakeFileHandle('DSC00119.JPG'),
      fakeFileHandle('DSC00121.JPG'),
    ]);

    const picked = await createBrowserFileStore().pickPhotos();

    assert.deepEqual(
      picked?.refs.map((ref) => ref.name),
      ['DSC00119.JPG', 'DSC00120.JPG', 'DSC00121.JPG'],
    );
    assert.deepEqual(picked?.skippedDuplicates, []);
    assert.deepEqual(picked?.readOnly, []);
  });

  it('gives each file a distinct locator, even when names repeat', async () => {
    // Locators key the handle map. Two files called the same thing must not collide there, or
    // a write would go to whichever handle was registered last.
    stubFilePicker([fakeFileHandle('a.jpg'), fakeFileHandle('b.jpg')]);

    const picked = await createBrowserFileStore().pickPhotos();
    const locators = picked?.refs.map((ref) => ref.locator) ?? [];

    assert.equal(new Set(locators).size, locators.length);
  });

  it('refuses a second file with a name already open, and says which', async () => {
    stubFilePicker([fakeFileHandle('DSC00119.JPG'), fakeFileHandle('DSC00119.JPG')]);

    const picked = await createBrowserFileStore().pickPhotos();

    assert.equal(picked?.refs.length, 1);
    assert.deepEqual(picked?.skippedDuplicates, ['DSC00119.JPG']);
  });

  it('reports files it could not get write access to, when saving in place', async () => {
    stubFilePicker([
      fakeFileHandle('ok.jpg'),
      fakeFileHandle('locked.jpg', { writable: false }),
    ]);

    const store = createBrowserFileStore();
    store.setDestination({ kind: 'in-place' });
    const picked = await store.pickPhotos();

    // Still listed and readable — only saving is impossible, and the UI says so.
    assert.equal(picked?.refs.length, 2);
    assert.deepEqual(picked?.readOnly, ['locked.jpg']);
  });

  it('asks for no write permission at all when saving copies', async () => {
    /*
     * The whole reason copies are the default. Picking five photos previously cost five
     * permission prompts, because saving in place needs write access to each one. Copies never
     * open the originals for writing, so there is nothing to ask about.
     */
    const handles = [fakeFileHandle('a.jpg'), fakeFileHandle('b.jpg'), fakeFileHandle('c.jpg')];
    stubFilePicker(handles);

    const store = createBrowserFileStore();
    // copy-pending is the default, but state it so the test does not rest on that.
    store.setDestination({ kind: 'copy-pending' });
    const picked = await store.pickPhotos();

    assert.equal(picked?.refs.length, 3);
    assert.deepEqual(picked?.readOnly, []);
    for (const handle of handles) {
      assert.equal(handle.permissionRequests, 0, `${handle.name} triggered a permission prompt`);
    }
  });

  it('defaults to copies, so the safe path is the one nobody has to choose', () => {
    assert.equal(createBrowserFileStore().getDestination().kind, 'copy-pending');
  });

  it('refuses to save before an output folder is chosen', async () => {
    // Falling back to overwriting the originals here would be the opposite of what somebody
    // asking for copies wants.
    stubFilePicker([fakeFileHandle('a.jpg')]);
    const store = createBrowserFileStore();
    const picked = await store.pickPhotos();
    const ref = picked?.refs[0];
    assert.ok(ref);

    await assert.rejects(
      () => store.writeAtomic(ref, new Uint8Array([1, 2, 3])),
      /choose a folder/i,
    );
  });

  it('returns undefined when the user cancels, which is not an error', async () => {
    globalThis.showOpenFilePicker = (async () => {
      throw new DOMException('cancelled', 'AbortError');
    }) as typeof showOpenFilePicker;

    assert.equal(await createBrowserFileStore().pickPhotos(), undefined);
  });

  it('returns undefined when nothing was selected', async () => {
    stubFilePicker([]);
    assert.equal(await createBrowserFileStore().pickPhotos(), undefined);
  });

  it('propagates a real failure rather than swallowing it', async () => {
    globalThis.showOpenFilePicker = (async () => {
      throw new DOMException('no', 'SecurityError');
    }) as typeof showOpenFilePicker;

    await assert.rejects(() => createBrowserFileStore().pickPhotos());
  });

  it('adds to an existing selection without losing it', async () => {
    // The clock-sync flow depends on this: the reference frame is shot after the session
    // started, so it has to come in without discarding the photos already open.
    const store = createBrowserFileStore();

    stubFilePicker([fakeFileHandle('DSC00119.JPG')]);
    const first = await store.pickPhotos();
    assert.ok(first);

    stubFilePicker([fakeFileHandle('DSC09999.JPG')]);
    const second = await store.pickPhotos({ add: first.refs });

    assert.deepEqual(second?.refs.map((ref) => ref.name), ['DSC00119.JPG', 'DSC09999.JPG']);
  });

  it('does not re-add a photo already open', async () => {
    const store = createBrowserFileStore();

    stubFilePicker([fakeFileHandle('DSC00119.JPG')]);
    const first = await store.pickPhotos();
    assert.ok(first);

    stubFilePicker([fakeFileHandle('DSC00119.JPG')]);
    const second = await store.pickPhotos({ add: first.refs });

    assert.equal(second?.refs.length, 1);
    assert.deepEqual(second?.skippedDuplicates, ['DSC00119.JPG']);
  });

  it('reads a picked file back through the store', async () => {
    stubFilePicker([fakeFileHandle('a.jpg')]);
    const store = createBrowserFileStore();
    const picked = await store.pickPhotos();
    const ref = picked?.refs[0];
    assert.ok(ref);

    assert.deepEqual(await store.read(ref), new Uint8Array([0xff, 0xd8, 0xff, 0xd9]));
  });
});

describe('countFolder', () => {
  it('counts photographs, raw included, and ignores everything else', async () => {
    /*
     * ARW counts, and that changed when sidecars shipped. A raw photograph can only be *saved*
     * from a folder — its sidecar has to be written beside it, and the file picker gives no access
     * to a parent — so a folder listing that hid ARW would hide the only route raw has, and the
     * whole feature would have been inert while every test passed.
     */
    const { directory } = fakeDirectory(['a.jpg', 'b.JPEG', 'notes.txt', 'c.jpg', 'raw.ARW']);
    const folder: BrowserFolder = { id: 'f', displayName: '100MSDCF', directory };

    assert.equal(await createBrowserFileStore().countFolder(folder), 4);
  });

  it('reads no file contents, so it stays fast on a thousand photos', async () => {
    /*
     * The whole point of counting first. If this touched each file the guard would cost as much
     * as the thing it is guarding against, and a card's folder would stall before the user was
     * even asked.
     */
    const { handles, directory } = fakeDirectory(['a.jpg', 'b.jpg', 'c.jpg']);
    const folder: BrowserFolder = { id: 'f', displayName: '100MSDCF', directory };

    await createBrowserFileStore().countFolder(folder);

    for (const handle of handles) {
      assert.equal(handle.getFileCalls, 0, `${handle.name} was opened during a count`);
    }
  });

  it('is zero for a picked selection, which has no folder', async () => {
    const folder: BrowserFolder = { id: 'picked', displayName: 'Selected photos' };
    assert.equal(await createBrowserFileStore().countFolder(folder), 0);
  });
});

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

describe('LARGE_FOLDER_THRESHOLD', () => {
  it('is small enough that the guard fires before a card folder is read', () => {
    // A camera card routinely holds several hundred to a few thousand photos in one folder.
    assert.ok(LARGE_FOLDER_THRESHOLD > 0);
    assert.ok(LARGE_FOLDER_THRESHOLD < 1000);
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
  const pick = async (folderName: string) => {
    const chosen = fakeOutputDirectory(folderName);
    (globalThis as Record<string, unknown>).showDirectoryPicker = async () => chosen.handle;
    const store = createBrowserFileStore();
    const destination = await store.pickOutputFolder();
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
