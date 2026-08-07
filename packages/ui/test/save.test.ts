import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  assignLocation,
  clearLocation,
  createSession,
  entryFromTags,
  failedEntry,
  locationOf,
  markSaved,
  type FileStore,
  type FolderHandle,
  type MetadataBackend,
  type PhotoEntry,
  type PhotoRef,
} from '@geotagger/core';

import { saveSession } from '../src/save.ts';
import { loadPhotos } from '../src/load-photos.ts';

/**
 * These modules are deliberately DOM-free so they can be tested here rather than only
 * by clicking through a browser. The logic worth testing is not the rendering — it is
 * what happens when one photo out of fifty fails, which is exactly the case a manual
 * test never reaches.
 */

const folder: FolderHandle = { id: 'f1', displayName: '100MSDCF' };

function ref(name: string): PhotoRef {
  return { folder, name, sizeBytes: 1000, modifiedAtMs: 1_700_000_000_000, locator: name };
}

/** A JPEG with real structure, so the splice path runs for real. */
function jpeg(scanBytes = 1000): Uint8Array {
  const seg = (marker: number, payload: number[]) => {
    const length = payload.length + 2;
    return [0xff, marker, (length >> 8) & 0xff, length & 0xff, ...payload];
  };
  return new Uint8Array([
    0xff, 0xd8,
    ...seg(0xe1, [...Array.from('Exif\0\0', (c) => c.charCodeAt(0)), 1, 2, 3, 4]),
    ...seg(0xc0, [8, 0, 16, 0, 16, 1, 1, 0x11, 0]),
    ...seg(0xda, [1, 1, 0, 0, 63, 0]),
    ...Array.from({ length: scanBytes }, (_, i) => (i % 251) + 1),
    0xff, 0xd9,
  ]);
}

interface FakeStoreOptions {
  failWritesFor?: readonly string[];
  failReadsFor?: readonly string[];
}

function fakeStore(options: FakeStoreOptions = {}) {
  const written = new Map<string, Uint8Array>();

  const store: FileStore = {
    async listFolder() {
      return [];
    },
    async read(target) {
      if (options.failReadsFor?.includes(target.name)) throw new Error('read failed');
      return jpeg();
    },
    async writeAtomic(target, bytes) {
      if (options.failWritesFor?.includes(target.name)) {
        throw new Error('the file is locked by another program');
      }
      written.set(target.name, bytes);
    },
  };

  return { store, written };
}

function fakeBackend(options: { failFor?: readonly string[]; message?: string } = {}): MetadataBackend {
  return {
    async write(input) {
      if (options.failFor?.includes(input.name)) {
        return { ok: false, data: undefined, message: 'Error: Corrupted JPEG image' };
      }
      // Return a structurally valid stub so the splice succeeds.
      return { ok: true, data: jpeg(16), message: options.message };
    },
    async read() {
      return {
        ok: true,
        data: '[{"SourceFile":"x","EXIF:DateTimeOriginal":"2024:05:17 14:32:08"}]',
        message: undefined,
      };
    },
  };
}

function entry(name: string): PhotoEntry {
  return entryFromTags(ref(name), { 'EXIF:DateTimeOriginal': '2024:05:17 14:32:08' });
}

const CLOCK = { timeZone: 'Europe/London', offsetSeconds: 0 };
const GREENWICH = { latitude: 51.4778, longitude: -0.0015 };

