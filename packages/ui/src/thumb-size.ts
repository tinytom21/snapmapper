/**
 * How big the thumbnails are, and remembering the answer.
 *
 * There is a hard ceiling here worth knowing about: the thumbnail is the ~6KB JPEG the camera
 * embedded, and on an ILCE-6400 that is **160x120** — a 3:2 frame letterboxed into 4:3. So 160px
 * is as large as it can be drawn with any real detail, and on a phone at device-pixel-ratio 3 even
 * the 76px default is already being upscaled. Offering a 300px option would offer mush.
 *
 * Bigger than that is what the full-size preview is for, which reads the original file.
 */

export interface ThumbSize {
  readonly key: 'small' | 'medium' | 'large' | 'largest';
  /** Shown on the control. */
  readonly label: string;
  /** CSS pixels wide. Height follows from the 3:2 aspect. */
  readonly width: number;
}

export const THUMB_SIZES: readonly ThumbSize[] = [
  { key: 'small', label: 'S', width: 44 },
  { key: 'medium', label: 'M', width: 76 },
  { key: 'large', label: 'L', width: 112 },
  // The embedded thumbnail's own width. Anything larger is upscaling.
  { key: 'largest', label: 'XL', width: 160 },
];

export const DEFAULT_THUMB_SIZE = 'medium';

const STORAGE_KEY = 'snapmapper.thumbSize';

export function thumbWidth(key: string): number {
  return (THUMB_SIZES.find((size) => size.key === key) ?? THUMB_SIZES[1]!).width;
}

/**
 * The stored preference, or the default.
 *
 * Anything unrecognised falls back rather than being trusted: this value goes straight into a CSS
 * length, and localStorage is shared with every other version of the app this origin has ever
 * served — including ones that stored something else under this key.
 */
export function loadThumbSize(storage?: Pick<Storage, 'getItem'>): ThumbSize['key'] {
  try {
    const stored = (storage ?? window.localStorage).getItem(STORAGE_KEY);
    const found = THUMB_SIZES.find((size) => size.key === stored);
    return found ? found.key : DEFAULT_THUMB_SIZE;
  } catch {
    // Private browsing modes throw on access rather than returning null.
    return DEFAULT_THUMB_SIZE;
  }
}

export function saveThumbSize(key: ThumbSize['key'], storage?: Pick<Storage, 'setItem'>): void {
  try {
    (storage ?? window.localStorage).setItem(STORAGE_KEY, key);
  } catch {
    // Not being able to remember the choice is not a reason to refuse to make it.
  }
}
