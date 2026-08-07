import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  UNDO_LIMIT,
  assignLocation,
  canRedo,
  canUndo,
  clearLocation,
  createSession,
  entryFromTags,
  failedEntry,
  hasPendingChanges,
  instantOf,
  locationOf,
  markSaved,
  pendingPhotos,
  redo,
  revert,
  select,
  setClock,
  toggleSelected,
  undo,
  type PhotoEntry,
} from '../src/session.ts';
import type { CameraClock } from '../src/time.ts';
import type { FolderHandle, PhotoRef } from '../src/storage.ts';

const folder: FolderHandle = { id: 'f1', displayName: '100MSDCF' };

function ref(name: string): PhotoRef {
  return { folder, name, sizeBytes: 6_000_000, modifiedAtMs: 1_600_000_000_000, locator: name };
}

const CLOCK: CameraClock = { timeZone: 'Europe/London', offsetSeconds: 0 };

function entry(name: string, overrides: Partial<PhotoEntry> = {}): PhotoEntry {
  return {
    ref: ref(name),
    takenAt: { year: 2024, month: 7, day: 1, hour: 12, minute: 0, second: 0, millisecond: 0 },
    existing: undefined,
    error: undefined,
    ...overrides,
  };
}

const GREENWICH = { latitude: 51.4778, longitude: -0.0015 };
const SANTIAGO = { latitude: -33.4489, longitude: -70.6693 };

describe('staging edits', () => {
  it('stages a location without touching what is on disk', () => {
    const before = createSession([entry('a.jpg')], CLOCK);
    const after = assignLocation(before, ['a.jpg'], GREENWICH);

    assert.deepEqual(locationOf(after, 'a.jpg'), { kind: 'pending', coordinates: GREENWICH });
    // The original session is untouched — sessions are immutable.
    assert.deepEqual(locationOf(before, 'a.jpg'), { kind: 'none' });
    assert.equal(hasPendingChanges(after), true);
    assert.equal(hasPendingChanges(before), false);
  });

  it('reports a location already in the file as saved, not pending', () => {
    const session = createSession([entry('a.jpg', { existing: SANTIAGO })], CLOCK);
    assert.deepEqual(locationOf(session, 'a.jpg'), { kind: 'saved', coordinates: SANTIAGO });
    assert.equal(hasPendingChanges(session), false);
  });

  it('assigns to many photos at once', () => {
    const session = assignLocation(
      createSession([entry('a.jpg'), entry('b.jpg'), entry('c.jpg')], CLOCK),
      ['a.jpg', 'c.jpg'],
      GREENWICH,
    );

    assert.equal(pendingPhotos(session).length, 2);
    assert.deepEqual(locationOf(session, 'b.jpg'), { kind: 'none' });
  });

  it('refuses out-of-range coordinates before they can reach a file', () => {
    const session = createSession([entry('a.jpg')], CLOCK);
    assert.throws(() => assignLocation(session, ['a.jpg'], { latitude: 91, longitude: 0 }), RangeError);
  });

  it('will not stage an edit for a photo that could not be read', () => {
    // Writing to a file we failed to parse is how photos get corrupted.
    const session = createSession([failedEntry(ref('bad.jpg'), 'unreadable EXIF')], CLOCK);
    const after = assignLocation(session, ['bad.jpg'], GREENWICH);

    assert.equal(hasPendingChanges(after), false);
    assert.equal(after, session, 'should be the same session object when nothing changed');
  });

  it('ignores names that are not in the session', () => {
    const session = createSession([entry('a.jpg')], CLOCK);
    assert.equal(hasPendingChanges(assignLocation(session, ['ghost.jpg'], GREENWICH)), false);
  });
});

