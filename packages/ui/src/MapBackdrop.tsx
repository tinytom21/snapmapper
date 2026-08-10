/**
 * A street-map pattern behind the landing screen, drawn rather than downloaded.
 *
 * ## Why generated
 *
 * The obvious way to get a dark monochrome city map is to use one — and the two candidates both
 * fail. A stock image is somebody else's copyright, and this project takes licensing seriously
 * enough to ship a 34KB notices file. A *real* map from the tile server would be worse: a network
 * request on first paint, in an app whose whole premise is that it works with the network switched
 * off, to fetch something nobody is meant to look at directly.
 *
 * So it is drawn. It costs no request, no licence and no bytes beyond this file, it is sharp at any
 * pixel density, and it recolours itself for the theme because it is `currentColor` all the way
 * down. The same argument as `scripts/make-icons.mjs`, where a dependency to draw two circles and a
 * triangle would have been larger than the encoder that draws them.
 *
 * ## Why it looks like a city rather than like noise
 *
 * A road network has a specific structure, and getting any of the three parts wrong makes it read
 * as wallpaper:
 *
 *   - **Arterials** — a few long routes that cross the whole frame, thicker, gently curving. These
 *     are what make it scan as a map at a glance.
 *   - **Districts** — pockets of local grid, each at its own rotation. Real cities are grids that
 *     disagree with each other, which is why a single uniform grid looks like graph paper.
 *   - **Lanes** — short thin connectors filling the gaps, so the density is not uniform.
 *
 * ## The two rules it must not break
 *
 * **No text.** Not a stylistic preference: a place name in the background of a page about
 * *photographs of places* would be read as information, and it would be wrong information.
 *
 * **Low contrast, and measured rather than eyeballed.** It sits behind body text and buttons, so it
 * cannot compete with them — `--backdrop-ink` is the single dial, and it is deliberately far below
 * anything that would register as an image.
 */

import { useEffect, useRef } from 'react';

/**
 * Fixed seed, so the map is the same map on every visit.
 *
 * A backdrop that reshuffles itself on each load is unsettling in a way that is hard to name — the
 * page looks like it has changed when nothing has. This is decoration, and decoration should stay
 * where it was put.
 */
const SEED = 0x5eed_1a7e;

/** How far past the viewport to draw, so no line ends visibly in mid-air at an edge. */
const BLEED = 120;

/** Deterministic PRNG (mulberry32). Small, fast, and good enough for scattering lines. */
function makeRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b_79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export function MapBackdrop() {
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const target = canvas.current;
    if (!target) return;

    let frame = 0;

    const draw = () => {
      /*
       * Sized from the viewport, not from the parent, because the element is `position: fixed`.
       *
       * Taking the parent's box gave a canvas the width of the content column — 1152 against a
       * 1440 viewport — anchored at the top left, so the pattern stopped in a straight vertical
       * line partway across the screen. Measured.
       *
       * Only the *bitmap* is set here. The element's own size stays with the stylesheet
       * (`inset: 0`), so there is one owner of the layout rather than two disagreeing.
       */
      const width = window.innerWidth;
      const height = window.innerHeight;
      if (width === 0 || height === 0) return;

      /*
       * Capped at 2, exactly as the map is. Past that the difference is invisible at arm's length
       * while the GPU fills nine times the pixels of a 1x screen — and this is a decoration.
       */
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      target.width = Math.round(width * ratio);
      target.height = Math.round(height * ratio);

      const context = target.getContext('2d');
      if (!context) return;

      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, width, height);

      // `currentColor` resolved once: the canvas cannot inherit CSS, so the theme is read off the
      // element and the whole drawing is done in that one ink.
      const ink = getComputedStyle(target).color;
      context.strokeStyle = ink;
      context.lineCap = 'round';
      context.lineJoin = 'round';

      const random = makeRandom(SEED);
      drawDistricts(context, width, height, random);
      drawLanes(context, width, height, random);
      drawArterials(context, width, height, random);
    };

    /*
     * Resizes are coalesced through rAF — a drag fires continuously, and redrawing a few thousand
     * lines per event is what makes a window resize feel broken.
     *
     * The **first** draw is not deferred, though, and that is deliberate. `requestAnimationFrame`
     * is tied to the compositor, so in a tab that is not painting it may never fire at all — which
     * leaves the canvas at its default 300x150 and the backdrop simply absent. Found exactly that
     * way: measured in a harness that does not composite, the bitmap had never been sized. Drawing
     * straight away costs nothing and removes the dependency.
     */
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(draw);
    };

    draw();

    window.addEventListener('resize', schedule);

    // The theme can change under a running page, and the ink is baked into the pixels.
    const scheme = window.matchMedia('(prefers-color-scheme: dark)');
    scheme.addEventListener('change', schedule);

    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', schedule);
      scheme.removeEventListener('change', schedule);
    };
  }, []);

  // `aria-hidden`, and not focusable: it carries no information, and a screen reader announcing a
  // canvas here would be pure noise.
  return <canvas ref={canvas} className="map-backdrop" aria-hidden="true" />;
}

