/**
 * Where the map should be looking.
 *
 * Separate from `PhotoMap.tsx` so it can be tested at all: that module imports MapLibre, which
 * needs a browser, while this is arithmetic over coordinates and needs nothing.
 */

import type { Coordinates } from '@snapmapper/core';

/**
 * Whether the map should be on screen at all.
 *
 * A rule rather than an inline condition because all three of its answers were bugs at some
 * point: a map shown on the landing screen before any photo was chosen, a map given 40vh beside a
 * crushed photo list on a phone, and a map torn down and rebuilt on every tab switch — which
 * discards the tiles and the viewport, so returning lands somewhere other than where you left.
 *
 * The caller mounts the map the first time this is true and only hides it afterwards.
 */
export function isMapVisible(
  hasSession: boolean,
  narrow: boolean,
  pane: 'photos' | 'map',
): boolean {
  if (!hasSession) return false;
  return !narrow || pane === 'map';
}

/**
 * Whether the map should stay in the document, given that it is not on screen.
 *
 * Mounting is a **latch**, and it has to be: within a session the map is hidden rather than
 * unmounted, because rebuilding a MapLibre instance discards the tiles, the viewport and every
 * marker. But a latch with no release is a bug waiting to happen, and it happened — *"click start
 * again and it returns me to a page that is bugged, the text width is too narrow"*.
 *
 * Ending the session is the release. The landing screen is laid out full width only when there is
 * no map beside it, so a map still mounted from the previous session left the whole hero squeezed
 * into the sidebar's 26rem: measured at 1900px, `.landing-main` came out **375px wide with a
 * 188px hero column**, against 1112px and 611px once released. It reads exactly like a mobile
 * layout served to a desktop, which is what it was.
 *
 * Nothing is lost by releasing it. The viewport and the markers belong to the session that just
 * ended, and the tiles are in the browser's cache — see `offline-tiles.ts`.
 */
export function keepMapMounted(mounted: boolean, visible: boolean, hasSession: boolean): boolean {
  if (!hasSession) return false;
  return mounted || visible;
}

/** `[[west, south], [east, north]]`, MapLibre's `LngLatBoundsLike`. */
export type Bounds = [[number, number], [number, number]];

export interface FocusTarget {
  readonly bounds: Bounds;
  /**
   * Identifies *what* is being looked at, not where it is.
   *
   * The map recentres when this changes and not otherwise, so dragging a pin does not yank the
   * viewport out from under the drag — the selection is unchanged, only its position moved.
   */
  readonly key: string;
  /** A single point, or several photos in the same spot. Framing it needs a chosen zoom. */
  readonly single: boolean;
}

export function boundsOf(
  points: readonly { readonly coordinates: Coordinates }[],
): Bounds | null {
  if (points.length === 0) return null;

  let west = 180;
  let east = -180;
  let south = 90;
  let north = -90;

  for (const point of points) {
    west = Math.min(west, point.coordinates.longitude);
    east = Math.max(east, point.coordinates.longitude);
    south = Math.min(south, point.coordinates.latitude);
    north = Math.max(north, point.coordinates.latitude);
  }

  return [[west, south], [east, north]];
}

/**
 * What to frame for the current selection, or `null` to leave the map alone.
 *
 * Photos with no location contribute nothing, so selecting unplaced photos does not move the map.
 * That is the point: where the map is is where you are about to place them.
 */
export function selectionFocus(
  pins: readonly { readonly name: string; readonly coordinates: Coordinates; readonly selected: boolean }[],
): FocusTarget | null {
  const chosen = pins.filter((pin) => pin.selected);
  const bounds = boundsOf(chosen);
  if (!bounds) return null;

  const [[west, south], [east, north]] = bounds;
  return {
    bounds,
    key: chosen.map((pin) => pin.name).sort().join(' '),
    single: west === east && south === north,
  };
}
