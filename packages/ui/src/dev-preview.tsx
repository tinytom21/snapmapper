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
 *     (await import('/src/dev-preview.tsx')).previewMap()
 *     (await import('/src/dev-preview.tsx')).previewConflicts(3)
 *     (await import('/src/dev-preview.tsx')).previewChooser(900)
 *
 * Sample photos only — nothing here touches the filesystem, and no real photograph is involved.
 */

import { createRoot, type Root } from 'react-dom/client';

import {
  applyTrack,
  assignLocation,
  clearLocation,
  createSession,
  parseGpx,
  entryFromTags,
  failedEntry,
  revert,
  select,
  selectRange,
  toggleSelected,
  stagedPhotos,
  unplacedPhotos,
  distanceMetres,
  type GpxTrack,
  type FileStore,
  type LocationConflict,
  type PhotoEntry,
  type Session,
} from '@snapmapper/core';

import { ActionMenu } from './ActionMenu.tsx';
import { ConflictPrompt } from './ConflictPrompt.tsx';
import { FolderChooser } from './FolderChooser.tsx';
import { PhotoMap, type MapPin } from './PhotoMap.tsx';
import { PhotoPreview } from './PhotoPreview.tsx';
import { ReviewBar } from './ReviewBar.tsx';
import { Sidebar } from './Sidebar.tsx';
import type { ViewMode } from './view-mode.ts';

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
 *
 * Selection is wired to the real session functions rather than stubbed. With stubs the rows and
 * tiles looked right and did nothing, so nothing about *behaviour* could be checked here — and in
 * the grid the interesting question is precisely whether tapping a tile selects it, tapping its
 * tick box toggles only that one, and tapping its corner opens the preview instead of doing either.
 */
/**
 * A synthetic walk, so the track panel and the map's line can be inspected without a GPX file.
 *
 * The times bracket `sampleSession`'s photographs, which all read `2024:05:17 14:32:08` — with the
 * sample clock (Europe/London, 45s fast) that resolves to 13:31:23Z. A track over any other
 * afternoon would look right in the panel and place nothing, which exercises none of this.
 */
export function sampleTrack(): GpxTrack {
  const points: string[] = [];
  for (let minute = 0; minute <= 120; minute++) {
    const time = new Date(Date.UTC(2024, 4, 17, 12, 30 + minute)).toISOString();
    points.push(
      `<trkpt lat="${43.6047 + minute * 0.002}" lon="${1.4442 + minute * 0.003}">`
      + `<ele>${150 + minute}</ele><time>${time}</time></trkpt>`,
    );
  }
  return parseGpx(`<gpx><trk><name>Sample walk</name><trkseg>${points.join('')}</trkseg></trk></gpx>`);
}

/**
 * The review bar, above a stand-in for the map.
 *
 * Its own entry point because it is mounted by `App` rather than by the sidebar, so the harness
 * that checks the sidebar cannot reach it — and a strip that sits over a working interface is
 * exactly the sort of thing that looks fine in isolation and overlaps something at 375px.
 */
export function previewReviewBar(): void {
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;inset:0;z-index:20;display:flex;flex-direction:column;'
    + 'background:var(--bg)';
  document.body.append(host);

  reviewRoot?.unmount();
  reviewRoot = createRoot(host);

  const base = sampleSession();
  const placed = assignLocation(
    base,
    base.photos.slice(0, 6).map((entry) => entry.ref.name),
    { latitude: 43.6047, longitude: 1.4442 },
  );
  const thumbnails = sampleThumbnails(placed);

  function render(current: string) {
    reviewRoot?.render(
      <>
        <ReviewBar
          session={placed}
          thumbnails={thumbnails}
          current={current}
          onGo={render}
          onClose={() => { reviewRoot?.unmount(); reviewRoot = null; host.remove(); }}
          onPreview={(name) => console.log('preview', name)}
        />
        <div style={{ flex: 1, background: 'var(--surface)', display: 'grid', placeItems: 'center' }}>
          the map would be here
        </div>
      </>,
    );
  }

  render(stagedPhotos(placed)[0]?.ref.name ?? '');
}

