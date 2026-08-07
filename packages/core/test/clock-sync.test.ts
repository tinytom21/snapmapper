import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  SYNC_QR_PREFIX,
  clockFromSync,
  encodeSyncPayload,
  parseSyncPayload,
  syncOffsetSeconds,
  syncUncertaintySeconds,
  type ClockSync,
} from '../src/clock-sync.ts';
import {
  applySync,
  clearSync,
  createSession,
  entryFromTags,
  instantOf,
  setOffsetSeconds,
  setTimeZone,
  undo,
} from '../src/session.ts';
import type { NaiveDateTime } from '../src/time.ts';
import type { FolderHandle, PhotoRef } from '../src/storage.ts';

const folder: FolderHandle = { id: 'f1', displayName: '100MSDCF' };

function ref(name: string): PhotoRef {
  return { folder, name, sizeBytes: 1000, modifiedAtMs: 0, locator: name };
}

function naive(
  year: number, month: number, day: number, hour: number, minute = 0, second = 0,
): NaiveDateTime {
  return { year, month, day, hour, minute, second, millisecond: 0 };
}

/** Camera read 12:00:45 BST while the truth was 11:00:00Z — so 45 seconds fast. */
const SYNC: ClockSync = {
  cameraReading: naive(2024, 7, 1, 12, 0, 45),
  trueInstant: new Date('2024-07-01T11:00:00.000Z'),
  sourcePhoto: 'DSC09999.JPG',
  method: 'qr',
};

describe('clockFromSync', () => {
  it('derives the drift in the given zone', () => {
    const clock = clockFromSync(SYNC, 'Europe/London');
    assert.equal(clock.timeZone, 'Europe/London');
    assert.equal(clock.offsetSeconds, 45);
  });

  it('derives a different offset in a different zone, which is the point', () => {
    /*
     * The same camera reading resolves to a different instant per zone, so the implied
     * drift differs by the zone gap. This is exactly why the reference is stored rather
     * than just the number.
     *
     * The sign is worth spelling out, because it reads backwards at first. In July London
     * is UTC+1 and New York is UTC-4, five hours apart. Reading 12:00:45 as New York local
     * puts it at 16:00:45Z rather than 11:00:45Z — five hours *later*. Measured against the
     * same true instant, the camera therefore looks five hours *more* ahead, not less.
     */
    const london = clockFromSync(SYNC, 'Europe/London').offsetSeconds;
    const newYork = clockFromSync(SYNC, 'America/New_York').offsetSeconds;

    assert.equal(london, 45);
    assert.equal(newYork, 45 + 5 * 3600);
    assert.equal(newYork - london, 5 * 3600);
  });

  it('reports the offset without a clock, for display', () => {
    assert.equal(syncOffsetSeconds(SYNC, 'Europe/London'), 45);
  });

  it('round-trips: applying a derived clock recovers the true instant', () => {
    const clock = clockFromSync(SYNC, 'Europe/London');
    const session = createSession(
      [{ ref: ref('a.jpg'), takenAt: SYNC.cameraReading, existing: undefined, error: undefined }],
      clock,
    );
    const photo = session.photos[0];
    assert.ok(photo);
    assert.equal(instantOf(session, photo)?.toISOString(), SYNC.trueInstant.toISOString());
  });
});

describe('a sync survives a timezone correction', () => {
  it('re-derives the offset when the zone changes', () => {
    // The bug this prevents: an offset measured under one zone silently staying put when
    // the user corrects the zone afterwards, leaving every timestamp wrong twice over.
    const session = applySync(createSession([], clockFromSync(SYNC, 'Europe/London')), SYNC);
    assert.equal(session.clock.offsetSeconds, 45);

    const moved = setTimeZone(session, 'America/New_York');
    assert.equal(moved.clock.timeZone, 'America/New_York');
    assert.equal(moved.clock.offsetSeconds, syncOffsetSeconds(SYNC, 'America/New_York'));
  });

  it('keeps the reference photo timestamp correct across a zone change', () => {
    let session = createSession(
      [{ ref: ref('a.jpg'), takenAt: SYNC.cameraReading, existing: undefined, error: undefined }],
      { timeZone: 'Europe/London', offsetSeconds: 0 },
    );
    session = applySync(session, SYNC);

    for (const zone of ['Europe/London', 'America/New_York', 'Asia/Kolkata', 'UTC']) {
      session = setTimeZone(session, zone);
      const photo = session.photos[0];
      assert.ok(photo);
      // The reference frame must always resolve to the instant it was actually taken,
      // whatever zone is currently set.
      assert.equal(
        instantOf(session, photo)?.toISOString(),
        SYNC.trueInstant.toISOString(),
        `wrong under ${zone}`,
      );
    }
  });

  it('leaves a hand-typed offset alone when the zone changes', () => {
    const session = setOffsetSeconds(
      createSession([], { timeZone: 'Europe/London', offsetSeconds: 0 }), 30,
    );
    const moved = setTimeZone(session, 'America/New_York');
    assert.equal(moved.clock.offsetSeconds, 30, 'a typed value must not be re-derived');
  });

  it('drops the reference when an offset is typed in, so the next zone change is honest', () => {
    const synced = applySync(createSession([], clockFromSync(SYNC, 'Europe/London')), SYNC);
    const typed = setOffsetSeconds(synced, 12);

    assert.equal(typed.sync, undefined);
    assert.equal(setTimeZone(typed, 'Asia/Kolkata').clock.offsetSeconds, 12);
  });

  it('undoes a sync, restoring both the clock and the reference', () => {
    const before = createSession([], { timeZone: 'Europe/London', offsetSeconds: 0 });
    const after = applySync(before, SYNC);

    assert.equal(after.clock.offsetSeconds, 45);
    const back = undo(after);
    assert.equal(back.clock.offsetSeconds, 0);
    assert.equal(back.sync, undefined);
  });

  it('clears a reference without changing the offset', () => {
    const synced = applySync(createSession([], clockFromSync(SYNC, 'Europe/London')), SYNC);
    const cleared = clearSync(synced);

    assert.equal(cleared.sync, undefined);
    assert.equal(cleared.clock.offsetSeconds, 45);
  });

  it('is a no-op when there is no reference to clear', () => {
    const session = createSession([], { timeZone: 'UTC', offsetSeconds: 0 });
    assert.equal(clearSync(session), session);
  });
});

