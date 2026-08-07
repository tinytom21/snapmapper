/**
 * Naming what Undo and Redo would do.
 *
 * "Undo" alone asks you to remember what you last did, and the case these buttons exist for is a
 * mis-tap on the map — which reassigns *every selected photo at once*. Undoing that blind is a leap
 * of faith; "Undo place 5" is not.
 *
 * The phrasing lives here rather than in `packages/core`, which reports a structured
 * `SessionAction` and leaves the words to whoever is displaying them.
 */

import type { SessionAction } from '@snapmapper/core';

/**
 * A few words, for a button that has to fit on a phone beside another one.
 *
 * Short on purpose: the button reads "Undo place 5", not "Undo placing 5 photos on the map". The
 * long form goes in the tooltip — see `explainAction`.
 */
export function describeAction(action: SessionAction | undefined): string {
  if (!action) return '';

  switch (action.kind) {
    case 'place': return `place ${action.count}`;
    case 'clear': return `clear ${action.count}`;
    case 'revert': return `revert ${action.count}`;
    // One word each. Measured at 375px: "clock offset" left 15px of slack on the header row and
    // overflowed a 320px screen outright. The full phrasing is in the tooltip.
    case 'time-zone': return 'zone';
    case 'offset': return 'offset';
    case 'sync': return 'sync';
    case 'clear-sync': return 'un-sync';
  }
}

/** The full sentence, for a `title`. */
export function explainAction(verb: 'Undo' | 'Redo', action: SessionAction | undefined): string {
  const shortcut = verb === 'Undo' ? 'Ctrl+Z' : 'Ctrl+Shift+Z';
  if (!action) return `${verb} (${shortcut}) — nothing to ${verb.toLowerCase()}`;

  return `${verb} ${longForm(action)} (${shortcut})`;
}

function longForm(action: SessionAction): string {
  switch (action.kind) {
    case 'place':
      return `placing ${photos(action.count)} on the map`;
    case 'clear':
      return `clearing the location of ${photos(action.count)}`;
    case 'revert':
      return `reverting ${photos(action.count)} to what is on disk`;
    case 'time-zone':
      return `the time zone change to ${action.timeZone}`;
    case 'offset':
      return `setting the camera clock offset to ${signed(action.offsetSeconds)}s`;
    case 'sync':
      return 'the camera clock measurement';
    case 'clear-sync':
      return 'discarding the camera clock measurement';
  }
}

function photos(count: number): string {
  return `${count} photo${count === 1 ? '' : 's'}`;
}

/** An offset of zero is meaningful here, and "+0s" reads better than "0s" beside "-4s". */
function signed(seconds: number): string {
  return seconds >= 0 ? `+${seconds}` : String(seconds);
}
