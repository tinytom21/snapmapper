/**
 * A folder listing, arranged so a person can choose from it.
 *
 * This is what replaced the operating system's file picker, and the reason it can is arithmetic:
 * **listing a folder is free and reading metadata is not.** Measured on 1000 entries, enumerating
 * them costs 20 ms and asking each for its size and date costs 235 ms; reading the same 1000 with
 * ExifTool would be about eight minutes on a desktop and closer to an hour on a phone. So a folder
 * can be opened and shown instantly, and ExifTool only ever runs on the photographs actually
 * chosen.
 *
 * The picker had to go because it cannot say *where a file lives*. `showOpenFilePicker` returns
 * handles with no route to their parent — verified against the live API: a `FileSystemFileHandle`
 * has `createWritable`, `getFile` and `move`, and nothing else. So "put the copies beside the
 * originals" and "put the sidecar next to the raw file" were both unanswerable, and the interface
 * had to ask for a folder *after* the photographs were chosen, which is the confusing step this
 * removes.
 *
 * ## Grouping by day, from the file's own date
 *
 * `modifiedAtMs` is the filesystem's date, not EXIF — no metadata has been read at this point and
 * reading it is the thing being avoided. On a camera card it is the capture time, because that is
 * what the camera wrote it as, and it is used **only to arrange the list**. Nothing here ever
 * reaches a photograph's coordinates or its GPS timestamp; the moment a photograph is opened, the
 * real EXIF date replaces this for every purpose that matters.
 *
 * A copied or synced card can carry today's date on every file, in which case the whole listing
 * lands in one group. That is a degraded arrangement rather than a wrong one.
 */

import { isRawFile, type PhotoRef } from '@snapmapper/core';

export interface DayGroup {
  /** `YYYY-MM-DD` in the viewer's own zone. Stable, and what a checkbox is keyed on. */
  readonly key: string;
  /** For a heading: `Friday, 12 July 2024`. */
  readonly label: string;
  readonly refs: readonly PhotoRef[];
  readonly rawCount: number;
}

/**
 * Above this many photographs, opening the lot is not offered as the default.
 *
 * Reading metadata is roughly half a second per photograph on a desktop and three on a phone, so
 * sixty is about thirty seconds and about three minutes respectively — the most that is reasonable
 * to start without being asked. Beyond it the newest day is chosen instead, which is what somebody
 * who has just come back from taking photographs almost always wants.
 */
export const COMFORTABLE_COUNT = 60;

/**
 * Arrange a listing into days, newest first.
 *
 * Newest first because the common case is a card just out of a camera: what you want is at the
 * top and usually needs no scrolling at all. Within a day the order is by name, which on any
 * camera is chronological — and `localeCompare` with `numeric` so `DSC00099` precedes `DSC00100`.
 */
export function groupByDay(refs: readonly PhotoRef[]): DayGroup[] {
  const byKey = new Map<string, PhotoRef[]>();

  for (const ref of refs) {
    const date = new Date(ref.modifiedAtMs);
    // Built from the local parts rather than `toISOString`, which would be UTC and would put an
    // evening's photographs on tomorrow for anyone east of Greenwich.
    const key = [
      date.getFullYear(),
      String(date.getMonth() + 1).padStart(2, '0'),
      String(date.getDate()).padStart(2, '0'),
    ].join('-');

    const bucket = byKey.get(key);
    if (bucket) bucket.push(ref);
    else byKey.set(key, [ref]);
  }

  return [...byKey.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([key, group]) => ({
      key,
      label: dayLabel(group[0]?.modifiedAtMs ?? 0),
      refs: [...group].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })),
      rawCount: group.filter((ref) => isRawFile(ref.name)).length,
    }));
}

/**
 * The photographs in the order they are drawn: newest day first, chronological within a day.
 *
 * This is what the thumbnail feed walks, and it is deliberately not the folder listing. The listing
 * is alphabetical — for camera filenames that is oldest first — while the chooser puts the newest
 * day at the top, so a feed following the listing reaches *away* from where anybody is looking and
 * spends itself on the oldest day on the card. Reported as loading that "seems artificially slow",
 * which is precisely what it is: the same work, done furthest from the screen first.
 *
 * Within a day the order stays chronological, because that is the order the tiles are drawn in and
 * a day should fill from the top down.
 */
export function displayOrder(groups: readonly DayGroup[]): PhotoRef[] {
  return groups.flatMap((group) => [...group.refs]);
}

/**
 * What to have selected when the chooser opens.
 *
 * A small folder is almost certainly all wanted, so it is all selected and the button can be
 * pressed straight away. A large one is a camera card, where the answer is nearly always the most
 * recent shoot — so that day is selected and everything older is left for a deliberate choice.
 *
 * Never nothing. A chooser that opens with an empty selection and a disabled button makes the
 * user do work before the interface does any.
 */
export function defaultChoice(
  groups: readonly DayGroup[],
  comfortable: number = COMFORTABLE_COUNT,
): Set<string> {
  const total = groups.reduce((sum, group) => sum + group.refs.length, 0);
  const chosen = total <= comfortable ? groups : groups.slice(0, 1);
  return new Set(chosen.flatMap((group) => group.refs.map((ref) => ref.name)));
}

/**
 * How long reading this many photographs is likely to take, in words.
 *
 * Said before the button is pressed rather than discovered afterwards, because it is the one cost
 * in this application that a person would want to reconsider a selection over. Deliberately vague
 * — "about a minute" — since the true figure spans six times between a desktop and a phone and a
 * precise-looking number would be precisely wrong on one of them.
 */
export function describeReadCost(count: number, perPhotoMs: number): string | undefined {
  if (count === 0) return undefined;

  const seconds = Math.round((count * perPhotoMs) / 1000);
  if (seconds < 5) return undefined;
  if (seconds < 60) return `about ${Math.round(seconds / 5) * 5} seconds to read`;

  const minutes = Math.round(seconds / 60);
  return `about ${minutes} minute${minutes === 1 ? '' : 's'} to read`;
}

/** Roughly what one photograph costs to read here. A phone is several times slower. */
export const READ_MS_PER_PHOTO = 500;

function dayLabel(atMs: number): string {
  return new Date(atMs).toLocaleDateString(undefined, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}
