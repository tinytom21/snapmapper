/**
 * The palette, checked against the stylesheet itself.
 *
 * This exists because of a real report: *"the text on the save button is not legible."* It was
 * true, and no amount of looking at it would have told me by how much. Measured, the answer was
 * 4.88:1 for white on the light theme's teal — legal for body text, muddy on a button — and
 * **2.56:1** for white on the dark theme's lifted teal, which is a plain failure.
 *
 * So the values live in `styles.css` and this reads them back out. Nothing is duplicated here:
 * a test holding its own copy of the palette would pass while the app shipped something else.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';

import { contrastRatio } from '../src/contrast.ts';
import { THUMB_WIDTH_PX } from '../src/marker-layout.ts';

const css = await readFile(
  path.join(import.meta.dirname, '..', 'src', 'styles.css'),
  'utf8',
);

/**
 * The custom properties from one `:root` block.
 *
 * `light` is the first block; `dark` is the one inside `prefers-color-scheme: dark`, layered over
 * the light values the way the cascade does it — so a token the dark block leaves alone is
 * inherited here too, and a test cannot pass by reading a value the browser would never use.
 */
function tokens(): { light: Record<string, string>; dark: Record<string, string> } {
  const blocks = [...css.matchAll(/:root\s*\{([^}]*)\}/g)].map((match) => match[1] ?? '');
  assert.ok(blocks.length >= 2, 'expected a light :root and a dark one');

  const read = (block: string) => {
    const found: Record<string, string> = {};
    for (const [, name, value] of block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
      if (name && value) found[name] = value.trim();
    }
    return found;
  };

  const light = read(blocks[0] ?? '');
  const darkBlock = css.slice(css.indexOf('prefers-color-scheme: dark'));
  const dark = { ...light, ...read(/:root\s*\{([^}]*)\}/.exec(darkBlock)?.[1] ?? '') };
  return { light, dark };
}

const { light, dark } = tokens();
const themes = [['light', light], ['dark', dark]] as const;

/** Every pair the interface actually paints, and why each threshold is what it is. */
const PAIRS = [
  {
    what: 'primary button text on its background',
    fg: '--accent-ink',
    bg: '--accent',
    // AAA. This is the Save button: the one control whose label must never be a squint, and the
    // specific thing that was reported as illegible.
    least: 7,
  },
  { what: 'body text on the page', fg: '--fg', bg: '--bg', least: 7 },
  { what: 'body text on a raised surface', fg: '--fg', bg: '--surface', least: 7 },
  // Secondary text: dates, coordinates, hints. AA is the right bar — pushing these to AAA would
  // mean they stopped reading as secondary at all.
  { what: 'dimmed text on the page', fg: '--dim', bg: '--bg', least: 4.5 },
  { what: 'dimmed text on a raised surface', fg: '--dim', bg: '--surface', least: 4.5 },
  { what: 'the accent as text or an icon', fg: '--accent', bg: '--bg', least: 4.5 },
  { what: 'the accent on a selected row', fg: '--accent', bg: '--accent-wash', least: 4.5 },
  // Status words — "unsaved", "unreadable", a verified save.
  { what: 'the staged colour as text', fg: '--pending', bg: '--bg', least: 4.5 },
  { what: 'the danger colour as text', fg: '--danger', bg: '--bg', least: 4.5 },
  { what: 'the saved colour as text', fg: '--ok', bg: '--bg', least: 4.5 },
] as const;