describe('clearing a location', () => {
  it('stages a clear for a photo that has saved coordinates', () => {
    const session = clearLocation(
      createSession([entry('a.jpg', { existing: SANTIAGO })], CLOCK),
      ['a.jpg'],
    );
    assert.deepEqual(locationOf(session, 'a.jpg'), { kind: 'pending-clear' });
  });

  it('does nothing for a photo that has no location at all', () => {
    const session = createSession([entry('a.jpg')], CLOCK);
    assert.equal(clearLocation(session, ['a.jpg']), session);
  });

  it('can clear a location that was only staged', () => {
    const staged = assignLocation(createSession([entry('a.jpg')], CLOCK), ['a.jpg'], GREENWICH);
    assert.deepEqual(locationOf(clearLocation(staged, ['a.jpg']), 'a.jpg'), { kind: 'pending-clear' });
  });
});

describe('revert', () => {
  it('drops a staged edit, restoring what is on disk', () => {
    const session = assignLocation(
      createSession([entry('a.jpg', { existing: SANTIAGO })], CLOCK),
      ['a.jpg'],
      GREENWICH,
    );
    const reverted = revert(session, ['a.jpg']);

    assert.deepEqual(locationOf(reverted, 'a.jpg'), { kind: 'saved', coordinates: SANTIAGO });
    assert.equal(hasPendingChanges(reverted), false);
  });

  it('is a no-op when there was nothing staged', () => {
    const session = createSession([entry('a.jpg')], CLOCK);
    assert.equal(revert(session, ['a.jpg']), session);
  });
});

describe('markSaved', () => {
  it('turns staged coordinates into saved ones', () => {
    const session = markSaved(
      assignLocation(createSession([entry('a.jpg')], CLOCK), ['a.jpg'], GREENWICH),
      ['a.jpg'],
    );

    assert.deepEqual(locationOf(session, 'a.jpg'), { kind: 'saved', coordinates: GREENWICH });
    assert.equal(hasPendingChanges(session), false);
  });

  it('leaves failures still pending, so a partial save is visible', () => {
    const staged = assignLocation(
      createSession([entry('a.jpg'), entry('b.jpg')], CLOCK),
      ['a.jpg', 'b.jpg'],
      GREENWICH,
    );
    const after = markSaved(staged, ['a.jpg']);

    assert.deepEqual(locationOf(after, 'a.jpg'), { kind: 'saved', coordinates: GREENWICH });
    assert.deepEqual(locationOf(after, 'b.jpg'), { kind: 'pending', coordinates: GREENWICH });
    assert.equal(pendingPhotos(after).length, 1);
  });

  it('applies a saved clear by removing the location', () => {
    const session = markSaved(
      clearLocation(createSession([entry('a.jpg', { existing: SANTIAGO })], CLOCK), ['a.jpg']),
      ['a.jpg'],
    );
    assert.deepEqual(locationOf(session, 'a.jpg'), { kind: 'none' });
  });

  it('clears undo history, because undo cannot reach past a write to disk', () => {
    const session = markSaved(
      assignLocation(createSession([entry('a.jpg')], CLOCK), ['a.jpg'], GREENWICH),
      ['a.jpg'],
    );
    assert.equal(canUndo(session), false);
    assert.equal(canRedo(session), false);
  });
});

