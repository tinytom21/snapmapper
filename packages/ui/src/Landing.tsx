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

import { useState } from 'react';

import { OUTPUT_FOLDER_NAME } from './browser-file-store.ts';
import { QrClock } from './QrClock.tsx';
import { Wordmark } from './Wordmark.tsx';

/**
 * Photograph the clock code before the card comes out.
 *
 * This is here because of where the *camera* is. The code has to be photographed by the camera, and
 * at the start of a session the camera is the thing holding the card — so this is the one moment
 * when photographing it costs nothing at all. Reaching it from the sidebar instead meant the card
 * had to be unmounted, plugged into the phone, some photos picked so the panel existed, then the
 * card unmounted again, returned to the camera, the screen photographed, and the card mounted a
 * second time. All to read a code that never needed the card.
 *
 * Collapsed by default, because the landing screen's job is to start you and most sessions do not
 * need this — a clock is set once and drifts slowly. Open, it is the only thing on screen worth
 * looking at, which is right for something you are about to point a camera at.
 */
function ClockSyncPanel() {
  return (
    <div className="landing-sync open">
      <p className="note">
        <strong>Do this while the card is still in the camera.</strong> Photograph the code below,
        then carry on as normal — the photo of it comes in with the rest, and Snapmapper reads the
        exact time out of the image. Nothing is typed and nothing can be misread.
      </p>

      <QrClock />

      <p className="note">
        Later, in <strong>Camera clock</strong>, select that one photo and press{' '}
        <strong>Read clock from photo</strong>. It only needs doing again if you change the
        camera&rsquo;s clock.
      </p>
    </div>
  );
}

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
  const [showClock, setShowClock] = useState(false);

  return (
    <div className="landing">
      <div className="landing-hero">
        {/*
          The wordmark, then the sentence. The name is the mark's job and the headline's job is to
          say what the thing does — running them together would leave a heading that has to do both
          and does neither.
        */}
        <h1 className="landing-wordmark"><Wordmark variant="hero" /></h1>

        <h2>Put your snapshots on the map</h2>
        <p className="landing-lead">
          Choose your photos, tap where they were taken, and the coordinates are written into the
          files themselves.
        </p>

        {/*
          The clock code is first, and it is first because that is the order the work happens in:
          it has to be photographed while the card is still in the camera, so once you have reached
          for `Select photos…` the moment has gone and the card has to go back.

          It is styled `feature` rather than `primary` deliberately. Two filled accent buttons side
          by side is no emphasis at all, and `Select photos…` is still the thing the application is
          for — so this one takes the accent outline and the wash, which is the loudest a control
          gets here without claiming to be the main action.
        */}
        <div className="landing-actions">
          <button
            type="button"
            className="feature big"
            aria-expanded={showClock}
            onClick={() => setShowClock((was) => !was)}
          >
            {showClock ? 'Hide the clock code' : 'Sync the camera clock…'}
          </button>
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

        {showClock && <ClockSyncPanel />}

        <p className="landing-hint">
          Sync the clock <strong>before the card leaves the camera</strong>, if it has drifted.
          Then: picking the photos you want is the quick way, and the right one for a camera card.
          Opening a folder reads every photo in it — fine for a small one.
        </p>

        {/*
          Which route takes which format, said where the choice is made.

          It is not a detail: raw can only be *saved* from a folder, because its sidecar has to be
          written next to the file and the file picker gives no access to a parent. Somebody who
          shoots raw and reaches for the obvious button would otherwise get as far as placing
          photographs before finding out.
        */}
        <p className="landing-formats">
          <span><strong>JPEG</strong> — either way in.</span>
          <span>
            <strong>Raw (.ARW)</strong> — <em>Open a whole folder</em> only. Its location is written
            to an <code>.xmp</code> sidecar beside the file, which needs the folder; the raw itself
            is never altered.
          </span>
        </p>
      </div>

      <ol className="landing-steps">
        {/*
          The clock code sits *above* the numbered steps and is deliberately not one of them.

          It genuinely comes first — it has to be photographed while the card is still in the
          camera, which is before anything else can happen — but it is optional, and a reader
          counting steps to judge how much work this is deserves the answer "three". So it keeps its
          place in the sequence and stays outside the numbering, which is what an unnumbered marker
          in the same column says without a word.

          It carries no button of its own. The control is the first one in the hero, where it is
          hard to miss; a second button doing the same thing further down the page would only raise
          the question of whether they differ.
        */}
        <li className="optional">
          <strong>Sync the camera clock <em>— optional</em></strong>
          <span>
            Only if the camera&rsquo;s clock is off, and only once — but it has to happen while the
            card is still in the camera, which is why it is up there rather than down here.
          </span>
        </li>

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
