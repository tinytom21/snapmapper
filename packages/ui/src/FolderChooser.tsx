/**
 * Choosing which photographs to open, from a folder that is already granted.
 *
 * This is the operating system's file picker, moved inside the application, and it exists because
 * the real one cannot say where a file lives. `showOpenFilePicker` returns handles with no route
 * to their parent, so "copies beside the originals" and "a sidecar next to the raw file" were both
 * unanswerable and the interface had to ask for a folder *after* the photographs were chosen. One
 * folder grant answers everything: where to read, where to put `geotagged/`, and where a sidecar
 * belongs.
 *
 * It costs nothing to show. Listing 1000 entries is 20 ms of enumeration and 235 ms of dates and
 * sizes; the eight minutes is ExifTool, and ExifTool now only runs on what was chosen. That is the
 * whole trade, and it is why opening a folder no longer needs a warning.
 *
 * ## Days, collapsed
 *
 * Grouped by the file's own date — see `folder-groups.ts` for why that is safe to use here and
 * nowhere else — newest first, and every group but the first starts closed. A thousand rows is a
 * thousand rows whether or not anybody reads them, and the question being asked is almost always
 * "which shoot", not "which frame". Opening a day answers the second question when it is really
 * being asked.
 */

import { useMemo, useState } from 'react';

import { isRawFile, type PhotoRef } from '@snapmapper/core';

import {
  READ_MS_PER_PHOTO,
  defaultChoice,
  describeReadCost,
  groupByDay,
} from './folder-groups.ts';

export interface FolderChooserProps {
  readonly folderName: string;
  /** Everything the folder holds. No metadata has been read. */
  readonly refs: readonly PhotoRef[];
  readonly busy: boolean;
  readonly onOpen: (chosen: readonly PhotoRef[]) => void;
  readonly onCancel: () => void;
  /** Names already open, when adding to a session. Shown as such and not offered again. */
  readonly alreadyOpen?: ReadonlySet<string>;
}

export function FolderChooser({
  folderName, refs, busy, onOpen, onCancel, alreadyOpen,
}: FolderChooserProps) {
  const groups = useMemo(() => groupByDay(refs), [refs]);

  /*
   * Seeded once, from the folder's own shape: everything if it is small, the newest day if it is a
   * card. Keyed on the groups so re-scanning a folder re-seeds, and so this does not fight the
   * user's own clicks in between.
   */
  const [chosen, setChosen] = useState<ReadonlySet<string>>(() => defaultChoice(groups));
  const [openDays, setOpenDays] = useState<ReadonlySet<string>>(
    () => new Set(groups[0] ? [groups[0].key] : []),
  );

  const selectable = useMemo(
    () => refs.filter((ref) => !alreadyOpen?.has(ref.name)),
    [refs, alreadyOpen],
  );

  const count = [...chosen].filter((name) => !alreadyOpen?.has(name)).length;
  const cost = describeReadCost(count, READ_MS_PER_PHOTO);

  function toggle(name: string) {
    setChosen((was) => {
      const next = new Set(was);
      if (!next.delete(name)) next.add(name);
      return next;
    });
  }

  function setDay(key: string, on: boolean) {
    const group = groups.find((candidate) => candidate.key === key);
    if (!group) return;

    setChosen((was) => {
      const next = new Set(was);
      for (const ref of group.refs) {
        if (alreadyOpen?.has(ref.name)) continue;
        if (on) next.add(ref.name);
        else next.delete(ref.name);
      }
      return next;
    });
  }

  function setAll(on: boolean) {
    setChosen(on ? new Set(selectable.map((ref) => ref.name)) : new Set());
  }

  return (
    <div className="chooser">
      <div className="chooser-head">
        <h2>
          {alreadyOpen ? 'Add photos from' : 'Choose photos from'}{' '}
          <code>{folderName}</code>
        </h2>
        <p className="note">
          {refs.length} file{refs.length === 1 ? '' : 's'} here. Nothing is read until you open
          them, and nothing is written until you save.
        </p>
        <div className="row">
          <button type="button" onClick={() => setAll(true)} disabled={busy}>Select all</button>
          <button type="button" onClick={() => setAll(false)} disabled={busy}>Select none</button>
        </div>
      </div>

      <div className="chooser-days">
        {groups.map((group) => {
          const mine = group.refs.filter((ref) => !alreadyOpen?.has(ref.name));
          const picked = mine.filter((ref) => chosen.has(ref.name)).length;
          const expanded = openDays.has(group.key);

          return (
            <section key={group.key} className="chooser-day">
              <div className="chooser-day-head">
                <label>
                  <input
                    type="checkbox"
                    checked={picked > 0 && picked === mine.length}
                    /* Some but not all: the box says "partly", which a tick alone cannot. */
                    ref={(box) => { if (box) box.indeterminate = picked > 0 && picked < mine.length; }}
                    onChange={(event) => setDay(group.key, event.currentTarget.checked)}
                    disabled={busy || mine.length === 0}
                  />
                  <span className="chooser-day-label">{group.label}</span>
                </label>
                <span className="meta">
                  {group.refs.length} photo{group.refs.length === 1 ? '' : 's'}
                  {group.rawCount > 0 && ` · ${group.rawCount} raw`}
                  {picked > 0 && ` · ${picked} selected`}
                </span>
                <button
                  type="button"
                  className="link"
                  aria-expanded={expanded}
                  onClick={() => setOpenDays((was) => {
                    const next = new Set(was);
                    if (!next.delete(group.key)) next.add(group.key);
                    return next;
                  })}
                >
                  {expanded ? 'Hide files' : 'Show files'}
                </button>
              </div>

              {/*
                Unmounted when closed, not hidden. A thousand rows nobody has asked for is a
                thousand rows the browser lays out, and the whole point of this screen is that
                opening a folder costs nothing.
              */}
              {expanded && (
                <ul className="chooser-files">
                  {group.refs.map((ref) => {
                    const open = alreadyOpen?.has(ref.name) ?? false;
                    return (
                      <li key={ref.name}>
                        <label className={open ? 'is-open' : ''}>
                          <input
                            type="checkbox"
                            checked={open || chosen.has(ref.name)}
                            disabled={busy || open}
                            onChange={() => toggle(ref.name)}
                          />
                          <span className="name">{ref.name}</span>
                          {isRawFile(ref.name) && <span className="tag">raw</span>}
                          <span className="meta">{formatSize(ref.sizeBytes)}</span>
                          {open && <span className="meta">already open</span>}
                        </label>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          );
        })}
      </div>

      <div className="chooser-foot">
        <button type="button" className="link" onClick={onCancel} disabled={busy}>
          Choose a different folder
        </button>
        <span className="note">{cost}</span>
        <button
          type="button"
          className="primary big"
          disabled={busy || count === 0}
          onClick={() => onOpen(selectable.filter((ref) => chosen.has(ref.name)))}
        >
          {count === 0 ? 'Nothing selected' : `Open ${count} photo${count === 1 ? '' : 's'}`}
        </button>
      </div>
    </div>
  );
}

/** Whole megabytes. A camera file is megabytes and the decimal is noise at this size. */
function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}
