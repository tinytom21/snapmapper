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
  LABEL_PADDING,
  RASTER_FALLBACK,
  VECTOR_STYLE_URL,
  isStyleLoadFailure,
  labelDensity,
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
    /*
     * The identical string, not an equivalent one. MapLibre dedupes attributions by exact match,
     * so a plain-text credit here beside the linked one in `ATTRIBUTION` renders as two entries
     * saying the same thing.
     */
    assert.equal(source && 'attribution' in source ? source.attribution : null, ATTRIBUTION);
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
    assert.match(ATTRIBUTION, /openstreetmap\.org\/copyright/);
  });

  it('does not credit OpenFreeMap, because the style credits itself', () => {
    /*
     * The style says "OpenFreeMap © OpenMapTiles Data from OpenStreetMap" the moment it loads, and
     * MapLibre merges that with this — so naming OpenFreeMap here printed it twice in one banner.
     * Nothing is owed to a tile host whose tiles never arrived; the OSM credit above is a licence
     * requirement and is the part that has to survive a style that never loads.
     */
    assert.doesNotMatch(ATTRIBUTION, /OpenFreeMap/);
  });
});

/**
 * A slice of Liberty, with the real ids, types and zoom gates.
 *
 * Taken from the style as served, because the whole function is about *its* layer names — a made-up
 * fixture would test the regexes against themselves.
 */
const LIBERTY = [
  { id: 'label_city', type: 'symbol', minzoom: 3 },
  { id: 'label_town', type: 'symbol', minzoom: 6 },
  { id: 'label_village', type: 'symbol', minzoom: 9 },
  { id: 'label_other', type: 'symbol', minzoom: 8 },
  { id: 'label_state', type: 'symbol', minzoom: 5 },
  { id: 'label_country_1', type: 'symbol' },
  // Real Liberty layer, and one of the few label layers with no minzoom at all.
  { id: 'water_name_point_label', type: 'symbol' },
  { id: 'poi_r1', type: 'symbol', minzoom: 15 },
  { id: 'poi_r7', type: 'symbol', minzoom: 16 },
  { id: 'poi_r20', type: 'symbol', minzoom: 17 },
  { id: 'airport', type: 'symbol', minzoom: 10 },
  { id: 'waterway_line_label', type: 'symbol', minzoom: 10 },
  { id: 'highway-name-major', type: 'symbol', minzoom: 12.2 },
  { id: 'highway-shield-us-interstate', type: 'symbol', minzoom: 7 },
  { id: 'road_one_way_arrow', type: 'symbol', minzoom: 16 },
  { id: 'landuse_park', type: 'fill', minzoom: 4 },
  { id: 'water', type: 'fill' },
];

const byId = (adjustments: ReturnType<typeof labelDensity>) =>
  Object.fromEntries(adjustments.map((a) => [a.id, a]));

describe('labelDensity', () => {
  it('brings placenames forward by two zoom levels', () => {
    // The reported problem: on a phone the same zoom covers a fraction of the ground a desktop
    // shows, so the names that would orient you are simply not drawn yet.
    const found = byId(labelDensity(LIBERTY));
    assert.equal(found['label_town']?.minzoom, 4);
    assert.equal(found['label_village']?.minzoom, 7);
    assert.equal(found['label_other']?.minzoom, 6);
    assert.equal(found['label_city']?.minzoom, 1);
  });

  it('brings points of interest forward by only one', () => {
    // They arrive with icons, and a screenful of icons is clutter rather than information.
    const found = byId(labelDensity(LIBERTY));
    assert.equal(found['poi_r1']?.minzoom, 14);
    assert.equal(found['poi_r7']?.minzoom, 15);
    assert.equal(found['airport']?.minzoom, 9);
  });

  it('leaves roads alone entirely', () => {
    // Dense by nature, and already drawn at the zoom where a road is worth naming. Arrows are not
    // labels at all.
    const found = byId(labelDensity(LIBERTY));
    for (const id of ['highway-name-major', 'highway-shield-us-interstate', 'road_one_way_arrow']) {
      assert.equal(found[id], undefined, id);
    }
  });

  it('touches no layer that is not a symbol', () => {
    // Fills and lines have no labels to space out, and moving their zoom range would change the
    // cartography rather than the labelling.
    const found = byId(labelDensity(LIBERTY));
    assert.equal(found['landuse_park'], undefined);
    assert.equal(found['water'], undefined);
  });

  it('never asks for a negative zoom', () => {
    // label_city starts at 3 and is shifted by 2; a layer with no minzoom is already drawn from 0
    // and has nothing to bring forward, but still takes the tighter padding.
    for (const adjustment of labelDensity(LIBERTY)) {
      assert.ok(adjustment.minzoom >= 0, `${adjustment.id} went below zero`);
    }
    assert.equal(byId(labelDensity(LIBERTY))['water_name_point_label']?.minzoom, 0);
  });

  it('leaves country labels where they are', () => {
    // They are legible at every zoom that shows a country. Bringing them forward would mean
    // drawing them over places you are actually looking at.
    assert.equal(byId(labelDensity(LIBERTY))['label_country_1'], undefined);
  });

  it('tightens collision padding on everything it touches', () => {
    for (const adjustment of labelDensity(LIBERTY)) {
      assert.equal(adjustment.textPadding, LABEL_PADDING);
    }
    assert.ok(LABEL_PADDING < 2, 'the MapLibre default is 2; tighter is the point');
  });

  it('preserves each layer maxzoom, so nothing is drawn past where it should stop', () => {
    const capped = labelDensity([{ id: 'label_town', type: 'symbol', minzoom: 6, maxzoom: 12 }]);
    assert.equal(capped[0]?.maxzoom, 12);
  });
});