describe('the QR payload', () => {
  it('round-trips an instant exactly', () => {
    const instant = new Date('2026-08-07T01:23:45.678Z');
    assert.equal(parseSyncPayload(encodeSyncPayload(instant))?.getTime(), instant.getTime());
  });

  it('is prefixed, so an unrelated barcode in the photo is not read as a time', () => {
    assert.ok(encodeSyncPayload(new Date()).startsWith(SYNC_QR_PREFIX));
    assert.equal(parseSyncPayload('https://example.com/'), undefined);
    assert.equal(parseSyncPayload('WIFI:S:home;P:hunter2;;'), undefined);
    assert.equal(parseSyncPayload('2026-08-07T01:23:45.678Z'), undefined);
  });

  it('rejects a version it does not know', () => {
    assert.equal(parseSyncPayload('PGT2|2026-08-07T01:23:45.678Z'), undefined);
  });

  it('demands a UTC instant, never a local-looking time', () => {
    // Accepting an offset-less time would risk reading local as UTC — a silent
    // multi-hour error of exactly the kind this module exists to prevent.
    assert.equal(parseSyncPayload(`${SYNC_QR_PREFIX}2026-08-07T01:23:45`), undefined);
    assert.equal(parseSyncPayload(`${SYNC_QR_PREFIX}2026-08-07T01:23:45+01:00`), undefined);
    assert.equal(parseSyncPayload(`${SYNC_QR_PREFIX}2026-08-07 01:23:45Z`), undefined);
  });

  it('rejects a malformed or impossible instant', () => {
    assert.equal(parseSyncPayload(`${SYNC_QR_PREFIX}not-a-date`), undefined);
    assert.equal(parseSyncPayload(`${SYNC_QR_PREFIX}2026-13-45T99:99:99Z`), undefined);
    assert.equal(parseSyncPayload(SYNC_QR_PREFIX), undefined);
    assert.equal(parseSyncPayload(''), undefined);
  });

  it('tolerates surrounding whitespace from a decoder', () => {
    const instant = new Date('2026-08-07T01:23:45.000Z');
    assert.equal(
      parseSyncPayload(`  ${encodeSyncPayload(instant)}\n`)?.getTime(),
      instant.getTime(),
    );
  });

  it('refuses to encode an invalid date', () => {
    assert.throws(() => encodeSyncPayload(new Date(NaN)), RangeError);
  });
});

describe('syncUncertaintySeconds', () => {
  it('is finer for a QR read than for a hand-typed time', () => {
    assert.ok(syncUncertaintySeconds('qr') < syncUncertaintySeconds('manual'));
    // Both must be well inside the camera's own one-second timestamp resolution, or the
    // measurement would be the limiting factor rather than the camera.
    assert.ok(syncUncertaintySeconds('qr') <= 1);
  });
});

describe('deriving a sync from a real reference photo', () => {
  it('builds a sync from a photo entry and a decoded instant', () => {
    // The whole flow: read the camera's own timestamp from the file, pair it with the
    // instant decoded from the photographed QR, and derive.
    const entry = entryFromTags(ref('DSC09999.JPG'), {
      'EXIF:DateTimeOriginal': '2024:07:01 12:00:45',
    });
    assert.ok(entry.takenAt);

    const sync: ClockSync = {
      cameraReading: entry.takenAt,
      trueInstant: new Date('2024-07-01T11:00:00.000Z'),
      sourcePhoto: entry.ref.name,
      method: 'qr',
    };

    assert.equal(clockFromSync(sync, 'Europe/London').offsetSeconds, 45);
  });
});
