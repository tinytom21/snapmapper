/**
 * Can ExifTool-in-WASM create an XMP sidecar, and is what it writes correct?
 *
 * Raw is shot occasionally, and the plan has always been **sidecars rather than rewriting the
 * ARW**: never touching the raw file means never risking it, and a sidecar is what raw editors read
 * anyway. exiv2's Sony ARW corruption is the cautionary tale this avoids entirely — there is no
 * corruption risk in a file we create from nothing.
 *
 * Three things had to be established before any of it could be built, and none was obvious:
 *
 *   1. **ExifTool will create an XMP from no input file at all.** `-o out.xmp -XMP:Tag=Value` with
 *      no source. Confirmed against native 13.59; this asks whether the WASM build agrees, since
 *      the wrapper's own write path cannot do it — that always appends the input path and names its
 *      output `<uuid>.tmp`, and the output *extension* is what tells ExifTool to make an XMP.
 *   2. **The bytes can be got back out.** Nothing is returned on stdout, so the file has to be read
 *      out of zeroperl's virtual filesystem afterwards.
 *   3. **XMP has no `GPSLatitudeRef`.** The hemisphere lives in the value — `51,30.0N`. Passing the
 *      ref tags the JPEG path uses earns `Sorry, XMP:GPSLatitudeRef doesn't exist or isn't
 *      writable`, and `classify` in `exiftool.ts` treats any unrecognised stderr as fatal, so the
 *      write would fail outright.
 *
 * Verified at the end against **native ExifTool**, which is the rule for anything that writes a
 * file: what one implementation produces, a second has to agree about.
 *
 *   npm run xmp --workspace spike
 */

import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { extractExifToolScript } from '../../packages/ui/exiftool-script.ts';

import { patchZeroperl } from './patch-zeroperl.mjs';
import { isMain, note, section } from './support.mjs';

const run = promisify(execFile);

function exifToolPath() {
  return process.env.EXIFTOOL
    ?? path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'ExifTool', 'exiftool.exe');
}

export async function verifyXmpSidecar() {
  section('Can ExifTool-in-WASM create an XMP sidecar?');

  await patchZeroperl();
  const zeroperl = await import('@6over3/zeroperl-ts');
  const source = await readFile(
    path.join(process.cwd(), '..', 'node_modules', '@uswriting', 'exiftool', 'dist', 'esm', 'index.js'),
    'utf8',
  );
  const script = extractExifToolScript(source);

  let out = '';
  let err = '';
  const decoder = new TextDecoder();
  const fs = new zeroperl.MemoryFileSystem({ '/': '' });
  fs.addFile('/exiftool', script);
  const perl = await zeroperl.ZeroPerl.create({
    fileSystem: fs,
    stdout: (c) => { out += typeof c === 'string' ? c : decoder.decode(c); },
    stderr: (c) => { err += typeof c === 'string' ? c : decoder.decode(c); },
  });

  /** Run ExifTool and read a file it produced back out of the virtual filesystem. */
  async function produce(args, wanted) {
    out = ''; err = '';
    await perl.reset();
    try { fs.removeFile(wanted); } catch { /* not there */ }

    const result = await perl.runFile('/exiftool', args);
    perl.flush();

    const node = fs.lookup(wanted);
    const bytes = node && node.type === 'file'
      ? (node.content instanceof Uint8Array ? node.content : undefined)
      : undefined;

    return { exitCode: result.exitCode, stdout: out, stderr: err.trim(), bytes };
  }

  section('A sidecar from nothing at all');
  const made = await produce([
    '-n',
    '-XMP:GPSLatitude=-33.8688',
    '-XMP:GPSLongitude=-151.2093',
    '-XMP:GPSAltitude=42.5',
    '-XMP:GPSMapDatum=WGS-84',
    '-XMP:City=Sydney',
    '-XMP:Country=Australia',
    '-XMP:CountryCode=AU',
    '-o', '/out.xmp',
  ], '/out.xmp');

  console.log(`  exit ${made.exitCode}`);
  note(`  stderr: ${made.stderr || '(none)'}`);
  if (!made.bytes) {
    note('  NOTHING WAS PRODUCED — the WASM build cannot create a sidecar this way.');
    process.exitCode = 1;
    return;
  }
  note(`  produced ${made.bytes.length} bytes`);
  console.log(new TextDecoder().decode(made.bytes).split('\n').map((l) => `    ${l}`).join('\n'));

  section('Does the ref-tag trap still bite?');
  const refs = await produce([
    '-n', '-XMP:GPSLatitude=51.5', '-XMP:GPSLatitudeRef=N', '-o', '/ref.xmp',
  ], '/ref.xmp');
  note(`  stderr: ${refs.stderr || '(none)'}`);
  note(refs.stderr.toLowerCase().includes('gpslatituderef')
    ? '  Confirmed: XMP has no GPSLatitudeRef, and passing it is an error the write path would '
      + 'treat as fatal. Do not send the EXIF ref tags to a sidecar.'
    : '  It did NOT complain — check whether this ExifTool version changed.');

  section('Verified against native ExifTool');
  const dir = await mkdtemp(path.join(tmpdir(), 'snapmapper-xmp-'));
  const file = path.join(dir, 'DSC01234.xmp');
  await writeFile(file, made.bytes);

  let native;
  try {
    const { stdout } = await run(exifToolPath(), ['-json', '-n', '-G', file]);
    native = JSON.parse(stdout)[0];
  } catch (error) {
    note(`  Could not run native ExifTool: ${error.message}`);
    note('  Install it, or set EXIFTOOL to its absolute path.');
    return;
  }

  const expected = {
    'XMP:GPSLatitude': -33.8688,
    'XMP:GPSLongitude': -151.2093,
    'XMP:GPSAltitude': 42.5,
    'XMP:GPSMapDatum': 'WGS-84',
    'XMP:City': 'Sydney',
    'XMP:Country': 'Australia',
    'XMP:CountryCode': 'AU',
    // Derived by ExifTool from the signed values, which is the proof the hemisphere survived.
    'Composite:GPSLatitudeRef': 'S',
    'Composite:GPSLongitudeRef': 'W',
  };

  let checks = 0;
  let failures = 0;
  for (const [tag, want] of Object.entries(expected)) {
    checks += 1;
    const got = native[tag];
    const ok = String(got) === String(want);
    if (!ok) failures += 1;
    console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${tag}: ${got}${ok ? '' : ` (expected ${want})`}`);
  }

  checks += 1;
  if (native['File:FileType'] !== 'XMP') {
    failures += 1;
    console.log(`  FAIL  native ExifTool reads it as ${native['File:FileType']}, not XMP`);
  } else {
    console.log('  ok    native ExifTool recognises it as an XMP file');
  }

  section('Verdict');
  note(`${checks} checks, ${failures} failures.`);
  if (failures > 0) process.exitCode = 1;
  else note('The WASM build creates a sidecar that native ExifTool reads back exactly.');
}

if (isMain(import.meta.url)) await verifyXmpSidecar();
