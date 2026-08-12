/**
 * The background thumbnail feed, as a hook.
 *
 * The ordering lives in `thumbnail-feed.ts` and is pure; the reading lives in
 * `read-thumbnails.ts`. This is only the loop and the lifetimes, which is the part that cannot be
 * tested without a browser and therefore the part worth keeping as small as possible.
 *
 * Two lifetimes matter and both leak if forgotten. Object URLs are held until revoked, and a card
 * of 322 thumbnails is a couple of megabytes of blobs — nothing next to the photographs, but they
 * accumulate across every folder opened in a session. And the loop must stop when the chooser
 * closes, or it goes on reading a card nobody is looking at while the map is being used.
 */

import { useEffect, useRef, useState } from 'react';

import type { BatchRunner, FileStore, PhotoRef } from '@snapmapper/core';

import { createBatchRunner } from './batch-runner.ts';
import { readThumbnails } from './read-thumbnails.ts';
import { THUMBNAIL_BATCH, nextBatch } from './thumbnail-feed.ts';
import { NOTHING, addBatch, type Totals } from './diagnostics.ts';
import { INITIAL_WINDOWS, nextWindows } from './thumbnail-window.ts';

/**
 * How long the main thread is handed back between batches.
 *
 * A batch blocks it for ~700 ms, so this is the share the interface gets. A quarter of a second is
 * enough for the queued taps of somebody selecting; much more and a day of sixty photographs takes
 * uncomfortably long to fill.
 */
const BREATHER_MS = 250;

/** How often to look for newly visible photographs when there is nothing to fetch. */
const IDLE_MS = 300;

const pause = (ms: number) => new Promise((resolve) => { setTimeout(resolve, ms); });

export interface ThumbnailFeed {
  /** Object URLs by photograph name. Grows as the feed runs. */
  readonly urls: ReadonlyMap<string, string>;
  /** How many have been tried. Rises as days are opened, since the feed only fetches those. */
  readonly done: number;
  /** How many are wanted right now — the expanded days. The progress line is `done` of this. */
  readonly wantedCount: number;
  /** Report what is on screen, so it jumps the queue. */
  readonly want: (names: readonly string[]) => void;
  /** Where the time went, for a report the user can paste back. See `diagnostics.ts`. */
  readonly timings: Totals;
}

export function useThumbnailFeed(
  refs: readonly PhotoRef[],
  store: FileStore,
  enabled = true,
): ThumbnailFeed {
  const [urls, setUrls] = useState<ReadonlyMap<string, string>>(new Map());
  const [done, setDone] = useState(0);
  const [timings, setTimings] = useState<Totals>(NOTHING);

  /*
   * What is on screen, in a ref rather than state.
   *
   * Scrolling reports constantly, and putting that in state would re-render the whole grid on every
   * intersection callback — which is precisely while somebody is trying to look at it. The loop
   * reads the ref at the top of each batch instead, so a scroll takes effect within one batch.
   */
  const wanted = useRef<ReadonlySet<string>>(new Set());
  const [wantedCount, setWantedCount] = useState(0);
  const want = useRef((names: readonly string[]) => {
    wanted.current = new Set(names);
    setWantedCount(wanted.current.size);
  }).current;

  useEffect(() => {
    if (!enabled || refs.length === 0) return;

    let stopped = false;
    const made: string[] = [];
    const byName = new Map(refs.map((ref) => [ref.name, ref]));
    const all = refs.map((ref) => ref.name);
    const doneNames = new Set<string>();

    /*
     * Built on first need, and usually never.
     *
     * A folder of JPEGs is answered entirely by the byte reader, so instantiating zeroperl's 24MB
     * of WebAssembly when the chooser opens is most of a second of blocked main thread for nothing.
     * Measured before this: the first picture took 646 ms to appear, essentially all of it the boot.
     * `createBatchRunner` caches page-wide, so this stays one instance however often it is asked.
     */
    let runner: Promise<BatchRunner | undefined> | undefined;
    const getRunner = () => (runner ??= createBatchRunner());

    /*
     * How much of each head to read, fitted to the camera as the batches go by.
     *
     * A read costs about 110 ms whether it carries 43KB or 128KB — measured on two devices — so a
     * head too small to hold the thumbnail buys a second round trip and roughly doubles the cost of
     * that photograph. It did: on a Galaxy S23's own JPEGs, whose thumbnail is about 53KB, three
     * quarters needed a second read and the phone came out slower on its internal storage than on a
     * card. Rather than guess a number that suits every camera, the first batch measures where the
     * thumbnails end and the rest read that far in one go. See `thumbnail-window.ts`.
     */
    let windows = INITIAL_WINDOWS;

    void (async () => {
      for (;;) {
        if (stopped) return;

        const batch = nextBatch(
          { all, wanted: wanted.current, done: doneNames, inFlight: new Set() },
          THUMBNAIL_BATCH,
        );

        /*
         * Nothing to fetch: idle rather than stop.
         *
         * The feed never walks a whole card, so "nothing to do" is the normal resting state and
         * not the end — expanding another day makes more wanted, and the loop has to notice. A
         * poll rather than a subscription because it costs one comparison every third of a second
         * against a set that is usually already satisfied.
         */
        if (batch.length === 0) {
          await pause(IDLE_MS);
          continue;
        }

        const batchResult = await readThumbnails(
          batch.map((name) => byName.get(name)).filter((ref): ref is PhotoRef => ref !== undefined),
          store,
          getRunner,
          windows,
        );
        windows = nextWindows(windows, batchResult.timing.deepest);
        if (stopped) return;

        const fresh = new Map<string, string>();
        for (const result of batchResult.results) {
          if (!result.bytes) continue;
          const url = URL.createObjectURL(new Blob([result.bytes as BlobPart], { type: 'image/jpeg' }));
          made.push(url);
          fresh.set(result.name, url);
        }

        // Every name in the batch counts as done, thumbnail or not, or the loop retries it for ever.
        for (const name of batch) doneNames.add(name);

        setDone(doneNames.size);
        setTimings((was) => addBatch(was, batchResult.timing));
        if (fresh.size > 0) setUrls((was) => new Map([...was, ...fresh]));

        /*
         * A breather only when ExifTool was actually needed.
         *
         * The interpreter runs on the main thread and holds it for about 700 ms per batch, so
         * running batches back to back is an interface that ignores taps — on the one screen whose
         * whole job is being tapped. But a batch answered by the byte reader costs a fraction of a
         * millisecond per photograph and blocks nothing, so pausing after one would be throwing
         * away the entire point of the fast path. `usedExifTool` is the difference, and in practice
         * it is only true for raw.
         */
        await pause(batchResult.usedExifTool ? BREATHER_MS : 0);
      }
    })();

    return () => {
      stopped = true;
      for (const url of made) URL.revokeObjectURL(url);
      setUrls(new Map());
      setDone(0);
      setTimings(NOTHING);
    };
  }, [refs, store, enabled]);

  /*
   * `done` counts everything tried, including the lookahead, so it can exceed what is wanted. The
   * progress line reads better clamped than showing "72/60".
   */
  return { urls, done: Math.min(done, wantedCount), wantedCount, want, timings };
}
