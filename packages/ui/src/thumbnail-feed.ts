/**
 * Thumbnails filled in gradually, while the person is choosing.
 *
 * Reported plainly: *"I need a thumbnail in order to select the photos. I can't do it by
 * filename."* Of course not — `DSC01234.JPG` says nothing about what is in the frame, and the whole
 * job here is picking the right frames.
 *
 * The tension is that a thumbnail is not free. It is the camera's own embedded ~6KB JPEG, but
 * getting at it means reading the file's header and running ExifTool: about 43 ms per photograph
 * batched, so a 322-file card is roughly fifteen seconds on a desktop and a couple of minutes on a
 * phone. Waiting for that before showing anything would undo the entire point of the chooser,
 * which is that opening a folder costs nothing.
 *
 * So they arrive in the background, and **what is on screen is fetched first**.
 *
 * ## Only a little beyond what is on screen, and that is measured
 *
 * ExifTool-in-WASM runs on the **main thread**. Measured: a `setTimeout(0)` scheduled before a
 * batch does not fire until after it finishes, so the thread is held solid for **~700 ms per
 * batch** — at every batch size, since the invocation dominates (16 files is 45 ms each, 4 files is
 * 163 ms each, both about 700 ms in total). Sixteen is therefore the right batch, and the thread is
 * going to be unavailable in 700 ms slices whatever else is done.
 *
 * **That is why the fast path matters so much.** `embeddedThumbnail` reads a JPEG's thumbnail out
 * of the header bytes directly — 0.165 ms against 634 ms, byte-identical to ExifTool on every real
 * fixture — so the interpreter is only invoked for what it declines, which in practice is raw.
 * A batch that never touched ExifTool blocks nothing and gets no breather.
 *
 * The feed still reaches only `LOOKAHEAD` past what is on screen, because a raw-heavy card would
 * otherwise fall back for every file and freeze exactly as before. Expanding another day starts it
 * again. Moving the interpreter into a worker remains the fix for the raw case.
 *
 * ## The ordering is the whole design, and it is pure
 *
 * `nextBatch` takes what is wanted, what is already done and what is in flight, and returns what to
 * fetch next. Keeping it a function of three sets — rather than state mutated from a scroll
 * handler — is what makes it testable, and this is exactly the kind of code where an off-by-one
 * means a photograph never loads at all and nobody can say why.
 */

/**
 * How many share one ExifTool invocation.
 *
 * Sixteen, and the measurement says it firmly: one batch costs about 700 ms whatever its size, so
 * four files cost 163 ms each and sixteen cost 45 ms each for the same wait. Smaller batches buy
 * no responsiveness — the block is the same — and cost four times the throughput.
 */
export const THUMBNAIL_BATCH = 16;

/**
 * How far past what is on screen to keep fetching.
 *
 * Raised from 32 once thumbnails stopped needing ExifTool. A JPEG's is now read straight out of the
 * header bytes at **0.165 ms**, so reaching ahead costs disk rather than the main thread, and a
 * whole card of 2000 files is a couple of seconds of reading rather than fifteen minutes of
 * blocking. It is still bounded: raw falls back to ExifTool, and an unbounded reach on a
 * raw-heavy card would be exactly the freeze this was written to avoid.
 */
export const LOOKAHEAD = 512;

export interface FeedState {
  /**
   * Everything the chooser could show, **in the order it is drawn** — not the folder listing.
   *
   * Both passes below follow this order, so it decides which day the reach beyond the screen
   * covers first. Given the listing it went to the oldest photographs on the card, which is the
   * furthest possible point from anywhere anybody was looking. `displayOrder` supplies it.
   */
  readonly all: readonly string[];
  /** On screen now, or recently. Fetched before anything else. */
  readonly wanted: ReadonlySet<string>;
  /** Fetched, successfully or not — either way there is nothing more to do. */
  readonly done: ReadonlySet<string>;
  /** Being fetched right now. */
  readonly inFlight: ReadonlySet<string>;
}

/**
 * The next photographs to fetch thumbnails for, visible ones first.
 *
 * Falls through to the rest of the list once what is on screen is covered, so a card fills itself
 * in while somebody reads the first day — and by the time they scroll, much of it is already there.
 * Returns fewer than `size`, or nothing, when there is nothing left; the caller stops on empty.
 */
export function nextBatch(
  state: FeedState,
  size: number = THUMBNAIL_BATCH,
  lookahead: number = LOOKAHEAD,
): string[] {
  const busy = (name: string) => state.done.has(name) || state.inFlight.has(name);

  const batch: string[] = [];
  // Visible first, in list order rather than in the order they were reported, so a day fills from
  // the top down and looks deliberate instead of arriving in scattered pieces.
  for (const name of state.all) {
    if (batch.length >= size) return batch;
    if (state.wanted.has(name) && !busy(name)) batch.push(name);
  }

  /*
   * Then a little beyond, and only a little. Prefetching the rest of a card would hold the main
   * thread for fifteen seconds on days nobody has opened — see the note at the top of this file.
   */
  let ahead = 0;
  for (const name of state.all) {
    if (batch.length >= size || ahead >= lookahead) return batch;
    if (state.wanted.has(name) || busy(name)) continue;
    batch.push(name);
    ahead += 1;
  }

  return batch;
}

/**
 * Whether everything on screen has been tried.
 *
 * Not whether the *folder* is finished — the feed deliberately never walks a whole card. This is
 * what the loop waits on: when it is true there is nothing to do until somebody opens another day,
 * so the loop idles instead of spinning.
 */
export function wantedSettled(state: FeedState): boolean {
  for (const name of state.wanted) {
    if (!state.done.has(name)) return false;
  }
  return true;
}
