/**
 * Choosing which of a folder's track files covers a set of photographs.
 *
 * The workflow this exists for: a logger running permanently on a phone, writing one GPX per day
 * into one folder, forever. The folder never changes, so being asked which file to use on every
 * shoot is asking a question the photographs already answer.
 *
 * **Chosen by the times inside the files, never by the dates in their names.** Filenames are a
 * convention, not a fact — `20240701.gpx`, `2024-07-01_walk.gpx` and `track_1719...gpx` are all
 * real, and a file named for the day it was *written* is off by one for anything after midnight.
 * The times inside are the thing that is actually true, and reading them is cheap: see `gpxSpan`.
 *
 * That choice also disposes of the midnight problem without special-casing it. A photograph taken
 * at ten past midnight has an instant; whichever file covers that instant is the file, whatever
 * either of them is called. Where a shoot straddles the boundary, both files overlap the range and
 * both are taken — see `mergeTracks`.
 */

/** A file in the track folder, with the span read out of it. */
export interface TrackCandidate {
  readonly name: string;
  /** Absent when the file could not be read or holds no times at all. */
  readonly span?: { readonly from: number; readonly to: number };
}

/**
 * How far either side of the photographs to look.
 *
 * This is slack for the camera clock, which is the one quantity in the whole selection that is
 * *known* to be wrong — that is why the app has a clock panel at all. Twelve hours is chosen to be
 * comfortably more than any drift that has gone unnoticed, and it costs nothing to be generous
 * here: a file that overlaps but holds nothing near the photographs contributes points the matcher
 * then refuses on its own tolerance. Selecting one file too many is invisible; selecting one too
 * few is a shoot that will not place.
 */
export const SELECTION_PAD_MS = 12 * 60 * 60 * 1000;

export interface TrackChoice {
  /** Files to load and merge, in time order. Empty when nothing overlaps. */
  readonly chosen: readonly TrackCandidate[];
  /** Candidates that had no readable span. Reported rather than silently ignored. */
  readonly unreadable: readonly string[];
  /**
   * The nearest file when nothing overlapped, and how far off it was in milliseconds.
   *
   * So the interface can say "the closest track is from three days earlier" rather than "no
   * match" — which is the difference between a user who knows the logger was off that day and one
   * who thinks the feature is broken.
   */
  readonly nearest?: { readonly name: string; readonly offBy: number };
}

/**
 * Pick the files covering a photo range.
 *
 * `photos` is the span of the photographs' *corrected* instants — the session's zone and drift
 * already applied. Handing raw camera readings in would reintroduce exactly the error the padding
 * is here to absorb, and on a badly-set clock could select the wrong day outright.
 */
export function chooseTracks(
  candidates: readonly TrackCandidate[],
  photos: { readonly from: number; readonly to: number },
  padMs: number = SELECTION_PAD_MS,
): TrackChoice {
  const unreadable = candidates.filter((one) => !one.span).map((one) => one.name);
  const usable = candidates.filter(
    (one): one is TrackCandidate & { span: { from: number; to: number } } => one.span !== undefined,
  );

  const from = photos.from - padMs;
  const to = photos.to + padMs;

  // Overlap, not containment. A logger restarted mid-afternoon leaves a file that covers half the
  // shoot, and half a track is worth far more than none.
  const chosen = usable
    .filter((one) => one.span.from <= to && one.span.to >= from)
    .sort((a, b) => a.span.from - b.span.from);

  if (chosen.length > 0) return { chosen, unreadable };

  let nearest: TrackChoice['nearest'];
  for (const one of usable) {
    // Distance from the photo range to the file's span: zero inside, positive outside.
    const offBy = Math.max(photos.from - one.span.to, one.span.from - photos.to, 0);
    if (!nearest || offBy < nearest.offBy) nearest = { name: one.name, offBy };
  }

  return { chosen: [], unreadable, ...(nearest ? { nearest } : {}) };
}

/**
 * The span of a set of photographs, from whatever instants are known.
 *
 * `undefined` when not one photograph has a readable date, which is a different situation from an
 * empty folder and gets a different message.
 */
export function photoSpan(
  instants: readonly (Date | undefined)[],
): { readonly from: number; readonly to: number } | undefined {
  let from = Infinity;
  let to = -Infinity;

  for (const instant of instants) {
    if (!instant) continue;
    const time = instant.getTime();
    if (time < from) from = time;
    if (time > to) to = time;
  }

  return Number.isFinite(from) ? { from, to } : undefined;
}
