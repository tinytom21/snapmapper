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

import type { FileStore, PhotoRef } from '@snapmapper/core';

import { createBatchRunner } from './batch-runner.ts';
import { readThumbnails } from './read-thumbnails.ts';
import { THUMBNAIL_BATCH, nextBatch } from './thumbnail-feed.ts';

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
}

export function useThumbnailFeed(
  refs: readonly PhotoRef[],
  store: FileStore,
  enabled = true,
): ThumbnailFeed {
  const [urls, setUrls] = useState<ReadonlyMap<string, string>>(new Map());
  const [done, setDone] = useState(0);

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

    void (async () => {
      const runner = await createBatchRunner();
      if (!runner || stopped) return;

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

        const results = await readThumbnails(
          batch.map((name) => byName.get(name)).filter((ref): ref is PhotoRef => ref !== undefined),
          store,
          runner,
        );
        if (stopped) return;

        const fresh = new Map<string, string>();
        for (const result of results) {
          if (!result.bytes) continue;
          const url = URL.createObjectURL(new Blob([result.bytes as BlobPart], { type: 'image/jpeg' }));
          made.push(url);
          fresh.set(result.name, url);
        }

        // Every name in the batch counts as done, thumbnail or not, or the loop retries it for ever.
        for (const name of batch) doneNames.add(name);

        setDone(doneNames.size);
        if (fresh.size > 0) setUrls((was) => new Map([...was, ...fresh]));

        /*
         * A breather, and it is not politeness.
         *
         * The interpreter runs on the main thread and holds it for about 700 ms per batch —
         * measured, with a `setTimeout(0)` set beforehand that does not fire until afterwards. Back
         * to back, that is an interface that ignores taps for as long as the feed runs, on the one
         * screen whose entire job is being tapped. This hands the thread back between batches so
         * the queued taps are actually processed.
         */
        await pause(BREATHER_MS);
      }
    })();

    return () => {
      stopped = true;
      for (const url of made) URL.revokeObjectURL(url);
      setUrls(new Map());
      setDone(0);
    };
  }, [refs, store, enabled]);

  /*
   * `done` counts everything tried, including the lookahead, so it can exceed what is wanted. The
   * progress line reads better clamped than showing "72/60".
   */
  return { urls, done: Math.min(done, wantedCount), wantedCount, want };
}
