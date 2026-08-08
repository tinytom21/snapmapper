/**
 * Redirecting a style through the tile cache.
 *
 * The rewriting is the part where a mistake is invisible: the map keeps working perfectly online
 * and caches nothing at all, or every tile 404s for a reason nothing names. Both are pure string
 * handling, so both are pinned here.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  TILE_PROTOCOL,
  prefixUrl,
  realUrl,
  redirectStyle,
} from '../src/offline-tiles.ts';

describe('the protocol prefix', () => {
  it('round-trips an absolute URL', () => {
    const url = 'https://tiles.openfreemap.org/planet/1/2/3.pbf';
    assert.equal(prefixUrl(url), `${TILE_PROTOCOL}://${url}`);
    assert.equal(realUrl(prefixUrl(url)), url);
  });

  it('leaves a URL that is not remote alone', () => {
    // A relative one is ours to serve anyway, and prefixing it produces a scheme followed by a
    // path that resolves to nothing.
    assert.equal(prefixUrl('/local/style.json'), '/local/style.json');
    assert.equal(prefixUrl('mapbox://styles/x'), 'mapbox://styles/x');
  });

  it('passes through anything that was never prefixed', () => {
    assert.equal(realUrl('https://example.test/a'), 'https://example.test/a');
  });
});

describe('rewriting a style document', () => {
  /** The shape a real vector style has, including the parts easy to forget. */
  const STYLE = {
    version: 8,
    name: 'Liberty',
    glyphs: 'https://tiles.example/fonts/{fontstack}/{range}.pbf',
    sprite: 'https://tiles.example/sprites/liberty',
    sources: {
      openmaptiles: {
        type: 'vector',
        url: 'https://tiles.example/planet.json',
        tiles: ['https://tiles.example/planet/{z}/{x}/{y}.pbf'],
      },
    },
    layers: [
      { id: 'water', type: 'fill', source: 'openmaptiles' },
      // Attribution is HTML with a real link in it, and rewriting that would break the credit a
      // licence requires.
      { id: 'label', type: 'symbol', metadata: { attribution: '<a href="https://osm.org">OSM</a>' } },
    ],
  };

  const rewritten = redirectStyle(STYLE) as typeof STYLE;

  it('redirects tiles, glyphs and the sprite', () => {
    // Glyphs matter as much as tiles: a vector map with none renders every road and town
    // silently unlabelled, which looks like a styling bug rather than a missing download.
    assert.ok(rewritten.glyphs.startsWith(`${TILE_PROTOCOL}://`));
    assert.ok(rewritten.sprite.startsWith(`${TILE_PROTOCOL}://`));
    assert.ok(rewritten.sources.openmaptiles.tiles[0]?.startsWith(`${TILE_PROTOCOL}://`));
    assert.ok(rewritten.sources.openmaptiles.url.startsWith(`${TILE_PROTOCOL}://`));
  });

  it("keeps the tile template braces intact", () => {
    /*
     * The trap that would take the whole map out. `{` and `}` are in the WHATWG path
     * percent-encode set, so running a template through `new URL().toString()` yields
     * `%7Bz%7D/%7Bx%7D/%7By%7D.pbf` and every request 404s — with nothing in the error naming the
     * cause.
     */
    assert.match(rewritten.sources.openmaptiles.tiles[0] ?? '', /\{z\}\/\{x\}\/\{y\}\.pbf$/);
    assert.match(rewritten.glyphs, /\{fontstack\}\/\{range\}\.pbf$/);
  });

  it('does not touch anything that is not a URL', () => {
    // A blanket walk over every string would rewrite layer ids, text fields and attribution HTML.
    assert.equal(rewritten.name, 'Liberty');
    assert.equal(rewritten.layers[0]?.id, 'water');
    assert.equal(
      (rewritten.layers[1] as { metadata: { attribution: string } }).metadata.attribution,
      '<a href="https://osm.org">OSM</a>',
    );
  });

  it('handles a sprite given as an array, which newer styles do', () => {
    // The shape changed between style versions, and enumerating known shapes is how a style one
    // version newer quietly stops being cached.
    const style = redirectStyle({
      sprite: [{ id: 'default', url: 'https://tiles.example/sprites/liberty' }],
    }) as { sprite: { id: string; url: string }[] };

    assert.equal(style.sprite[0]?.id, 'default');
    assert.ok(style.sprite[0]?.url.startsWith(`${TILE_PROTOCOL}://`));
  });

  it('leaves a style that has nothing remote in it unchanged', () => {
    const local = { version: 8, sources: {}, layers: [] };
    assert.deepEqual(redirectStyle(local), local);
  });
});
