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

import { PhotoList } from './PhotoList.tsx';

const FOLDER = { id: 'preview', displayName: 'Selected photos' };

function samplePhoto(name: string, tags: Record<string, unknown> = {}): PhotoEntry {
  return entryFromTags(
    { folder: FOLDER, name, sizeBytes: 6_400_000, modifiedAtMs: 0, locator: name },
    { 'EXIF:DateTimeOriginal': '2024:05:17 14:32:08', ...tags },
  );
}

/** A session covering every state a row can be in, which is what makes it worth looking at. */
export function sampleSession(): Session {
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

  let session = createSession(photos, { timeZone: 'Europe/London', offsetSeconds: 45 });
  // One with a staged edit, so the pending styling is visible too.
  session = assignLocation(session, ['DSC00121.JPG'], { latitude: -33.4489, longitude: -70.6693 });
  return select(session, ['DSC00119.JPG', 'DSC00121.JPG']);
}

let root: Root | undefined;

/**
 * Replace the sidebar with a sample photo list.
 *
 * Mounted into the real `<aside>` on purpose, so it inherits the actual layout and media
 * queries rather than being measured in an artificial container that proves nothing.
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
    <PhotoList
      session={session}
      thumbnails={new Map()}
      onToggle={() => {}}
      onSelectOnly={() => {}}
      onSelectRange={() => {}}
      onSelectAll={() => {}}
      onSelectNone={() => {}}
      onClear={() => {}}
      onRevert={() => {}}
    />,
  );
}
