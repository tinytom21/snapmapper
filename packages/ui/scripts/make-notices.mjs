/**
 * Assemble `public/THIRD-PARTY-NOTICES.md` from the licence texts actually installed.
 *
 * ## Why this is generated rather than written
 *
 * Every licence in the tree — MIT, BSD-3-Clause, Apache-2.0 — obliges us to reproduce its text and
 * its copyright notices when we distribute a binary, and a bundled web app is a binary
 * distribution. A hand-written notices file is a copy of somebody else's legal text maintained by
 * hand: it goes stale on `npm update`, and a mistyped licence is worse than none because it looks
 * authoritative.
 *
 * So the text is read out of `node_modules` verbatim. If a dependency changes its licence, this
 * picks it up; if a dependency vanishes, the build fails rather than shipping a notice for
 * something that is no longer there.
 *
 * ## Why it lives in `public/`
 *
 * Because the obligation attaches to the **distribution**, not to the repository. A file only in
 * the repo does not travel with the deployed site, and the deployed site is what people receive.
 * From `public/` it is served alongside the app and the interface links to it.
 *
 *   npm run notices --workspace @snapmapper/ui
 */

import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require_ = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, '..', 'public', 'THIRD-PARTY-NOTICES.md');

/**
 * What we ship, and where each one's licence text lives.
 *
 * `licenseFile` is relative to the package root. Listed explicitly rather than crawled, because a
 * crawl of `node_modules` reports hundreds of build-time packages that are never distributed —
 * and a notices file that claims to ship Vite is inaccurate in the other direction.
 */
const SHIPPED = [
  {
    name: 'ExifTool',
    by: 'Copyright Phil Harvey',
    url: 'https://exiftool.org/',
    licence: 'Artistic License 2.0 (elected) or GPL v1+',
    /*
     * No year range here on purpose.
     *
     * ExifTool's own notice lives in the POD documentation at the end of the `exiftool` script,
     * and `@uswriting/exiftool` strips it when bundling — so the copy Snapmapper actually ships
     * carries no notice of its own, which is the single strongest reason this file has to exist.
     * Stating a range that cannot be read back out of what we distribute would be inventing a
     * legal detail; the canonical notice is at exiftool.org, and this points there.
     */
    note: 'Dual-licensed under the Artistic License and the GPL. Snapmapper **elects the Artistic '
      + 'License 2.0**, whose full text is in `LICENSE` at the root of this project.\n\n'
      + 'The copy shipped here is ExifTool 13.42, embedded in `@uswriting/exiftool` and extracted '
      + 'at build time. That bundling strips the script\'s own POD documentation, which is where '
      + 'ExifTool normally carries its copyright and licence statement — see https://exiftool.org/ '
      + 'for the canonical text.',
  },
  {
    name: '@uswriting/exiftool',
    package: '@uswriting/exiftool',
    licenseFile: 'LICENSE',
    url: 'https://github.com/6over3/exiftool',
    licence: 'Apache-2.0',
  },
  {
    name: '@6over3/zeroperl-ts',
    package: '@6over3/zeroperl-ts',
    url: 'https://github.com/6over3/zeroperl',
    licence: 'Apache-2.0',
    // Ships no LICENSE file of its own; its package metadata declares Apache-2.0, whose text is
    // reproduced once above under @uswriting/exiftool.
    sameTextAs: '@uswriting/exiftool',
  },
  { name: 'MapLibre GL JS', package: 'maplibre-gl', licenseFile: 'LICENSE.txt', licence: 'BSD-3-Clause', url: 'https://maplibre.org/' },
  { name: 'React', package: 'react', licenseFile: 'LICENSE', licence: 'MIT', url: 'https://react.dev/' },
  { name: 'React DOM', package: 'react-dom', licenseFile: 'LICENSE', licence: 'MIT', url: 'https://react.dev/' },
  { name: 'node-qrcode', package: 'qrcode', licenseFile: 'license', licence: 'MIT', url: 'https://github.com/soldair/node-qrcode' },
  { name: 'jsQR', package: 'jsqr', licenseFile: 'LICENSE', licence: 'Apache-2.0', url: 'https://github.com/cozmo/jsQR' },
];

/** Map data and tiles are not code, and their obligation is attribution rather than licence text. */
const DATA = `## Map data and tiles

The map is drawn from **OpenStreetMap** data, © OpenStreetMap contributors, available under the
[Open Database License](https://www.openstreetmap.org/copyright). Tiles are served by
[OpenFreeMap](https://openfreemap.org). Both are credited on the map itself, on every screen that
shows one, and that credit is not removable.

Place names come from **Nominatim**, run by the OpenStreetMap Foundation, and are used under its
[usage policy](https://operations.osmfoundation.org/policies/nominatim/): requests are serialised to
one per second across the whole application, grouped by rounded position so a fifty-photograph walk
is three or four lookups, and cached — including misses. Only coordinates are ever sent. Photographs
are not.
`;

async function packageRoot(name) {
  // Navigate from the resolved entry rather than resolving `<pkg>/package.json`, which an
  // `exports` map may refuse.
  const entry = require_.resolve(name, { paths: [path.join(HERE, '..', '..', '..')] });
  let dir = path.dirname(entry);
  for (let up = 0; up < 6; up += 1) {
    try {
      const meta = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8'));
      if (meta.name === name) return dir;
    } catch { /* keep walking up */ }
    dir = path.dirname(dir);
  }
  throw new Error(`could not find the package root for ${name}`);
}

async function build() {
  const parts = [
    '# Third-party notices',
    '',
    'Snapmapper is distributed with the software listed below. Each entry reproduces the notices its',
    'licence requires. Snapmapper itself is under the Artistic License 2.0; see `LICENSE`.',
    '',
    'This file is generated by `packages/ui/scripts/make-notices.mjs` from the licence texts as',
    'installed, so it cannot drift from what is actually shipped. Do not edit it by hand.',
    '',
    DATA,
    '## Software',
    '',
  ];

  for (const entry of SHIPPED) {
    parts.push(`### ${entry.name}`, '');
    parts.push(`- Licence: **${entry.licence}**`);
    if (entry.url) parts.push(`- Home: ${entry.url}`);
    if (entry.by) parts.push(`- ${entry.by}`);
    parts.push('');
    if (entry.note) parts.push(entry.note, '');
    if (entry.sameTextAs) {
      parts.push(`The Apache License 2.0 text is reproduced above under **${entry.sameTextAs}**.`, '');
      continue;
    }
    if (!entry.licenseFile) continue;

    const root = await packageRoot(entry.package);
    const text = (await readFile(path.join(root, entry.licenseFile), 'utf8')).trimEnd();

    // Indented as a fenced block so the licence text cannot be mistaken for this file's own prose,
    // and so a Markdown renderer leaves its formatting alone.
    parts.push('```', text, '```', '');
  }

  const written = `${parts.join('\n')}\n`;
  await writeFile(OUT, written);
  console.log(`Wrote ${path.relative(process.cwd(), OUT)} — ${(written.length / 1024).toFixed(1)}KB`);
}

await build();
