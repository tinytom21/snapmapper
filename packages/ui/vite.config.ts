import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import basicSsl from '@vitejs/plugin-basic-ssl';

import { serviceWorker } from './vite-plugin-service-worker.ts';
import { zeroperlWasm } from './vite-plugin-zeroperl.ts';

/**
 * Two dev modes.
 *
 * Default (`npm run dev`) binds to localhost, which is a secure context without any
 * certificate — the friction-free way to work on the desktop.
 *
 * `npm run dev:lan` binds to every interface *and* serves HTTPS, to reach the app from a
 * phone. The HTTPS part is not optional: the File System Access API and
 * `crypto.randomUUID` are both gated on a secure context, so over plain `http://` on a LAN
 * address they are simply absent — indistinguishable from the platform not supporting them.
 * Concluding anything from a capability test on an insecure origin would be the third
 * premise this project got wrong for free.
 *
 * The certificate is self-signed, so the browser warns. Accepting the warning still yields
 * a secure context, which is the whole point.
 *
 * Vite's own `mode` carries this rather than an environment variable, which would not
 * survive being set in a child process on Windows.
 */
export default defineConfig(({ mode }) => {
  const lan = mode === 'lan';

  return {
    /*
     * Where the app will be served from.
     *
     * A GitHub Pages project site lives at `/<repo>/`, not at the domain root, so every
     * absolute URL in the app has to carry that prefix — and the service worker's scope has to
     * as well, or it silently controls nothing. Set `SNAPMAPPER_BASE=/snapmapper/` for that
     * deploy; the default suits localhost, a user site and any other host serving from the root.
     *
     * An environment variable rather than a mode, because the deploy sets it in CI where a
     * `--mode` flag would also drag in the LAN certificate arrangement.
     */
    base: process.env.SNAPMAPPER_BASE ?? '/',
    plugins: [react(), zeroperlWasm(), serviceWorker(), ...(lan ? [basicSsl()] : [])],
    server: lan ? { host: true, port: 5173 } : { host: 'localhost', port: 5173 },
    // @snapmapper/core is consumed as TypeScript source, so Vite must transpile it rather
    // than treat it as a pre-built dependency.
    optimizeDeps: { exclude: ['@snapmapper/core'] },
    build: { target: 'es2023' },
  };
});
