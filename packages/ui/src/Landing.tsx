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
      {/*
        Why, before how.

        The old copy opened with the instruction and never said what it was for, so the honest
        reaction to it was "my clock is probably fine, skip". It usually is not fine: a camera has
        no radio and no network, so its clock free-runs and drifts — and if the zone was never
        changed after a flight, or a battery went flat, it can be hours out. That is what makes a
        photograph land in the wrong town when a track places it, and it is the thing to say first.
      */}
      <p className="note">
        <strong>Your camera&rsquo;s clock is almost certainly a little wrong</strong> — it has no
        radio to set itself by, so it drifts. A few seconds a week is normal; hours if the time
        zone was never changed after travelling, or if the battery went flat.
      </p>

      <p className="note">
        <strong>Photograph this code and that stops mattering.</strong> Snapmapper reads the exact
        instant back out of the picture, compares it with what the camera recorded, and corrects
        every photograph you place from a GPS track by the difference. Nothing is typed, and a
        misread code fails outright rather than producing a plausible wrong time.
      </p>

      <QrClock />

      <p className="note">
        Take the photograph now, while the card is still in the camera — then carry on as normal.
        Once your photos are open, choose <strong>Camera clock</strong>, select this one frame and
        press <strong>Read clock from photo</strong>. It only needs doing again if you change the
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
        {/*
          Each button says what it takes, so the paragraph explaining it can go.

          There were two of those — one contrasting the ways in, one listing the formats — and
          between them they said the same thing twice in prose nobody reads while looking for a
          button. A format belongs on the control it applies to: it is answered at the moment the
          question is asked, and it cannot drift out of step with what the button actually does.
        */}
        <div className="landing-actions">
          <button
            type="button"
            className="feature big stacked"
            aria-expanded={showClock}
            onClick={() => setShowClock((was) => !was)}
          >
            <span>{showClock ? 'Hide the clock code' : 'Sync the camera clock'}</span>
            <span className="sub">Cameras drift — one photo fixes it</span>
          </button>
          {canPickFiles && (
            <button
              type="button"
              className="primary big stacked"
              onClick={onPickPhotos}
              disabled={busy}
            >
              <span>Select photos…</span>
              <span className="sub">JPEG only</span>
            </button>
          )}
          {canPickFolder && (
            <button type="button" className="big stacked" onClick={onPickFolder} disabled={busy}>
              <span>Open a whole folder…</span>
              <span className="sub">JPEG and raw</span>
            </button>
          )}
        </div>

        {showClock && <ClockSyncPanel />}

      </div>

      {/*
        Three steps, and the clock is not one of them any more.

        It had a button in the hero *and* an unnumbered entry here, which is one mention too many
        for something optional — and the two had to agree forever. The button carries it; this list
        is the shape of the job.
      */}
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

      {/*
        The notices have to reach the person receiving the software, not just sit in the
        repository — MIT, BSD-3-Clause and Apache-2.0 each oblige us to reproduce their text when
        distributing a binary, and a bundled web app is a binary distribution. So the file is a
        static asset served beside the app, and this is the link to it.

        `import.meta.env.BASE_URL` rather than a bare '/': on a GitHub Pages project site the app
        lives under `/snapmapper/`, and a root-relative link would 404 there while working
        perfectly on localhost.
      */}
      {/*
        Credit where it is owed, which is mostly not where the licences require it.

        Snapmapper is a thin interface over other people's hard work: the entire metadata engine is
        ExifTool, and the only reason it runs in a browser at all is that somebody built a Perl
        interpreter for WebAssembly. Saying so is not a legal obligation — the notices file covers
        that — it is just true, and the names are verifiable rather than guessed: every handle here
        comes from the package's own `repository` field.
      */}
      <section className="landing-credits">
        <h3>Built on other people&rsquo;s work</h3>
        <ul>
          <li>
            <a href="https://exiftool.org/">ExifTool</a> by <strong>Phil Harvey</strong> — twenty
            years of knowing what every camera actually writes. It does all the metadata work here;
            Snapmapper only decides what to ask it.
          </li>
          <li>
            <a href="https://github.com/6over3/zeroperl">zeroperl</a> and{' '}
            <a href="https://github.com/6over3/exiftool">@uswriting/exiftool</a> by{' '}
            <strong>6over3</strong> — a Perl interpreter compiled to WebAssembly, which is the only
            reason real ExifTool runs in a browser with no server behind it.
          </li>
          <li>
            <a href="https://github.com/maplibre/maplibre-gl-js">MapLibre GL JS</a> by the{' '}
            <strong>MapLibre</strong> community, and{' '}
            <a href="https://openfreemap.org">OpenFreeMap</a>, which serves the vector tiles free
            and without an API key.
          </li>
          <li>
            <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors — the
            map itself, and the place names, both given away.
          </li>
          <li>
            <a href="https://github.com/cozmo/jsQR">jsQR</a> by <strong>cozmo</strong> and{' '}
            <a href="https://github.com/soldair/node-qrcode">node-qrcode</a> by{' '}
            <strong>Ryan Day</strong> — between them, the camera-clock trick.
          </li>
        </ul>
      </section>

      <p className="landing-licences">
        Open source. <a href="https://github.com/tinytom21/snapmapper">Source code</a> under the
        Artistic License 2.0, and the{' '}
        <a href={`${import.meta.env.BASE_URL}THIRD-PARTY-NOTICES.md`}>
          notices for everything it is built on
        </a>.
      </p>

      <p className="landing-privacy">
        <strong>Your photographs stay on this device.</strong> They are read and written here, by
        code running in your browser — there is no server and no account, and it works with the
        network switched off.
      </p>
    </div>
  );
}
