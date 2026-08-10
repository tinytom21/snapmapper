/**
 * Asking which of two locations a photograph belongs at.
 *
 * Only ever shown for a genuine disagreement — the file says one place, a copy written by an
 * earlier session says another, and they are more than a metre apart. Everything else is settled
 * without asking; see `core/prior-location.ts` for which cases those are and why.
 *
 * ## One at a time, with a way to answer for the rest
 *
 * A disagreement is a decision, so the default is to make it per photograph. But the reason two
 * sources disagree is usually systematic — a whole afternoon re-placed last week, a camera whose
 * fix was cold for the first dozen frames — and in that case the second question has the same
 * answer as the first. So the answer can be applied to everything remaining, from a checkbox that
 * is off until it is asked for.
 *
 * ## What is on screen is what the decision needs
 *
 * The thumbnail, because recognising the frame is most of the judgement. Both sets of coordinates.
 * And **how far apart they are**, which is the fact that actually decides it: three metres is a
 * different reading of one spot and three kilometres is a different place. Without it the two
 * coordinates are eight digits each that nobody can subtract in their head.
 *
 * Deliberately not dismissable by clicking away or pressing Escape. Every other overlay in this
 * application is a view of something; this one is a question, and a question with no answer leaves
 * the photograph showing a location that may be wrong. `Decide later` is there and says what it
 * does: the file's own location stands, and the disagreement is left on disk to be asked about
 * next time.
 */

import { useState } from 'react';

import type { LocationChoice, LocationConflict } from '@snapmapper/core';

import { formatCoordinates, formatDistance } from './format-location.ts';

export interface ConflictPromptProps {
  /** Still to answer, in list order. The first is the one being asked about. */
  readonly conflicts: readonly LocationConflict[];
  readonly thumbnails: ReadonlyMap<string, string>;
  /** `all` answers the remaining conflicts the same way. */
  readonly onChoose: (choice: LocationChoice, all: boolean) => void;
  /** Leave the rest unanswered. The originals stand. */
  readonly onDismiss: () => void;
}

export function ConflictPrompt({
  conflicts, thumbnails, onChoose, onDismiss,
}: ConflictPromptProps) {
  const [applyToAll, setApplyToAll] = useState(false);

  const conflict = conflicts[0];
  if (!conflict) return null;

  const remaining = conflicts.length - 1;
  const thumbnail = thumbnails.get(conflict.name);

  return (
    <div className="conflict-backdrop" role="dialog" aria-modal="true" aria-labelledby="conflict-title">
      <div className="conflict">
        <h2 id="conflict-title">Two locations for this photograph</h2>
        <p className="note">
          {conflicts.length === 1
            ? 'It was geotagged in an earlier session, and the copy disagrees with the file itself.'
            : `${conflicts.length} photographs were geotagged in an earlier session, and the copies `
              + 'disagree with the files themselves.'}
        </p>

        <div className="conflict-photo">
          {thumbnail
            ? <img src={thumbnail} alt="" draggable={false} />
            : <div className="conflict-noshot" aria-hidden="true" />}
          <span className="name">{conflict.name}</span>
        </div>

        <p className="conflict-apart">
          <strong>{formatDistance(conflict.metresApart)}</strong> apart
        </p>

        <div className="conflict-choices">
          <button
            type="button"
            className="feature stacked"
            onClick={() => onChoose('copy', applyToAll)}
          >
            <span>Use the saved copy</span>
            <span className="sub">{formatCoordinates(conflict.prior.coordinates)}</span>
            <span className="sub">{conflict.prior.location}</span>
          </button>

          <button
            type="button"
            className="feature stacked"
            onClick={() => onChoose('original', applyToAll)}
          >
            <span>Keep the original</span>
            <span className="sub">{formatCoordinates(conflict.original)}</span>
            {/* Said plainly, because it is the one answer that creates work. */}
            <span className="sub">the copy will be rewritten on the next save</span>
          </button>
        </div>

        {remaining > 0 && (
          <label className="conflict-all">
            <input
              type="checkbox"
              checked={applyToAll}
              onChange={(event) => setApplyToAll(event.currentTarget.checked)}
            />
            <span>
              Answer the same way for the other {remaining}
            </span>
          </label>
        )}

        <div className="conflict-footer">
          <button type="button" className="link" onClick={onDismiss}>
            Decide later
          </button>
          <span className="note">
            {remaining > 0 ? `${remaining} more after this` : 'the last one'}
          </span>
        </div>
      </div>
    </div>
  );
}
