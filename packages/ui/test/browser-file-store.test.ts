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
    (globalThis as Record<string, unknown>).showDirectoryPicker = async () => parent.handle;
    const store = createBrowserFileStore();
    const chosen = await store.pickOutputFolder();
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
    (globalThis as Record<string, unknown>).showDirectoryPicker = async () => chosen.handle;
    const store = createBrowserFileStore();
    const picked = await store.pickOutputFolder();
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
    (globalThis as Record<string, unknown>).showDirectoryPicker = async () => chosen.handle;
    const store = createBrowserFileStore();
    const picked = await store.pickOutputFolder();
    if (picked) store.setDestination(picked);
    chosen.remove();

    assert.equal((await store.listOutputNames()).size, 0);
  });
});

describe('adoptFolder', () => {
  /*
   * Raw picked one file at a time has no parent — `showOpenFilePicker` gives none — and a sidecar
   * written anywhere but beside its raw file is a file no reader will ever look for. So the folder
   * is asked for separately and grafted on, and *checked*: choosing the wrong one is an easy
   * mistake and a completely silent one, because sidecars would still be written, still report
   * success, and simply sit next to nothing.
   */
  /** A picked file: no `directory` on its folder, which is exactly the problem being solved. */
  function refIn(name: string) {
    const parentless: BrowserFolder = { id: 'picked', displayName: 'Selected photos' };
    return { folder: parentless, name, sizeBytes: 10, modifiedAtMs: 0, locator: name };
  }

  function withPicker(names: readonly string[], run: () => Promise<unknown>) {
    const { directory } = fakeDirectory(names);
    const original = globalThis.showDirectoryPicker;
    (globalThis as { showDirectoryPicker?: unknown }).showDirectoryPicker = async () => directory;
    return run().finally(() => {
      (globalThis as { showDirectoryPicker?: unknown }).showDirectoryPicker = original;
    });
  }

  it('attaches the folder so a sidecar has somewhere to go', async () => {
    await withPicker(['a.ARW', 'b.ARW'], async () => {
      const store = createBrowserFileStore();
      const got = await store.adoptFolder([refIn('a.ARW'), refIn('b.ARW')]);

      assert.equal(got?.missing.length, 0);
      // The directory handle is what `writeSidecar` needs; without it the write refuses.
      assert.ok((got?.refs[0]?.folder as { directory?: unknown }).directory);
      assert.equal(got?.refs.length, 2);
    });
  });

  it('names the files that are not in the chosen folder', async () => {
    // The wrong folder, or the right folder for only some of them. Either way the user has to be
    // told which, because the failure is otherwise invisible until Lightroom shows nothing.
    await withPicker(['a.ARW'], async () => {
      const store = createBrowserFileStore();
      const got = await store.adoptFolder([refIn('a.ARW'), refIn('missing.ARW')]);

      assert.deepEqual(got?.missing, ['missing.ARW']);
    });
  });

  it('keeps each file’s locator, since the files have not changed', async () => {
    // Only the parent is new. A changed locator would orphan the handle the store already holds.
    await withPicker(['a.ARW'], async () => {
      const store = createBrowserFileStore();
      const got = await store.adoptFolder([refIn('a.ARW')]);
      assert.equal(got?.refs[0]?.locator, 'a.ARW');
    });
  });
});
