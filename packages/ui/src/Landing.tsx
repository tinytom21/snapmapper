/**
 * The first screen: what this is, and the one button that starts.
 *
 * What was here before was the empty state of a working screen — a paragraph of caveats and the
 * device capability report, which existed to settle whether Android needed a native shell. That
 * question is answered, so on the way in the report is just diagnostics in a stranger's face. It
 * still exists: in the sidebar's "This device" section once photos are open, and on the gate screen
 * for a browser that cannot do this at all, where it is the explanation rather than clutter.
 *
 * The two ways in are both here and both described, because choosing wrongly is expensive: a camera
 * card holds a thousand photos in one folder and metadata costs about half a second each, so
 * opening a whole card would run for the best part of an hour before you could touch anything.
 */

import { OUTPUT_FOLDER_NAME } from './browser-file-store.ts';

export function Landing({
  canPickFiles,
  canPickFolder,
  busy,
  onPickPhotos,
  onPickFolder,
}: {
  readonly canPickFiles: boolean;
  readonly canPickFolder: boolean;
  readonly busy: boolean;
  readonly onPickPhotos: () => void;
  readonly onPickFolder: () => void;
}) {
  return (
    <div className="landing">
      <div className="landing-hero">
        {/* The app's own icon, inline, so the hero costs no request and scales cleanly. */}
        <svg className="landing-mark" viewBox="0 0 64 64" aria-hidden="true">
          <circle cx="32" cy="27" r="12" fill="none" stroke="currentColor" strokeWidth="5" />
          <path d="M32 39 L32 52" stroke="currentColor" strokeWidth="5" strokeLinecap="round" />
        </svg>

        <h2>Put your snapshots on the map</h2>
        <p className="landing-lead">
          Choose your photos, tap where they were taken, and the coordinates are written into the
          files themselves.
        </p>

        <div className="landing-actions">
          {canPickFiles && (
            <button type="button" className="primary big" onClick={onPickPhotos} disabled={busy}>
              Select photos…
            </button>
          )}
          {canPickFolder && (
            <button type="button" className="big" onClick={onPickFolder} disabled={busy}>
              Open a whole folder…
            </button>
          )}
        </div>
        <p className="landing-hint">
          Picking the photos you want is the quick way, and the right one for a camera card.
          Opening a folder reads every photo in it — fine for a small one.
        </p>
      </div>

      <ol className="landing-steps">
        <li>
          <strong>Pick your photos</strong>
          <span>Straight off the camera card, if you like. Nothing is copied anywhere yet.</span>
        </li>
        <li>
          <strong>Select and tap the map</strong>
          <span>One photo or fifty at once. Nothing is written until you press Save.</span>
        </li>
        <li>
          <strong>Save</strong>
          <span>
            Copies go to a <code>{OUTPUT_FOLDER_NAME}</code> folder beside your originals, and each
            one is read back and checked.
          </span>
        </li>
      </ol>

      <p className="landing-privacy">
        <strong>Your photographs stay on this device.</strong> They are read and written here, by
        code running in your browser — there is no server and no account, and it works with the
        network switched off.
      </p>
    </div>
  );
}
