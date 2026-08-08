/**
 * Stepping through what a track just placed, to catch the one that is wrong before saving.
 *
 * A match reports "placed 38 of 45" and puts 38 pins on a map. That is enough to see that it
 * worked and nowhere near enough to see that it worked *correctly* — and the failure mode of a
 * track match is not a wild outlier, it is a photograph a few hundred metres along the road from
 * where it belongs, which looks entirely reasonable as a pin.
 *
 * So: one photograph at a time, selected, so the map centres on it and the thumbnail is beside its
 * coordinates. The check is "does this picture look like that place", which a human does instantly
 * and no amount of arithmetic here can do at all.
 *
 * **It reviews staged edits only.** What is already on disk was reviewed when it was staged, and
 * including it would turn a pass over this afternoon's work into a pass over the whole card.
 */

import { useEffect } from 'react';

import { locationOf, stagedPhotos, type Session } from '@snapmapper/core';

import { neighbourName } from './photo-nav.ts';

export interface ReviewBarProps {
  readonly session: Session;
  readonly thumbnails: Map<string, string>;
  /** The photo being reviewed, which is always also the selection. */
  readonly current: string | null;
  readonly onGo: (name: string) => void;
  readonly onClose: () => void;
  /** Open this one full size — the answer to "I cannot tell from a thumbnail". */
  readonly onPreview: (name: string) => void;
}

export function ReviewBar({
  session, thumbnails, current, onGo, onClose, onPreview,
}: ReviewBarProps) {
  const staged = stagedPhotos(session);
  const names = staged.map((entry) => entry.ref.name);
  const at = current ? names.indexOf(current) : -1;

  /*
   * Follow the list when it changes underneath.
   *
   * Reverting the photograph being reviewed removes it from the staged set, and the obvious next
   * thing to look at is whatever took its place — not nothing, and not the start again.
   */
  useEffect(() => {
    if (names.length === 0) {
      onClose();
      return;
    }
    if (at < 0) onGo(names[0] as string);
  }, [names.length, at]);

  // Arrow keys, because this is a repetitive pass and reaching for a button each time is the
  // difference between reviewing forty and reviewing four.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
      if (!current) return;

      const delta = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
      if (delta === 0) {
        if (event.key === 'Escape') onClose();
        return;
      }

      const next = neighbourName(names, current, delta);
      if (next) {
        event.preventDefault();
        onGo(next);
      }
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [names, current, onGo, onClose]);

  if (names.length === 0 || !current) return null;

  const location = locationOf(session, current);
  const thumbnail = thumbnails.get(current);
  const previous = neighbourName(names, current, -1);
  const next = neighbourName(names, current, 1);

  return (
    <div className="review">
      <button
        type="button"
        className="review-step"
        onClick={() => previous && onGo(previous)}
        disabled={!previous}
        aria-label="Previous staged photo"
      >
        ‹
      </button>

      {/* The picture is the whole point — this is a visual check, not a numeric one. */}
      {thumbnail && (
        <img
          src={thumbnail}
          alt=""
          className="review-thumb"
          draggable={false}
          onClick={() => onPreview(current)}
        />
      )}

      <div className="review-what">
        <div className="name">{current}</div>
        <div className="note">
          {at + 1} of {names.length} staged
          {location.kind === 'pending' && ` · ${
            location.coordinates.latitude.toFixed(5)}, ${location.coordinates.longitude.toFixed(5)}`}
        </div>
      </div>

      <button
        type="button"
        className="review-step"
        onClick={() => next && onGo(next)}
        disabled={!next}
        aria-label="Next staged photo"
      >
        ›
      </button>

      <button type="button" className="link" onClick={onClose}>Done</button>
    </div>
  );
}
