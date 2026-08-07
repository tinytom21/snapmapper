/**
 * Which view is shown, and remembering it.
 *
 * The storage path is what is worth testing: the value reaches a CSS length, and localStorage is
 * shared with every version of this app the origin has ever served — including the one that stored
 * four thumbnail sizes before the views replaced them.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DEFAULT_VIEW_MODE,
  GRID_MIN_WIDTH,
  LIST_THUMB_WIDTH,
  VIEW_MODES,
  gridMinWidth,
  isGrid,
  loadViewMode,
  saveViewMode,
} from '../src/view-mode.ts';

const store = (value: string | null) => ({ getItem: () => value });

describe('view modes', () => {
  it('offers a list and exactly two grid sizes', () => {
    assert.deepEqual([...VIEW_MODES], ['list', 'grid-small', 'grid-large']);
  });

  it('shows list thumbnails at the resolution the camera embedded', () => {
    // An ILCE-6400 writes a 160x120 thumbnail. Smaller wastes it; larger only upscales, which is
    // what the full-size preview exists for. There is no size choice in this view for that reason.
    assert.equal(LIST_THUMB_WIDTH, 160);
  });

  it('knows a grid from a list', () => {
    assert.equal(isGrid('list'), false);
    assert.equal(isGrid('grid-small'), true);
    assert.equal(isGrid('grid-large'), true);
  });

  it('gives the list no tile width, because it is not a grid', () => {
    // Zero rather than a fallback: a nonzero value here would lay out a grid nobody asked for if
    // the class and the property ever disagreed.
    assert.equal(gridMinWidth('list'), 0);
  });

  it('makes small tiles smaller than large ones', () => {
    assert.ok(GRID_MIN_WIDTH['grid-small'] < GRID_MIN_WIDTH['grid-large']);
    assert.equal(gridMinWidth('grid-small'), GRID_MIN_WIDTH['grid-small']);
    assert.equal(gridMinWidth('grid-large'), GRID_MIN_WIDTH['grid-large']);
  });

  it('falls back rather than trusting an unknown stored value', () => {
    // Includes what the previous version of this preference stored, which is a real value that a
    // real browser is holding right now.
    assert.equal(loadViewMode(store('largest')), DEFAULT_VIEW_MODE);
    assert.equal(loadViewMode(store('grid')), DEFAULT_VIEW_MODE);
    assert.equal(loadViewMode(store('')), DEFAULT_VIEW_MODE);
    assert.equal(loadViewMode(store(null)), DEFAULT_VIEW_MODE);
  });

  it('returns a stored value that is one of the offered views', () => {
    assert.equal(loadViewMode(store('grid-small')), 'grid-small');
    assert.equal(loadViewMode(store('list')), 'list');
  });

  it('survives storage that throws, as private browsing does', () => {
    const hostile = {
      getItem: () => { throw new Error('denied'); },
      setItem: () => { throw new Error('denied'); },
    };
    assert.equal(loadViewMode(hostile), DEFAULT_VIEW_MODE);
    assert.doesNotThrow(() => saveViewMode('grid-large', hostile));
  });
});