describe('undo and redo', () => {
  it('undoes an assignment', () => {
    const session = assignLocation(createSession([entry('a.jpg')], CLOCK), ['a.jpg'], GREENWICH);
    assert.equal(canUndo(session), true);
    assert.deepEqual(locationOf(undo(session), 'a.jpg'), { kind: 'none' });
  });

  it('redoes what was undone', () => {
    const session = assignLocation(createSession([entry('a.jpg')], CLOCK), ['a.jpg'], GREENWICH);
    const again = redo(undo(session));
    assert.deepEqual(locationOf(again, 'a.jpg'), { kind: 'pending', coordinates: GREENWICH });
  });

  it('walks back through several edits in order', () => {
    let session = createSession([entry('a.jpg'), entry('b.jpg')], CLOCK);
    session = assignLocation(session, ['a.jpg'], GREENWICH);
    session = assignLocation(session, ['b.jpg'], SANTIAGO);

    session = undo(session);
    assert.deepEqual(locationOf(session, 'b.jpg'), { kind: 'none' });
    assert.deepEqual(locationOf(session, 'a.jpg'), { kind: 'pending', coordinates: GREENWICH });

    session = undo(session);
    assert.deepEqual(locationOf(session, 'a.jpg'), { kind: 'none' });
    assert.equal(canUndo(session), false);
  });

  it('discards the redo stack once a new edit is made', () => {
    let session = assignLocation(createSession([entry('a.jpg')], CLOCK), ['a.jpg'], GREENWICH);
    session = undo(session);
    assert.equal(canRedo(session), true);

    session = assignLocation(session, ['a.jpg'], SANTIAGO);
    assert.equal(canRedo(session), false, 'the old future is no longer reachable');
  });

  it('is a no-op at the ends of the stack', () => {
    const session = createSession([entry('a.jpg')], CLOCK);
    assert.equal(undo(session), session);
    assert.equal(redo(session), session);
  });

  it('bounds history so a long session cannot grow without limit', () => {
    let session = createSession([entry('a.jpg')], CLOCK);
    for (let i = 0; i < UNDO_LIMIT + 25; i++) {
      session = assignLocation(session, ['a.jpg'], { latitude: i / 1000, longitude: 0 });
    }
    assert.equal(session.history.length, UNDO_LIMIT);
  });

  it('undoes a clock change, which silently moves every GPS timestamp', () => {
    const session = setClock(createSession([entry('a.jpg')], CLOCK), {
      timeZone: 'America/New_York',
      offsetSeconds: 45,
    });
    assert.equal(session.clock.timeZone, 'America/New_York');
    assert.equal(undo(session).clock.timeZone, 'Europe/London');
  });
});

describe('selection', () => {
  it('replaces the selection', () => {
    const session = select(createSession([entry('a.jpg'), entry('b.jpg')], CLOCK), ['b.jpg']);
    assert.deepEqual([...session.selected], ['b.jpg']);
  });

  it('toggles a photo in and out', () => {
    let session = createSession([entry('a.jpg')], CLOCK);
    session = toggleSelected(session, 'a.jpg');
    assert.equal(session.selected.has('a.jpg'), true);
    session = toggleSelected(session, 'a.jpg');
    assert.equal(session.selected.has('a.jpg'), false);
  });

  it('is not undoable — only edits are', () => {
    const session = select(createSession([entry('a.jpg')], CLOCK), ['a.jpg']);
    assert.equal(canUndo(session), false);
  });
});

describe('instantOf', () => {
  it('applies the camera clock correction', () => {
    const session = createSession([entry('a.jpg')], {
      timeZone: 'Europe/London',
      offsetSeconds: 45,
    });
    const photo = session.photos[0];
    assert.ok(photo);
    // 12:00:00 BST is 11:00:00Z; a clock 45s fast means the true instant is 45s earlier.
    assert.equal(instantOf(session, photo)?.toISOString(), '2024-07-01T10:59:15.000Z');
  });

  it('returns undefined for a photo with an unusable date', () => {
    const session = createSession([entry('a.jpg', { takenAt: undefined })], CLOCK);
    const photo = session.photos[0];
    assert.ok(photo);
    assert.equal(instantOf(session, photo), undefined);
  });
});

