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
} from '@snapmapper/core';

import { saveSession } from '../src/save.ts';
import { loadPhotos } from '../src/load-photos.ts';
import { scanWidthsFor } from '../src/clock-sync-qr.ts';

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
  /** Simulates copy mode, where the written file is not the original. */
  copyTo?: string;
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

      // A real store hands back where the bytes went, so verification can read *that* rather
      // than assuming it landed on the original.
      return {
        location: options.copyTo ? `${options.copyTo}/${target.name}` : target.name,
        replacedOriginal: !options.copyTo,
        read: async () => written.get(target.name) ?? new Uint8Array(),
      };
    },
  };

  return { store, written };
}

interface FakeBackendOptions {
  failFor?: readonly string[];
  message?: string;
  /** Overrides what a read returns, so verification can be made to fail. */
  readData?: string;
  /** Coordinates the verification read should report. Defaults to what was asked for. */
  readsBack?: { latitude: number; longitude: number } | null;
  /** A warning the verification read should report. */
  readWarning?: string;
}

function fakeBackend(options: FakeBackendOptions = {}): MetadataBackend {
  return {
    async write(input) {
      if (options.failFor?.includes(input.name)) {
        return { ok: false, data: undefined, message: 'Error: Corrupted JPEG image' };
      }
      // Return a structurally valid stub so the splice succeeds.
      return { ok: true, data: jpeg(16), message: options.message };
    },
    async read(input) {
      if (options.readData !== undefined) {
        return { ok: true, data: options.readData, message: undefined };
      }

      // A load read passes -fast2; a verification read deliberately does not, so that maker
      // notes are parsed and their warnings surface. That is the honest discriminator — both
      // reads ask for Composite:GPSLatitude, so the tag list cannot tell them apart.
      const verifying = !input.args.includes('-fast2');
      if (!verifying) {
        return {
          ok: true,
          data: '[{"SourceFile":"x","EXIF:DateTimeOriginal":"2024:05:17 14:32:08"}]',
          message: undefined,
        };
      }

      const coords = options.readsBack === undefined ? GREENWICH : options.readsBack;
      const tags: Record<string, string | number> = { SourceFile: 'x' };
      if (coords) {
        tags['Composite:GPSLatitude'] = coords.latitude;
        tags['Composite:GPSLongitude'] = coords.longitude;
        tags['EXIF:GPSLatitudeRef'] = coords.latitude < 0 ? 'S' : 'N';
        tags['EXIF:GPSLongitudeRef'] = coords.longitude < 0 ? 'W' : 'E';
      }
      if (options.readWarning) tags['ExifTool:Warning'] = options.readWarning;

      return { ok: true, data: JSON.stringify([tags]), message: undefined };
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

    // readsBack: null — the file really has no coordinates afterwards. Verification checks a
    // clear as an *absence*, so a fake that still reported coordinates would correctly fail.
    const { outcomes } = await saveSession(session, store, fakeBackend({ readsBack: null }));

    assert.equal(outcomes[0]?.ok, true);
    assert.equal(written.size, 1);
  });
});

