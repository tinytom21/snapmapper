/**
 * Place names, and the arithmetic that keeps the lookups honest.
 *
 * Two things here would be silently wrong rather than visibly broken: a tag name that nothing
 * reads (which looks exactly like the feature not working), and a grouping that sends one request
 * per photograph (which works perfectly while abusing a free service).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  PLACE_PRECISION,
  buildClearPlaceTags,
  buildPlaceTags,
  describePlace,
  groupByPlace,
  isEmptyPlace,
  placeKey,
  type Place,
} from '../src/place.ts';

const TOULOUSE: Place = {
  location: 'Saint-Cyprien',
  city: 'Toulouse',
  state: 'Haute-Garonne',
  country: 'France',
  countryCode: 'FR',
};

describe('the tags a place is written into', () => {
  it('writes IPTC and XMP, because readers disagree about which to believe', () => {
    // The same reason both EXIF and XMP carry the coordinates: a file where they differ shows one
    // thing in Explorer and another in Lightroom.
    const tags = buildPlaceTags(TOULOUSE);

    assert.equal(tags['IPTC:City'], 'Toulouse');
    assert.equal(tags['XMP:City'], 'Toulouse');
    // IPTC spells these with hyphens and XMP does not. Getting either wrong writes a tag nothing
    // reads, which is indistinguishable from the feature being broken.
    assert.equal(tags['IPTC:Province-State'], 'Haute-Garonne');
    assert.equal(tags['XMP:State'], 'Haute-Garonne');
    assert.equal(tags['IPTC:Country-PrimaryLocationName'], 'France');
    assert.equal(tags['XMP:Country'], 'France');
    assert.equal(tags['IPTC:Sub-location'], 'Saint-Cyprien');
  });

  it('puts the country code in XMP only, because IPTC wants three letters', () => {
    /*
     * Found by writing to a real A6400 file, where ExifTool refused the write outright:
     * `String too short for IPTC:Country-PrimaryLocationCode (padded)`. That field is a fixed
     * three-octet ISO 3166-1 *alpha-3*, and every geocoder returns alpha-2 — so `FR` becomes
     * `FR `, which is not a cosmetic mismatch but a value meaning a different country or none.
     * XMP:CountryCode is alpha-2 by its own specification and takes it correctly.
     */
    const tags = buildPlaceTags(TOULOUSE);
    assert.equal(tags['XMP:CountryCode'], 'FR');
    assert.equal(tags['IPTC:Country-PrimaryLocationCode'], undefined);
  });

  it('omits what it does not know rather than blanking it', () => {
    /*
     * The important one. An empty string is ExifTool's *delete* value, so writing every field
     * unconditionally would strip a city somebody had set by hand because this lookup happened to
     * return only a country.
     */
    const tags = buildPlaceTags({ country: 'France' });
    assert.deepEqual(Object.keys(tags).sort(), ['IPTC:Country-PrimaryLocationName', 'XMP:Country']);
  });

  it('clears every field it can write, and only by explicit request', () => {
    const cleared = buildClearPlaceTags();
    assert.deepEqual(
      Object.keys(cleared).sort(),
      Object.keys(buildPlaceTags(TOULOUSE)).sort(),
    );
    assert.ok(Object.values(cleared).every((value) => value === ''));
  });

  it('knows an empty place from a real one', () => {
    assert.equal(isEmptyPlace({}), true);
    assert.equal(isEmptyPlace({ country: 'France' }), false);
  });
});

describe('describing a place in one line', () => {
  it('goes from most specific to least', () => {
    assert.equal(describePlace(TOULOUSE), 'Saint-Cyprien, Toulouse, Haute-Garonne, France');
  });

  it('does not repeat a name that fills two fields', () => {
    // City-states do this constantly, and "Singapore, Singapore, Singapore" reads as a bug.
    assert.equal(
      describePlace({ city: 'Singapore', state: 'Singapore', country: 'Singapore' }),
      'Singapore',
    );
  });
});

describe('grouping photographs before asking anything', () => {
  it('turns a walk around a park into a handful of questions', () => {
    /*
     * The difference between using a free service and abusing it. Fifty photographs a few metres
     * apart are in the same street, the same park and the same town — asking fifty times would be
     * asking the same question fifty times, at one request a second.
     */
    const located = Array.from({ length: 50 }, (_, index) => ({
      name: `DSC${index}.JPG`,
      // Spread over ~5 metres, well inside the rounding.
      coordinates: { latitude: 43.6047 + index * 1e-6, longitude: 1.4442 + index * 1e-6 },
    }));

    const groups = groupByPlace(located);
    assert.ok(groups.length <= 2, `${groups.length} requests for one spot`);
    assert.equal(groups.reduce((total, group) => total + group.names.length, 0), 50);
  });

  it('keeps genuinely different places apart', () => {
    // 11km apart crosses a town boundary, which is exactly what must not be merged.
    const groups = groupByPlace([
      { name: 'a.jpg', coordinates: { latitude: 43.60, longitude: 1.44 } },
      { name: 'b.jpg', coordinates: { latitude: 43.70, longitude: 1.44 } },
    ]);
    assert.equal(groups.length, 2);
  });

  it('sends a position somebody was actually at, not an average of several', () => {
    // An average is a position nobody occupied. Rounding has already established the group is
    // within metres, so taking a real one costs nothing.
    const groups = groupByPlace([
      { name: 'a.jpg', coordinates: { latitude: 43.60470, longitude: 1.44420 } },
      { name: 'b.jpg', coordinates: { latitude: 43.604701, longitude: 1.444201 } },
    ]);
    assert.equal(groups.length, 1);
    assert.equal(groups[0]?.coordinates.latitude, 43.60470);
  });

  it('rounds to about eleven metres, which is a street and not a town', () => {
    assert.equal(PLACE_PRECISION, 4);
    assert.equal(placeKey({ latitude: 43.60470123, longitude: 1.44420456 }), '43.6047,1.4442');
    // Negative values must not lose their sign to the formatting.
    assert.equal(placeKey({ latitude: -33.4489, longitude: -70.6693 }), '-33.4489,-70.6693');
  });
});
