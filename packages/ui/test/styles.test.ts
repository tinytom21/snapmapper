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

/**
 * The body of one rule, found by its exact selector.
 *
 * Anchored to the start of a line and required to be followed by `{`, so `.pin` cannot match
 * `.pin-body` or `.pin.pin-tile` — a prefix match would quietly test the wrong rule and pass.
 * Built with `String.raw` at every call site: in a plain template literal `\.` is just `.` and
 * `\s` is a literal `s`, which silently produces a pattern that matches nothing.
 */
function ruleBody(css: string, selector: string): string {
  const match = new RegExp(String.raw`^${selector}\s*\{([\s\S]*?)\}`, 'm').exec(css);
  if (!match) throw new Error(`no rule for ${selector} in styles.css`);
  return match[1] as string;
}

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

  /** `ruleBody` bound to this file's stylesheet, so each call site reads as one line. */
  const block = (selector: string) => ruleBody(css, selector);

  it('draws a marker tile at exactly the width the crowding rule assumes', () => {
    /*
     * The two have to agree, and nothing else would notice if they stopped.
     *
     * `crowdedNames` decides whether two photographs can both show a picture by measuring the gap
     * between them in pixels, against the tile width. Widen the tile in the stylesheet alone and
     * the rule goes on permitting tiles that now overlap; narrow it and the map hides pictures
     * that would have fitted. Either way it looks like a judgement call rather than a bug.
     */
    const rule = block(String.raw`\.pin\.pin-tile \.pin-body`);
    const width = /--marker-thumb-w:\s*(\d+)px/.exec(rule)?.[1];

    assert.equal(Number(width), THUMB_WIDTH_PX);
  });

  it('keeps the white outline and the drop shadow on both marker shapes', () => {
    // What makes a marker findable against Liberty's colourful ground, and the reason markers do
    // not have to compete on colour — which is what lets a photograph fill one.
    const dot = block(String.raw`\.pin-body`);
    assert.match(dot, /border:\s*2px solid #fff/);
    assert.match(dot, /box-shadow:/);

    // The tile keeps the border by not overriding it, and restates the shadow in each state ring.
    const tile = block(String.raw`\.pin\.pin-tile \.pin-body`);
    assert.doesNotMatch(tile, /border:/, 'the tile must inherit the white border, not replace it');
    for (const state of ['pin-pending', 'pin-selected']) {
      const ring = block(String.raw`\.pin\.pin-tile\.${state} \.pin-body`);
      assert.match(ring, /box-shadow:[^;]*rgb\(0 0 0/, `${state} must restate the drop shadow`);
    }
  });

  it('reserves room for the leader on the wrapper MapLibre positions', () => {
    /*
     * This is what makes the marker point at the right place, and it is easy to undo by accident.
     *
     * The marker is anchored `bottom`, so the wrapper's bottom edge sits on the coordinate. The
     * leader is drawn inside the wrapper's own bottom padding, which is why its tip lands exactly
     * there and why a marker that changes shape does not move. Take the padding away and the
     * picture drops onto the coordinate with the leader hanging below it, pointing at nothing —
     * and nothing would fail except the thing the leader was added to promise.
     */
    const wrapper = block(String.raw`\.pin`);
    assert.match(wrapper, /--leader:\s*\d+px/);
    assert.match(wrapper, /padding:\s*0 0 var\(--leader\)/);

    const leader = block(String.raw`\.pin::after`);
    assert.match(leader, /bottom:\s*0/);
    assert.match(leader, /border-top:\s*var\(--leader\) solid #fff/);
  });

  it('never positions or transforms the element MapLibre positions', () => {
    /*
     * `.pin` is MapLibre's element, not ours, and both halves of this have already bitten.
     *
     * `position`: `.maplibregl-marker` sets `position: absolute`, which is what takes a marker out
     * of the flow. `.pin` has the same specificity and this stylesheet loads later, so a
     * `position` here wins — a `position: relative` added to anchor the leader put every marker
     * back into normal flow, stacking them one marker-height apart: measured at 57, 114, 171 …
     * 627 pixels out, an exact multiple per marker.
     *
     * `transform`: MapLibre sets an inline one, and inline beats the stylesheet, so `.pin` carried
     * a `rotate(-45deg)` for months that never once applied.
     */
    const wrapper = block(String.raw`\.pin`);
    assert.doesNotMatch(wrapper, /(^|[;{\s])transform:/);
    assert.doesNotMatch(wrapper, /(^|[;{\s])position:/);
  });

  it('declares each selector once outside the media queries', () => {
    /*
     * The trap that produced "the button layout isn't neat any more", and it had already produced
     * one silent duplicate before that.
     *
     * `.landing-actions` was declared twice at the top level. A later rule turned it from a flex
     * row into a grid without removing the earlier one, so the phone override — written as
     * `flex-direction: column` against the flex version — went on parsing, went on being applied,
     * and did nothing whatever on a grid. The phone quietly got the desktop layout: three buttons
     * in two columns, two and an orphan.
     *
     * Nothing about that is visible in either rule. Only the pair is wrong, and only one of the
     * two is ever in effect, so reading the one you happen to find tells you the wrong thing.
     * `.banner.line` was pasted twice as well, and `.map` once more after that.
     *
     * Media queries are excluded: overriding a base rule inside one is the entire point of them.
     */
    const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');

    // Cut out every `@media` body, braces balanced, so only top-level rules remain.
    let topLevel = '';
    let at = 0;
    for (;;) {
      const start = withoutComments.indexOf('@media', at);
      if (start === -1) { topLevel += withoutComments.slice(at); break; }
      topLevel += withoutComments.slice(at, start);

      let depth = 0;
      let index = withoutComments.indexOf('{', start);
      do {
        if (withoutComments[index] === '{') depth += 1;
        else if (withoutComments[index] === '}') depth -= 1;
        index += 1;
      } while (depth > 0 && index < withoutComments.length);
      at = index;
    }

    const seen = new Map<string, number>();
    for (const [, selector] of topLevel.matchAll(/([^{}]+)\{/g)) {
      const key = (selector ?? '').trim().replace(/\s+/g, ' ');
      if (!key || key.startsWith('@')) continue;
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }

    const repeated = [...seen].filter(([, count]) => count > 1).map(([key]) => key);
    assert.deepEqual(repeated, [], 'merge these into one rule, or the later one wins silently');
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
