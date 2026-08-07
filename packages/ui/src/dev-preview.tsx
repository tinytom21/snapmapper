/**
 * Mount interface pieces with sample data, for looking at them.
 *
 * A development aid, not part of the application. It exists because the parts worth checking at a
 * phone's width sit behind an operating system file picker that cannot be scripted, so the only
 * way to see the photo list at 375px was to pick real photos on a real phone every time. That is
 * a slow loop for work that is mostly about spacing and touch targets.
 *
 * From the browser console:
 *
 *     (await import('/src/dev-preview.tsx')).previewPhotoList()
 *
 * Sample photos only — nothing here touches the filesystem, and no real photograph is involved.
 */

import { createRoot, type Root } from 'react-dom/client';

import {
  assignLocation,
  createSession,
  entryFromTags,
  failedEntry,
  select,
  type PhotoEntry,
  type Session,
} from '@geotagger/core';

import { Sidebar } from './Sidebar.tsx';

const FOLDER = { id: 'preview', displayName: 'Selected photos' };

function samplePhoto(name: string, tags: Record<string, unknown> = {}): PhotoEntry {
  return entryFromTags(
    { folder: FOLDER, name, sizeBytes: 6_400_000, modifiedAtMs: 0, locator: name },
    { 'EXIF:DateTimeOriginal': '2024:05:17 14:32:08', ...tags },
  );
}

/**
 * A session covering every state a row can be in, and long enough to overflow a phone.
 *
 * The length is deliberate: a list that fits is the case that always worked. Every layout bug
 * here has been about what happens past the fold, so the sample has to go past it.
 */
export function sampleSession(count = 24): Session {
  const photos: PhotoEntry[] = [
    samplePhoto('DSC00119.JPG'),
    samplePhoto('DSC00120.JPG', {
      'Composite:GPSLatitude': 51.4778,
      'Composite:GPSLongitude': -0.0015,
    }),
    samplePhoto('DSC00121.JPG'),
    samplePhoto('DSC00122.JPG', { 'EXIF:DateTimeOriginal': '0000:00:00 00:00:00' }),
    failedEntry(
      { folder: FOLDER, name: 'DSC00123.JPG', sizeBytes: 12, modifiedAtMs: 0, locator: 'x' },
      'unreadable EXIF',
    ),
    samplePhoto('DSC00124.JPG'),
    samplePhoto('DSC00125.JPG'),
  ];

  while (photos.length < count) {
    photos.push(samplePhoto(`DSC00${(126 + photos.length).toString().padStart(3, '0')}.JPG`));
  }

  let session = createSession(photos, { timeZone: 'Europe/London', offsetSeconds: 45 });
  // One with a staged edit, so the pending styling is visible too.
  session = assignLocation(session, ['DSC00121.JPG'], { latitude: -33.4489, longitude: -70.6693 });
  return select(session, ['DSC00119.JPG', 'DSC00121.JPG']);
}

let root: Root | undefined;

/**
 * Replace the sidebar's contents with the real sidebar, on sample data.
 *
 * Mounts `Sidebar` rather than `PhotoList` alone, and into the real `<aside>`, so it inherits the
 * actual layout and media queries. The earlier version rendered only the list, which is exactly
 * why a bug where the collapsed sections drew over the list's buttons survived being "measured".
 */
export function previewPhotoList(session: Session = sampleSession()): void {
  const aside = document.querySelector('aside');
  if (!aside) throw new Error('no sidebar to mount into — open the app first');

  root?.unmount();
  aside.textContent = '';

  const host = document.createElement('div');
  host.style.cssText = 'display:flex;flex-direction:column;flex:1;min-height:0';
  aside.append(host);

  root = createRoot(host);
  root.render(
    <Sidebar
      session={session}
      thumbnails={new Map()}
      narrow={window.matchMedia('(max-width: 900px)').matches}
      busy={false}
      addPhotosLabel="Add photos…"
      onToggle={() => {}}
      onSelectOnly={() => {}}
      onSelectRange={() => {}}
      onSelectAll={() => {}}
      onSelectNone={() => {}}
      onClear={() => {}}
      onRevert={() => {}}
      onTimeZone={() => {}}
      onOffsetSeconds={() => {}}
      onSync={() => {}}
      onClearSync={() => {}}
      onScanReference={async () => null}
    />,
  );
}
