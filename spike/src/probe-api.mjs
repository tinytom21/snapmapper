/**
 * Spike Q2 — what does the WASM wrapper's API actually look like?
 *
 * The package's documented surface is `parseMetadata(file, options)` and
 * `writeMetadata(file, tags, options)`, with reads accepting an `args` array.
 * Whether *writes* accept raw ExifTool arguments is undocumented, and it
 * matters: `-n`, `-P` and `-overwrite_original` are not optional for this
 * application, and `-XMP:GPS*` is how Lightroom sees a location at all.
 *
 * This script assumes nothing. It prints what is really exported, what the
 * results really look like, and whether raw arguments have any effect.
 */

import { isMain, loadFixture, section, result } from './support.mjs';

const REQUIRED_ARGS = ['-n', '-P', '-overwrite_original'];

export async function probeApi() {
  const findings = {};

  section('Package surface');

  let pkg;
  try {
    pkg = await import('@uswriting/exiftool');
  } catch (error) {
    result(false, `Could not import @uswriting/exiftool: ${error.message}`);
    console.log('\n  Run `npm install` at the repository root first.\n');
    return { failed: true };
  }

  const exports = Object.keys(pkg).sort();
  console.log(`  exports: ${exports.join(', ')}`);
  findings.exports = exports;

  for (const name of ['parseMetadata', 'writeMetadata']) {
    const fn = pkg[name];
    console.log(
      `  ${name}: ${typeof fn}${typeof fn === 'function' ? ` (arity ${fn.length})` : ''}`,
    );
  }

  const fixture = await loadFixture();
  if (!fixture) return { failed: true };

  // --- What shape does the file argument take in Node? -------------------
  section('File argument shape');

  const candidates = [
    {
      label: 'Binaryfile { name, data }',
      build: () => ({ name: fixture.name, data: fixture.bytes }),
    },
    {
      label: 'File (node:buffer global)',
      build: () =>
        typeof File === 'undefined'
          ? null
          : new File([fixture.bytes], fixture.name, { type: 'image/jpeg' }),
    },
  ];

  let workingFile = null;
  for (const candidate of candidates) {
    const built = candidate.build();
    if (!built) {
      result(false, `${candidate.label} — not available in this runtime`);
      continue;
    }

    try {
      const output = await pkg.parseMetadata(built, { args: ['-json', '-n'] });
      const ok = output?.success === true;
      result(ok, `${candidate.label} — ${describe(output)}`);
      if (ok && !workingFile) workingFile = candidate;
    } catch (error) {
      result(false, `${candidate.label} — threw: ${error.message}`);
    }
  }

  if (!workingFile) {
    console.log('\n  No file shape worked. Everything downstream is blocked on this.\n');
    return { failed: true, findings };
  }

  findings.fileShape = workingFile.label;

  // --- Which ExifTool does it actually wrap? -----------------------------
  section('Wrapped ExifTool version');

  const version = await pkg.parseMetadata(workingFile.build(), { args: ['-ver'] });
  const versionText = String(version?.data ?? '').trim();
  console.log(`  ExifTool ${versionText || '(unreported)'}`);
  findings.exifToolVersion = versionText;

  // --- Q2 proper: do raw arguments reach the write path? -----------------
  section('Raw argument passthrough on writes');

  const tags = { 'EXIF:GPSLatitude': '51.4778', 'EXIF:GPSLatitudeRef': 'N' };

  const attempts = [
    { label: 'no options', options: {} },
    { label: '{ args: [...] }', options: { args: REQUIRED_ARGS } },
    { label: '{ extraArgs: [...] }', options: { extraArgs: REQUIRED_ARGS } },
  ];

  findings.writeArgSupport = {};

  for (const attempt of attempts) {
    try {
      const output = await pkg.writeMetadata(workingFile.build(), tags, attempt.options);
      const bytes = output?.data;
      const ok = output?.success === true && bytes && bytes.byteLength > 0;

      result(
        ok,
        `${attempt.label} — ${describe(output)}${ok ? `, ${bytes.byteLength} bytes out` : ''}`,
      );
      findings.writeArgSupport[attempt.label] = ok ? 'accepted' : 'rejected';
    } catch (error) {
      result(false, `${attempt.label} — threw: ${error.message}`);
      findings.writeArgSupport[attempt.label] = `threw: ${error.message}`;
    }
  }

  console.log(`
  Being *accepted* is not the same as being *applied* — an unknown option is
  easily ignored. write-gps.mjs settles it by checking whether the file
  modification date survived, which is what -P exists to do.
`);

  return { findings };
}

function describe(output) {
  if (output === undefined || output === null) return 'returned nothing';
  if (typeof output !== 'object') return `returned ${typeof output}`;

  const keys = Object.keys(output);
  if (output.success === false) return `success: false, error: ${truncate(output.error)}`;

  const dataType = output.data === undefined
    ? 'no data'
    : output.data instanceof Uint8Array
      ? `Uint8Array(${output.data.byteLength})`
      : typeof output.data;

  return `keys [${keys.join(', ')}], data: ${dataType}`;
}

function truncate(value, limit = 120) {
  const text = String(value ?? '');
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

if (isMain(import.meta.url)) {
  await probeApi();
}
