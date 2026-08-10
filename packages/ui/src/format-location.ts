/**
 * Wording for a position and for the gap between two of them.
 *
 * In its own module rather than beside the component that uses it, because a `.tsx` file cannot be
 * imported by the test runner — Node strips types but not JSX — and these two are the only part of
 * the conflict prompt with a right and a wrong answer.
 */

/**
 * Metres up to a kilometre, then kilometres.
 *
 * Whole metres below a kilometre: the tenths are noise from two GPS fixes, and printing them
 * implies a precision that neither reading has. One decimal place up to ten kilometres, none
 * above — by then the question is "somewhere else entirely" and the digits do not help answer it.
 */
export function formatDistance(metres: number): string {
  if (metres < 1000) return `${Math.round(metres)} m`;
  return `${(metres / 1000).toFixed(metres < 10_000 ? 1 : 0)} km`;
}

/**
 * Five decimal places — about a metre at the equator.
 *
 * The resolution of the question being asked. Seven, which is what the writer emits, would be
 * eleven millimetres and two digits of noise on each of four numbers the reader is comparing by
 * eye.
 */
export function formatCoordinates(coordinates: {
  readonly latitude: number;
  readonly longitude: number;
}): string {
  return `${coordinates.latitude.toFixed(5)}, ${coordinates.longitude.toFixed(5)}`;
}
