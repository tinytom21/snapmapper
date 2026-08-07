/**
 * Stepping from one photo to the next.
 *
 * Its own module so it can be tested without a browser, and because the edge cases are the whole
 * point: the ends of the list must stop rather than wrap, and a name that is no longer in the list
 * must not silently resolve to whatever now sits at that index.
 */

/**
 * The name `delta` places away, or `null` at the ends.
 *
 * Deliberately does not wrap. Wrapping in a preview means pressing Right at the last photo takes
 * you to the first, which reads as the list having jumped rather than as having reached the end.
 */
export function neighbourName(
  names: readonly string[],
  current: string,
  delta: number,
): string | null {
  const at = names.indexOf(current);
  // Not in the list at all — after a re-scan, say. Guessing a neighbour from a stale index would
  // show a different photograph than the one asked for.
  if (at < 0) return null;

  return names[at + delta] ?? null;
}
