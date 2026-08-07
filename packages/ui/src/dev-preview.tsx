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
 *     (await import('/src/dev-preview.tsx')).previewFullSize()
 *     (await import('/src/dev-preview.tsx')).previewActionMenu()
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
} from '@snapmapper/core';

import { ActionMenu } from './ActionMenu.tsx';
import { PhotoPreview } from './PhotoPreview.tsx';
import { Sidebar } from './Sidebar.tsx';
import type { ThumbSize } from './thumb-size.ts';

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
export function previewPhotoList(
  session: Session = sampleSession(),
  size: ThumbSize['key'] = 'medium',
): void {
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
      thumbnails={sampleThumbnails(session)}
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
      onPreview={() => {}}
      thumbSize={size}
      onThumbSize={(next) => previewPhotoList(session, next)}
      onTimeZone={() => {}}
      onOffsetSeconds={() => {}}
      onSync={() => {}}
      onClearSync={() => {}}
      onScanReference={async () => null}
    />,
  );
}

let previewRoot: Root | undefined;

/**
 * Mount the full-size preview over the page, on a generated photograph.
 *
 * The real one is reached through the OS file picker, which cannot be scripted, so without this
 * the overlay could only be checked by picking real photos on a real phone every time — and the
 * things worth checking are exactly the ones that go wrong at 375px: whether the image fits the
 * viewport rather than overflowing it, and whether the step buttons are reachable by a thumb.
 *
 * The photograph is drawn here. No file is read and no real photograph is involved.
 */
export function previewFullSize(name = 'DSC00121.JPG'): void {
  const session = sampleSession();
  const host = document.createElement('div');
  document.body.append(host);

  previewRoot?.unmount();
  previewRoot = createRoot(host);

  function show(current: string) {
    previewRoot?.render(
      <PhotoPreview
        session={session}
        name={current}
        read={fakePhotograph}
        onShow={show}
        onClose={() => {
          previewRoot?.unmount();
          previewRoot = undefined;
          host.remove();
        }}
        onSelectOnly={(chosen) => console.log('would select', chosen)}
      />,
    );
  }

  show(name);
}

/** A 3:2 image with the same proportions as an A6400 frame, so the layout is being told the truth. */
async function fakePhotograph(): Promise<Uint8Array> {
  const canvas = document.createElement('canvas');
  canvas.width = 3000;
  canvas.height = 2000;

  const context = canvas.getContext('2d');
  if (!context) throw new Error('no 2d canvas context');

  const gradient = context.createLinearGradient(0, 0, canvas.width, canvas.height);
  gradient.addColorStop(0, '#1d4ed8');
  gradient.addColorStop(1, '#b45309');
  context.fillStyle = gradient;
  context.fillRect(0, 0, canvas.width, canvas.height);

  context.fillStyle = '#fff';
  context.font = 'bold 220px system-ui, sans-serif';
  context.textAlign = 'center';
  context.fillText('sample', canvas.width / 2, canvas.height / 2);

  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, 'image/jpeg', 0.85));
  if (!blob) throw new Error('canvas produced no JPEG');
  return new Uint8Array(await blob.arrayBuffer());
}

/**
 * Thumbnails shaped like the camera's own.
 *
 * The A6400 embeds a **160x120** JPEG: a 3:2 frame letterboxed into 4:3, with black bars above and
 * below. Those bars were being displayed for months, because the row's box was 4:3 too. The
 * samples are built the same way so the crop that hides them is being tested against the real
 * shape rather than a convenient one.
 */
function sampleThumbnails(session: Session): Map<string, string> {
  const urls = new Map<string, string>();

  for (const [index, entry] of session.photos.entries()) {
    const canvas = document.createElement('canvas');
    canvas.width = 160;
    canvas.height = 120;

    const context = canvas.getContext('2d');
    if (!context) break;

    // The letterbox.
    context.fillStyle = '#000';
    context.fillRect(0, 0, 160, 120);

    // The picture: 160x107, centred, so 6.5px of bar top and bottom.
    const hue = (index * 47) % 360;
    context.fillStyle = `hsl(${hue} 55% 45%)`;
    context.fillRect(0, 7, 160, 106);
    context.fillStyle = '#fff';
    context.font = 'bold 34px system-ui, sans-serif';
    context.textAlign = 'center';
    context.fillText(String(index + 1), 80, 72);

    urls.set(entry.ref.name, canvas.toDataURL('image/jpeg', 0.8));
  }

  return urls;
}

let menuRoot: Root | undefined;

/**
 * Mount the header's overflow menu, which is otherwise only reachable with photos open.
 *
 * The header's actions appear only once a session exists, and a session needs the OS file picker,
 * so without this the menu could not be looked at on a phone-width screen at all — which is the
 * only width it exists for.
 */
export function previewActionMenu(): void {
  const actions = document.querySelector('header .actions') ?? document.querySelector('header');
  if (!actions) throw new Error('no header to mount into — open the app first');

  const host = document.createElement('div');
  host.style.cssText = 'margin-left:auto';
  actions.append(host);

  menuRoot?.unmount();
  menuRoot = createRoot(host);

  function render(open: boolean) {
    menuRoot?.render(
      <ActionMenu open={open} onOpen={() => render(true)} onClose={() => render(false)}>
        <div className="menu-label">DCIM/100MSDCF</div>
        <button type="button">Add photos…</button>
        <button type="button">Select different photos…</button>
        <button type="button">Open a whole folder…</button>
      </ActionMenu>,
    );
  }

  render(false);
}
