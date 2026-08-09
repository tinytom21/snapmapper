/**
 * The live clock code, on its own so it is not trapped behind a loaded session.
 *
 * ## Why this moved out of `ClockPanel`
 *
 * The code has to be **photographed by the camera**, and the camera is holding the card. So the
 * moment to photograph it is *before* the card comes out — and it used to live in a sidebar panel
 * that only exists once photographs are open, which is to say only after the card has come out.
 * The workflow that forced was: unmount the card, plug it into the phone, pick some photos so the
 * panel exists at all, open the clock section, unmount the card, put it back in the camera,
 * photograph the screen, and mount it again. Two extra round trips of a small piece of hardware,
 * to read a code that never needed the card at all.
 *
 * Nothing about the measurement requires a session. The code encodes an instant; the camera records
 * that instant against its own clock; the difference is read out of the photograph *later*, when
 * the photographs are loaded and one of them is marked as the reference. Only the *display* was
 * ever coupled to the session, and only by where it happened to be drawn.
 *
 * So it is drawn here, and both the landing screen and the sidebar panel use it.
 *
 * ## The bits that matter
 *
 * - **Maximum error correction (`H`).** This code is photographed off a glossy screen, at an angle,
 *   often in a room with a light behind it. That is close to the worst case a QR faces. QR was
 *   chosen over showing the time as text for exactly this reason: a misread cannot silently produce
 *   a plausible wrong instant — it either decodes exactly or not at all.
 * - **Redrawn on a fixed interval**, so the uncertainty in the reading is bounded and known rather
 *   than being however long the code happened to sit on screen.
 * - **Black on white, always.** Not themed. The dark palette's ink on its surface is a perfectly
 *   good contrast for reading and a poor one for a decoder pointed at a backlit panel, and this is
 *   the one element on screen whose job is to be machine-readable rather than to look right.
 */

import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';

import { SYNC_QR_REFRESH_MS, encodeSyncPayload, syncUncertaintySeconds } from '@snapmapper/core';

export function QrClock() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [shown, setShown] = useState<Date>(() => new Date());

  useEffect(() => {
    let cancelled = false;

    const draw = () => {
      const target = canvas.current;
      if (!target || cancelled) return;

      const now = new Date();
      QRCode.toCanvas(target, encodeSyncPayload(now), {
        width: 260,
        margin: 2,
        errorCorrectionLevel: 'H',
        color: { dark: '#000000ff', light: '#ffffffff' },
      }).then(
        () => {
          if (cancelled) return;
          /*
           * Drop the inline width and height the library writes.
           *
           * `toCanvas` sets `style.width` and `style.height` from its own option, and an inline
           * style beats any stylesheet — so the canvas ignored every responsive rule aimed at it.
           * That was invisible until a 320px screen, where `max-width: 100%` (which *does* win,
           * because max-width beats width) shrank the box to 254px while the inline height stayed
           * at 260 and the code came out squashed by 2%. A decoder tolerates that; a stylesheet
           * that silently does nothing is the part worth removing.
           *
           * Stripped rather than overridden with `!important`, so `.qr canvas` in the stylesheet
           * means what it says. The bitmap keeps its own resolution — that comes from the width
           * *attribute*, which this does not touch.
           */
          target.removeAttribute('style');
          setShown(now);
        },
        (cause: unknown) => {
          if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
        },
      );
    };

    draw();
    const timer = setInterval(draw, SYNC_QR_REFRESH_MS);
    return () => {
      // Both matter: the interval stops the redraw, and the flag stops an in-flight `toCanvas`
      // resolving into a component that has gone. A collapsed section unmounts this, so it is not
      // redrawing a code nobody is looking at four times a second.
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  return (
    <div className="qr">
      <canvas ref={canvas} />
      {error
        ? <p className="note error">Could not draw the code: {error}</p>
        : (
          <p className="note">
            {shown.toISOString().replace('T', ' ').slice(0, 19)}Z — redrawn every{' '}
            {SYNC_QR_REFRESH_MS} ms, so the reading is good to about{' '}
            {syncUncertaintySeconds('qr')} s.
          </p>
        )}
    </div>
  );
}
