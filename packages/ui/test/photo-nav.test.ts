/**
 * Stepping through photos in the full-size preview.
 *
 * Small, but every case here is a way the preview could show you a different photograph than the
 * one you asked for — which matters in a tool whose next action writes to a file.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { neighbourName } from '../src/photo-nav.ts';

const NAMES = ['a.jpg', 'b.jpg', 'c.jpg'];

describe('neighbourName', () => {
  it('steps forwards and backwards', () => {
    assert.equal(neighbourName(NAMES, 'b.jpg', 1), 'c.jpg');
    assert.equal(neighbourName(NAMES, 'b.jpg', -1), 'a.jpg');
  });

  it('stops at both ends rather than wrapping', () => {
    // Wrapping would make Right at the last photo look like the list had jumped, rather than
    // like you had reached the end.
    assert.equal(neighbourName(NAMES, 'c.jpg', 1), null);
    assert.equal(neighbourName(NAMES, 'a.jpg', -1), null);
  });

  it('returns null for a name that is no longer in the list', () => {
    // Re-scanning a folder replaces the photo list. Resolving a stale name by index would show
    // whatever photo now happens to sit there.
    assert.equal(neighbourName(NAMES, 'gone.jpg', 1), null);
    assert.equal(neighbourName([], 'a.jpg', 1), null);
  });

  it('handles a single photo, where there is nowhere to go', () => {
    assert.equal(neighbourName(['only.jpg'], 'only.jpg', 1), null);
    assert.equal(neighbourName(['only.jpg'], 'only.jpg', -1), null);
  });
});
