/**
 * Searching the logger's folder, and the cache that stops it being slow.
 *
 * The cache is the part worth testing hard. A logger's folder grows without limit — a file per day
 * for as long as it has been running — so a search that re-read everything would get slower every
 * week, and one that cached too eagerly would answer with this morning's span all afternoon.
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { clearSpanCache, searchTrackFolder } from '../src/track-search.ts';
import type { BrowserFileStore, TrackFileRef, TrackFolder } from '../src/browser-file-store.ts';

/** `localStorage` does not exist under `node:test`, and the cache is the point of these tests. */
function installStorage(): void {
  const values = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
}

const FOLDER = { displayName: 'tracks', needsPermission: false } as unknown as TrackFolder;

function gpx(from: string, to: string): string {
  return '<gpx><trk><trkseg>'
    + `<trkpt lat="51" lon="-1"><time>${from}</time></trkpt>`
    + `<trkpt lat="52" lon="-2"><time>${to}</time></trkpt>`
    + '</trkseg></trk></gpx>';
}

/** A store over an in-memory folder that counts what was actually read. */
function fakeStore(files: Record<string, { text: string; ref: TrackFileRef }>) {
  const reads: string[] = [];
  const store = {
    listTracks: async () => Object.values(files).map((one) => one.ref),
    readTrack: async (_folder: TrackFolder, name: string) => {
      reads.push(name);
      const found = files[name];
      if (!found) throw new Error(`no such file: ${name}`);
      return found.text;
    },
  } as unknown as BrowserFileStore;

  return { store, reads };
}

function entry(name: string, from: string, to: string, modifiedAtMs = 1) {
  return {
    text: gpx(from, to),
    ref: { name, sizeBytes: 100, modifiedAtMs },
  };
}

const PHOTOS = [new Date('2024-07-01T13:00:00Z'), new Date('2024-07-01T14:00:00Z')];

describe('searching a track folder', () => {
  beforeEach(() => {
    installStorage();
    clearSpanCache();
  });

  it('chooses the file covering the photographs', async () => {
    const { store } = fakeStore({
      'a.gpx': entry('a.gpx', '2023-01-01T06:00:00Z', '2023-01-01T22:00:00Z'),
      'b.gpx': entry('b.gpx', '2024-07-01T06:00:00Z', '2024-07-01T22:00:00Z'),
    });

    const found = await searchTrackFolder(store, FOLDER, PHOTOS);
    assert.notEqual(found, 'no-dates');
    assert.ok(found !== 'no-dates');
    assert.deepEqual(found.chosen, ['b.gpx']);
    assert.equal(found.considered, 2);
  });

  it('reads each file once and then not again', async () => {
    // The whole reason the cache exists. A year of daily tracks is 365 files, and re-reading them
    // on every search would make the feature slower the longer somebody used it.
    const { store, reads } = fakeStore({
      'a.gpx': entry('a.gpx', '2024-07-01T06:00:00Z', '2024-07-01T22:00:00Z'),
    });

    await searchTrackFolder(store, FOLDER, PHOTOS);
    assert.deepEqual(reads, ['a.gpx']);

    const again = await searchTrackFolder(store, FOLDER, PHOTOS);
    assert.deepEqual(reads, ['a.gpx'], 'the second search re-read the folder');
    assert.ok(again !== 'no-dates');
    assert.equal(again.read, 0);
    assert.deepEqual(again.chosen, ['a.gpx']);
  });

  it('re-reads a file the logger has appended to', async () => {
    /*
     * The bug a name-only cache would have. A logger appends to today's file all day: the name
     * never changes while the span grows by the hour, so an afternoon search would be answered
     * with the morning's span and would stop finding the afternoon's photographs.
     */
    const morning = fakeStore({
      'today.gpx': entry('today.gpx', '2024-07-01T06:00:00Z', '2024-07-01T09:00:00Z', 1000),
    });
    await searchTrackFolder(morning.store, FOLDER, [new Date('2024-07-01T07:00:00Z')]);

    const afternoon = fakeStore({
      // Same name, more bytes, later mtime — which is what the fingerprint is made of.
      'today.gpx': {
        text: gpx('2024-07-01T06:00:00Z', '2024-07-01T18:00:00Z'),
        ref: { name: 'today.gpx', sizeBytes: 900, modifiedAtMs: 2000 },
      },
    });
    const found = await searchTrackFolder(afternoon.store, FOLDER, [
      new Date('2024-07-01T17:00:00Z'),
    ]);

    assert.deepEqual(afternoon.reads, ['today.gpx'], 'the appended file was served from cache');
    assert.ok(found !== 'no-dates');
    assert.deepEqual(found.chosen, ['today.gpx']);
  });

  it('says so rather than searching when no photo has a date', async () => {
    const { store, reads } = fakeStore({
      'a.gpx': entry('a.gpx', '2024-07-01T06:00:00Z', '2024-07-01T22:00:00Z'),
    });
    assert.equal(await searchTrackFolder(store, FOLDER, [undefined, undefined]), 'no-dates');
    // And it did not read the folder to find that out.
    assert.deepEqual(reads, []);
  });

  it('reports the nearest track when nothing covers the shoot', async () => {
    const { store } = fakeStore({
      'old.gpx': entry('old.gpx', '2024-06-01T06:00:00Z', '2024-06-01T22:00:00Z'),
    });

    const found = await searchTrackFolder(store, FOLDER, PHOTOS);
    assert.ok(found !== 'no-dates');
    assert.deepEqual(found.chosen, []);
    assert.equal(found.nearest?.name, 'old.gpx');
  });

  it('survives a file that cannot be read, and does not retry it every time', async () => {
    const { store, reads } = fakeStore({
      'good.gpx': entry('good.gpx', '2024-07-01T06:00:00Z', '2024-07-01T22:00:00Z'),
    });
    // Listed but missing when read — a file deleted between the two, or one we cannot open.
    const listing = [
      { name: 'gone.gpx', sizeBytes: 1, modifiedAtMs: 1 },
      { name: 'good.gpx', sizeBytes: 100, modifiedAtMs: 1 },
    ];
    (store as unknown as { listTracks: () => Promise<readonly TrackFileRef[]> }).listTracks =
      async () => listing;

    const found = await searchTrackFolder(store, FOLDER, PHOTOS);
    assert.ok(found !== 'no-dates');
    assert.deepEqual(found.chosen, ['good.gpx']);
    assert.deepEqual(found.unreadable, ['gone.gpx']);

    // A permanently broken file must not cost a read on every search for the rest of time.
    reads.length = 0;
    await searchTrackFolder(store, FOLDER, PHOTOS);
    assert.deepEqual(reads, []);
  });

  it('works with no storage at all, just without the shortcut', async () => {
    // Private browsing blocks localStorage. Losing the cache is acceptable; throwing is not.
    delete (globalThis as { localStorage?: unknown }).localStorage;
    const { store } = fakeStore({
      'a.gpx': entry('a.gpx', '2024-07-01T06:00:00Z', '2024-07-01T22:00:00Z'),
    });

    const found = await searchTrackFolder(store, FOLDER, PHOTOS);
    assert.ok(found !== 'no-dates');
    assert.deepEqual(found.chosen, ['a.gpx']);
    installStorage();
  });
});