describe('the palette in styles.css', () => {
  for (const [name, theme] of themes) {
    describe(name, () => {
      for (const pair of PAIRS) {
        it(`${pair.what} is at least ${pair.least}:1`, () => {
          const fg = theme[pair.fg];
          const bg = theme[pair.bg];
          assert.ok(fg, `${pair.fg} is missing from the ${name} theme`);
          assert.ok(bg, `${pair.bg} is missing from the ${name} theme`);

          const ratio = contrastRatio(fg, bg);
          assert.ok(
            ratio >= pair.least,
            `${pair.what} in ${name}: ${fg} on ${bg} is ${ratio.toFixed(2)}:1, `
            + `needs ${pair.least}:1`,
          );
        });
      }
    });
  }

  it('never paints a literal white on the accent', () => {
    /*
     * The trap that caused this, twice: `color: #fff` beside `background: var(--accent)` looks
     * right in the light theme and fails outright in the dark one, where the accent is a lifted
     * teal. Both the Save button and the map's placement pill had it.
     */
    const offenders: string[] = [];
    for (const [, rule] of css.matchAll(/\{([^}]*background:\s*var\(--accent\)[^}]*)\}/g)) {
      if (rule && /color:\s*#fff/i.test(rule)) offenders.push(rule.trim().slice(0, 80));
    }
    assert.deepEqual(offenders, [], 'use var(--accent-ink) instead of a literal');
  });

  it('sizes the grid rows to their content, not to the space available', () => {
    /*
     * The bug this pins shipped and was plainly visible: overlapping photographs.
     *
     * The implicit rows were `auto`, and in a grid with a definite height — `.photo-grid` has
     * `flex: 1` — `auto` rows get stretched to share that height out. Measured with ten photos:
     * rows of 25.78px for tiles 107px tall, so every tile overflowed into the ones below. It moved
     * around as sections were opened and closed, because that changed the height available.
     *
     * `max-content` rows do not stretch, and a tile's `aspect-ratio` does contribute to its
     * max-content height. `align-content: start` alone does not fix it — that was measured too.
     */
    const rule = /\.photo-grid\s*\{([\s\S]*?)\}/.exec(css)?.[1] ?? '';
    assert.match(rule, /grid-auto-rows:\s*max-content/);
  });

  it('draws a marker tile at exactly the width the crowding rule assumes', () => {
    /*
     * The two have to agree, and nothing else would notice if they stopped.
     *
     * `crowdedNames` decides whether two photographs can both show a picture by measuring the gap
     * between them in pixels, against the tile width. Widen the tile in the stylesheet alone and
     * the rule goes on permitting tiles that now overlap; narrow it and the map hides pictures
     * that would have fitted. Either way it looks like a judgement call rather than a bug.
     */
    const rule = /\.pin\.pin-tile\s*\{([\s\S]*?)\}/.exec(css)?.[1] ?? '';
    const width = /--marker-thumb-w:\s*(\d+)px/.exec(rule)?.[1];

    assert.equal(Number(width), THUMB_WIDTH_PX);
  });

  it('keeps the white outline and the drop shadow on both marker shapes', () => {
    // What makes a marker findable against Liberty's colourful ground, and the reason markers do
    // not have to compete on colour — which is what lets a photograph fill one.
    const dot = /\.pin\s*\{([\s\S]*?)\}/.exec(css)?.[1] ?? '';
    assert.match(dot, /border:\s*2px solid #fff/);
    assert.match(dot, /box-shadow:/);

    // The tile keeps the border by not overriding it, and restates the shadow in each state ring.
    const tile = /\.pin\.pin-tile\s*\{([\s\S]*?)\}/.exec(css)?.[1] ?? '';
    assert.doesNotMatch(tile, /border:/, 'the tile must inherit the white border, not replace it');
    /*
     * Built with `String.raw`, not a plain template literal.
     *
     * In a normal template literal `\.` is just `.` and `\s` is a literal `s`, so the pattern
     * silently becomes `.pin.pin-tile.pin-pendings*{` and matches nothing — a test that fails for
     * a reason that has nothing to do with the stylesheet. It did exactly that once.
     */
    for (const state of ['pin-pending', 'pin-selected']) {
      const pattern = String.raw`\.pin\.pin-tile\.${state}\s*\{([\s\S]*?)\}`;
      const ring = new RegExp(pattern).exec(css)?.[1] ?? '';
      assert.match(ring, /box-shadow:[^;]*rgb\(0 0 0/, `${state} must restate the drop shadow`);
    }
  });

  it('defines the dark theme by overriding tokens, not by restyling components', () => {
    // The whole reason a palette swap is cheap. A component styled inside the media query is a
    // component that has to be maintained twice.
    const darkBlock = css.slice(css.indexOf('@media (prefers-color-scheme: dark)'));
    const body = /\{([\s\S]*?)\n\}/.exec(darkBlock)?.[1] ?? '';
    assert.match(body, /:root\s*\{/);
    assert.doesNotMatch(body, /\.\w[\w-]*\s*\{/, 'no component selectors in the dark block');
  });
});
