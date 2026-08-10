import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  SAME_PLACE_METRES,
  findPriorLocations,
  samePlace,
  type PriorLocation,
} from '../src/prior-location.ts';
import {
  adoptPriorLocations,
  createSession,
  assignLocation,
  hasPendingChanges,
  locationOf,
  pendingPhotos,
  resolvePriorConflicts,
  undo,
  undoAction,
  unplacedPhotos,
  type PhotoEntry,
} from '../src/session.ts';
import { distanceMetres } from '../src/gps.ts';
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
const KEW = { latitude: 51.4787, longitude: -0.2956 };

function prior(name: string, coordinates = GREENWICH): PriorLocation {
  return { name, coordinates, source: 'copy', location: `geotagged/${name}` };
}

describe('distance between two positions', () => {
  it('is zero for the same point', () => {
    assert.equal(distanceMetres(GREENWICH, GREENWICH), 0);
  });

  it('matches a known separation', () => {
    // Greenwich to Kew is about 20.5 km along the ground.
    const metres = distanceMetres(GREENWICH, KEW);
    assert.ok(metres > 20_000 && metres < 21_000, `${metres} m`);
  });

  it('does not sweep the wrong way round the antimeridian', () => {
    // The classic longitude bug: +179.9 to -179.9 is 22 km, not most of the planet.
    const metres = distanceMetres(
      { latitude: 0, longitude: 179.9 },
      { latitude: 0, longitude: -179.9 },
    );
    assert.ok(metres < 25_000, `${metres} m`);
  });

  it('ignores altitude, because two readings of one spot differ vertically', () => {
    const ground = { ...GREENWICH, altitude: 5 };
    const air = { ...GREENWICH, altitude: 500 };
    assert.equal(distanceMetres(ground, air), 0);
  });
});

describe('is it the same place', () => {
  it('accepts a coordinate that has been through EXIF rationals and back', () => {
    // What a round trip actually costs: seven decimal places is ~11 mm.
    const rounded = {
      latitude: Number(GREENWICH.latitude.toFixed(7)),
      longitude: Number(GREENWICH.longitude.toFixed(7)),
    };
    assert.equal(samePlace(GREENWICH, rounded), true);
  });

  it('rejects a separation a person could have made on purpose', () => {
    // Ten metres. Below anything draggable on the map, and still a different answer.
    const along = { latitude: GREENWICH.latitude + 0.0001, longitude: GREENWICH.longitude };
    assert.ok(distanceMetres(GREENWICH, along) > SAME_PLACE_METRES);
    assert.equal(samePlace(GREENWICH, along), false);
  });
});

describe('sorting prior locations', () => {
  it('adopts a location for a photograph that had none', () => {
    const review = findPriorLocations([entry('a.jpg')], [prior('a.jpg')]);
    assert.equal(review.conflicts.length, 0);
    assert.deepEqual(review.adopt.map((p) => p.name), ['a.jpg']);
  });

  it('adopts silently when the two agree', () => {
    const entries = [entry('a.jpg', { existing: GREENWICH })];
    const review = findPriorLocations(entries, [prior('a.jpg')]);
    assert.equal(review.conflicts.length, 0);
    assert.equal(review.adopt.length, 1);
  });

  it('raises a conflict when they disagree, with the distance', () => {
    const entries = [entry('a.jpg', { existing: GREENWICH })];
    const review = findPriorLocations(entries, [prior('a.jpg', KEW)]);

    assert.equal(review.adopt.length, 0);
    assert.equal(review.conflicts.length, 1);
    const conflict = review.conflicts[0]!;
    assert.deepEqual(conflict.original, GREENWICH);
    assert.deepEqual(conflict.prior.coordinates, KEW);
    assert.ok(conflict.metresApart > 20_000);
  });

  it('ignores a prior for a photograph that is not open', () => {
    const review = findPriorLocations([entry('a.jpg')], [prior('b.jpg')]);
    assert.equal(review.adopt.length, 0);
    assert.equal(review.conflicts.length, 0);
  });

  it('ignores a photograph that could not be read', () => {
    // It cannot be written either, so a pin for it would point at a file already given up on.
    const entries = [entry('a.jpg', { error: 'File format error' })];
    const review = findPriorLocations(entries, [prior('a.jpg')]);
    assert.equal(review.adopt.length, 0);
    assert.equal(review.conflicts.length, 0);
  });
});

