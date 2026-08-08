/**
 * Finding the day's track in the logger's folder, and not re-reading the folder to do it.
 *
 * The workflow: a logger running permanently, into one folder, forever. Both the shapes people
 * actually choose are awkward in their own way, and this file is mostly about the two of them:
 *
 * **A file per day.** The folder grows without limit — a year is 365 files and some hundreds of
 * megabytes — so reading every file to find the one covering a shoot would read a year to use a
 * day of it, once, every time. Hence the span cache.
 *
 * **A file per month.** Far fewer files, which is why people pick it, but each is tens of
 * megabytes and *the current one changes every few minutes*. Its cache entry is therefore invalid
 * every single time you look, so the cache alone does not save it. Hence `spanOf`, which reads a
 * large file's span from its two ends rather than from all of it, and the load window, which keeps
 * a month from being parsed and drawn in full to place one afternoon.
 *
 * The cache key is name, size and modification time together. Keyed on the name alone, a logger
 * appending all day would be answered with this morning's span all afternoon.
 */

import {
  chooseTracks,
  gpxSpan,
  mergeSpans,
  photoSpan,
  type TimeWindow,
  type TrackCandidate,
} from '@snapmapper/core';

import type { BrowserFileStore, TrackFileRef, TrackFolder } from './browser-file-store.ts';

const CACHE_KEY = 'snapmapper.track-spans.v1';

/** A cached span, or the fact that a file had none. `null` spans are worth remembering too. */
type CachedSpan = { readonly from: number; readonly to: number } | null;

/**
 * Identity of a file's *contents*, as far as this cache is concerned.
 *
 * Size and modification time both, because a logger appends: the name is stable all day while the
 * span grows by the hour, and a cache that missed that would stop finding this afternoon.
 */
function fingerprint(file: TrackFileRef): string {
  return `${file.name}|${file.sizeBytes}|${file.modifiedAtMs}`;
}

function loadCache(): Record<string, CachedSpan> {
  try {
    const stored = localStorage.getItem(CACHE_KEY);
    const parsed: unknown = stored ? JSON.parse(stored) : {};
    return typeof parsed === 'object' && parsed !== null
      ? parsed as Record<string, CachedSpan>
      : {};
  } catch {
    // Private browsing, a full quota, a value from an older shape. None is worth failing over —
    // the cost of an empty cache is a slower search, not a wrong one.
    return {};
  }
}

function saveCache(cache: Record<string, CachedSpan>): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
  } catch {
    // Quota. The search still worked; only the next one is slower.
  }
}

/**
 * Above this, a file's span is read from its two ends rather than from all of it.
 *
 * The threshold exists because monthly track files change the arithmetic completely. A day at a
 * ten-second interval is a few hundred kilobytes; a month is tens of megabytes — and the file the
 * logger is *currently* appending to changes every few minutes, so its cached span is invalid
 * every time you look. Re-reading 30MB on every search is the difference between instant and not.
 */
const FULL_SCAN_LIMIT = 2 * 1024 * 1024;

/**
 * How much of each end is read for a large file's span.
 *
 * Generous on purpose: it only has to contain one `<time>`, and 128KB is hundreds of points even
 * at the most verbose the format gets.
 */
const EDGE_BYTES = 128 * 1024;

/**
 * How much either side of the photographs is kept when a file is trimmed.
 *
 * Comfortably more than any matching tolerance anybody would set, so trimming can never change
 * which fix a photograph matches — and enough context either side that the map shows the walk the
 * photographs came from rather than a fragment hanging in space.
 */
const LOAD_PAD_MS = 6 * 60 * 60 * 1000;

/**
 * A file's span, reading as little as will do.
 *
 * The shortcut assumes a large file's earliest and latest points are near its two ends, which is
 * true of every logger that appends as it goes — which is what makes a file large in the first
 * place. It is checked rather than trusted: if the ends yield no times at all, the whole file is
 * scanned rather than the file being written off as spanless.
 */
