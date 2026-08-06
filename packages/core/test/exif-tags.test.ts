import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  REQUIRED_WRITE_ARGS,
  buildClearLocationTags,
  buildGeotagTags,
} from '../src/exif-tags.ts';

describe('buildGeotagTags', () => {
  it('writes unsigned EXIF magnitudes with separate hemisphere refs', () => {
    const tags = buildGeotagTags({ coordinates: { latitude: -33.8688, longitude: 151.2093 } });

    assert.equal(tags['EXIF:GPSLatitude'], '33.8688');
    assert.equal(tags['EXIF:GPSLatitudeRef'], 'S');
    assert.equal(tags['EXIF:GPSLongitude'], '151.2093');
    assert.equal(tags['EXIF:GPSLongitudeRef'], 'E');
  });

  it('writes signed decimals to XMP, which has no ref tags', () => {
    const tags = buildGeotagTags({ coordinates: { latitude: -33.8688, longitude: -74.006 } });

    assert.equal(tags['XMP:GPSLatitude'], '-33.8688');
    assert.equal(tags['XMP:GPSLongitude'], '-74.006');
  });

  it('always states the datum, in XMP as well as EXIF', () => {
    const tags = buildGeotagTags({ coordinates: { latitude: 51.4778, longitude: 0 } });
    assert.equal(tags['EXIF:GPSMapDatum'], 'WGS-84');
    // GeoSetter writes both, and matching its output is the point of this module.
    assert.equal(tags['XMP:GPSMapDatum'], 'WGS-84');
  });

  it('omits altitude entirely when there is none, rather than writing zero', () => {
    const tags = buildGeotagTags({ coordinates: { latitude: 51.4778, longitude: 0 } });

    assert.ok(!('EXIF:GPSAltitude' in tags));
    assert.ok(!('EXIF:GPSAltitudeRef' in tags));
  });

  it('splits a below-sea-level altitude into magnitude and ref', () => {
    const tags = buildGeotagTags({
      coordinates: { latitude: 31.5, longitude: 35.5, altitude: -420.5 },
    });

    assert.equal(tags['EXIF:GPSAltitude'], '420.5');
    assert.equal(tags['EXIF:GPSAltitudeRef'], '1');
    assert.equal(tags['XMP:GPSAltitude'], '-420.5');
  });

  it('writes GPS date and time in UTC when the instant is known', () => {
    const tags = buildGeotagTags({
      coordinates: { latitude: 51.4778, longitude: 0 },
      instant: new Date('2024-05-17T23:30:08.000Z'),
    });

    assert.equal(tags['EXIF:GPSDateStamp'], '2024:05:17');
    assert.equal(tags['EXIF:GPSTimeStamp'], '23:30:08');
  });

  it('writes no GPS time at all rather than a guessed one', () => {
    const tags = buildGeotagTags({ coordinates: { latitude: 51.4778, longitude: 0 } });

    assert.ok(!('EXIF:GPSDateStamp' in tags));
    assert.ok(!('EXIF:GPSTimeStamp' in tags));
  });

  it('refuses out-of-range coordinates before anything reaches a file', () => {
    assert.throws(
      () => buildGeotagTags({ coordinates: { latitude: 91, longitude: 0 } }),
      RangeError,
    );
  });
});

describe('buildClearLocationTags', () => {
  it('clears the refs too, so no photo is left stranded at 0,0', () => {
    const tags = buildClearLocationTags();

    assert.equal(tags['EXIF:GPSLatitudeRef'], '');
    assert.equal(tags['EXIF:GPSLongitudeRef'], '');
    assert.equal(tags['EXIF:GPSAltitudeRef'], '');
    assert.equal(tags['EXIF:GPSMapDatum'], '');
  });

  it('clears every tag the write path can set', () => {
    const written = Object.keys(
      buildGeotagTags({
        coordinates: { latitude: 51.4778, longitude: 0, altitude: 100 },
        instant: new Date('2024-05-17T23:30:08.000Z'),
      }),
    );
    const cleared = buildClearLocationTags();

    for (const tag of written) {
      assert.ok(tag in cleared, `${tag} is written but never cleared`);
    }
  });

  it('uses the empty string, which is ExifTool\'s delete value', () => {
    for (const value of Object.values(buildClearLocationTags())) {
      assert.equal(value, '');
    }
  });
});

describe('REQUIRED_WRITE_ARGS', () => {
  it('asks for numeric mode, since the values are signed decimal degrees', () => {
    assert.ok(REQUIRED_WRITE_ARGS.includes('-n'));
  });

  // Regression guard for a bug this project already had. Spike Q2 measured both
  // of these failing against real A6400 files: -overwrite_original errors with
  // "Error erasing original" and -P warns with "Error setting file time",
  // because the WASM sandbox has no real filesystem. Preserving the modification
  // date is FileStore.writeAtomic's job instead.
  for (const forbidden of ['-P', '-overwrite_original']) {
    it(`does not pass ${forbidden}, which fails in the WASM sandbox`, () => {
      assert.ok(
        !REQUIRED_WRITE_ARGS.includes(forbidden),
        `${forbidden} breaks the write path — see spike/README.md Q2`,
      );
    });
  }
});
