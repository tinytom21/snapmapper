/**
 * What this device can do about files, shown on screen.
 *
 * On screen rather than in the console because the device that matters is a phone, and a
 * phone has no console without plugging it into a computer. A capability report you cannot
 * read on the device is no use for deciding anything about that device.
 *
 * This exists to answer one question: does Android actually need a native shell? `docs/PLAN.md`
 * says a pure PWA cannot rewrite files in a card folder because Chrome on Android has no
 * `showDirectoryPicker`. That was true when written, has never been checked on the hardware,
 * and the whole Tauri-versus-Capacitor question rests on it.
 */

import { useMemo, useState } from 'react';

import { describePlatform } from './self-check.ts';

export function PlatformReport() {
  const [open, setOpen] = useState(false);
  const report = useMemo(() => describePlatform(), []);

  const secure = report.secureContext === true;
  const picker = report.showDirectoryPicker === true;

  return (
    <div className="panel-body">
      <Verdict secure={secure} picker={picker} />

      <div className="row">
        <button type="button" onClick={() => setOpen((shown) => !shown)}>
          {open ? 'Hide details' : 'Show details'}
        </button>
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard?.writeText(JSON.stringify(report, null, 2));
          }}
        >
          Copy report
        </button>
      </div>

      {open && (
        <dl className="report">
          {Object.entries(report).map(([key, value]) => (
            <div key={key} className={typeof value === 'boolean' ? (value ? 'yes' : 'no') : ''}>
              <dt>{key}</dt>
              <dd>{typeof value === 'boolean' ? (value ? 'yes' : 'no') : String(value)}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

/** One line for a collapsed summary. */
export function describePlatformBriefly(): string {
  const report = describePlatform();
  if (report.showDirectoryPicker === true || report.showOpenFilePicker === true) {
    return 'can write to your photos';
  }
  return report.secureContext === true ? 'cannot write here' : 'not a secure context';
}

/**
 * The conclusion, stated so it cannot be misread.
 *
 * The important case is the middle one. `showDirectoryPicker` is gated on a secure context,
 * so over plain `http://` on a LAN address it is absent whatever the platform supports. A
 * report that just said "no" there would be worse than no report at all: it looks like a
 * definitive answer and is not one.
 */
function Verdict({ secure, picker }: { secure: boolean; picker: boolean }) {
  if (picker) {
    return (
      <div className="banner ok inline">
        <strong>This browser can open a folder and write to it in place.</strong>
        <div className="note">
          No native shell is needed here — the app works as it stands.
        </div>
      </div>
    );
  }

  if (!secure) {
    return (
      <div className="banner warn inline">
        <strong>Inconclusive — this page is not a secure context.</strong>
        <div className="note">
          The folder picker is only exposed on a secure origin, so its absence here says
          nothing about what this device supports. Reach the app over <code>https://</code>
          {' '}or <code>localhost</code> and look again.
        </div>
        <div className="note">
          On the machine running it: <code>npm run dev:lan</code>, then open the
          {' '}<code>https://</code> address it prints and accept the certificate warning.
        </div>
      </div>
    );
  }

  return (
    <div className="banner error inline">
      <strong>No folder picker, on a secure origin — so this platform genuinely lacks it.</strong>
      <div className="note">
        A native shell is required to write to photos in place here. This is the result that
        makes the Tauri-versus-Capacitor question real.
      </div>
    </div>
  );
}