async function spanOf(
  store: BrowserFileStore,
  folder: TrackFolder,
  file: TrackFileRef,
): Promise<TimeWindow | undefined> {
  if (file.sizeBytes <= FULL_SCAN_LIMIT) {
    return gpxSpan(await store.readTrack(folder, file.name));
  }

  const [head, tail] = await store.readTrackEnds(folder, file.name, EDGE_BYTES);
  // Scanned separately and merged, so a `<time>` straddling the join cannot be misread.
  const edges = mergeSpans([gpxSpan(head), gpxSpan(tail)]);
  if (edges) return edges;

  return gpxSpan(await store.readTrack(folder, file.name));
}

export interface TrackSearchProgress {
  readonly read: number;
  readonly total: number;
}

export interface TrackSearchResult {
  /**
   * The window worth loading: the photographs, padded.
   *
   * Handed back so the caller can trim the files it loads. A monthly file holds a quarter of a
   * million points, of which a shoot uses a few hundred — and an untrimmed month drawn on the map
   * is a scribble across the whole county with the day you want invisible inside it.
   */
  readonly window: TimeWindow;
  /** Files to load, in time order. Empty when nothing covers the photographs. */
  readonly chosen: readonly string[];
  /** How many files were in the folder at all. */
  readonly considered: number;
  /** How many had to be read this time, the rest coming from the cache. */
  readonly read: number;
  readonly unreadable: readonly string[];
  /** Set when nothing overlapped: the closest track, and by how many milliseconds it missed. */
  readonly nearest?: { readonly name: string; readonly offBy: number };
}

/**
 * Work out which files in the track folder cover a set of photograph instants.
 *
 * Reads only the files whose span is not already known, and only their `<time>` elements — see
 * `gpxSpan`. Nothing is fully parsed here; that happens to the winners, in the caller.
 */
export async function searchTrackFolder(
  store: BrowserFileStore,
  folder: TrackFolder,
  instants: readonly (Date | undefined)[],
  onProgress?: (progress: TrackSearchProgress) => void,
): Promise<TrackSearchResult | 'no-dates'> {
  const photos = photoSpan(instants);
  // Not the same as "no tracks": nothing to search *with* needs a different thing said.
  if (!photos) return 'no-dates';

  const files = await store.listTracks(folder);
  const cache = loadCache();
  const candidates: TrackCandidate[] = [];

  let read = 0;
  let dirty = false;

  for (const file of files) {
    const key = fingerprint(file);
    let span = cache[key];

    if (span === undefined) {
      try {
        span = await spanOf(store, folder, file) ?? null;
      } catch {
        // A file that vanished between listing and reading, or one we cannot open. Cached as
        // having no span so a folder with a permanently broken file is not re-read every time.
        span = null;
      }
      cache[key] = span;
      dirty = true;
      read += 1;
      onProgress?.({ read, total: files.length });
    }

    candidates.push({ name: file.name, ...(span ? { span } : {}) });
  }

  if (dirty) saveCache(prune(cache, files));

  const choice = chooseTracks(candidates, photos);
  return {
    window: { from: photos.from - LOAD_PAD_MS, to: photos.to + LOAD_PAD_MS },
    chosen: choice.chosen.map((one) => one.name),
    considered: files.length,
    read,
    unreadable: choice.unreadable,
    ...(choice.nearest ? { nearest: choice.nearest } : {}),
  };
}

/**
 * Drop entries for files no longer in the folder.
 *
 * Without this the cache grows forever — a fingerprint changes every time a file is appended to,
 * so a logger writing all day leaves a trail of dead keys for the same file, and `localStorage`
 * has a quota measured in a few megabytes.
 */
function prune(
  cache: Record<string, CachedSpan>,
  files: readonly TrackFileRef[],
): Record<string, CachedSpan> {
  const live = new Set(files.map(fingerprint));
  return Object.fromEntries(Object.entries(cache).filter(([key]) => live.has(key)));
}

/** Forget every cached span. For when a folder is changed or something looks wrong. */
export function clearSpanCache(): void {
  try {
    localStorage.removeItem(CACHE_KEY);
  } catch {
    // Nothing to do, and nothing depends on it.
  }
}
