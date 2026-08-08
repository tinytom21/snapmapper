/**
 * Keeping staged edits somewhere a killed tab cannot take them.
 *
 * The failure being defended against is silent and specific: Android discards backgrounded tabs,
 * `beforeunload` does not fire for it, and forty photographs placed by hand look exactly like forty
 * that were never touched. Nothing warns you, and nothing can put them back.
 *
 * `fake-indexeddb` is not a dependency here — the store is exercised through a hand-rolled stand-in
 * that behaves the way the real one does for the three operations used. What is actually worth
 * testing is the shape guard and the folder-mismatch arithmetic, both of which are pure.
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { createSession, entryFromTags, type Session } from '@snapmapper/core';

import {
  BACKUP_LIFETIME_MS,
  applicableEdits,
  backupSession,
  clearBackup,
  findBackup,
  type SessionBackup,
} from '../src/session-backup.ts';

/**
 * Enough of IndexedDB for one object store, one key, and the three calls this module makes.
 *
 * Hand-rolled rather than pulled in: a fake for `open` / `transaction` / `get` / `put` / `delete`
 * is thirty lines, and the alternative is a dependency in a bundle whose size is already the thing
 * most worth shrinking.
 */
function installIndexedDb(): { rows: Map<string, unknown> } {
  const rows = new Map<string, unknown>();

  const request = <T>(result: T) => {
    const handle = { result, onsuccess: null as null | (() => void), onerror: null };
    // The real thing fires on a later task; firing on a microtask is close enough and keeps the
    // tests synchronous to read.
    queueMicrotask(() => handle.onsuccess?.());
    return handle;
  };

  (globalThis as { indexedDB?: unknown }).indexedDB = {
    open() {
      const database = {
        objectStoreNames: { contains: () => true },
        createObjectStore: () => undefined,
        close: () => undefined,
        transaction: () => ({
          objectStore: () => ({
            get: (key: string) => request(rows.get(key)),
            put: (value: unknown, key: string) => { rows.set(key, value); return request(undefined); },
            delete: (key: string) => { rows.delete(key); return request(undefined); },
          }),
        }),
      };
      const handle = {
        result: database,
        onsuccess: null as null | (() => void),
        onerror: null,
        onupgradeneeded: null,
        onblocked: null,
      };
      queueMicrotask(() => handle.onsuccess?.());
      return handle;
    },
  };

  return { rows };
}

function sessionOf(names: readonly string[]): Session {
  return createSession(
    names.map((name) => entryFromTags(
      { folder: { id: 'f', displayName: 'f' }, name, sizeBytes: 1, modifiedAtMs: 1, locator: name },
      { 'EXIF:DateTimeOriginal': '2024:07:01 12:00:00' },
    )),
    { timeZone: 'Europe/London', offsetSeconds: 45 },
  );
}

/** A session with two staged placements, built without reaching into its internals. */
function staged(): Session {
  const session = sessionOf(['a.jpg', 'b.jpg', 'c.jpg']);
  return {
    ...session,
    edits: new Map([
      ['a.jpg', { latitude: 51.5, longitude: -0.1 }],
      ['b.jpg', null],
    ]),
  };
}

const NOW = Date.parse('2024-07-01T18:00:00Z');

describe('backing up staged edits', () => {
  let store: { rows: Map<string, unknown> };
  beforeEach(() => { store = installIndexedDb(); });

  it('keeps the edits, the clock and the measurement — and not the photographs', async () => {
    await backupSession(staged(), '100MSDCF', NOW);
    const stored = store.rows.get('staged') as SessionBackup;

    assert.deepEqual(stored.edits, {
      'a.jpg': { latitude: 51.5, longitude: -0.1 },
      'b.jpg': null,
    });
    assert.equal(stored.clock.offsetSeconds, 45);
    assert.equal(stored.folderName, '100MSDCF');
    // Names only. The photographs are on disk and are re-read when the folder is opened again;
    // storing their metadata would multiply the size for nothing.
    assert.deepEqual(stored.photoNames, ['a.jpg', 'b.jpg', 'c.jpg']);
  });

  it('offers a backup back', async () => {
    await backupSession(staged(), '100MSDCF', NOW);
    const found = await findBackup(NOW + 60_000);
    assert.equal(found?.folderName, '100MSDCF');
  });

  it('does not offer one that is too old, and deletes it', async () => {
    // A fortnight-old backup, whose folder has almost certainly moved on, presented as though it
    // were relevant is worse than none.
    await backupSession(staged(), '100MSDCF', NOW);
    assert.equal(await findBackup(NOW + BACKUP_LIFETIME_MS + 1), null);
    assert.equal(store.rows.has('staged'), false, 'a stale backup should be deleted, not kept');
  });

  it('does not offer an empty one', async () => {
    await backupSession(sessionOf(['a.jpg']), '100MSDCF', NOW);
    assert.equal(await findBackup(NOW), null);
  });

  it('refuses a stored value whose shape it does not recognise', async () => {
    /*
     * A restore is a *write* path — these coordinates end up in photographs — and structured clone
     * hands back whatever an older version of the app wrote. So the shape is checked rather than
     * trusted, and anything unrecognised counts as no backup at all.
     */
    for (const rubbish of [
      42,
      { edits: { 'a.jpg': { latitude: 'north', longitude: -0.1 } }, clock: { timeZone: 'UTC', offsetSeconds: 0 }, folderName: 'f', photoNames: [], savedAtMs: NOW },
      { edits: {}, clock: { timeZone: 'UTC' }, folderName: 'f', photoNames: [], savedAtMs: NOW },
      { edits: { 'a.jpg': { latitude: 1, longitude: 2 } }, clock: { timeZone: 'UTC', offsetSeconds: 0 }, folderName: 'f', photoNames: [] },
    ]) {
      store.rows.set('staged', rubbish);
      assert.equal(await findBackup(NOW), null, `accepted ${JSON.stringify(rubbish)}`);
    }
  });

  it('never throws when storage is unavailable', async () => {
    // Private browsing blocks IndexedDB. A backup that fails must not interrupt the editing it
    // exists to protect — this runs while somebody is tapping a map.
    delete (globalThis as { indexedDB?: unknown }).indexedDB;
    await backupSession(staged(), 'f', NOW);
    assert.equal(await findBackup(NOW), null);
    await clearBackup();
  });
});

describe('matching a backup to the folder that is open', () => {
  it('restores what is present and counts what is not', () => {
    // A backup is offered against whatever folder is open, which may not be the one it came from.
    // Restoring what matches beats refusing because two are missing — and the count is what lets
    // somebody notice they have opened the wrong folder.
    const backup: SessionBackup = {
      edits: {
        'a.jpg': { latitude: 51.5, longitude: -0.1 },
        'gone.jpg': { latitude: 1, longitude: 2 },
      },
      clock: { timeZone: 'UTC', offsetSeconds: 0 },
      sync: undefined,
      folderName: 'other',
      photoNames: ['a.jpg', 'gone.jpg'],
      savedAtMs: NOW,
    };

    const { edits, missing } = applicableEdits(backup, sessionOf(['a.jpg', 'b.jpg']));
    assert.deepEqual([...edits.keys()], ['a.jpg']);
    assert.equal(missing, 1);
  });
});
