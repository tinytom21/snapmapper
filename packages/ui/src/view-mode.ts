/**
 * How the photos are shown, and remembering the answer.
 *
 * Two views rather than a size dial. Four thumbnail sizes was granularity nobody wanted: the real
 * question is whether you are *reading* the list — filenames, times, coordinates — or *looking* at
 * the photographs to find the ones you mean.
 *
 * - **list** — every detail, thumbnails at 160px, which is as large as the camera's embedded JPEG
 *   goes (an ILCE-6400 writes 160x120). No size choice, because there is nothing to choose between:
 *   smaller wastes the resolution and larger only upscales.
 * - **grid-small / grid-large** — pictures and a tick box, nothing else. This is where a size
 *   option earns its keep, because it decides how many photographs you can see at once.
 *
 * One stored value rather than a view plus a size, so there is no such thing as a size that applies
 * to a view that does not use it.
 */

export type ViewMode = 'list' | 'grid-small' | 'grid-large';

export const VIEW_MODES: readonly ViewMode[] = ['list', 'grid-small', 'grid-large'];

export const DEFAULT_VIEW_MODE: ViewMode = 'list';

/** The width of the JPEG the camera embedded. Larger is upscaling; see the preview for that. */
export const LIST_THUMB_WIDTH = 160;

/**
 * The narrowest a grid tile may be, which sets the column count.
 *
 * A minimum rather than a fixed width, so tiles share the row exactly and no strip of empty space
 * is left at the right edge. On a 375px phone that is four columns small, two large.
 */
export const GRID_MIN_WIDTH: Readonly<Record<'grid-small' | 'grid-large', number>> = {
  'grid-small': 84,
  'grid-large': 150,
};

const STORAGE_KEY = 'snapmapper.view';

export function isGrid(mode: ViewMode): mode is 'grid-small' | 'grid-large' {
  return mode !== 'list';
}

/** Pixels, for the CSS that lays the grid out. Zero for the list, which is not a grid. */
export function gridMinWidth(mode: ViewMode): number {
  return isGrid(mode) ? GRID_MIN_WIDTH[mode] : 0;
}

/**
 * The stored preference, or the default.
 *
 * Anything unrecognised falls back rather than being trusted. This value reaches a CSS length, and
 * localStorage is shared with every version of the app this origin has ever served — including the
 * one that wrote four thumbnail sizes under a different key.
 */
export function loadViewMode(storage?: Pick<Storage, 'getItem'>): ViewMode {
  try {
    const stored = (storage ?? window.localStorage).getItem(STORAGE_KEY);
    return VIEW_MODES.find((mode) => mode === stored) ?? DEFAULT_VIEW_MODE;
  } catch {
    // Private browsing modes throw on access rather than returning null.
    return DEFAULT_VIEW_MODE;
  }
}

export function saveViewMode(mode: ViewMode, storage?: Pick<Storage, 'setItem'>): void {
  try {
    (storage ?? window.localStorage).setItem(STORAGE_KEY, mode);
  } catch {
    // Not being able to remember the choice is not a reason to refuse to make it.
  }
}
