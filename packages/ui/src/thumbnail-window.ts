/**
 * How much of a file's head to read when looking for its thumbnail — measured, then adjusted.
 *
 * ## The round trip is the cost, not the bytes
 *
 * Two reports from a Galaxy S23, one reading its own JPEGs off internal storage and one reading an
 * A6400 card through a reader:
 *
 * | | reads per file | KB per call | ms per call | ms per file |
 * |---|---|---|---|---|
 * | phone storage | 1.75 | 50 | **107** | 187 |
 * | SD card | 1.17 | 43 | **113** | 133 |
 * | an earlier run at a 128KB window | 1.00 | 128 | **128** | 128 |
 *
 * The middle column is the finding. Tripling the bytes in a call costs about **15 ms**; making a
 * second call costs about **110 ms**. So a read is charged per round trip, near enough, and the
 * previous conclusion — shrink the window, since reading dominates — pulled the wrong lever: it
 * cut the bytes and bought a second round trip for three quarters of the photographs on the phone,
 * which is why that device came out *slower* at 187 ms than the card at 133 ms.
 *
 * ## So the window is fitted to the camera, not guessed
 *
 * 48KB is right for an A6400 and wrong for an S23, whose thumbnail is itself about **53KB** — no
 * fixed number is right for both, and there was no way to know either from here. Rather than pick
 * one, the first batch measures where the thumbnails actually end and every later batch reads that
 * far in one go. It converges after a single batch, because `locateThumbnail` reports the exact end
 * offset even when the bytes are not there yet.
 *
 * **It only ever grows.** A card of mixed cameras would otherwise oscillate — shrink to fit the
 * Sony, then pay a second read on the next Samsung — and the cost of an over-large window is
 * fifteen milliseconds while the cost of an under-large one is a hundred and ten.
 */

import { THUMBNAIL_LOCATE_BYTES } from '@snapmapper/core';

/**
 * Where to start, before anything has been measured.
 *
 * **80KB, not the 48KB the parser needs**, because starting small has a cost and starting large
 * does not. Both of the user's devices tuned themselves to exactly 80KB — a Samsung thumbnail
 * ending at 60KB, an A6400's at 51KB — and the reads that got them there were the only second reads
 * in either run: 8 of 311 and 6 of 1126. Beginning at the answer removes those.
 *
 * Nothing is paid for the extra bytes. Measured across four runs, a call cost 96 ms at 80KB, 107 ms
 * at 50KB, 113 ms at 43KB and 128 ms at 128KB — no useful signal, against 110 ms for a second call.
 *
 * `THUMBNAIL_LOCATE_BYTES` stays the floor in core: it is the smallest window that can reach IFD1
 * on the files this was verified against, and is what the spike and a bare `readThumbnails` use.
 */
export const MIN_WINDOW_BYTES = Math.max(80 * 1024, THUMBNAIL_LOCATE_BYTES);

/**
 * Never read more than this, however deep a thumbnail turns out to be.
 *
 * A ceiling rather than a target: at some size the transfer really does start to matter, and a
 * pathological file claiming a thumbnail halfway through a 25MB raw must not drag every subsequent
 * read out with it. Past this the exact-range second read is the right answer — it is one extra
 * round trip on the few files that need it rather than on all of them.
 */
export const MAX_WINDOW_BYTES = 256 * 1024;

/** Rounded to this, so a folder of near-identical files settles on one number and stays there. */
const STEP_BYTES = 16 * 1024;

/**
 * The window to use next, given the deepest thumbnail seen so far.
 *
 * `deepestEnd` is where the last batch's furthest thumbnail *ended* — known exactly, since the
 * offsets are in the EXIF block whether or not the bytes were fetched. A little is added on top
 * before rounding, because the very file that defined the deepest end would otherwise land flush
 * against the edge and any slightly longer one in the next batch would miss again.
 *
 * **Nothing changes unless something actually missed.** Growing to fit a thumbnail that was already
 * inside the window would pull more bytes for no fewer round trips, which is the wrong trade in the
 * one direction the measurements are clear about.
 */
export function nextWindow(current: number, deepestEnd: number): number {
  if (deepestEnd <= current) return current;

  const wanted = Math.ceil((deepestEnd + STEP_BYTES) / STEP_BYTES) * STEP_BYTES;
  return Math.min(MAX_WINDOW_BYTES, Math.max(current, MIN_WINDOW_BYTES, wanted));
}
