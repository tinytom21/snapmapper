/**
 * The map's framing decisions.
 *
 * Worth pinning because the failure modes are quiet: a degenerate box silently jumps to maximum
 * zoom, and a focus key that changes when it should not fights the user mid-drag.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { boundsOf, selectionFocus } from '../src/map-focus.ts';

const pin = (name: string, latitude: number, longitude: number, selected = true) => ({
  name,
  coordinates: { latitude, longitude },
  selected,
});

describe('selectionFocus', () => {
  it('leaves the map alone when nothing selected has a location', () => {
    assert.equal(selectionFocus([pin('a', 51, 0, false)]), null);
    assert.equal(selectionFocus([]), null);
  });

  it('frames only the selected photos, not every pin', () => {
    const focus = selectionFocus([
      pin('a', 51.5, -0.1),
      pin('far-away', -33.4, -70.7, false),
    ]);
    assert.deepEqual(focus?.bounds, [[-0.1, 51.5], [-0.1, 51.5]]);
    assert.equal(focus?.key, 'a');
  });

  it('reports a single point as single, so the caller can choose a zoom', () => {
    assert.equal(selectionFocus([pin('a', 51.5, -0.1)])?.single, true);
    // Several photos in the same spot is the same problem: fitBounds would max out.
    assert.equal(selectionFocus([pin('a', 51.5, -0.1), pin('b', 51.5, -0.1)])?.single, true);
    assert.equal(selectionFocus([pin('a', 51.5, -0.1), pin('b', 52, 0.2)])?.single, false);
  });

  it('keys on which photos are selected, not on where they are', () => {
    // The load-bearing case: dragging a pin must not recentre the map underneath the drag.
    const before = selectionFocus([pin('a', 51.5, -0.1), pin('b', 52, 0.2)]);
    const dragged = selectionFocus([pin('a', 40, -3), pin('b', 52, 0.2)]);
    assert.equal(before?.key, dragged?.key);

    const other = selectionFocus([pin('a', 51.5, -0.1), pin('c', 52, 0.2)]);
    assert.notEqual(before?.key, other?.key);
  });

  it('does not depend on the order the photos arrive in', () => {
    const one = selectionFocus([pin('a', 51.5, -0.1), pin('b', 52, 0.2)]);
    const other = selectionFocus([pin('b', 52, 0.2), pin('a', 51.5, -0.1)]);
    assert.equal(one?.key, other?.key);
  });
});

describe('boundsOf', () => {
  it('returns west, south, east, north in MapLibre order', () => {
    assert.deepEqual(
      boundsOf([
        { coordinates: { latitude: 51.5, longitude: -0.1 } },
        { coordinates: { latitude: -33.4, longitude: 18.4 } },
      ]),
      [[-0.1, -33.4], [18.4, 51.5]],
    );
  });

  it('handles the southern and western hemispheres, where the extremes are negative', () => {
    // A naive `west = 0` start would clamp this to the prime meridian.
    assert.deepEqual(
      boundsOf([
        { coordinates: { latitude: -33.4489, longitude: -70.6693 } },
        { coordinates: { latitude: -34.6037, longitude: -58.3816 } },
      ]),
      [[-70.6693, -34.6037], [-58.3816, -33.4489]],
    );
  });
});