export function previewPhotoList(
  initial: Session = sampleSession(),
  view: ViewMode = 'list',
): void {
  const aside = document.querySelector('aside');
  if (!aside) throw new Error('no sidebar to mount into — open the app first');

  root?.unmount();
  aside.textContent = '';

  const host = document.createElement('div');
  host.style.cssText = 'display:flex;flex-direction:column;flex:1;min-height:0';
  aside.append(host);

  root = createRoot(host);
  const thumbnails = sampleThumbnails(initial);
  // Mutable rather than state: this harness re-renders by calling `render` itself, so a hook
  // would need a component wrapper that exists only to hold one value.
  let track: GpxTrack | null = sampleTrack();
  function render(session: Session, current: ViewMode) {
    const again = (next: Session) => render(next, current);

    root?.render(
      <Sidebar
        session={session}
        thumbnails={thumbnails}
        busy={false}
        addPhotosLabel="Add photos…"
        places={{
          progress: null,
          lastRun: null,
          onGeocode: (scope) => console.log('geocode', scope),
          onStop: () => console.log('stop'),
        }}
        track={{
          track: track,
          trackFile: 'sample.gpx',
          onTrack: (loaded) => { track = loaded; again(session); },
          onClearTrack: () => { track = null; again(session); },
          onReview: () => console.log("review"),
          onMatch: (options) => {
            if (!track) return { placed: [], skipped: [] };
            const outcome = applyTrack(session, track, options);
            again(outcome.session);
            return { placed: outcome.placed, skipped: outcome.skipped };
          },
          // The folder half is stubbed: it needs a real directory handle, which only a picker can
          // produce. What this harness is for is the layout, and the bar is present either way.
          folder: {
            name: 'GPSLogger',
            needsPermission: false,
            searching: null,
            lastSearch: { kind: 'loaded', files: ['2024-05-17.gpx'], considered: 412 },
            onChoose: () => console.log('choose track folder'),
            onReconnect: () => console.log('reconnect'),
            onForget: () => console.log('forget'),
            onSearch: () => console.log('search'),
          },
        }}
        onToggle={(name) => again(toggleSelected(session, name))}
        onSelectOnly={(name) => again(select(session, [name]))}
        onSelectRange={(from, to, add) => again(selectRange(session, from, to, add))}
        onSelectAll={() =>
          again(select(session, session.photos.map((entry) => entry.ref.name)))}
        onSelectUnplaced={() => again(select(session, unplacedPhotos(session).map((e) => e.ref.name)))}
        onSelectNone={() => again(select(session, []))}
        onClear={() => again(clearLocation(session, [...session.selected]))}
        onRevert={() => again(revert(session, [...session.selected]))}
        onPreview={(name) => previewFullSize(name)}
        view={current}
        onView={(next) => render(session, next)}
        onTimeZone={() => {}}
        onOffsetSeconds={() => {}}
        onSync={() => {}}
        onClearSync={() => {}}
        onScanReference={async () => null}
      />,
    );
  }

  render(initial, view);
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

let conflictRoot: Root | undefined;
let conflictHost: HTMLElement | undefined;

/**
 * The "two locations for this photograph" question, which is otherwise almost unreachable.
 *
 * It needs a card whose photographs were geotagged in an *earlier* session and then moved, so
 * without this it could not be looked at on a phone-width screen without staging that situation on
 * real files. It is also the only overlay in the app with three lines of text on each of two
 * buttons, which is exactly the shape that overflows at 320px.
 *
 * `count` drives the "answer the same way for the other N" checkbox, which only appears when there
 * is more than one — so both states need to be reachable.
 */
export function previewConflicts(count = 3): void {
  /*
   * The previous host is *removed*, not just unmounted.
   *
   * Unmounting empties a `<div>` and leaves it in the document. Calling this twice then left two
   * hosts, and `document.querySelector('.conflict')` answered with the stale one — so a second
   * measurement silently reported the first call's numbers. Found by measuring, which is the
   * only way it would have been found: on screen the two sit exactly on top of one another.
   */
  conflictRoot?.unmount();
  conflictHost?.remove();

  const host = document.createElement('div');
  document.body.append(host);
  conflictHost = host;
  conflictRoot = createRoot(host);

  const names = ['DSC00119.JPG', 'DSC00120.JPG', 'DSC00121.JPG', 'DSC00516.ARW'];
  const conflicts: LocationConflict[] = Array.from({ length: count }, (_, index) => {
    const name = names[index % names.length] as string;
    const original = { latitude: 51.4778, longitude: -0.0015 };
    /*
     * Varied so the distance wording is exercised across metres and kilometres — and offset from
     * `index + 1`, never zero. A conflict a metre apart cannot occur: `samePlace` settles those
     * without asking, so a preview showing "0 m apart" would be showing a state the app never
     * reaches. It did, on the first cut of this harness.
     */
    const step = index + 1;
    const prior = { latitude: 51.4778 + step * 0.0008, longitude: -0.0015 - step * 0.004 };
    return {
      name,
      original,
      prior: {
        name,
        coordinates: prior,
        source: name.toLowerCase().endsWith('.arw') ? 'sidecar' : 'copy',
        location: name.toLowerCase().endsWith('.arw')
          ? name.replace(/\.[^.]+$/, '.xmp')
          : `geotagged/${name}`,
      },
      metresApart: distanceMetres(original, prior),
    };
  });

  function render(queued: readonly LocationConflict[]) {
    conflictRoot?.render(
      <ConflictPrompt
        conflicts={queued}
        thumbnails={new Map()}
        onChoose={(_choice, all) => render(all ? [] : queued.slice(1))}
        onDismiss={() => render([])}
      />,
    );
  }

  render(conflicts);
}


/**
 * A store that hands back drawn "photographs", so the chooser's background feed can be watched.
 *
 * The real one reads a card through ExifTool, which this harness has no card for. What is being
 * checked here is the *feed* — that pictures arrive gradually, visible days first, without the
 * grid reflowing under a selection — and that needs bytes rather than a real camera.
 */
function fakeThumbnailStore(): FileStore {
  const jpeg = (seed: number) => {
    const canvas = document.createElement('canvas');
    canvas.width = 160;
    canvas.height = 120;
    const context = canvas.getContext('2d');
    if (context) {
      context.fillStyle = `hsl(${(seed * 37) % 360} 55% 45%)`;
      context.fillRect(0, 0, 160, 120);
      context.fillStyle = '#fff';
      context.font = 'bold 40px system-ui, sans-serif';
      context.textAlign = 'center';
      context.fillText(String(seed % 1000), 80, 78);
    }
    const data = canvas.toDataURL('image/jpeg', 0.7).split(',')[1] ?? '';
    const binary = atob(data);
    return Uint8Array.from(binary, (c) => c.charCodeAt(0));
  };

  let seed = 0;
  return {
    async listFolder() { return []; },
    async read() { return jpeg(seed++); },
    async writeAtomic() { throw new Error('not used'); },
  } as unknown as FileStore;
}

let chooserRoot: Root | undefined;

/**
 * The folder chooser, on a listing the size of a real camera card.
 *
 * Its whole justification is that it stays usable at a thousand files, and a thousand files is not
 * something anyone will stage by hand to look at a layout. Note that no metadata exists here and
 * none is needed: the chooser works entirely from names, sizes and filesystem dates, which is what
 * makes opening a folder free.
 */
export function previewChooser(count = 900): void {
  const aside = document.querySelector('aside');
  if (!aside) throw new Error('no sidebar to mount into — open the app first');

  chooserRoot?.unmount();
  aside.textContent = '';

  const host = document.createElement('div');
  host.style.cssText = 'display:flex;flex-direction:column;flex:1;min-height:0';
  aside.append(host);
  chooserRoot = createRoot(host);

  // Spread over several days, with a RAW+JPEG stretch, as a card that has been out a while is.
  const day = 24 * 60 * 60 * 1000;
  const start = new Date(2024, 6, 12, 9, 0, 0).getTime();
  const refs = Array.from({ length: count }, (_, i) => {
    const raw = i % 7 === 0;
    const name = `DSC0${String(1000 + i).padStart(4, '0')}.${raw ? 'ARW' : 'JPG'}`;
    return {
      folder: FOLDER,
      name,
      sizeBytes: raw ? 24_900_000 : 6_400_000,
      modifiedAtMs: start - Math.floor(i / 60) * day + i * 20_000,
      locator: name,
    };
  });

  chooserRoot.render(
    <FolderChooser
      folderName="DCIM/100MSDCF"
      refs={refs}
      busy={false}
      onOpen={(chosen) => console.log('open', chosen.length, 'photos')}
      onCancel={() => console.log('cancel')}
      store={fakeThumbnailStore()}
    />,
  );
}

let mapRoot: Root | undefined;
let reviewRoot: Root | null | undefined;

/**
 * Mount the map on its own, with pins.
 *
 * The map is only mounted once photos are open, and opening photos needs the OS file picker, so
 * without this the tile source could not be checked at all — which matters, because the thing worth
 * checking about it is whether the vector style, its fonts and its tiles actually arrive.
 */
export function previewMap(): void {
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;inset:0;z-index:20;display:flex;background:var(--bg)';
  document.body.append(host);

  mapRoot?.unmount();
  mapRoot = createRoot(host);

  /*
   * A spread set *and* a huddle, because that is the case thumbnail markers had to solve.
   *
   * Fifty frames from one walk pile forty-pixel tiles on top of each other, so the crowding rule
   * turns a huddle back into dots while leaving an isolated photograph its picture — and a preview
   * with only well-separated pins would show none of that. `previewMap` used to have two.
   */
  const session = sampleSession(12);
  const thumbnails = sampleThumbnails(session);
  const names = session.photos.map((entry) => entry.ref.name);

  const spread: MapPin[] = [
    { name: names[0]!, coordinates: { latitude: 43.6047, longitude: 1.4442 } },
    { name: names[1]!, coordinates: { latitude: 43.2965, longitude: 5.3698 } },
    { name: names[2]!, coordinates: { latitude: 45.7640, longitude: 4.8357 } },
  ].map((pin) => ({ ...pin, pending: false, selected: false, thumbnail: thumbnails.get(pin.name)! }));

  // Eight frames within a few hundred metres, as an afternoon in one town produces.
  const huddle: MapPin[] = names.slice(3, 11).map((name, index) => ({
    name,
    coordinates: { latitude: 43.6047 + index * 0.0004, longitude: 1.4442 + index * 0.0006 },
    pending: index % 3 === 0,
    selected: false,
    thumbnail: thumbnails.get(name)!,
  }));

  // One with no thumbnail at all, which must stay a dot however much room it has.
  const bare: MapPin = {
    name: 'no-thumbnail.jpg',
    coordinates: { latitude: 47.2184, longitude: -1.5536 },
    pending: false,
    selected: false,
  };

  const pins = [...spread, ...huddle, bare];

  function render(selected: string | null) {
    mapRoot?.render(
      <PhotoMap
        pins={pins.map((pin) => ({ ...pin, selected: pin.name === selected }))}
        track={sampleTrack()}
        onPlace={(c) => console.log('place', c)}
        onSelectPin={render}
        onMovePin={(n, c) => console.log('move', n, c)}
        armed={selected !== null}
        selectedCount={selected ? 1 : 0}
        visible
      />,
    );
  }

  render(null);
}

/**
 * Find elements that are painted on top of one another.
 *
 * Layout bugs in this app have been overlaps three times now — collapsed sections over the photo
 * rows, grid tiles over each other, and the sidebar's own headings over the section beneath. Each
 * time the check was written from scratch and each time it produced **phantoms**, because a
 * `getBoundingClientRect()` is not what you see:
 *
 * - an element scrolled out of a container still reports its real, off-screen rect, so it must be
 *   clipped by *every* scrolling ancestor — not just the outermost one;
 * - an element inside a closed `<details>` reports a rect too, though nothing is painted;
 * - a zero-height or clipped-to-nothing element overlaps everything and means nothing.
 *
 * From the browser console:
 *
 *     (await import('/src/dev-preview.tsx')).findOverlaps('.sidebar')
 */
export function findOverlaps(within = '.sidebar'): string[] {
  const root = document.querySelector(within);
  if (!root) throw new Error(`nothing matches ${within}`);

  const clipped = (el: Element): DOMRect | null => {
    // Not painted at all: `display: none`, `visibility: hidden`, or inside a closed <details>,
    // which Chrome hides with `content-visibility` while still reporting boxes.
    if (!el.checkVisibility({ contentVisibilityAuto: true, opacityProperty: true, visibilityProperty: true })) {
      return null;
    }

    let box = el.getBoundingClientRect();
    for (let parent = el.parentElement; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent);
      if (!/(auto|scroll|hidden)/.test(style.overflowY + style.overflowX)) continue;

      const bounds = parent.getBoundingClientRect();
      const top = Math.max(box.top, bounds.top);
      const bottom = Math.min(box.bottom, bounds.bottom);
      const left = Math.max(box.left, bounds.left);
      const right = Math.min(box.right, bounds.right);
      if (bottom - top <= 0 || right - left <= 0) return null;
      box = new DOMRect(left, top, right - left, bottom - top);
    }
    return box.height > 2 && box.width > 2 ? box : null;
  };

  const named = [...root.querySelectorAll('h2, .row, .note, .photos, .photo-grid, summary, label, .sync')]
    .map((el) => ({ name: (el.className || el.tagName).toString().slice(0, 24), box: clipped(el) }))
    .filter((entry): entry is { name: string; box: DOMRect } => entry.box !== null);

  const overlaps: string[] = [];
  for (let i = 0; i < named.length; i += 1) {
    for (let j = i + 1; j < named.length; j += 1) {
      const a = named[i]!.box;
      const b = named[j]!.box;
      const y = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      const x = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      if (x > 2 && y > 2) {
        overlaps.push(`${named[i]!.name} over ${named[j]!.name} by ${Math.round(y)}px`);
      }
    }
  }
  return overlaps;
}
