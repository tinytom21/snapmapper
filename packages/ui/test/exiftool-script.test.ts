/**
 * Extracting the ExifTool script out of `@uswriting/exiftool`'s bundle.
 *
 * Two halves, and they fail differently.
 *
 * The **unescaping** is pure string handling with a silent failure mode: a mangled backslash in
 * 100KB of Perl changes what a regular expression matches, and the script still runs. So it is
 * tested against constructed cases, including the one a chain of `replaceAll` calls gets right
 * only by luck.
 *
 * The **finding** is a dependence on somebody else's bundler output, and its failure must be loud.
 * Every assertion is checked against the really-installed package too, because a synthetic bundle
 * only ever tests the extractor against itself.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { extractExifToolScript, readExifToolScript, unescapeTemplate } from '../exiftool-script.ts';

const TICK = String.fromCharCode(96);

/** A bundle-shaped string with `perl` as the script body, escaped as a bundler would escape it. */
function bundle(perl: string): string {
  const escaped = perl
    .replaceAll('\\', '\\\\')
    .replaceAll(TICK, `\\${TICK}`)
    .replaceAll('${', '\\${');
  return `import{x}from"y";var q=${TICK}${escaped}${TICK};class p{}`;
}

/** Long enough and Perl enough to pass the sanity checks, so cases can be about the escaping. */
function padded(body: string): string {
  return `use strict;use warnings;${body}\n`
    + `# Image::ExifTool @ARGV\n${'#'.repeat(60_000)}\n`;
}

describe('unescapeTemplate', () => {
  it('undoes the escapes a bundler adds', () => {
    assert.equal(unescapeTemplate(`\\${TICK}`), TICK);
    assert.equal(unescapeTemplate('\\${'), '${');
    assert.equal(unescapeTemplate('\\\\'), '\\');
  });

  it('handles a backslash immediately before a backtick', () => {
    /*
     * The case that a chained implementation gets right only by accident. Source `\\` + `` \` ``
     * means a literal backslash followed by a literal backtick; replacing `` \` `` first leaves a
     * `\\` for the later pass to eat, which happens to work — and stops working the moment
     * somebody reorders the chain. A single left-to-right pass is right by construction.
     */
    assert.equal(unescapeTemplate(`\\\\\\${TICK}`), `\\${TICK}`);
  });

  it('leaves a Perl escape alone', () => {
    // `\d` and `\s` are not JavaScript escapes, so they stand for themselves — and they are what
    // most of ExifTool's regular expressions are made of.
    assert.equal(unescapeTemplate('\\\\d+\\\\s*'), '\\d+\\s*');
  });

  it('decodes the named escapes rather than dropping the backslash', () => {
    // 1.0.9 emits real newlines, but turning a `\n` it *did* emit into the letter `n` would break
    // the Perl in a way no assertion in this file would catch.
    assert.equal(unescapeTemplate('a\\nb\\tc'), 'a\nb\tc');
    assert.equal(unescapeTemplate('\\x41\\u0042'), 'AB');
  });
});

describe('extractExifToolScript', () => {
  it('round-trips a script through a bundle', () => {
    const perl = padded(`my $re = qr/\\d+${TICK}/; my $s = "\${x}";`);
    assert.equal(extractExifToolScript(bundle(perl)), perl);
  });

  it('stops at the closing backtick, not at an escaped one', () => {
    const perl = padded(`print ${TICK}hostname${TICK};`);
    const extracted = extractExifToolScript(bundle(perl));
    assert.ok(extracted.endsWith('\n'), 'the tail after the escaped backtick was lost');
    assert.equal(extracted, perl);
  });

  it('throws when the marker is gone', () => {
    // The dependency changed shape. This must stop a build, not produce an empty string.
    assert.throws(
      () => extractExifToolScript('var q="not a template literal";'),
      /has changed shape/,
    );
  });

  it('throws when what it found is too short to be the whole script', () => {
    assert.throws(
      () => extractExifToolScript(bundle('use strict;use warnings;print 1;')),
      /cannot be the whole of it/,
    );
  });

  it('throws when what it found is not ExifTool', () => {
    const impostor = `use strict;use warnings;@ARGV;\n${'#'.repeat(70_000)}`;
    assert.throws(() => extractExifToolScript(bundle(impostor)), /does not contain Image::ExifTool/);
  });
});

describe('the installed @uswriting/exiftool', () => {
  /*
   * Against the real package, because a synthetic bundle tests the extractor against itself. This
   * is the test that fails when the dependency is upgraded to something that no longer embeds the
   * script the same way — which is the whole risk of deriving it rather than vendoring it.
   */
  it('yields a plausible ExifTool script', async () => {
    const script = await readExifToolScript();

    assert.ok(script.startsWith('use strict;use warnings;'), 'not the start of the script');
    assert.ok(script.length > 90_000, `only ${script.length} bytes`);
    assert.match(script, /Image::ExifTool/);
    // Its own version, which is also the one the write path uses.
    assert.match(script, /\$version\s*=\s*'13\./);
  });

  it('leaves no unescaped template syntax in the result', async () => {
    const script = await readExifToolScript();

    // A backtick surviving into the output would mean the extractor stopped in the wrong place;
    // the real script contains none, verified against 1.0.9.
    assert.equal(script.includes(TICK), false, 'a backtick survived — extraction ran long');
    // `\`` or `\$` left in place would mean the unescaping did not run.
    assert.equal(script.includes(`\\${TICK}`), false);
  });
});
