import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  deriveClockOffsetSeconds,
  formatGpsDateStamp,
  formatGpsTimeStamp,
  isValidTimeZone,
  naiveToInstant,
  parseExifDateTime,
  photoInstant,
  zoneOffsetMs,
  type NaiveDateTime,
} from '../src/time.ts';

const HOUR_MS = 3_600_000;

function naive(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute = 0,
  second = 0,
): NaiveDateTime {
  return { year, month, day, hour, minute, second, millisecond: 0 };
}

describe('parseExifDateTime', () => {
  it('parses the standard EXIF form', () => {
    assert.deepEqual(parseExifDateTime('2024:05:17 14:32:08'), naive(2024, 5, 17, 14, 32, 8));
  });

  it('reads sub-seconds as a fraction, not as milliseconds', () => {
    // `.5` is half a second, so 500ms — not 5ms.
    assert.equal(parseExifDateTime('2024:05:17 14:32:08.5')?.millisecond, 500);
    assert.equal(parseExifDateTime('2024:05:17 14:32:08.25')?.millisecond, 250);
    assert.equal(parseExifDateTime('2024:05:17 14:32:08.123')?.millisecond, 123);
  });

  it('rejects the all-zero timestamp a dead clock battery produces', () => {
    assert.equal(parseExifDateTime('0000:00:00 00:00:00'), null);
  });

  it('rejects nonsense rather than throwing mid-batch', () => {
    assert.equal(parseExifDateTime(''), null);
    assert.equal(parseExifDateTime('not a date'), null);
    assert.equal(parseExifDateTime('2024:13:01 00:00:00'), null);
    assert.equal(parseExifDateTime('2024:05:17 25:00:00'), null);
  });
});

describe('zoneOffsetMs', () => {
  it('reports zero for UTC', () => {
    assert.equal(zoneOffsetMs(Date.UTC(2024, 6, 1, 12), 'UTC'), 0);
  });

  it('tracks British summer time', () => {
    assert.equal(zoneOffsetMs(Date.UTC(2024, 6, 1, 12), 'Europe/London'), HOUR_MS);
    assert.equal(zoneOffsetMs(Date.UTC(2024, 0, 15, 12), 'Europe/London'), 0);
  });

  it('handles zones behind UTC', () => {
    assert.equal(zoneOffsetMs(Date.UTC(2024, 6, 1, 12), 'America/New_York'), -4 * HOUR_MS);
    assert.equal(zoneOffsetMs(Date.UTC(2024, 0, 15, 12), 'America/New_York'), -5 * HOUR_MS);
  });

  it('handles a half-hour zone', () => {
    assert.equal(zoneOffsetMs(Date.UTC(2024, 6, 1, 12), 'Asia/Kolkata'), 5.5 * HOUR_MS);
  });
});

describe('naiveToInstant', () => {
  it('resolves a wall clock reading to the right instant', () => {
    assert.equal(
      naiveToInstant(naive(2024, 7, 1, 12), 'Europe/London').toISOString(),
      '2024-07-01T11:00:00.000Z',
    );
    assert.equal(
      naiveToInstant(naive(2024, 1, 15, 12), 'Europe/London').toISOString(),
      '2024-01-15T12:00:00.000Z',
    );
    assert.equal(
      naiveToInstant(naive(2024, 7, 1, 12), 'America/New_York').toISOString(),
      '2024-07-01T16:00:00.000Z',
    );
  });

  it('preserves milliseconds', () => {
    const withMs = { ...naive(2024, 7, 1, 12), millisecond: 250 };
    assert.equal(naiveToInstant(withMs, 'UTC').toISOString(), '2024-07-01T12:00:00.250Z');
  });

  it('lands on the correct side of a spring-forward transition', () => {
    // BST began 2024-03-31 at 01:00 UTC. 00:30 local is still GMT; 02:30 is BST.
    assert.equal(
      naiveToInstant(naive(2024, 3, 31, 0, 30), 'Europe/London').toISOString(),
      '2024-03-31T00:30:00.000Z',
    );
    assert.equal(
      naiveToInstant(naive(2024, 3, 31, 2, 30), 'Europe/London').toISOString(),
      '2024-03-31T01:30:00.000Z',
    );
  });

  it('resolves an autumn-overlap time to a single instant without throwing', () => {
    // 01:30 on 2024-10-27 happens twice in London. Either answer is defensible;
    // what matters is that it produces one and does not crash a batch.
    const resolved = naiveToInstant(naive(2024, 10, 27, 1, 30), 'Europe/London');
    assert.ok(!Number.isNaN(resolved.getTime()));
    const iso = resolved.toISOString();
    assert.ok(
      iso === '2024-10-27T00:30:00.000Z' || iso === '2024-10-27T01:30:00.000Z',
      `unexpected resolution ${iso}`,
    );
  });
});

