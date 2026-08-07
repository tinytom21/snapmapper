/**
 * A photo, big enough to actually recognise.
 *
 * The list's 76px thumbnail is enough to tell photographs apart but not enough to confirm you are
 * about to geotag the right frame, which is the one thing you want to be sure of before writing
 * to a file.
 *
 * ## It shows the original file, not the embedded preview
 *
 * The plan said to use the camera's embedded ~400KB `PreviewImage`, on the assumption it was
 * sitting unused in the header bytes already being read. **It is not.** Measured on a real
 * ILCE-6400 JPEG: the preview lives at 94% into the file, after the image data, so the header stub
 * does not contain it. Asking ExifTool for it from the stub costs 1212 ms and returns nothing at
 * all; from the whole file it costs 1328 ms and returns 1616x1080.
 *
 * Handing the original bytes to the browser costs **586 ms**, needs no ExifTool invocation, and
 * yields the full 6000x4000 image. So that is what this does. (`createImageBitmap` with
 * `resizeWidth` was also measured, at 1244 ms — downscaling during decode is slower than decoding,
 * not faster.)
 *
 * EXIF orientation is handled by the browser: CSS `image-orientation` defaults to `from-image`,
 * so a portrait frame arrives upright without us rotating anything.
 */

import { useEffect, useState } from 'react';

import { instantOf, locationOf, type PhotoEntry, type Session } from '@snapmapper/core';

import { neighbourName } from './photo-nav.ts';

export interface PhotoPreviewProps {
  readonly session: Session;
  /** The photo being shown. `null` closes the preview. */
  readonly name: string;
  /** Reads the original file's bytes. */
  readonly read: (entry: PhotoEntry) => Promise<Uint8Array>;
  readonly onShow: (name: string) => void;
  readonly onClose: () => void;
  /** Select just this photo and close, so "yes, that frame" leads straight to placing it. */
  readonly onSelectOnly: (name: string) => void;
}

export function PhotoPreview({
  session, name, read, onShow, onClose, onSelectOnly,
}: PhotoPreviewProps) {
  const entry = session.photos.find((photo) => photo.ref.name === name);
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  /*
   * Load the bytes and hand them to the browser as a blob URL.
   *
   * The cleanup does two things that both matter. It revokes the URL — a 6.5MB blob per photo
   * leaks for the lifetime of the page otherwise, and flicking through fifty photos would leak
   * 300MB. And `cancelled` discards a read that finished after the user moved on, which would
   * otherwise replace the photo they are now looking at with the one they left.
   */
  useEffect(() => {
    if (!entry) return;

    let cancelled = false;
    let created: string | null = null;

    setUrl(null);
    setError(entry.error ? `${name} could not be read — ${entry.error}` : null);
    if (entry.error) return;

    read(entry).then(
      (bytes) => {
        if (cancelled) return;
        created = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'image/jpeg' }));
        setUrl(created);
      },
      (cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      },
    );

    return () => {
      cancelled = true;
      if (created) URL.revokeObjectURL(created);
    };
  }, [entry, name, read]);

  const names = session.photos.map((photo) => photo.ref.name);
  const previous = neighbourName(names, name, -1);
  const next = neighbourName(names, name, 1);

  // Arrows to move, Escape to leave. Registered here rather than on the overlay element so it
  // works without the overlay having been clicked into focus first.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose();
      else if (event.key === 'ArrowLeft' && previous) onShow(previous);
      else if (event.key === 'ArrowRight' && next) onShow(next);
      else return;
      event.preventDefault();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose, onShow, previous, next]);

  if (!entry) return null;

  const location = locationOf(session, name);
  const instant = instantOf(session, entry);

  return (
    // Clicking the backdrop closes; clicking anything inside it must not, hence the guard on
    // the target. A dialog that shuts when you click its own buttons is a special kind of
    // infuriating.
    <div
      className="preview-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={`Preview of ${name}`}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="preview">
        <div className="preview-bar">
          <span className="name">{name}</span>
          <span className="note">
            {instant ? `${instant.toISOString().replace('T', ' ').slice(0, 19)}Z` : 'no date'}
            {' · '}
            {describeLocation(location)}
          </span>
          <div className="spacer" />
          <button type="button" onClick={() => onSelectOnly(name)}>Select this photo</button>
          <button type="button" onClick={onClose} aria-label="Close preview">Close</button>
        </div>

        <div className="preview-stage">
          {error && <p className="error">{error}</p>}
          {!error && !url && <p className="note">Reading the full photograph…</p>}
          {url && <img src={url} alt={name} draggable={false} />}

          <button
            type="button"
            className="preview-step left"
            onClick={() => previous && onShow(previous)}
            disabled={!previous}
            aria-label="Previous photo"
          >
            ‹
          </button>
          <button
            type="button"
            className="preview-step right"
            onClick={() => next && onShow(next)}
            disabled={!next}
            aria-label="Next photo"
          >
            ›
          </button>
        </div>
      </div>
    </div>
  );
}

function describeLocation(location: ReturnType<typeof locationOf>): string {
  if (location.kind === 'none') return 'no location';
  if (location.kind === 'pending-clear') return 'location will be removed';

  const { latitude, longitude } = location.coordinates;
  const text = `${latitude.toFixed(5)}, ${longitude.toFixed(5)}`;
  return location.kind === 'pending' ? `${text} (unsaved)` : text;
}