describe('adopting prior locations', () => {
  it('shows the photograph as saved, not as unsaved work', () => {
    // The trap this feature had to avoid: these coordinates are already on disk, so putting
    // them on the Save button would offer to do a write that has already happened.
    const session = adoptPriorLocations(
      createSession([entry('a.jpg')], CLOCK),
      [prior('a.jpg')],
    );

    assert.deepEqual(locationOf(session, 'a.jpg'), { kind: 'saved', coordinates: GREENWICH });
    assert.equal(hasPendingChanges(session), false);
    assert.equal(pendingPhotos(session).length, 0);
  });

  it('takes the photograph out of the unplaced list', () => {
    const before = createSession([entry('a.jpg')], CLOCK);
    assert.equal(unplacedPhotos(before).length, 1);
    assert.equal(unplacedPhotos(adoptPriorLocations(before, [prior('a.jpg')])).length, 0);
  });

  it('adds nothing to the undo stack', () => {
    const session = adoptPriorLocations(createSession([entry('a.jpg')], CLOCK), [prior('a.jpg')]);
    assert.equal(session.history.length, 0);
  });

  it('does not overwrite an edit the user has just made', () => {
    const placed = assignLocation(createSession([entry('a.jpg')], CLOCK), ['a.jpg'], KEW);
    const after = adoptPriorLocations(placed, [prior('a.jpg', GREENWICH)]);

    assert.deepEqual(locationOf(after, 'a.jpg'), { kind: 'pending', coordinates: KEW });
  });

  it('changes the photos array but never the filenames', () => {
    /*
     * The invariant the App's effect depends on, and the reason it is keyed on names.
     *
     * Adopting produces a new `photos` array, so an effect watching the array would re-run, adopt
     * again, produce another new array and never settle. Keying on the filenames settles after one
     * pass — but only for as long as adopting cannot rename anything.
     */
    const before = createSession([entry('a.jpg'), entry('b.jpg')], CLOCK);
    const after = adoptPriorLocations(before, [prior('a.jpg')]);

    assert.notEqual(after.photos, before.photos);
    assert.deepEqual(
      after.photos.map((photo) => photo.ref.name),
      before.photos.map((photo) => photo.ref.name),
    );

    // And a second pass over the same priors is a no-op as far as the names go, so the key holds.
    const twice = adoptPriorLocations(after, [prior('a.jpg')]);
    assert.deepEqual(
      twice.photos.map((photo) => photo.ref.name),
      before.photos.map((photo) => photo.ref.name),
    );
  });

  it('leaves the session alone when there is nothing to adopt', () => {
    const session = createSession([entry('a.jpg')], CLOCK);
    assert.equal(adoptPriorLocations(session, []), session);
  });
});

describe('resolving a disagreement', () => {
  const entries = [entry('a.jpg', { existing: GREENWICH }), entry('b.jpg', { existing: GREENWICH })];
  const review = findPriorLocations(entries, [prior('a.jpg', KEW), prior('b.jpg', KEW)]);

  it('choosing the copy stages nothing — the disk already says so', () => {
    const session = resolvePriorConflicts(
      createSession(entries, CLOCK),
      [{ conflict: review.conflicts[0]!, choice: 'copy' }],
    );

    assert.deepEqual(locationOf(session, 'a.jpg'), { kind: 'saved', coordinates: KEW });
    assert.equal(pendingPhotos(session).length, 0);
  });

  it('choosing the original stages a rewrite, so the copy stops disagreeing', () => {
    // Not staging would leave the wrong coordinates on disk and ask the same question next visit.
    const session = resolvePriorConflicts(
      createSession(entries, CLOCK),
      [{ conflict: review.conflicts[0]!, choice: 'original' }],
    );

    assert.deepEqual(locationOf(session, 'a.jpg'), { kind: 'pending', coordinates: GREENWICH });
    assert.deepEqual(pendingPhotos(session).map((e) => e.ref.name), ['a.jpg']);
  });

  it('records one undoable step for the whole batch, and names it', () => {
    const session = resolvePriorConflicts(createSession(entries, CLOCK), [
      { conflict: review.conflicts[0]!, choice: 'original' },
      { conflict: review.conflicts[1]!, choice: 'original' },
    ]);

    assert.deepEqual(undoAction(session), { kind: 'prior', count: 2 });
    assert.equal(pendingPhotos(session).length, 2);
    assert.equal(pendingPhotos(undo(session)).length, 0);
  });

  it('handles a mixed answer across the batch', () => {
    const session = resolvePriorConflicts(createSession(entries, CLOCK), [
      { conflict: review.conflicts[0]!, choice: 'copy' },
      { conflict: review.conflicts[1]!, choice: 'original' },
    ]);

    assert.deepEqual(locationOf(session, 'a.jpg'), { kind: 'saved', coordinates: KEW });
    assert.deepEqual(locationOf(session, 'b.jpg'), { kind: 'pending', coordinates: GREENWICH });
  });

  it('leaves the session alone when nothing was resolved', () => {
    const session = createSession(entries, CLOCK);
    assert.equal(resolvePriorConflicts(session, []), session);
  });
});