/**
 * Pockets of local grid, each at its own rotation.
 *
 * The rotation is the whole trick. One grid across the frame reads as graph paper; real cities are
 * several grids that disagree, meeting at awkward angles, and that disagreement is what the eye
 * recognises as a street plan.
 */
function drawDistricts(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  random: () => number,
): void {
  const districts = Math.max(6, Math.round((width * height) / 90_000));

  for (let index = 0; index < districts; index += 1) {
    const centreX = random() * (width + BLEED * 2) - BLEED;
    const centreY = random() * (height + BLEED * 2) - BLEED;
    const radius = 90 + random() * 190;
    const angle = random() * Math.PI;
    const spacing = 13 + random() * 16;

    context.save();
    context.beginPath();
    context.arc(centreX, centreY, radius, 0, Math.PI * 2);
    context.clip();
    context.translate(centreX, centreY);
    context.rotate(angle);

    context.lineWidth = 0.7;
    context.globalAlpha = 0.55;
    context.beginPath();
    for (let offset = -radius; offset <= radius; offset += spacing) {
      context.moveTo(-radius, offset);
      context.lineTo(radius, offset);
      // The cross streets are spaced differently, because blocks are rarely square.
      context.moveTo(offset * 1.35, -radius);
      context.lineTo(offset * 1.35, radius);
    }
    context.stroke();
    context.restore();
  }
}

/** Short connectors, scattered, so the density is uneven the way a real city's is. */
function drawLanes(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  random: () => number,
): void {
  const lanes = Math.round((width * height) / 5_500);

  context.save();
  context.lineWidth = 0.6;
  context.globalAlpha = 0.4;
  context.beginPath();

  for (let index = 0; index < lanes; index += 1) {
    const x = random() * (width + BLEED * 2) - BLEED;
    const y = random() * (height + BLEED * 2) - BLEED;
    const angle = random() * Math.PI * 2;
    const length = 18 + random() * 70;
    context.moveTo(x, y);
    context.lineTo(x + Math.cos(angle) * length, y + Math.sin(angle) * length);
  }

  context.stroke();
  context.restore();
}

/**
 * The long routes that cross the whole frame.
 *
 * Drawn last so they sit over the grid, which is the right order: an arterial cuts *through* a
 * street plan rather than stopping at it. Each one walks across the frame with its heading nudged
 * a little at every step, which gives the slow curve a road has and a straight line does not.
 */
function drawArterials(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  random: () => number,
): void {
  const routes = Math.max(5, Math.round(width / 210));

  context.save();
  context.globalAlpha = 1;

  for (let index = 0; index < routes; index += 1) {
    // Start off one edge and head roughly across, so nothing begins in open space.
    const fromLeft = random() > 0.45;
    let x = fromLeft ? -BLEED : random() * width;
    let y = fromLeft ? random() * height : -BLEED;
    let heading = fromLeft
      ? (random() - 0.5) * 1.1
      : Math.PI / 2 + (random() - 0.5) * 1.1;

    context.lineWidth = 1.6 + random() * 1.4;
    context.beginPath();
    context.moveTo(x, y);

    const steps = 90;
    const step = (Math.max(width, height) + BLEED * 2) / steps;

    for (let taken = 0; taken < steps; taken += 1) {
      heading += (random() - 0.5) * 0.22;
      x += Math.cos(heading) * step;
      y += Math.sin(heading) * step;
      context.lineTo(x, y);

      if (x < -BLEED * 2 || x > width + BLEED * 2 || y < -BLEED * 2 || y > height + BLEED * 2) {
        break;
      }
    }

    context.stroke();
  }

  context.restore();
}
