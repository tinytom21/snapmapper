/**
 * Naming what Undo and Redo would do.
 *
 * Worth testing because the words appear on a button that must stay narrow enough to sit beside
 * another one on a phone, and because "Undo" with nothing after it is the state these labels exist
 * to eliminate.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { SessionAction } from '@snapmapper/core';

import { describeAction, explainAction } from '../src/describe-action.ts';

const ACTIONS: readonly SessionAction[] = [
  { kind: 'place', count: 5 },
  { kind: 'track', count: 12 },
  { kind: 'clear', count: 2 },
  { kind: 'revert', count: 1 },
  { kind: 'time-zone', timeZone: 'Europe/London' },
  { kind: 'offset', offsetSeconds: -42 },
  { kind: 'sync' },
  { kind: 'clear-sync' },
];

describe('describeAction', () => {
  it('says what happened, with the count where there is one', () => {
    assert.equal(describeAction({ kind: 'place', count: 5 }), 'place 5');
    assert.equal(describeAction({ kind: 'clear', count: 2 }), 'clear 2');
    assert.equal(describeAction({ kind: 'revert', count: 1 }), 'revert 1');
  });

  it('names every action, so no button can read "Undo" with a blank after it', () => {
    for (const action of ACTIONS) {
      const label = describeAction(action);
      assert.ok(label.length > 0, `${action.kind} has no label`);
      // Beside another button and the More menu on a 375px screen. Measured: "clock offset" left
      // 15px of slack there and did not fit a 320px screen at all.
      assert.ok(label.length <= 9, `${action.kind} label too long: ${label}`);
    }
  });

  it('is empty only when there is nothing to undo', () => {
    assert.equal(describeAction(undefined), '');
  });
});

describe('explainAction', () => {
  it('gives the long form and the keyboard shortcut', () => {
    assert.equal(
      explainAction('Undo', { kind: 'place', count: 5 }),
      'Undo placing 5 photos on the map (Ctrl+Z)',
    );
    assert.equal(
      explainAction('Redo', { kind: 'clear', count: 1 }),
      'Redo clearing the location of 1 photo (Ctrl+Shift+Z)',
    );
  });

  it('gets singular and plural right', () => {
    assert.match(explainAction('Undo', { kind: 'revert', count: 1 }), /1 photo /);
    assert.match(explainAction('Undo', { kind: 'revert', count: 3 }), /3 photos /);
  });

  it('signs the offset, because zero and negative both need to read clearly', () => {
    assert.match(explainAction('Undo', { kind: 'offset', offsetSeconds: 0 }), /\+0s/);
    assert.match(explainAction('Undo', { kind: 'offset', offsetSeconds: -42 }), /-42s/);
    assert.match(explainAction('Undo', { kind: 'offset', offsetSeconds: 42 }), /\+42s/);
  });

  it('still says something useful with nothing to undo', () => {
    assert.equal(explainAction('Undo', undefined), 'Undo (Ctrl+Z) — nothing to undo');
    assert.equal(explainAction('Redo', undefined), 'Redo (Ctrl+Shift+Z) — nothing to redo');
  });
});