describe('verify after save', () => {
  it('confirms a good write and counts it as saved', async () => {
    const session = assignLocation(createSession([entry('a.jpg')], CLOCK), ['a.jpg'], GREENWICH);
    const { store } = fakeStore();

    const { outcomes, savedNames } = await saveSession(session, store, fakeBackend());

    assert.equal(outcomes[0]?.ok, true);
    assert.deepEqual(savedNames, ['a.jpg']);
  });

  it('catches a write that landed somewhere else entirely', async () => {
    // The file was written and the write reported success, but it does not say what was
    // intended. Without reading back, this is indistinguishable from a correct save.
    const session = assignLocation(createSession([entry('a.jpg')], CLOCK), ['a.jpg'], GREENWICH);
    const { store, written } = fakeStore();

    const { outcomes, savedNames } = await saveSession(
      session, store, fakeBackend({ readsBack: { latitude: 12.3, longitude: 45.6 } }),
    );

    assert.equal(outcomes[0]?.ok, false);
    assert.equal(outcomes[0]?.writtenButUnverified, true);
    assert.match(outcomes[0]?.message ?? '', /latitude reads 12.3/);
    // The bytes did reach the file, and the result must not imply otherwise.
    assert.equal(written.size, 1);
    assert.deepEqual(savedNames, [], 'an unverified file must not count as saved');
  });

  it('catches a write that silently did nothing', async () => {
    const session = assignLocation(createSession([entry('a.jpg')], CLOCK), ['a.jpg'], GREENWICH);
    const { store } = fakeStore();

    const { outcomes } = await saveSession(session, store, fakeBackend({ readsBack: null }));

    assert.equal(outcomes[0]?.ok, false);
    assert.match(outcomes[0]?.message ?? '', /no coordinates could be read back/);
  });

  it('catches the maker-note damage that tag values alone would hide', async () => {
    // The coordinates read back perfectly here. Only the warning betrays the damage, which
    // is exactly how piexifjs looked from the outside.
    const session = assignLocation(createSession([entry('a.jpg')], CLOCK), ['a.jpg'], GREENWICH);
    const { store } = fakeStore();

    const { outcomes, savedNames } = await saveSession(
      session, store,
      fakeBackend({ readWarning: '[minor] Possibly incorrect maker notes offsets (fix by -53?)' }),
    );

    assert.equal(outcomes[0]?.ok, false);
    assert.equal(outcomes[0]?.writtenButUnverified, true);
    assert.match(outcomes[0]?.message ?? '', /maker notes offsets/);
    assert.deepEqual(savedNames, []);
  });

  it('verifies a clear as an absence, so a failed clear cannot pass', async () => {
    const located = entryFromTags(ref('a.jpg'), {
      'Composite:GPSLatitude': 51.4778,
      'Composite:GPSLongitude': -0.0015,
    });
    const session = clearLocation(createSession([located], CLOCK), ['a.jpg']);
    const { store } = fakeStore();

    // The file still reports coordinates, so the clear did not take.
    const { outcomes } = await saveSession(session, store, fakeBackend({ readsBack: GREENWICH }));

    assert.equal(outcomes[0]?.ok, false);
    assert.match(outcomes[0]?.message ?? '', /should have been removed/);
  });

  it('accepts a clear that really removed the location', async () => {
    const located = entryFromTags(ref('a.jpg'), {
      'Composite:GPSLatitude': 51.4778,
      'Composite:GPSLongitude': -0.0015,
    });
    const session = clearLocation(createSession([located], CLOCK), ['a.jpg']);
    const { store } = fakeStore();

    const { outcomes, savedNames } = await saveSession(
      session, store, fakeBackend({ readsBack: null }),
    );

    assert.equal(outcomes[0]?.ok, true);
    assert.deepEqual(savedNames, ['a.jpg']);
  });

  it('reports a benign warning without failing the save', async () => {
    const session = assignLocation(createSession([entry('a.jpg')], CLOCK), ['a.jpg'], GREENWICH);
    const { store } = fakeStore();

    const { outcomes } = await saveSession(
      session, store, fakeBackend({ readWarning: 'Odd offset for ThumbnailImage' }),
    );

    assert.equal(outcomes[0]?.ok, true);
    assert.ok(outcomes[0]?.warnings.some((w) => /Odd offset/.test(w)));
  });

  it('can be turned off, and then does not read back at all', async () => {
    const session = assignLocation(createSession([entry('a.jpg')], CLOCK), ['a.jpg'], GREENWICH);
    const { store } = fakeStore();

    // Would fail verification if it ran.
    const { outcomes, savedNames } = await saveSession(
      session, store, fakeBackend({ readsBack: { latitude: 1, longitude: 2 } }),
      undefined, { verify: false },
    );

    assert.equal(outcomes[0]?.ok, true);
    assert.deepEqual(savedNames, ['a.jpg']);
  });

  it('is on by default, so nobody has to remember to ask for it', async () => {
    const session = assignLocation(createSession([entry('a.jpg')], CLOCK), ['a.jpg'], GREENWICH);
    const { store } = fakeStore();

    const { outcomes } = await saveSession(
      session, store, fakeBackend({ readsBack: { latitude: 1, longitude: 2 } }),
    );
    assert.equal(outcomes[0]?.ok, false, 'verification should have run without being asked');
  });

  it('keeps checking the rest after one file fails verification', async () => {
    const session = assignLocation(
      createSession([entry('a.jpg'), entry('b.jpg')], CLOCK), ['a.jpg', 'b.jpg'], GREENWICH,
    );
    const { store } = fakeStore();

    const { outcomes } = await saveSession(
      session, store, fakeBackend({ readsBack: { latitude: 9, longitude: 9 } }),
    );
    assert.equal(outcomes.length, 2);
    assert.ok(outcomes.every((outcome) => outcome.writtenButUnverified));
  });
});

