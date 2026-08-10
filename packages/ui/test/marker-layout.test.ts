import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CROWDING_GAP_PX,
  crowdedNames,
  markerZIndex,
  showsThumbnail,
  type ProjectedPin,
} from '../src/marker-layout.ts';

/**
 * The rule that decides whether a marker shows its photograph, in screen pixels.
 *
 * Testable at all because it is arithmetic over projected points — the same reason `map-focus.ts`
 * exists separately from `PhotoMap.tsx`, which imports MapLibre and therefore needs a browser.
 */

function at(name: string, x: number, y: number): ProjectedPin {
  return { name, x, y };
}

describe('which markers are too close to show a photograph', () => {
  it('leaves a photograph on its own alone', () => {
    assert.deepEqual([...crowdedNames([at('a', 100, 100)])], []);
  });

  it('crowds both of a colliding pair, not just the later one', () => {
    // Neither is readable, so hiding only one would leave a tile half-covered by a dot.
    const crowded = crowdedNames([at('a', 100, 100), at('b', 120, 100)]);
    assert.deepEqual([...crowded].sort(), ['a', 'b']);
  });

  it('leaves a pair that clears the gap', () => {
    const clear = CROWDING_GAP_PX + 1;
    assert.deepEqual([...crowdedNames([at('a', 0, 0), at('b', clear, 0)])], []);
  });

  it('measures diagonally, not by axis', () => {
    // Two pins each 40px apart on both axes are 56px apart, which clears a 60px gap on neither
    // axis alone. Comparing axes separately would call this a collision.
    const crowded = crowdedNames([at('a', 0, 0), at('b', 40, 40)], 50);
    assert.deepEqual([...crowded], []);
  });

  it('crowds photographs on identical coordinates', () => {
    // The common case rather than an edge one: a burst from one spot lands on the same point.
    const crowded = crowdedNames([at('a', 50, 50), at('b', 50, 50), at('c', 50, 50)]);
    assert.deepEqual([...crowded].sort(), ['a', 'b', 'c']);
  });

  it('keeps a lone outlier as a picture while a huddle goes to dots', () => {
    /*
     * The reason this is a pixel rule rather than a zoom threshold. A zoom that suits the huddle
     * hides the outlier too, and a zoom that suits the outlier lets the huddle overlap.
     */
    const huddle = [at('a', 10, 10), at('b', 20, 14), at('c', 15, 30)];
    const crowded = crowdedNames([...huddle, at('far', 600, 600)]);

    assert.equal(crowded.has('far'), false);
    assert.deepEqual([...crowded].sort(), ['a', 'b', 'c']);
  });

  it('handles a long chain without missing the middle', () => {
    // Each is close only to its neighbours, so a check that stopped at the first hit would leave
    // the interior pins looking isolated.
    const chain = Array.from({ length: 6 }, (_, i) => at(`p${i}`, i * 20, 0));
    assert.equal(crowdedNames(chain).size, 6);
  });

  it('says nothing about an empty map', () => {
    assert.equal(crowdedNames([]).size, 0);
  });
});

describe('whether a marker draws its photograph', () => {
  const crowded = new Set(['a', 'b']);

  it('draws it when there is room', () => {
    assert.equal(showsThumbnail({ name: 'c', selected: false, thumbnail: 'blob:x' }, crowded), true);
  });

  it('falls back to a dot in a huddle', () => {
    assert.equal(showsThumbnail({ name: 'a', selected: false, thumbnail: 'blob:x' }, crowded), false);
  });

  it('always draws the selected one, however crowded', () => {
    /*
     * The whole point of the feature. Choosing a frame in the list and seeing *which picture* it
     * is on the map is the check a dot cannot answer — and it is safe, because selection also
     * brings the marker to the front, so the tile lands over the huddle rather than inside it.
     */
    assert.equal(showsThumbnail({ name: 'a', selected: true, thumbnail: 'blob:x' }, crowded), true);
  });

  it('stays a dot when there is no thumbnail to show', () => {
    // A frame the camera wrote without one, or one whose read failed. An empty box says less.
    assert.equal(showsThumbnail({ name: 'c', selected: false }, crowded), false);
    assert.equal(showsThumbnail({ name: 'c', selected: true }, crowded), false);
  });
});

describe('stacking order', () => {
  it('puts the selected photograph above everything', () => {
    // DOM markers stack by insertion order, so without this the one just selected is usually
    // underneath something — which is precisely when it needs to be seen.
    const selected = markerZIndex({ selected: true, pending: false });
    assert.ok(selected > markerZIndex({ selected: false, pending: true }));
    assert.ok(selected > markerZIndex({ selected: false, pending: false }));
  });

  it('puts unsaved work above what is already on disk', () => {
    assert.ok(
      markerZIndex({ selected: false, pending: true })
      > markerZIndex({ selected: false, pending: false }),
    );
  });

  it('prefers selection over pending, when a photograph is both', () => {
    assert.equal(
      markerZIndex({ selected: true, pending: true }),
      markerZIndex({ selected: true, pending: false }),
    );
  });
});
