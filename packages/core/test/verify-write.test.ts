import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  COORD_TOLERANCE,
  VERIFY_ARGS,
  VERIFY_TAGS,
  verifyWrittenLocation,
} from '../src/verify-write.ts';

const GREENWICH = { latitude: 51.4778, longitude: -0.0015 };
const SANTIAGO = { latitude: -33.4489, longitude: -70.6693 };

/** What a correct write looks like when read back, in ExifTool's real key shape. */
function readBack(coords: { latitude: number; longitude: number }, extra = {}) {
  return {
    'Composite:GPSLatitude': coords.latitude,
    'Composite:GPSLongitude': coords.longitude,
    'EXIF:GPSLatitudeRef': coords.latitude < 0 ? 'S' : 'N',
    'EXIF:GPSLongitudeRef': coords.longitude < 0 ? 'W' : 'E',
    ...extra,
  };
}

describe('verifying a written location', () => {
  it('accepts a file that reads back as intended', () => {
    const result = verifyWrittenLocation(readBack(GREENWICH), GREENWICH);
    assert.equal(result.ok, true);
    assert.deepEqual(result.problems, []);
  });

  it('accepts a southern and western location, refs and all', () => {
    assert.equal(verifyWrittenLocation(readBack(SANTIAGO), SANTIAGO).ok, true);
  });

  it('tolerates the rounding EXIF rationals introduce', () => {
    const nudged = {
      latitude: GREENWICH.latitude + COORD_TOLERANCE / 2,
      longitude: GREENWICH.longitude - COORD_TOLERANCE / 2,
    };
    assert.equal(verifyWrittenLocation(readBack(nudged), GREENWICH).ok, true);
  });

  it('rejects a coordinate that drifted further than rounding explains', () => {
    const wrong = { latitude: GREENWICH.latitude + 0.01, longitude: GREENWICH.longitude };
    const result = verifyWrittenLocation(readBack(wrong), GREENWICH);

    assert.equal(result.ok, false);
    assert.match(result.problems.join(' '), /latitude reads/);
  });

  it('catches a write that silently did nothing', () => {
    const result = verifyWrittenLocation({}, GREENWICH);
    assert.equal(result.ok, false);
    assert.match(result.problems.join(' '), /no coordinates could be read back/);
  });

  it('catches a dropped hemisphere, which Composite alone would hide', () => {
    /*
     * The magnitude is right and Composite is right, but the raw ref says north for a
     * southern location. A reader that combines magnitude and ref itself would put this
     * photo in the wrong hemisphere, so the refs are checked separately on purpose.
     */
    const result = verifyWrittenLocation(
      { ...readBack(SANTIAGO), 'EXIF:GPSLatitudeRef': 'N' },
      SANTIAGO,
    );
    assert.equal(result.ok, false);
    assert.match(result.problems.join(' '), /latitude ref reads N, expected S/);
  });

  it('accepts numeric strings, which ExifTool sometimes emits', () => {
    const result = verifyWrittenLocation(
      {
        'Composite:GPSLatitude': '51.4778',
        'Composite:GPSLongitude': '-0.0015',
        'EXIF:GPSLatitudeRef': 'N',
        'EXIF:GPSLongitudeRef': 'W',
      },
      GREENWICH,
    );
    assert.equal(result.ok, true);
  });
});

describe('verifying a cleared location', () => {
  it('accepts a file with no coordinates left', () => {
    const result = verifyWrittenLocation({}, null);
    assert.equal(result.ok, true);
  });

  it('catches a clear that silently did nothing', () => {
    // Without this, a failed clear looks identical to a successful one.
    const result = verifyWrittenLocation(readBack(GREENWICH), null);
    assert.equal(result.ok, false);
    assert.match(result.problems.join(' '), /should have been removed/);
  });
});

