import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  altitudeRef,
  assertValidCoordinates,
  formatDecimal,
  formatDms,
  fromDms,
  latitudeRef,
  longitudeRef,
  toDms,
} from '../src/gps.ts';

describe('hemisphere references', () => {
  it('maps signs to the correct hemisphere', () => {
    assert.equal(latitudeRef(51.4778), 'N');
    assert.equal(latitudeRef(-33.8688), 'S');
    assert.equal(longitudeRef(2.3522), 'E');
    assert.equal(longitudeRef(-74.006), 'W');
  });

  it('resolves the equator and prime meridian to the positive hemisphere', () => {
    assert.equal(latitudeRef(0), 'N');
    assert.equal(latitudeRef(-0), 'N');
    assert.equal(longitudeRef(0), 'E');
    assert.equal(longitudeRef(-0), 'E');
  });

  it('treats sea level as above, and below as below', () => {
    assert.equal(altitudeRef(0), 0);
    assert.equal(altitudeRef(134.2), 0);
    assert.equal(altitudeRef(-8.5), 1);
  });
});

describe('toDms', () => {
  it('splits a coordinate into degrees, minutes and seconds', () => {
    assert.deepEqual(toDms(51.4778), { degrees: 51, minutes: 28, seconds: 40.08 });
  });

  it('ignores the sign, which the reference tag carries instead', () => {
    assert.deepEqual(toDms(-51.4778), toDms(51.4778));
  });

  it('carries 60 seconds up into the minutes rather than emitting 60', () => {
    const dms = toDms(1 + 59.999999 / 3600);
    assert.deepEqual(dms, { degrees: 1, minutes: 1, seconds: 0 });
  });

  it('carries all the way up into the degrees', () => {
    const dms = toDms(2.999999999);
    assert.deepEqual(dms, { degrees: 3, minutes: 0, seconds: 0 });
  });

  it('never produces a minutes or seconds value of 60', () => {
    for (let i = 0; i <= 2000; i++) {
      const dms = toDms(i * 0.0499983);
      assert.ok(dms.minutes < 60, `minutes was ${dms.minutes}`);
      assert.ok(dms.seconds < 60, `seconds was ${dms.seconds}`);
    }
  });
});

describe('round-tripping', () => {
  const cases = [51.4778, -33.8688, 0, 90, -90, 180, -180, 0.0000001, 2.3522];

  it('survives decimal -> DMS -> decimal within GPS precision', () => {
    for (const value of cases) {
      const ref = value < 0 ? 'S' : 'N';
      const restored = fromDms(toDms(value), ref);
      assert.ok(
        Math.abs(restored - value) < 1e-6,
        `${value} restored as ${restored}`,
      );
    }
  });

  it('does not lose the southern hemisphere on the way back', () => {
    assert.ok(fromDms(toDms(-33.8688), 'S') < 0);
    assert.ok(fromDms(toDms(-74.006), 'W') < 0);
  });
});

describe('formatting', () => {
  it('emits signed decimals with trailing zeros trimmed', () => {
    assert.equal(formatDecimal(51.4778), '51.4778');
    assert.equal(formatDecimal(-51.4778), '-51.4778');
    assert.equal(formatDecimal(0), '0');
    assert.equal(formatDecimal(100), '100');
    assert.equal(formatDecimal(10.5), '10.5');
  });

  it('does not strip significant zeros before the decimal point', () => {
    assert.equal(formatDecimal(20), '20');
    assert.equal(formatDecimal(1000), '1000');
  });

  it('emits ExifTool-parseable DMS', () => {
    assert.equal(formatDms(51.4778), `51 deg 28' 40.08"`);
  });
});

describe('validation', () => {
  it('accepts coordinates at the limits', () => {
    assert.doesNotThrow(() => assertValidCoordinates({ latitude: 90, longitude: 180 }));
    assert.doesNotThrow(() => assertValidCoordinates({ latitude: -90, longitude: -180 }));
  });

  it('rejects coordinates beyond them', () => {
    assert.throws(() => assertValidCoordinates({ latitude: 90.1, longitude: 0 }), RangeError);
    assert.throws(() => assertValidCoordinates({ latitude: 0, longitude: 180.1 }), RangeError);
    assert.throws(() => assertValidCoordinates({ latitude: NaN, longitude: 0 }), RangeError);
  });

  it('rejects a non-finite altitude', () => {
    assert.throws(
      () => assertValidCoordinates({ latitude: 0, longitude: 0, altitude: Infinity }),
      RangeError,
    );
  });
});
