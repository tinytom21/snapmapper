/**
 * The tile source, and the one decision in it that has to be right.
 *
 * The fallback is the interesting part. MapLibre reports a great deal through its `error` event —
 * a tile that 404s over the sea, a font that is slow, a source that hiccups — and treating any of
 * those as "the style is broken" would throw away a working vector map because one tile was
 * missing. It has to fire for a failed style document and nothing else.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ATTRIBUTION,
  RASTER_FALLBACK,
  VECTOR_STYLE_URL,
  isStyleLoadFailure,
  tileChoiceFrom,
} from '../src/tiles.ts';

/** MapLibre attaches the failing URL to the error it emits. */
function requestError(url: string): Error {
  return Object.assign(new Error(`Failed to fetch ${url}`), { url });
}

describe('the tile source', () => {
  it('needs no API key, which is why the map works for anyone who clones this', () => {
    assert.doesNotMatch(VECTOR_STYLE_URL, /key|token|apikey/i);
    assert.match(VECTOR_STYLE_URL, /^https:\/\//);
  });

  it('keeps a raster fallback that needs no key either', () => {
    const source = RASTER_FALLBACK.sources['osm'];
    assert.ok(source && source.type === 'raster');
    assert.doesNotMatch(JSON.stringify(RASTER_FALLBACK), /key=|token=/i);
    // Attribution is not optional, and it is easy to lose in a refactor.
    assert.match(JSON.stringify(RASTER_FALLBACK), /OpenStreetMap/);
  });
});

describe('isStyleLoadFailure', () => {
  it('fires when the style document itself cannot be fetched', () => {
    assert.equal(isStyleLoadFailure(requestError(VECTOR_STYLE_URL)), true);
  });

  it('does not fire for a missing tile', () => {
    // The case that matters: one tile over the ocean must not cost the whole vector map.
    assert.equal(
      isStyleLoadFailure(requestError('https://tiles.openfreemap.org/planet/tiles/14/8000/5000.pbf')),
      false,
    );
  });

  it('does not fire for fonts, sprites or anything else on that host', () => {
    for (const url of [
      'https://tiles.openfreemap.org/fonts/noto_sans_regular/0-255.pbf',
      'https://tiles.openfreemap.org/sprites/ofm_f384/ofm.json',
      'https://tile.openstreetmap.org/5/15/10.png',
    ]) {
      assert.equal(isStyleLoadFailure(requestError(url)), false, url);
    }
  });

  it('does not fire for things that are not errors at all', () => {
    // MapLibre's error event has been known to carry an event object with no `error` on it.
    assert.equal(isStyleLoadFailure(undefined), false);
    assert.equal(isStyleLoadFailure(null), false);
    assert.equal(isStyleLoadFailure('style broken'), false);
    assert.equal(isStyleLoadFailure({ url: VECTOR_STYLE_URL }), false);
  });

  it('falls back on a style failure reported only in the message', () => {
    // Not every MapLibre build attaches `url`, so the message is checked too.
    assert.equal(isStyleLoadFailure(new Error(`Load failed: ${VECTOR_STYLE_URL}`)), true);
  });
});

describe('tileChoiceFrom', () => {
  it('uses vector by default', () => {
    assert.equal(tileChoiceFrom(''), 'vector');
    assert.equal(tileChoiceFrom('?foo=bar'), 'vector');
  });

  it('lets a phone force the raster source without a rebuild', () => {
    // The point: telling "the tiles are wrong" from "the app is wrong" on a device, with no
    // console and no toolchain.
    assert.equal(tileChoiceFrom('?tiles=raster'), 'raster');
    assert.equal(tileChoiceFrom('?a=1&tiles=raster&b=2'), 'raster');
  });

  it('ignores anything else, including a truthy-looking value', () => {
    assert.equal(tileChoiceFrom('?tiles=vector'), 'vector');
    assert.equal(tileChoiceFrom('?tiles=1'), 'vector');
    assert.equal(tileChoiceFrom('?tiles='), 'vector');
  });
});

describe('ATTRIBUTION', () => {
  it('credits OpenStreetMap without waiting for a style to load', () => {
    // The style's own attribution arrives with its TileJSON, so it is missing while loading and
    // missing altogether if the style fails. The licence has no loading state.
    assert.match(ATTRIBUTION, /OpenStreetMap/);
    assert.match(ATTRIBUTION, /OpenFreeMap/);
    assert.match(ATTRIBUTION, /openstreetmap\.org\/copyright/);
  });
});