describe('structural warnings', () => {
  it('fails on the warning that exposed piexifjs', () => {
    /*
     * The important case. The coordinates read back perfectly here — a check that only
     * compared tag values would pass this file — but the maker notes are wrecked, which is
     * exactly how a corrupting writer looks from the outside.
     */
    const result = verifyWrittenLocation(
      {
        ...readBack(GREENWICH),
        'ExifTool:Warning': '[minor] Possibly incorrect maker notes offsets (fix by -53?)',
      },
      GREENWICH,
    );

    assert.equal(result.ok, false);
    assert.match(result.problems.join(' '), /maker notes offsets/);
    assert.equal(result.warnings.length, 1);
  });

  it('fails on every shape of structural complaint', () => {
    for (const warning of [
      'Truncated PreviewImage',
      'Corrupted JPEG image',
      'Bad IFD0 offset',
      'Invalid EXIF header',
      '[minor] Possibly incorrect maker notes offsets',
    ]) {
      const result = verifyWrittenLocation(
        { ...readBack(GREENWICH), 'ExifTool:Warning': warning },
        GREENWICH,
      );
      assert.equal(result.ok, false, `should have failed on: ${warning}`);
    }
  });

  it('reports a harmless warning without failing the write', () => {
    // Failing on any warning at all would reject files over trivia and teach people to
    // ignore the result, which is worse than not checking.
    const result = verifyWrittenLocation(
      { ...readBack(GREENWICH), 'ExifTool:Warning': 'Odd offset for ThumbnailImage' },
      GREENWICH,
    );

    assert.equal(result.ok, true);
    assert.deepEqual(result.warnings, ['Odd offset for ThumbnailImage']);
    assert.deepEqual(result.problems, []);
  });

  it('collects several warnings, including the numbered variants -a produces', () => {
    const result = verifyWrittenLocation(
      {
        ...readBack(GREENWICH),
        'ExifTool:Warning': 'Odd offset for ThumbnailImage',
        'ExifTool:Warning (1)': 'Possibly incorrect maker notes offsets',
      },
      GREENWICH,
    );

    assert.equal(result.warnings.length, 2);
    assert.equal(result.ok, false, 'the structural one must still fail it');
  });

  it('ignores an empty warning value', () => {
    const result = verifyWrittenLocation({ ...readBack(GREENWICH), 'ExifTool:Warning': '  ' }, GREENWICH);
    assert.deepEqual(result.warnings, []);
    assert.equal(result.ok, true);
  });

  it('does not mistake a tag merely containing the word for a warning', () => {
    const result = verifyWrittenLocation(
      { ...readBack(GREENWICH), 'EXIF:WarningMode': 'whatever' },
      GREENWICH,
    );
    assert.deepEqual(result.warnings, []);
    assert.equal(result.ok, true);
  });
});

describe('the read used for verification', () => {
  it('asks for the signed Composite values and both refs', () => {
    assert.ok(VERIFY_TAGS.includes('Composite:GPSLatitude'));
    assert.ok(VERIFY_TAGS.includes('EXIF:GPSLatitudeRef'));
    assert.ok(VERIFY_TAGS.includes('Warning'));
  });

  it('does not pass -fast2, which would skip the maker notes entirely', () => {
    /*
     * Regression guard, measured rather than assumed: with -fast2 a file with wrecked maker
     * notes reports no warning at all, and without it reports "[minor] Possibly incorrect
     * maker notes offsets". Adding -fast2 here for speed would quietly remove the main
     * reason this check exists.
     */
    assert.ok(!VERIFY_ARGS.includes('-fast2'));
    // -a is needed for more than one warning, -u to see unknown tags.
    assert.ok(VERIFY_ARGS.includes('-a'));
    assert.ok(VERIFY_ARGS.includes('-G'));
    // -G0:1 would emit EXIF:GPS:GPSLatitudeRef and break every lookup above.
    assert.ok(!VERIFY_ARGS.includes('-G0:1'));
  });
});