describe('saveSession', () => {
  it('writes every staged photo and reports each one', async () => {
    const session = assignLocation(
      createSession([entry('a.jpg'), entry('b.jpg')], CLOCK),
      ['a.jpg', 'b.jpg'],
      GREENWICH,
    );
    const { store, written } = fakeStore();

    const { outcomes, savedNames } = await saveSession(session, store, fakeBackend());

    assert.equal(outcomes.length, 2);
    assert.ok(outcomes.every((outcome) => outcome.ok));
    assert.deepEqual(savedNames.sort(), ['a.jpg', 'b.jpg']);
    assert.equal(written.size, 2);
  });

  it('writes nothing for photos that were never edited', async () => {
    const session = assignLocation(
      createSession([entry('a.jpg'), entry('b.jpg')], CLOCK), ['a.jpg'], GREENWICH,
    );
    const { store, written } = fakeStore();

    await saveSession(session, store, fakeBackend());

    assert.deepEqual([...written.keys()], ['a.jpg']);
  });

  it('keeps going after one file fails, and names the one that did', async () => {
    // The case a manual test never reaches, and the whole reason results are per-file.
    const session = assignLocation(
      createSession([entry('a.jpg'), entry('b.jpg'), entry('c.jpg')], CLOCK),
      ['a.jpg', 'b.jpg', 'c.jpg'],
      GREENWICH,
    );
    const { store, written } = fakeStore({ failWritesFor: ['b.jpg'] });

    const { outcomes, savedNames } = await saveSession(session, store, fakeBackend());

    assert.equal(outcomes.length, 3);
    assert.deepEqual(savedNames.sort(), ['a.jpg', 'c.jpg']);
    assert.equal(written.size, 2);

    const failed = outcomes.find((outcome) => !outcome.ok);
    assert.equal(failed?.name, 'b.jpg');
    assert.match(failed?.message ?? '', /locked/);
  });

  it('leaves a failed photo still pending after markSaved', async () => {
    const session = assignLocation(
      createSession([entry('a.jpg'), entry('b.jpg')], CLOCK), ['a.jpg', 'b.jpg'], GREENWICH,
    );
    const { store } = fakeStore({ failWritesFor: ['b.jpg'] });

    const { savedNames } = await saveSession(session, store, fakeBackend());
    const after = markSaved(session, savedNames);

    assert.deepEqual(locationOf(after, 'a.jpg'), { kind: 'saved', coordinates: GREENWICH });
    assert.deepEqual(locationOf(after, 'b.jpg'), { kind: 'pending', coordinates: GREENWICH });
  });

  it('reports a read failure without writing anything for that photo', async () => {
    const session = assignLocation(createSession([entry('a.jpg')], CLOCK), ['a.jpg'], GREENWICH);
    const { store, written } = fakeStore({ failReadsFor: ['a.jpg'] });

    const { outcomes, savedNames } = await saveSession(session, store, fakeBackend());

    assert.equal(outcomes[0]?.ok, false);
    assert.deepEqual(savedNames, []);
    assert.equal(written.size, 0);
  });

  it('does not write a file the backend refused to produce', async () => {
    const session = assignLocation(createSession([entry('a.jpg')], CLOCK), ['a.jpg'], GREENWICH);
    const { store, written } = fakeStore();

    const { outcomes } = await saveSession(session, store, fakeBackend({ failFor: ['a.jpg'] }));

    assert.equal(outcomes[0]?.ok, false);
    assert.equal(written.size, 0, 'a failed metadata write must not reach the file');
  });

  it('surfaces benign warnings alongside a success', async () => {
    const session = assignLocation(createSession([entry('a.jpg')], CLOCK), ['a.jpg'], GREENWICH);
    const { store } = fakeStore();

    const { outcomes } = await saveSession(
      session, store, fakeBackend({ message: 'Warning: Error setting file time - /a.jpg' }),
    );

    assert.equal(outcomes[0]?.ok, true);
    assert.equal(outcomes[0]?.warnings.length, 1);
  });

  it('reports progress for every photo, ending complete', async () => {
    const session = assignLocation(
      createSession([entry('a.jpg'), entry('b.jpg')], CLOCK), ['a.jpg', 'b.jpg'], GREENWICH,
    );
    const { store } = fakeStore();
    const seen: string[] = [];

    await saveSession(session, store, fakeBackend(), (progress) => {
      seen.push(`${progress.done}/${progress.total}`);
    });

    assert.deepEqual(seen, ['0/2', '1/2', '2/2']);
  });

  it('carries a staged clear through to the file', async () => {
    const located = entryFromTags(ref('a.jpg'), {
      'Composite:GPSLatitude': 51.4778,
      'Composite:GPSLongitude': -0.0015,
    });
    const session = clearLocation(createSession([located], CLOCK), ['a.jpg']);
    const { store, written } = fakeStore();

    const { outcomes } = await saveSession(session, store, fakeBackend());

    assert.equal(outcomes[0]?.ok, true);
    assert.equal(written.size, 1);
  });
});

describe('loadPhotos', () => {
  it('reads every photo into an entry', async () => {
    const { store } = fakeStore();
    const entries = await loadPhotos([ref('a.jpg'), ref('b.jpg')], store, fakeBackend());

    assert.equal(entries.length, 2);
    assert.equal(entries[0]?.takenAt?.year, 2024);
    assert.equal(entries[0]?.error, undefined);
  });

  it('keeps an unreadable photo in the list rather than dropping it', async () => {
    // Silently losing a file the user can see in Explorer is worse than showing it broken.
    const { store } = fakeStore({ failReadsFor: ['b.jpg'] });
    const entries = await loadPhotos([ref('a.jpg'), ref('b.jpg')], store, fakeBackend());

    assert.equal(entries.length, 2);
    assert.equal(entries[1]?.error !== undefined, true);
  });

  it('reports progress, ending complete', async () => {
    const { store } = fakeStore();
    const seen: number[] = [];

    await loadPhotos([ref('a.jpg'), ref('b.jpg')], store, fakeBackend(), (progress) => {
      seen.push(progress.done);
    });

    assert.deepEqual(seen, [0, 1, 2]);
  });

  it('handles an empty folder without complaint', async () => {
    const { store } = fakeStore();
    assert.deepEqual(await loadPhotos([], store, fakeBackend()), []);
  });

  it('does not stage a write for a photo that failed to load', async () => {
    const { store } = fakeStore({ failReadsFor: ['a.jpg'] });
    const entries = await loadPhotos([ref('a.jpg')], store, fakeBackend());
    const session = assignLocation(createSession(entries, CLOCK), ['a.jpg'], GREENWICH);

    const { outcomes } = await saveSession(session, store, fakeBackend());
    assert.deepEqual(outcomes, [], 'nothing should have been staged at all');
  });
});

describe('failedEntry', () => {
  it('marks a photo unusable while keeping it listed', () => {
    const built = failedEntry(ref('a.jpg'), 'unreadable');
    assert.equal(built.error, 'unreadable');
    assert.equal(built.existing, undefined);
  });
});
