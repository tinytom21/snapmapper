/**
 * Finding the day's track in the logger's folder, and not re-reading the folder to do it.
 *
 * The workflow: a logger running permanently, one GPX per day, into one folder, forever. After a
 * year that folder holds 365 files and some hundreds of megabytes — so the naive version of this,
 * reading every file to see which covers the shoot, would read a year to use a day of it. Once.
 * Every time.
 *
 * So spans are cached. The key is the file's name, size and modification time together: a logger
 * appends to today's file all day, and a cache keyed on the name alone would answer with this
 * morning's span all afternoon.
 */

import { chooseTracks, gpxSpan, photoSpan, type TrackCandidate } from '@snapmapper/core';

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

export interface TrackSearchProgress {
  readonly read: number;
  readonly total: number;
}

export interface TrackSearchResult {
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
        span = gpxSpan(await store.readTrack(folder, file.name)) ?? null;
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
