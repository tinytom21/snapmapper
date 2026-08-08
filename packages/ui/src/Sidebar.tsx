/**
 * Everything beside (or below) the map: the photo list, the camera clock, the device report.
 *
 * One component rather than a stretch of JSX inside `App`, so that `dev-preview.tsx` can mount
 * **exactly what ships**. An early version of that harness rendered only the photo list, which is
 * why a layout bug where the sections drew on top of the list's buttons survived a round of
 * measurement — the composition was never the thing being measured.
 *
 * The three sections are an accordion with exactly one open. See `Accordion.tsx` for why: two
 * open sections compete for a height neither can have, and every way of dividing it failed.
 */

import { useState } from 'react';

import { Accordion, type AccordionSection } from './Accordion.tsx';
import { ClockPanel, describeClock } from './ClockPanel.tsx';
import { PhotoList } from './PhotoList.tsx';
import { OfflineMap } from './OfflineMap.tsx';
import { PlatformReport, describePlatformBriefly } from './PlatformReport.tsx';
import { PlacePanel, describePlaces, type PlacePanelProps } from './PlacePanel.tsx';
import { TrackPanel, describeTrack, type TrackPanelProps } from './TrackPanel.tsx';
import { pendingPhotos, type ClockSync, type Session } from '@snapmapper/core';
import type { ViewMode } from './view-mode.ts';

export interface SidebarProps {
  readonly session: Session;
  readonly thumbnails: Map<string, string>;
  readonly addPhotosLabel: string;
  readonly busy: boolean;

  readonly onToggle: (name: string) => void;
  readonly onSelectOnly: (name: string) => void;
  readonly onSelectRange: (from: string, to: string, add: boolean) => void;
  readonly onSelectAll: () => void;
  readonly onSelectNone: () => void;
  readonly onSelectUnplaced: () => void;
  readonly onClear: () => void;
  readonly onRevert: () => void;
  readonly onPreview: (name: string) => void;
  readonly view: ViewMode;
  readonly onView: (view: ViewMode) => void;

  readonly onTimeZone: (timeZone: string) => void;
  readonly onOffsetSeconds: (offsetSeconds: number) => void;
  readonly onSync: (sync: ClockSync) => void;
  readonly onClearSync: () => void;
  readonly onScanReference: (name: string) => Promise<string | null>;

  /** The GPS track section, passed through whole — this component only decides where it sits. */
  readonly track: Omit<TrackPanelProps, 'session' | 'busy'>;
  /** Place names, likewise. */
  readonly places: Omit<PlacePanelProps, 'session' | 'busy'>;
}

export function Sidebar(props: SidebarProps) {
  const { session } = props;
  // Photos, because that is what you came to do.
  const [open, setOpen] = useState('photos');

  const pending = pendingPhotos(session).length;
  const selected = session.selected.size;

  const sections: AccordionSection[] = [
    {
      id: 'photos',
      title: 'Photos',
      state: describePhotos(session.photos.length, selected, pending),
      content: (
        <PhotoList
          session={session}
          thumbnails={props.thumbnails}
          onToggle={props.onToggle}
          onSelectOnly={props.onSelectOnly}
          onSelectRange={props.onSelectRange}
          onSelectAll={props.onSelectAll}
          onSelectNone={props.onSelectNone}
          onSelectUnplaced={props.onSelectUnplaced}
          onClear={props.onClear}
          onRevert={props.onRevert}
          onPreview={props.onPreview}
          view={props.view}
          onView={props.onView}
        />
      ),
    },
    {
      id: 'clock',
      title: 'Camera clock',
      state: describeClock(session),
      content: (
        <ClockPanel
          session={session}
          addPhotosLabel={props.addPhotosLabel}
          busy={props.busy}
          onTimeZone={props.onTimeZone}
          onOffsetSeconds={props.onOffsetSeconds}
          onSync={props.onSync}
          onClearSync={props.onClearSync}
          onScanReference={props.onScanReference}
        />
      ),
    },
    /*
     * Directly after the clock, and that ordering is the argument for it: a track match is only as
     * good as the clock it is matched against, so the section that sets the clock comes first.
     */
    {
      id: 'track',
      title: 'GPS track',
      state: describeTrack(props.track.track, props.track.trackFile),
      content: <TrackPanel session={session} busy={props.busy} {...props.track} />,
    },
    /*
     * After the track, because a place name is derived from a location and there is no point
     * looking one up before anything has been placed. The panel says so when nothing has.
     */
    {
      id: 'places',
      title: 'Place names',
      state: describePlaces(session),
      content: <PlacePanel session={session} busy={props.busy} {...props.places} />,
    },
    {
      id: 'device',
      title: 'This device',
      state: describePlatformBriefly(),
      // The offline map cache lives here rather than in its own section: it is a fact about
      // storage on this device, which is exactly what this section is for.
      content: <><OfflineMap /><PlatformReport /></>,
    },
  ];

  return (
    <div className="sidebar">
      <Accordion sections={sections} open={open} onOpen={setOpen} />
    </div>
  );
}

/**
 * What the Photos header says while it is shut.
 *
 * Selection and staged edits both belong here: with the section closed they are the two things you
 * would otherwise have to open it to find out, and staged edits are the ones that have not reached
 * disk yet.
 */
function describePhotos(total: number, selected: number, pending: number): string {
  const parts = [`${total}`];
  if (selected > 0) parts.push(`${selected} selected`);
  if (pending > 0) parts.push(`${pending} unsaved`);
  return parts.join(' · ');
}
