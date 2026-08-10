/**
 * Which markers can afford to show their photograph, and which have to stay a dot.
 *
 * A thumbnail marker answers the question a dot cannot: *which frame is that?* But a 52-pixel tile
 * is thirteen times the area of the dot it replaces, so a walk round a park — fifty photographs
 * inside a few hundred metres — becomes a pile of overlapping tiles hiding both the map and each
 * other. The suggestion on the table was a zoom threshold, and this is that idea made to fit the
 * data rather than a guess: **a photograph draws as a tile unless another photograph is close
 * enough on screen to collide with it.**
 *
 * That is better than a fixed zoom in the way that matters. A day in one town and a fortnight
 * across Europe need different thresholds and nobody can pick one for both; the same rule, asked
 * in pixels, gives the town dots and the tour pictures, and gives a lone outlier its picture even
 * when the rest of the set is a huddle.
 *
 * ## Pixels, and why panning cannot make it flicker
 *
 * The distance between two fixed points **in screen pixels does not change when you pan** — only
 * when you zoom. So this is recomputed on zoom alone, and a marker cannot flip between a picture
 * and a dot while you are dragging the map, which is the failure a naive grid of screen cells
 * would have: two pins either side of a cell boundary would swap appearance every few pixels of
 * pan, for no reason the user could see.
 *
 * Pairwise, and deliberately not a quadtree. Two hundred photographs is 20,000 distance
 * comparisons of two numbers each, which is nothing, and it happens on a zoom rather than a frame.
 * A spatial index here would be more code, more to get wrong, and unmeasurably faster.
 */

/** A pin projected to screen pixels. `x`/`y` are `map.project()` output. */
export interface ProjectedPin {
  readonly name: string;
  readonly x: number;
  readonly y: number;
}

/**
 * Tile width in CSS pixels.
 *
 * Big enough to recognise a photograph you took, small enough that several fit on a phone screen
 * without becoming the map. The height follows from the aspect ratio in the stylesheet.
 */
export const THUMB_WIDTH_PX = 52;

/**
 * How close two photographs may be before both give up their picture.
 *
 * The tile width plus a little, so tiles that merely touch are already dots: two tiles sharing an
 * edge are just as unreadable as two overlapping, and the point of the rule is legibility rather
 * than avoiding literal overlap.
 */
export const CROWDING_GAP_PX = THUMB_WIDTH_PX + 8;

/**
 * The photographs too close to anything else to be worth drawing as a picture.
 *
 * Distance is compared **squared**, so nothing takes a square root: at 20,000 comparisons the
 * difference is not worth measuring, but neither is the cost of not doing it.
 *
 * A pin exactly on top of another is crowded, which is the common case rather than an edge one —
 * a burst of frames from one spot lands on identical coordinates.
 */
export function crowdedNames(
  pins: readonly ProjectedPin[],
  gap: number = CROWDING_GAP_PX,
): Set<string> {
  const crowded = new Set<string>();
  const limit = gap * gap;

  for (let i = 0; i < pins.length; i += 1) {
    const a = pins[i] as ProjectedPin;
    for (let j = i + 1; j < pins.length; j += 1) {
      const b = pins[j] as ProjectedPin;

      // Both are hidden by a collision, not just the later one: neither is readable.
      if (crowded.has(a.name) && crowded.has(b.name)) continue;

      const dx = a.x - b.x;
      const dy = a.y - b.y;
      if (dx * dx + dy * dy < limit) {
        crowded.add(a.name);
        crowded.add(b.name);
      }
    }
  }

  return crowded;
}

/**
 * Whether this marker draws its photograph.
 *
 * **A selected photograph always does, crowded or not**, and that is the whole reason the feature
 * is worth having: picking a frame in the list and seeing *which picture* it is on the map is the
 * check nobody can do from a dot. It is also safe to exempt, because selection brings the marker
 * to the front — see `markerZIndex` — so the tile is drawn over the huddle rather than into it.
 *
 * No thumbnail means no tile. Some photographs have none: a frame the camera wrote without one, or
 * one whose metadata read failed. A tile with an empty box in it says less than a dot.
 */
export function showsThumbnail(
  pin: { readonly name: string; readonly selected: boolean; readonly thumbnail?: string },
  crowded: ReadonlySet<string>,
): boolean {
  if (!pin.thumbnail) return false;
  if (pin.selected) return true;
  return !crowded.has(pin.name);
}

/**
 * Stacking order, because DOM markers stack by the order they were added.
 *
 * MapLibre appends each marker as it is created, so without an explicit z-index the photograph on
 * top is whichever happened to be reconciled last — and the one you just selected is usually
 * *underneath* something, which is exactly when you need to see it. Reconciliation only adds new
 * markers, so the order is effectively the order photographs were first placed and drifts further
 * from anything meaningful the longer a session runs.
 *
 * Three levels, in the order of how much the user currently cares: what they picked, what they
 * have changed and not saved, and everything else.
 */
export function markerZIndex(pin: { readonly selected: boolean; readonly pending: boolean }): number {
  if (pin.selected) return 3;
  if (pin.pending) return 2;
  return 1;
}
