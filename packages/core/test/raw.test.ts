/**
 * Raw detection and sidecar naming.
 *
 * Small functions, but the naming one decides whether anybody's software ever sees the data:
 * Lightroom looks for `DSC01234.xmp` beside `DSC01234.ARW` and will not look anywhere else.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  extensionOf,
  isRawFile,
  sidecarCollision,
  sidecarName,
} from '../src/raw.ts';

describe('isRawFile', () => {
  it('recognises ARW whatever the case', () => {
    // A camera writes .ARW; a card copied through some tools arrives .arw.
    assert.equal(isRawFile('DSC01234.ARW'), true);
    assert.equal(isRawFile('DSC01234.arw'), true);
  });

  it('does not claim JPEGs', () => {
    assert.equal(isRawFile('DSC01234.JPG'), false);
    assert.equal(isRawFile('DSC01234.jpeg'), false);
  });

  it('is not fooled by a name merely containing the extension', () => {
    assert.equal(isRawFile('my.arw.backup'), false);
    assert.equal(isRawFile('arw'), false);
  });
});

describe('extensionOf', () => {
  it('treats a leading dot as a hidden file, not an extension', () => {
    // `.gitignore` has no extension; reading one would make its sidecar `.xmp`, a hidden file
    // named for nothing.
    assert.equal(extensionOf('.gitignore'), '');
  });

  it('takes the last extension', () => {
    assert.equal(extensionOf('DSC01234.ARW'), '.arw');
    assert.equal(extensionOf('a.b.c'), '.c');
  });
});

describe('sidecarName', () => {
  it('replaces the extension, which is the Adobe convention', () => {
    // Not `DSC01234.ARW.xmp` — that is what darktable and digiKam use, and Lightroom ignores it.
    assert.equal(sidecarName('DSC01234.ARW'), 'DSC01234.xmp');
  });

  it('keeps the case of the name while lowercasing nothing but the new extension', () => {
    assert.equal(sidecarName('MyPhoto.ARW'), 'MyPhoto.xmp');
  });

  it('gives an extensionless name one', () => {
    assert.equal(sidecarName('photo'), 'photo.xmp');
  });
});

describe('sidecarCollision', () => {
  it('finds the JPEG that would share a raw file’s sidecar', () => {
    /*
     * The price of the Adobe convention, and an A6400 shooting RAW+JPEG produces it on every
     * frame: one basename, two files, one sidecar. Harmless when both want the same coordinates
     * and exactly what Lightroom expects — but the caller has to be able to notice.
     */
    const names = ['DSC01234.ARW', 'DSC01234.JPG', 'DSC01235.ARW'];
    assert.deepEqual(sidecarCollision('DSC01234.ARW', names), ['DSC01234.JPG']);
  });

  it('never reports the photograph itself', () => {
    assert.deepEqual(sidecarCollision('DSC01234.ARW', ['DSC01234.ARW']), []);
  });

  it('reports a sidecar already sitting in the folder', () => {
    // Written by something else, and about to be overwritten.
    assert.deepEqual(
      sidecarCollision('DSC01234.ARW', ['DSC01234.ARW', 'DSC01234.xmp']),
      ['DSC01234.xmp'],
    );
  });

  it('says nothing when the basename is unique', () => {
    assert.deepEqual(sidecarCollision('DSC01234.ARW', ['DSC01234.ARW', 'DSC09999.JPG']), []);
  });
});
