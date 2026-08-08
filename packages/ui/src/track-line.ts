/**
 * Turning a GPX track into the line the map draws.
 *
 * Its own module rather than a function inside `PhotoMap.tsx` so that it can be tested: importing
 * the map component under `node:test` would pull in MapLibre, which wants a DOM and a WebGL
 * context. Pure arithmetic on an array has no business being untestable for that reason.
 */

import type { GpxTrack } from '@snapmapper/core';

/**
 * How many points the line is drawn from, at most.
 *
 * A day logged at one fix a second is 86,000 points. MapLibre will render that, but it is a
 * GeoJSON object rebuilt on the main thread whenever the track changes, on a phone, for a line
 * whose shape is indistinguishable at any zoom this map reaches. The line answers exactly one
 * question — *is this the right track?* — and 4,000 points answers it identically.
 */
export const MAX_LINE_POINTS = 4000;

/** `[longitude, latitude]` pairs, in the order MapLibre wants them. */
export type LinePoint = readonly [number, number];

/**
 * The track as map coordinates, sampled down if it is enormous.
 *
 * The first and last fix are always kept. A line stopping short of where the walk actually ended
 * would suggest the file was truncated — a false alarm, raised by the very thing that exists to
 * reassure you the file is right.
 */
export function trackLine(track: GpxTrack | null): readonly LinePoint[] {
  if (!track || track.points.length === 0) return [];

  const step = Math.ceil(track.points.length / MAX_LINE_POINTS);
  const sampled: LinePoint[] = [];

  for (let index = 0; index < track.points.length; index += step) {
    const point = track.points[index];
    if (point) sampled.push([point.longitude, point.latitude]);
  }

  const last = track.points.at(-1);
  if (last && (track.points.length - 1) % step !== 0) sampled.push([last.longitude, last.latitude]);
  return sampled;
}