describe('camera clock drift', () => {
  it('subtracts a fast clock', () => {
    const instant = photoInstant(naive(2024, 7, 1, 12, 0, 45), {
      timeZone: 'Europe/London',
      offsetSeconds: 45,
    });
    assert.equal(instant.toISOString(), '2024-07-01T11:00:00.000Z');
  });

  it('adds back a slow clock', () => {
    const instant = photoInstant(naive(2024, 7, 1, 11, 59, 15), {
      timeZone: 'Europe/London',
      offsetSeconds: -45,
    });
    assert.equal(instant.toISOString(), '2024-07-01T11:00:00.000Z');
  });

  it('is a no-op when the clock is correct', () => {
    const instant = photoInstant(naive(2024, 7, 1, 12), {
      timeZone: 'Europe/London',
      offsetSeconds: 0,
    });
    assert.equal(instant.toISOString(), '2024-07-01T11:00:00.000Z');
  });

  it('derives the offset from a photo of a trusted clock', () => {
    const offset = deriveClockOffsetSeconds(
      naive(2024, 7, 1, 12, 0, 45),
      new Date('2024-07-01T11:00:00.000Z'),
      'Europe/London',
    );
    assert.equal(offset, 45);
  });

  it('derives a negative offset for a slow clock', () => {
    const offset = deriveClockOffsetSeconds(
      naive(2024, 7, 1, 11, 59, 15),
      new Date('2024-07-01T11:00:00.000Z'),
      'Europe/London',
    );
    assert.equal(offset, -45);
  });

  it('round-trips: an offset derived then applied recovers the true instant', () => {
    const trueInstant = new Date('2024-07-01T11:00:00.000Z');
    const cameraReading = naive(2024, 7, 1, 12, 3, 20);
    const timeZone = 'Europe/London';

    const offsetSeconds = deriveClockOffsetSeconds(cameraReading, trueInstant, timeZone);
    const recovered = photoInstant(cameraReading, { timeZone, offsetSeconds });

    assert.equal(recovered.toISOString(), trueInstant.toISOString());
  });
});

describe('GPS timestamps', () => {
  it('formats in UTC regardless of the machine timezone', () => {
    const instant = new Date('2024-05-17T23:30:08.000Z');
    assert.equal(formatGpsDateStamp(instant), '2024:05:17');
    assert.equal(formatGpsTimeStamp(instant), '23:30:08');
  });

  it('zero-pads', () => {
    const instant = new Date('2024-01-05T04:03:02.000Z');
    assert.equal(formatGpsDateStamp(instant), '2024:01:05');
    assert.equal(formatGpsTimeStamp(instant), '04:03:02');
  });
});

describe('isValidTimeZone', () => {
  it('accepts IANA zones and rejects invented ones', () => {
    assert.equal(isValidTimeZone('Europe/London'), true);
    assert.equal(isValidTimeZone('UTC'), true);
    assert.equal(isValidTimeZone('Mars/Olympus_Mons'), false);
  });
});