describe('entryFromTags', () => {
  it('reads the date and existing signed coordinates', () => {
    const built = entryFromTags(ref('a.jpg'), {
      'EXIF:DateTimeOriginal': '2020:07:27 20:16:48',
      'Composite:GPSLatitude': -33.4489,
      'Composite:GPSLongitude': -70.6693,
      'Composite:GPSAltitude': 570.2,
    });

    assert.deepEqual(built.takenAt, {
      year: 2020, month: 7, day: 27, hour: 20, minute: 16, second: 48, millisecond: 0,
    });
    assert.deepEqual(built.existing, { latitude: -33.4489, longitude: -70.6693, altitude: 570.2 });
  });

  it('prefers the signed Composite values over the unsigned raw EXIF tags', () => {
    // EXIF stores GPS unsigned with a separate ref. Reading the raw tag as if it were
    // signed is exactly the bug that made the spike's verifier report a false failure.
    const built = entryFromTags(ref('a.jpg'), {
      'Composite:GPSLatitude': -33.4489,
      GPSLatitude: 33.4489,
      'Composite:GPSLongitude': -70.6693,
      GPSLongitude: 70.6693,
    });
    assert.equal(built.existing?.latitude, -33.4489);
    assert.equal(built.existing?.longitude, -70.6693);
  });

  it('reports no location when only one coordinate is present', () => {
    const built = entryFromTags(ref('a.jpg'), { 'Composite:GPSLatitude': 51.4778 });
    assert.equal(built.existing, undefined);
  });

  it('omits altitude rather than inventing zero', () => {
    const built = entryFromTags(ref('a.jpg'), {
      'Composite:GPSLatitude': 51.4778,
      'Composite:GPSLongitude': 0,
    });
    assert.ok(built.existing);
    assert.ok(!('altitude' in built.existing));
  });

  it('survives a dead-battery timestamp without losing the photo', () => {
    const built = entryFromTags(ref('a.jpg'), { 'EXIF:DateTimeOriginal': '0000:00:00 00:00:00' });
    assert.equal(built.takenAt, undefined);
    assert.equal(built.error, undefined, 'the photo is still usable, just undated');
  });

  it('accepts numeric strings, which ExifTool sometimes emits', () => {
    const built = entryFromTags(ref('a.jpg'), {
      'Composite:GPSLatitude': '51.4778',
      'Composite:GPSLongitude': '-0.0015',
    });
    assert.equal(built.existing?.latitude, 51.4778);
  });

  it('falls back to CreateDate when DateTimeOriginal is missing', () => {
    const built = entryFromTags(ref('a.jpg'), { 'EXIF:CreateDate': '2024:05:17 14:32:08' });
    assert.equal(built.takenAt?.year, 2024);
  });
});

describe('key format regression', () => {
  /**
   * The exact JSON shape ExifTool 13.59 emits with `-json -n -G`, copied from a real
   * ILCE-6400 file. Pinned because the first version of readTags passed `-G0:1`, which
   * emits `EXIF:ExifIFD:DateTimeOriginal` instead, so no date ever resolved and every
   * photo silently showed "no date" while coordinates kept working.
   */
  const REAL_OUTPUT = {
    SourceFile: 'DSC00119.JPG',
    'EXIF:DateTimeOriginal': '2020:07:27 20:16:48',
    'EXIF:Orientation': 1,
    'EXIF:Make': 'SONY',
    'EXIF:Model': 'ILCE-6400',
    'EXIF:GPSDateStamp': '2024:05:17',
    'Composite:GPSLatitude': 51.4778,
    'Composite:GPSLongitude': -0.0015,
    'Composite:GPSAltitude': 45.7,
  };

  it('reads the keys ExifTool actually emits under -G', () => {
    const built = entryFromTags(ref('DSC00119.JPG'), REAL_OUTPUT);

    assert.deepEqual(built.takenAt, {
      year: 2020, month: 7, day: 27, hour: 20, minute: 16, second: 48, millisecond: 0,
    });
    assert.deepEqual(built.existing, {
      latitude: 51.4778, longitude: -0.0015, altitude: 45.7,
    });
  });

  it('would fail on the -G0:1 key shape, which is the point of pinning this', () => {
    // Demonstrates the bug rather than merely asserting the fix: these are the keys the
    // wrong flag produced, and they resolve to nothing.
    const built = entryFromTags(ref('DSC00119.JPG'), {
      'EXIF:ExifIFD:DateTimeOriginal': '2020:07:27 20:16:48',
      'EXIF:GPS:GPSDateStamp': '2024:05:17',
    });
    assert.equal(built.takenAt, undefined);
  });
});
