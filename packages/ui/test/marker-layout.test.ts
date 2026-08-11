import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  CROWDING_GAP_PX,
  crowdedNames,
  depthRanks,
  markerModeFrom,
  markerZIndex,
  showsThumbnail,
  type MarkerMode,
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
  const shown = (name: string, selected: boolean, mode: MarkerMode) =>
    showsThumbnail({ name, selected, thumbnail: 'blob:x' }, crowded, mode);

  it('draws it when there is room, under either rule', () => {
    assert.equal(shown('c', false, 'declutter'), true);
    assert.equal(shown('c', false, 'always'), true);
  });

  it('keeps every picture by default, crowded or not', () => {
    // The default, on request and as an experiment: overlapping photographs may read better than a
    // map that keeps swapping between two kinds of marker as you zoom.
    assert.equal(shown('a', false, 'always'), true);
  });

  it('falls back to a dot in a huddle when decluttering', () => {
    assert.equal(shown('a', false, 'declutter'), false);
  });

  it('always draws the selected one, however crowded', () => {
    /*
     * Choosing a frame in the list and seeing *which picture* it is on the map is the check a dot
     * cannot answer, and it is safe because selection also brings the marker to the front.
     */
    assert.equal(shown('a', true, 'declutter'), true);
  });

  it('stays a dot when there is no thumbnail to show, under either rule', () => {
    // A frame the camera wrote without one, or one whose read failed. An empty box says less.
    for (const mode of ['always', 'declutter'] as const) {
      assert.equal(showsThumbnail({ name: 'c', selected: false }, crowded, mode), false);
      assert.equal(showsThumbnail({ name: 'c', selected: true }, crowded, mode), false);
    }
  });
});

describe('choosing between the two marker rules', () => {
  it('keeps every picture unless asked otherwise', () => {
    assert.equal(markerModeFrom(''), 'always');
    assert.equal(markerModeFrom('?tiles=raster'), 'always');
  });

  it('restores decluttering from the query string, like ?tiles=raster', () => {
    // Reachable from a phone, where there is no console and no way to rebuild.
    assert.equal(markerModeFrom('?markers=declutter'), 'declutter');
  });

  it('ignores a value it does not recognise', () => {
    assert.equal(markerModeFrom('?markers=sometimes'), 'always');
  });
});

describe('drawing order by depth', () => {
  it('ranks what is lower on the screen later, so it draws in front', () => {
    const ranks = depthRanks([at('south', 0, 900), at('north', 0, 100), at('middle', 0, 500)]);
    assert.equal(ranks.get('north'), 0);
    assert.equal(ranks.get('middle'), 1);
    assert.equal(ranks.get('south'), 2);
  });

  it('breaks ties by name, so a repaint cannot shuffle a pile', () => {
    // Two photographs on one spot must keep a stable order between repaints, or the top of the
    // pile changes every time the map is touched.
    const once = depthRanks([at('b', 0, 10), at('a', 0, 10)]);
    const again = depthRanks([at('a', 0, 10), at('b', 0, 10)]);
    assert.deepEqual([...once], [...again]);
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
      markerZIndex({ selected: true, pending: true }, 5),
      markerZIndex({ selected: true, pending: false }, 5),
    );
  });

  it('draws the nearer of two equals in front', () => {
    // How every map draws overlap, and what stops a pile of tiles looking shuffled. It matters
    // much more now every photograph keeps its picture, since overlap is the normal case.
    const plain = { selected: false, pending: false };
    assert.ok(markerZIndex(plain, 40) > markerZIndex(plain, 3));
  });

  it('never lets depth carry a marker out of its band', () => {
    // A selection must beat every unselected photograph, whatever the session size.
    const deepest = markerZIndex({ selected: false, pending: true }, 9_999_999);
    assert.ok(markerZIndex({ selected: true, pending: false }, 0) > deepest);
    assert.ok(deepest > markerZIndex({ selected: false, pending: false }, 9_999_999));
  });
});

/**
 * Read back out of `PhotoMap.tsx`, because the mistake was a DOM write and there is no DOM here.
 *
 * A grep is a poor test in general and the right one for this: what went wrong was not a wrong
 * value but a wrong *kind of assignment*, in one line, with no observable consequence until the
 * markers were on a real map. The same shape as the rule in `styles.test.ts` forbidding a literal
 * `color: #fff` beside an accent background.
 */
const photoMap = await readFile(
  path.join(import.meta.dirname, '..', 'src', 'PhotoMap.tsx'),
  'utf8',
);

describe('the marker element MapLibre is positioning', () => {
  it('never has its className assigned wholesale', () => {
    /*
     * The bug this pins reached the user, and it is the worst kind this application can have short
     * of writing a wrong coordinate: the map lying about where photographs are.
     *
     * MapLibre adds `maplibregl-marker` in the `Marker` constructor and that class carries
     * `position: absolute`. Assigning `className` removes it, the markers drop into normal
     * document flow, and each one's correct inline transform becomes an offset from wherever it
     * landed in the flow. Measured: three markers on identical coordinates, identical transforms,
     * rendering at x = 585, 705 and 721 — an evenly spaced row of photographs across the map.
     */
    const offenders = [...photoMap.matchAll(/^.*\.className\s*=[^=].*$/gm)]
      .map((match) => match[0].trim());

    assert.deepEqual(offenders, [], 'use classList.add / classList.toggle on a marker element');
  });

  it('turns off the attribution control MapLibre would add for itself', () => {
    /*
     * MapLibre adds an `AttributionControl` unless the map is told not to, and this file adds one
     * too — so without this the map carried two credit banners stacked on top of each other, each
     * with its own (i) button, taking two lines of a phone screen to say nearly the same thing
     * twice. Reported from a device.
     *
     * Ours is the one to keep: it carries `ATTRIBUTION` directly, so the credit is present while
     * the style is still loading and stays present if the style never loads at all.
     */
    assert.match(photoMap, /attributionControl:\s*false/);
    assert.equal((photoMap.match(/new maplibregl\.AttributionControl/g) ?? []).length, 1);
  });

  it('is given its base class by adding, not by replacing', () => {
    assert.match(photoMap, /classList\.add\('pin'\)/);
  });
});
