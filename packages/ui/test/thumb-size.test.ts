/**
 * The thumbnail size preference.
 *
 * The storage path is the part worth testing: the value goes straight into a CSS length, and
 * localStorage is shared with every version of the app this origin has ever served — including
 * ones that wrote something else under this key.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DEFAULT_THUMB_SIZE,
  THUMB_SIZES,
  loadThumbSize,
  saveThumbSize,
  thumbWidth,
} from '../src/thumb-size.ts';

const store = (value: string | null) => ({ getItem: () => value });

describe('thumb sizes', () => {
  it('tops out at the resolution the camera actually embedded', () => {
    // The embedded thumbnail is 160x120 on an ILCE-6400. A larger option would offer no more
    // detail, only upscaling — that is what the full-size preview is for.
    const widest = Math.max(...THUMB_SIZES.map((size) => size.width));
    assert.equal(widest, 160);
  });

  it('has distinct keys and increasing widths', () => {
    const keys = THUMB_SIZES.map((size) => size.key);
    assert.equal(new Set(keys).size, keys.length);

    const widths = THUMB_SIZES.map((size) => size.width);
    assert.deepEqual(widths, [...widths].sort((a, b) => a - b));
  });

  it('resolves a width for every offered size', () => {
    for (const size of THUMB_SIZES) assert.equal(thumbWidth(size.key), size.width);
  });

  it('falls back rather than trusting an unknown stored value', () => {
    // Straight into a CSS length, so `300px; background: url(...)` must never reach it.
    assert.equal(loadThumbSize(store('enormous')), DEFAULT_THUMB_SIZE);
    assert.equal(loadThumbSize(store('')), DEFAULT_THUMB_SIZE);
    assert.equal(loadThumbSize(store(null)), DEFAULT_THUMB_SIZE);
    assert.equal(thumbWidth('nonsense'), thumbWidth(DEFAULT_THUMB_SIZE));
  });

  it('returns a stored value that is one of the offered sizes', () => {
    assert.equal(loadThumbSize(store('largest')), 'largest');
    assert.equal(loadThumbSize(store('small')), 'small');
  });

  it('survives storage that throws, as private browsing does', () => {
    const hostile = {
      getItem: () => { throw new Error('denied'); },
      setItem: () => { throw new Error('denied'); },
    };
    // Not being able to remember the choice is not a reason to refuse to make it.
    assert.equal(loadThumbSize(hostile), DEFAULT_THUMB_SIZE);
    assert.doesNotThrow(() => saveThumbSize('large', hostile));
  });
});
