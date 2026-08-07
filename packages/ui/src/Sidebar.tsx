/**
 * Everything beside (or below) the map: the photo list, the camera clock, the device report.
 *
 * One component rather than a stretch of JSX inside `App`, so that `dev-preview.tsx` can mount
 * **exactly what ships**. The previous version of that harness rendered only the photo list, which
 * is why a layout bug where the collapsed sections drew on top of the list's buttons survived a
 * round of measurement — the composition was never the thing being measured.
 */

import { ClockPanel, describeClock } from './ClockPanel.tsx';
import { Collapsible } from './Collapsible.tsx';
import { PhotoList } from './PhotoList.tsx';
import { PlatformReport, describePlatformBriefly } from './PlatformReport.tsx';
import type { ThumbSize } from './thumb-size.ts';
import type { ClockSync, Session } from '@snapmapper/core';

export interface SidebarProps {
  readonly session: Session;
  readonly thumbnails: Map<string, string>;
  readonly addPhotosLabel: string;
  readonly busy: boolean;
  /** Collapsed by default where vertical space is scarce. */
  readonly narrow: boolean;

  readonly onToggle: (name: string) => void;
  readonly onSelectOnly: (name: string) => void;
  readonly onSelectRange: (from: string, to: string, add: boolean) => void;
  readonly onSelectAll: () => void;
  readonly onSelectNone: () => void;
  readonly onClear: () => void;
  readonly onRevert: () => void;
  readonly onPreview: (name: string) => void;
  readonly thumbSize: ThumbSize['key'];
  readonly onThumbSize: (key: ThumbSize['key']) => void;

  readonly onTimeZone: (timeZone: string) => void;
  readonly onOffsetSeconds: (offsetSeconds: number) => void;
  readonly onSync: (sync: ClockSync) => void;
  readonly onClearSync: () => void;
  readonly onScanReference: (name: string) => Promise<string | null>;
}

export function Sidebar(props: SidebarProps) {
  const { session, narrow } = props;

  return (
    <div className="sidebar">
      <PhotoList
        session={session}
        thumbnails={props.thumbnails}
        onToggle={props.onToggle}
        onSelectOnly={props.onSelectOnly}
        onSelectRange={props.onSelectRange}
        onSelectAll={props.onSelectAll}
        onSelectNone={props.onSelectNone}
        onClear={props.onClear}
        onRevert={props.onRevert}
        onPreview={props.onPreview}
        thumbSize={props.thumbSize}
        onThumbSize={props.onThumbSize}
      />

      <Collapsible title="Camera clock" state={describeClock(session)} defaultOpen={!narrow}>
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
      </Collapsible>

      <Collapsible title="This device" state={describePlatformBriefly()} defaultOpen={false}>
        <PlatformReport />
      </Collapsible>
    </div>
  );
}
