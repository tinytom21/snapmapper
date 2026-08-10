/**
 * Locations written by an earlier session, and what to do when they disagree with the original.
 *
 * A photograph geotagged last week is placed. The coordinates are on disk — they are simply not in
 * the file being read, because saving writes a *copy* into `geotagged/` and leaves the original
 * untouched. Reading only the original therefore shows a photograph that has already been done as
 * though nothing had happened, which is what this exists to fix.
 *
 * Two places, read two different ways, and the difference is not cosmetic:
 *
 *   - **JPEG** — the copy at `geotagged/<name>`, read through `Composite:GPSLatitude`.
 *   - **Raw** — the sidecar `<base>.xmp` beside the file, read through **`XMP:GPSLatitude`**. An
 *     XMP has no `Composite:GPSLatitude`: there is nothing to compose it from, because the value
 *     *is* the XMP tag. Asking for Composite against a sidecar returns nothing at all, and the
 *     symptom is not an error — it is a raw photograph that quietly goes on looking unplaced.
 *
 * ## The disagreement, which is the part that needed deciding
 *
 * This introduces a second source of truth for where a photograph is, so the two can differ. Most
 * of the time they do not, and the cases fall out:
 *
 *   - the original has nothing and the copy has something — the copy is the answer, silently;
 *   - both say the same place — nothing to ask;
 *   - the copy has nothing — there is nothing to adopt.
 *
 * The remaining case is a real disagreement: the original carries GPS *and* an earlier session
 * placed the copy somewhere else. Neither is automatically right. The camera's own fix can be a
 * cold start in a city; the earlier placement can be last week's mistake. So it is put to the user
 * rather than resolved by a rule — `findPriorLocations` separates the two piles and the interface
 * asks about the second.
 *
 * `SAME_PLACE_METRES` is what separates them, and it is deliberately not zero. A coordinate that
 * has been through EXIF's degrees/minutes/seconds rationals and back is not bit-identical to the
 * decimal that went in, so an exact comparison would raise a question about every single
 * photograph that had ever been saved — the feature would be unusable on its first run.
 */

import { distanceMetres, type Coordinates } from './gps.ts';
import type { PhotoEntry } from './session.ts';

/**
 * How far apart two readings of one photograph may be and still count as the same place.
 *
 * One metre. Well above the round-trip error through EXIF rationals — which is a few millimetres,
 * since `Composite:GPSLatitude` is rendered from thirds of a degree at rational precision — and far
 * below any placement a person would make deliberately. Dragging a pin one metre on the map is not
 * possible at any zoom the application offers, so nothing a user did on purpose can hide under it.
 */
export const SAME_PLACE_METRES = 1;

/** Where a prior location was found. The two are read through different tags — see the file note. */
export type PriorSource = 'copy' | 'sidecar';

/** A location an earlier session left on disk, for a photograph now open. */
export interface PriorLocation {
  /** The *photograph's* name, not the file the coordinates were read from. */
  readonly name: string;
  readonly coordinates: Coordinates;
  readonly source: PriorSource;
  /** The file it came out of, for display: `geotagged/DSC00119.JPG`, `DSC00516.xmp`. */
  readonly location: string;
}

/** Which of the two disagreeing positions to believe. */
export type LocationChoice = 'original' | 'copy';

/**
 * One photograph whose original and prior copy disagree about where it was taken.
 *
 * Carries the distance so the interface can say how far apart they are without recomputing it.
 * Three metres and three kilometres are the same question and completely different answers.
 */
export interface LocationConflict {
  readonly name: string;
  /** What is in the file itself. */
  readonly original: Coordinates;
  /** What an earlier session wrote. */
  readonly prior: PriorLocation;
  readonly metresApart: number;
}

/** The two piles: what can be adopted without asking, and what has to be put to the user. */
export interface PriorLocationReview {
  /**
   * Priors that are not in dispute — the original had no location, or it agrees.
   *
   * Adopted straight into `PhotoEntry.existing`, which renders them as placed with no change to
   * the map and, crucially, **no staged edit**: these coordinates are already on disk. A
   * photograph shown as placed from a copy must not then be counted as unsaved work.
   */
  readonly adopt: readonly PriorLocation[];
  readonly conflicts: readonly LocationConflict[];
}

export function samePlace(a: Coordinates, b: Coordinates): boolean {
  return distanceMetres(a, b) <= SAME_PLACE_METRES;
}

/**
 * Sort prior locations into the ones to adopt and the ones to ask about.
 *
 * Pure, and takes entries rather than a session on purpose: this runs before the interface has
 * anything to show, and the answer does not depend on staged edits. A photograph that could not be
 * read is skipped — it cannot be written either, so adopting a location for it would put a pin on
 * the map for a file the application has already given up on.
 */
export function findPriorLocations(
  entries: readonly PhotoEntry[],
  priors: readonly PriorLocation[],
): PriorLocationReview {
  const byName = new Map(entries.map((entry) => [entry.ref.name, entry]));
  const adopt: PriorLocation[] = [];
  const conflicts: LocationConflict[] = [];

  for (const prior of priors) {
    const entry = byName.get(prior.name);
    if (!entry || entry.error !== undefined) continue;

    const original = entry.existing;
    if (!original || samePlace(original, prior.coordinates)) {
      adopt.push(prior);
      continue;
    }

    conflicts.push({
      name: prior.name,
      original,
      prior,
      metresApart: distanceMetres(original, prior.coordinates),
    });
  }

  return { adopt, conflicts };
}
