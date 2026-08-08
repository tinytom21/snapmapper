import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  UNDO_LIMIT,
  addPhotos,
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
  redoAction,
  revert,
  select,
  selectRange,
  setOffsetSeconds,
  setTimeZone,
  toggleSelected,
  undo,
  undoAction,
  applyTrack,
  restoreEdits,
  stagedPhotos,
  unplacedPhotos,
  type PhotoEntry,
} from '../src/session.ts';
import { parseGpx } from '../src/gpx.ts';
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

describe('addPhotos', () => {
  it('appends new photos in filename order', () => {
    const session = addPhotos(
      createSession([entry('DSC00119.JPG'), entry('DSC00121.JPG')], CLOCK),
      [entry('DSC00120.JPG')],
    );
    assert.deepEqual(
      session.photos.map((photo) => photo.ref.name),
      ['DSC00119.JPG', 'DSC00120.JPG', 'DSC00121.JPG'],
    );
  });

  it('keeps staged edits, so adding a photo does not discard work', () => {
    // The clock-sync flow adds the reference frame mid-session. Losing staged edits at that
    // moment would be infuriating and hard to notice.
    let session = assignLocation(createSession([entry('a.jpg')], CLOCK), ['a.jpg'], GREENWICH);
    session = addPhotos(session, [entry('ref.jpg')]);

    assert.deepEqual(locationOf(session, 'a.jpg'), { kind: 'pending', coordinates: GREENWICH });
    assert.equal(pendingPhotos(session).length, 1);
  });

  it('keeps the clock, the measurement and the undo history', () => {
    let session = setTimeZone(createSession([entry('a.jpg')], CLOCK), 'America/New_York');
    session = assignLocation(session, ['a.jpg'], GREENWICH);
    const before = session.history.length;

    session = addPhotos(session, [entry('b.jpg')]);

    assert.equal(session.clock.timeZone, 'America/New_York');
    assert.equal(session.history.length, before);
    assert.equal(canUndo(session), true);
  });

  it('is not undoable, so Ctrl+Z cannot make a photo vanish from the list', () => {
    const session = addPhotos(createSession([entry('a.jpg')], CLOCK), [entry('b.jpg')]);
    assert.equal(canUndo(session), false);
  });

  it('ignores a photo already present rather than reloading it', () => {
    // Re-reading a photo already open costs a metadata read — three seconds on a phone — and
    // gains nothing.
    const session = createSession([entry('a.jpg')], CLOCK);
    assert.equal(addPhotos(session, [entry('a.jpg')]), session);
  });

  it('keeps the existing entry when a name collides, not the newcomer', () => {
    const located = createSession([entry('a.jpg', { existing: SANTIAGO })], CLOCK);
    const after = addPhotos(located, [entry('a.jpg')]);

    assert.equal(after.photos.length, 1);
    assert.deepEqual(locationOf(after, 'a.jpg'), { kind: 'saved', coordinates: SANTIAGO });
  });

  it('is a no-op for an empty list', () => {
    const session = createSession([entry('a.jpg')], CLOCK);
    assert.equal(addPhotos(session, []), session);
  });

  it('leaves the selection alone', () => {
    const session = addPhotos(
      select(createSession([entry('a.jpg')], CLOCK), ['a.jpg']), [entry('b.jpg')],
    );
    assert.deepEqual([...session.selected], ['a.jpg']);
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
    const session = setTimeZone(createSession([entry('a.jpg')], CLOCK), 'America/New_York');
    assert.equal(session.clock.timeZone, 'America/New_York');
    assert.equal(undo(session).clock.timeZone, 'Europe/London');
  });

  it('undoes a manual offset change', () => {
    const session = setOffsetSeconds(createSession([entry('a.jpg')], CLOCK), 45);
    assert.equal(session.clock.offsetSeconds, 45);
    assert.equal(undo(session).clock.offsetSeconds, 0);
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

  it('selects an inclusive range in list order', () => {
    const session = selectRange(
      createSession([entry('a.jpg'), entry('b.jpg'), entry('c.jpg'), entry('d.jpg')], CLOCK),
      'b.jpg', 'd.jpg',
    );
    assert.deepEqual([...session.selected].sort(), ['b.jpg', 'c.jpg', 'd.jpg']);
  });

  it('selects a range dragged upwards just the same', () => {
    const session = selectRange(
      createSession([entry('a.jpg'), entry('b.jpg'), entry('c.jpg')], CLOCK), 'c.jpg', 'a.jpg',
    );
    assert.deepEqual([...session.selected].sort(), ['a.jpg', 'b.jpg', 'c.jpg']);
  });

  it('replaces the selection by default and extends it on request', () => {
    let session = select(createSession([entry('a.jpg'), entry('b.jpg'), entry('c.jpg')], CLOCK), ['a.jpg']);

    assert.deepEqual([...selectRange(session, 'b.jpg', 'c.jpg').selected].sort(), ['b.jpg', 'c.jpg']);
    assert.deepEqual(
      [...selectRange(session, 'b.jpg', 'c.jpg', true).selected].sort(),
      ['a.jpg', 'b.jpg', 'c.jpg'],
    );
  });

  it('ignores a range naming a photo that is not present', () => {
    const session = createSession([entry('a.jpg')], CLOCK);
    assert.equal(selectRange(session, 'a.jpg', 'ghost.jpg'), session);
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

describe('naming what undo would take back', () => {
  const three = () =>
    createSession([entry('a.jpg'), entry('b.jpg'), entry('c.jpg')], CLOCK);

  it('records the action, not just the state', () => {
    const placed = assignLocation(three(), ['a.jpg', 'b.jpg'], GREENWICH);
    assert.deepEqual(undoAction(placed), { kind: 'place', count: 2 });
  });

  it('counts only the photos an action actually changed', () => {
    // 'c.jpg' has nothing to clear, so a clear of all three is a clear of two.
    const placed = assignLocation(three(), ['a.jpg', 'b.jpg'], GREENWICH);
    const cleared = clearLocation(placed, ['a.jpg', 'b.jpg', 'c.jpg']);
    assert.deepEqual(undoAction(cleared), { kind: 'clear', count: 2 });
  });

  it('names every kind of change', () => {
    const placed = assignLocation(three(), ['a.jpg'], GREENWICH);
    assert.deepEqual(undoAction(revert(placed, ['a.jpg'])), { kind: 'revert', count: 1 });
    assert.deepEqual(
      undoAction(setTimeZone(three(), 'Pacific/Auckland')),
      { kind: 'time-zone', timeZone: 'Pacific/Auckland' },
    );
    assert.deepEqual(
      undoAction(setOffsetSeconds(three(), -42)),
      { kind: 'offset', offsetSeconds: -42 },
    );
  });

  it('has nothing to name on a fresh session', () => {
    assert.equal(undoAction(three()), undefined);
    assert.equal(redoAction(three()), undefined);
  });

  /*
   * The pairing is the part that would drift silently.
   *
   * A history entry holds a *past* state, but the name the user wants is the change that replaced
   * it. So undoing must move that name onto the redo stack unchanged — otherwise Redo offers the
   * name of a different step, and the labels are worse than none.
   */
  it('offers the same name to redo that undo just used', () => {
    const placed = assignLocation(three(), ['a.jpg', 'b.jpg'], GREENWICH);
    const cleared = clearLocation(placed, ['a.jpg']);

    assert.deepEqual(undoAction(cleared), { kind: 'clear', count: 1 });

    const undone = undo(cleared);
    assert.deepEqual(redoAction(undone), { kind: 'clear', count: 1 });
    assert.deepEqual(undoAction(undone), { kind: 'place', count: 2 });

    const redone = redo(undone);
    assert.deepEqual(undoAction(redone), { kind: 'clear', count: 1 });
    assert.equal(redoAction(redone), undefined);
  });

  it('keeps the names in step across a longer walk', () => {
    let session = assignLocation(three(), ['a.jpg'], GREENWICH);
    session = setTimeZone(session, 'Pacific/Auckland');
    session = assignLocation(session, ['b.jpg', 'c.jpg'], SANTIAGO);

    const names: unknown[] = [];
    while (canUndo(session)) {
      names.push(undoAction(session));
      session = undo(session);
    }
    assert.deepEqual(names, [
      { kind: 'place', count: 2 },
      { kind: 'time-zone', timeZone: 'Pacific/Auckland' },
      { kind: 'place', count: 1 },
    ]);

    // And back up, in the mirror order.
    const redone: unknown[] = [];
    while (canRedo(session)) {
      redone.push(redoAction(session));
      session = redo(session);
    }
    assert.deepEqual(redone, [
      { kind: 'place', count: 1 },
      { kind: 'time-zone', timeZone: 'Pacific/Auckland' },
      { kind: 'place', count: 2 },
    ]);
  });

  it('forgets the names a save has settled', () => {
    // markSaved clears the history, so there is nothing left to name — and Undo must never
    // suggest it can take back something already on disk.
    const placed = assignLocation(three(), ['a.jpg'], GREENWICH);
    const saved = markSaved(placed, ['a.jpg']);
    assert.equal(undoAction(saved), undefined);
    assert.equal(canUndo(saved), false);
  });
});

describe('placing photos from a GPS track', () => {
  const TRACK = parseGpx(
    '<gpx><trk><trkseg>'
    // 12:00 and 12:10 London on 1 July is 11:00 and 11:10 UTC — BST is in force.
    + '<trkpt lat="51.0" lon="-1.0"><time>2024-07-01T11:00:00Z</time></trkpt>'
    + '<trkpt lat="51.1" lon="-1.1"><time>2024-07-01T11:10:00Z</time></trkpt>'
    + '</trkseg></trk></gpx>',
  );

  /** A photo whose camera clock read `hh:mm:ss` on 1 July 2024. */
  function shotAt(name: string, hour: number, minute: number, second = 0): PhotoEntry {
    return entry(name, {
      takenAt: { year: 2024, month: 7, day: 1, hour, minute, second, millisecond: 0 },
    });
  }

  it('places a photo where the track says it was', () => {
    const session = createSession([shotAt('a.jpg', 12, 0)], CLOCK);
    const { session: after, placed } = applyTrack(session, TRACK);

    assert.equal(placed.length, 1);
    assert.deepEqual(locationOf(after, 'a.jpg'), {
      kind: 'pending',
      coordinates: { latitude: 51, longitude: -1 },
    });
  });

  it('goes through the corrected clock, not the camera reading', () => {
    /*
     * The point of the whole feature, and the way it would fail silently.
     *
     * This photo's *camera* reading is 12:05, which under the session zone resolves to 11:05 UTC —
     * the middle of the track. But the camera is five minutes fast, so it was really taken at
     * 11:00 UTC, at the start. Matching the uncorrected reading would put it half a kilometre
     * along the walk with nothing to suggest anything was wrong.
     */
    const fast = { timeZone: 'Europe/London', offsetSeconds: 300 };
    const { session: after } = applyTrack(
      createSession([shotAt('a.jpg', 12, 5)], fast),
      TRACK,
    );

    const location = locationOf(after, 'a.jpg');
    assert.ok(location.kind === 'pending');
    assert.equal(location.coordinates.latitude, 51);
  });

  it('interpolates between fixes', () => {
    const { session: after, placed } = applyTrack(
      createSession([shotAt('a.jpg', 12, 5)], CLOCK),
      // Five minutes past the first fix is halfway, but ten minutes from the nearest one, so the
      // tolerance has to allow it.
      { ...TRACK },
      { toleranceSeconds: 600 },
    );

    assert.equal(placed[0]?.interpolated, true);
    const location = locationOf(after, 'a.jpg');
    assert.ok(location.kind === 'pending');
    assert.equal(Math.round(location.coordinates.latitude * 1000) / 1000, 51.05);
  });

  it('leaves hand-placed photos alone unless told otherwise', () => {
    // A hand-placed photograph is somebody's considered judgement. A track sweeping it aside is a
    // loss Undo can reverse and nobody would notice in time to press it.
    const session = assignLocation(
      createSession([shotAt('a.jpg', 12, 0)], CLOCK),
      ['a.jpg'],
      SANTIAGO,
    );

    const { session: kept, skipped } = applyTrack(session, TRACK);
    assert.deepEqual(skipped, [{ name: 'a.jpg', reason: 'already-placed' }]);
    assert.equal(kept, session);

    const { placed } = applyTrack(session, TRACK, { replaceExisting: true });
    assert.equal(placed.length, 1);
  });

  it('says why each photo it could not place was skipped', () => {
    const session = createSession([
      shotAt('near.jpg', 12, 0),
      shotAt('late.jpg', 18, 0),
      entry('undated.jpg', { takenAt: undefined }),
      failedEntry(ref('broken.jpg'), 'unreadable'),
    ], CLOCK);

    const { placed, skipped } = applyTrack(session, TRACK);

    assert.deepEqual(placed.map((one) => one.name), ['near.jpg']);
    assert.deepEqual(skipped.map((one) => [one.name, one.reason]), [
      ['late.jpg', 'no-fix'],
      ['undated.jpg', 'no-date'],
      ['broken.jpg', 'unreadable'],
    ]);
    // How far off the nearest fix was, so the user can judge whether raising the tolerance is
    // reasonable or absurd. Six hours is absurd.
    const missed = skipped.find((one) => one.name === 'late.jpg');
    assert.equal(missed?.reason === 'no-fix' && missed.gapSeconds, 6 * 3600 - 600);
  });

  it('honours a list of names, so "match selected" is possible', () => {
    const session = createSession([shotAt('a.jpg', 12, 0), shotAt('b.jpg', 12, 0)], CLOCK);
    const { placed } = applyTrack(session, TRACK, { names: ['b.jpg'] });
    assert.deepEqual(placed.map((one) => one.name), ['b.jpg']);
  });

  it('is one undo step, named as a track match', () => {
    const session = createSession([shotAt('a.jpg', 12, 0), shotAt('b.jpg', 12, 1)], CLOCK);
    const { session: after } = applyTrack(session, TRACK);

    assert.deepEqual(undoAction(after), { kind: 'track', count: 2 });
    assert.equal(hasPendingChanges(undo(after)), false);
  });

  it('changes nothing at all when it places nothing', () => {
    // Not merely "no edits": no history entry either, or Undo would offer to take back a match
    // that never happened.
    const session = createSession([shotAt('a.jpg', 18, 0)], CLOCK);
    assert.equal(applyTrack(session, TRACK).session, session);
  });
});

describe('putting back work a crash took', () => {
  it('stages a whole set as one undo step', () => {
    const session = createSession([entry('a.jpg'), entry('b.jpg')], CLOCK);
    const after = restoreEdits(session, new Map([
      ['a.jpg', GREENWICH],
      ['b.jpg', null],
    ]));

    assert.deepEqual(locationOf(after, 'a.jpg'), { kind: 'pending', coordinates: GREENWICH });
    assert.deepEqual(locationOf(after, 'b.jpg'), { kind: 'pending-clear' });
    // One step, so a restore somebody did not want costs one Ctrl+Z rather than forty.
    assert.deepEqual(undoAction(after), { kind: 'restore', count: 2 });
    assert.equal(hasPendingChanges(undo(after)), false);
  });

  it('validates what came out of storage before staging any of it', () => {
    /*
     * These coordinates have been serialised and deserialised, and they are on their way into
     * files. A value that has been through storage is a value that could have come back as
     * something else, so it gets the same check as one that came off the map.
     */
    const session = createSession([entry('a.jpg')], CLOCK);
    assert.throws(
      () => restoreEdits(session, new Map([['a.jpg', { latitude: 91, longitude: 0 }]])),
      RangeError,
    );
  });

  it('skips photos that are no longer here rather than refusing the lot', () => {
    // A backup may be offered against a folder that has changed underneath it. Restoring what
    // matches is more useful than refusing because one is missing.
    const session = createSession([entry('a.jpg')], CLOCK);
    const after = restoreEdits(session, new Map([
      ['a.jpg', GREENWICH],
      ['gone.jpg', SANTIAGO],
    ]));

    assert.deepEqual(undoAction(after), { kind: 'restore', count: 1 });
  });

  it('changes nothing when none of it applies', () => {
    const session = createSession([entry('a.jpg')], CLOCK);
    assert.equal(restoreEdits(session, new Map([['gone.jpg', GREENWICH]])), session);
  });
});

describe('finding what still needs work', () => {
  it('lists photos with no location, saved or staged', () => {
    // The set left over after a track match, and the reason "Unplaced" exists: 38 of 45 placed
    // leaves seven scattered through a list of forty-five.
    const session = createSession([
      entry('placed.jpg', { existing: GREENWICH }),
      entry('bare.jpg'),
      entry('staged.jpg'),
      failedEntry(ref('broken.jpg'), 'unreadable'),
    ], CLOCK);

    const withStaging = assignLocation(session, ['staged.jpg'], SANTIAGO);
    assert.deepEqual(
      unplacedPhotos(withStaging).map((one) => one.ref.name),
      ['bare.jpg'],
    );
  });

  it('excludes unreadable photos, which cannot be placed by hand either', () => {
    const session = createSession([failedEntry(ref('broken.jpg'), 'unreadable')], CLOCK);
    assert.deepEqual(unplacedPhotos(session), []);
  });

  it('lists staged photos for a review pass, and not what is already on disk', () => {
    // A pass over this afternoon's work, not over the whole card.
    const session = assignLocation(
      createSession([entry('saved.jpg', { existing: GREENWICH }), entry('new.jpg')], CLOCK),
      ['new.jpg'],
      SANTIAGO,
    );
    assert.deepEqual(stagedPhotos(session).map((one) => one.ref.name), ['new.jpg']);
  });
});
