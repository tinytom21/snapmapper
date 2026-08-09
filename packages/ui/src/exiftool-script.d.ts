/**
 * The ExifTool Perl script, supplied by `vite-plugin-exiftool-script.ts`.
 *
 * A virtual module, so there is no file for TypeScript to look at — hence this declaration. It is
 * extracted from `@uswriting/exiftool`'s own bundle at build time rather than committed here; see
 * `../exiftool-script.ts` for why, and for what happens when the dependency changes shape.
 *
 * Imported only by `batch-runner.ts`, and only through a dynamic import, so the 100KB of Perl
 * stays out of the main bundle.
 */
declare module 'virtual:exiftool-script' {
  const script: string;
  export default script;
}