describe('loadPhotos', () => {
  it('reads every photo into an entry', async () => {
    const { store } = fakeStore();
    const { entries } = await loadPhotos([ref('a.jpg'), ref('b.jpg')], store, fakeBackend());

    assert.equal(entries.length, 2);
    assert.equal(entries[0]?.takenAt?.year, 2024);
    assert.equal(entries[0]?.error, undefined);
  });

  it('keeps an unreadable photo in the list rather than dropping it', async () => {
    // Silently losing a file the user can see in Explorer is worse than showing it broken.
    const { store } = fakeStore({ failReadsFor: ['b.jpg'] });
    const { entries } = await loadPhotos([ref('a.jpg'), ref('b.jpg')], store, fakeBackend());

    assert.equal(entries.length, 2);
    assert.equal(entries[1]?.error !== undefined, true);
  });

  it('reports progress, ending complete', async () => {
    /*
     * Per batch rather than per photograph, since batching landed.
     *
     * Sixteen files share one ExifTool invocation and there is nothing to report from inside it,
     * so the bar advances in steps of up to sixteen. That is a fair trade at the speed batching
     * brought: the two hundred photographs that took over a minute — the wait this progress
     * reporting exists for — now take about nine seconds across thirteen steps.
     *
     * What must hold is that it starts at nothing, never goes backwards, and ends complete. A bar
     * that finishes at 198 of 200 is the thing users read as a hang.
     */
    const { store } = fakeStore();
    const seen: number[] = [];

    await loadPhotos([ref('a.jpg'), ref('b.jpg')], store, fakeBackend(), (progress) => {
      seen.push(progress.done);
    });

    assert.equal(seen.at(0), 0);
    assert.equal(seen.at(-1), 2);
    assert.deepEqual(seen, [...seen].sort((a, b) => a - b), 'progress went backwards');
  });

  it('handles an empty folder without complaint', async () => {
    const { store } = fakeStore();
    assert.deepEqual((await loadPhotos([], store, fakeBackend())).entries, []);
  });

  it('does not stage a write for a photo that failed to load', async () => {
    const { store } = fakeStore({ failReadsFor: ['a.jpg'] });
    const { entries } = await loadPhotos([ref('a.jpg')], store, fakeBackend());
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

describe('scanWidthsFor', () => {
  it('always attempts something, however small the image', () => {
    // Regression guard. An earlier version filtered out every preferred width larger than
    // the image, so a small photo got zero attempts and reported "no code found" for an
    // image containing a perfectly readable code.
    for (const width of [64, 200, 420, 640, 1000, 1600, 4000, 6000]) {
      assert.ok(scanWidthsFor(width).length > 0, `no attempts for a ${width}px image`);
    }
  });

  it('never upscales past the original', () => {
    for (const width of [100, 420, 900, 6000]) {
      for (const attempt of scanWidthsFor(width)) {
        assert.ok(attempt <= width, `${attempt} exceeds the ${width}px image`);
      }
    }
  });

  it('tries a small image at its native size', () => {
    assert.deepEqual(scanWidthsFor(420), [420]);
  });

  it('does not pay for a full-resolution pass on a 24MP photo', () => {
    const widths = scanWidthsFor(6000);
    assert.ok(!widths.includes(6000));
    assert.deepEqual(widths, [1600, 1000, 640]);
  });

  it('returns no duplicates, so no width is decoded twice', () => {
    for (const width of [640, 1000, 1600, 1999]) {
      const widths = scanWidthsFor(width);
      assert.equal(new Set(widths).size, widths.length, `duplicates for ${width}`);
    }
  });
});
