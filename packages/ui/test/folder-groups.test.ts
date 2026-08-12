import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  COMFORTABLE_COUNT,
  defaultChoice,
  describeReadCost,
  displayOrder,
  groupByDay,
} from '../src/folder-groups.ts';
import type { FolderHandle, PhotoRef } from '@snapmapper/core';

/**
 * The arrangement of a folder listing, which is what replaced the operating system's file picker.
 *
 * Worth testing here rather than by clicking because the interesting cases are a card with several
 * days on it and a folder too big to open whole — neither of which is convenient to stage by hand,
 * and both of which decide what somebody sees the moment they open a folder.
 */

const folder: FolderHandle = { id: 'f1', displayName: '100MSDCF' };

/** A file whose *filesystem* date is the given local time. No EXIF is involved at this stage. */
function ref(name: string, iso: string): PhotoRef {
  return {
    folder,
    name,
    sizeBytes: 6_000_000,
    modifiedAtMs: new Date(iso).getTime(),
    locator: name,
  };
}

describe('arranging a folder into days', () => {
  it('puts the newest day first, since that is the shoot you just came back from', () => {
    const groups = groupByDay([
      ref('DSC00001.JPG', '2024-07-10T09:00:00'),
      ref('DSC00002.JPG', '2024-07-12T09:00:00'),
      ref('DSC00003.JPG', '2024-07-11T09:00:00'),
    ]);

    assert.deepEqual(groups.map((g) => g.key), ['2024-07-12', '2024-07-11', '2024-07-10']);
  });

  it('orders a day by name, which on any camera is chronological', () => {
    // `numeric`, so DSC00099 comes before DSC00100 rather than after it.
    const groups = groupByDay([
      ref('DSC00100.JPG', '2024-07-12T10:00:00'),
      ref('DSC00099.JPG', '2024-07-12T09:00:00'),
    ]);

    assert.deepEqual(groups[0]!.refs.map((r) => r.name), ['DSC00099.JPG', 'DSC00100.JPG']);
  });

  it('uses the local day, not the UTC one', () => {
    /*
     * `toISOString` would be UTC, which puts an evening's photographs on tomorrow for anyone east
     * of Greenwich and yesterday's on today for anyone west — so a shoot would be split across two
     * headings for no reason the user could see. Built from the local parts instead.
     */
    const late = ref('DSC00001.JPG', '2024-07-12T23:30:00');
    const groups = groupByDay([late]);

    const localDay = new Date(late.modifiedAtMs);
    const expected = [
      localDay.getFullYear(),
      String(localDay.getMonth() + 1).padStart(2, '0'),
      String(localDay.getDate()).padStart(2, '0'),
    ].join('-');

    assert.equal(groups[0]!.key, expected);
  });

  it('counts the raw files in each day', () => {
    // A RAW+JPEG card shoots pairs, and knowing which days hold raw is most of choosing.
    const groups = groupByDay([
      ref('DSC00001.ARW', '2024-07-12T09:00:00'),
      ref('DSC00001.JPG', '2024-07-12T09:00:00'),
      ref('DSC00002.JPG', '2024-07-12T09:01:00'),
    ]);

    assert.equal(groups[0]!.refs.length, 3);
    assert.equal(groups[0]!.rawCount, 1);
  });

  it('says nothing about an empty folder', () => {
    assert.deepEqual(groupByDay([]), []);
  });

  it('puts a folder of same-dated copies in one group rather than failing', () => {
    // A card copied or synced carries the copy date on every file. A single group is a degraded
    // arrangement, not a wrong one, and the list still works.
    const same = Array.from({ length: 5 }, (_, i) => ref(`a${i}.JPG`, '2024-07-12T09:00:00'));
    assert.equal(groupByDay(same).length, 1);
  });
});

describe('what is selected when the chooser opens', () => {
  const day = (date: string, count: number) =>
    Array.from({ length: count }, (_, i) => ref(`${date}-${i}.JPG`, `${date}T09:0${i % 10}:00`));

  it('selects everything in a folder small enough to read', () => {
    const groups = groupByDay(day('2024-07-12', 10));
    assert.equal(defaultChoice(groups).size, 10);
  });

  it('selects only the newest day on a card too big to open whole', () => {
    // The answer somebody who has just been out taking photographs almost always wants.
    const groups = groupByDay([...day('2024-07-12', 40), ...day('2024-07-01', 400)]);

    const chosen = defaultChoice(groups);
    assert.equal(chosen.size, 40);
    assert.ok([...chosen].every((name) => name.startsWith('2024-07-12')));
  });

  it('never opens with nothing selected', () => {
    // A chooser whose button is disabled on arrival makes the user work before the interface does.
    const huge = groupByDay(day('2024-07-12', COMFORTABLE_COUNT * 10));
    assert.ok(defaultChoice(huge).size > 0);
  });

  it('has nothing to select in an empty folder', () => {
    assert.equal(defaultChoice([]).size, 0);
  });
});

describe('warning what a selection will cost', () => {
  it('says nothing for a handful, where the wait is not worth mentioning', () => {
    assert.equal(describeReadCost(0, 500), undefined);
    assert.equal(describeReadCost(5, 500), undefined);
  });

  it('rounds seconds, because the true figure spans six times between a desktop and a phone', () => {
    assert.equal(describeReadCost(40, 500), 'about 20 seconds to read');
  });

  it('switches to minutes, and gets the plural right', () => {
    assert.equal(describeReadCost(120, 500), 'about 1 minute to read');
    assert.equal(describeReadCost(600, 500), 'about 5 minutes to read');
  });
});

describe('the order the thumbnail feed walks', () => {
  /*
   * Reported: the parsing ran oldest to newest while the days were drawn newest first, so the
   * loading "seems artificially slow". The listing is alphabetical, which for camera filenames is
   * chronological, and the chooser reverses that by day — so a feed following the listing reaches
   * away from the screen and covers the oldest day on the card before the second-newest one.
   */
  const listing = [
    ref('DSC00001.JPG', '2024-06-01T09:00:00Z'),
    ref('DSC00002.JPG', '2024-06-01T10:00:00Z'),
    ref('DSC00010.JPG', '2024-07-02T09:00:00Z'),
    ref('DSC00011.JPG', '2024-07-02T10:00:00Z'),
    ref('DSC00020.JPG', '2024-08-03T09:00:00Z'),
  ];

  it('starts with the newest day, which is the one the chooser opens', () => {
    const order = displayOrder(groupByDay(listing)).map((entry) => entry.name);
    assert.equal(order[0], 'DSC00020.JPG');
  });

  it('is the drawn order exactly: days newest first, chronological within a day', () => {
    const order = displayOrder(groupByDay(listing)).map((entry) => entry.name);
    assert.deepEqual(order, [
      'DSC00020.JPG',
      'DSC00010.JPG', 'DSC00011.JPG',
      'DSC00001.JPG', 'DSC00002.JPG',
    ]);
  });

  it('reverses the listing by day rather than following it', () => {
    // The bug in one assertion: if these ever agree again, the feed is walking the folder.
    const order = displayOrder(groupByDay(listing)).map((entry) => entry.name);
    assert.notDeepEqual(order, listing.map((entry) => entry.name));
  });

  it('loses nothing and invents nothing', () => {
    const order = displayOrder(groupByDay(listing)).map((entry) => entry.name);
    assert.deepEqual([...order].sort(), listing.map((entry) => entry.name).sort());
  });
});
