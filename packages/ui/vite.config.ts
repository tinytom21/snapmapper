import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

import { zeroperlWasm } from './vite-plugin-zeroperl.ts';

export default defineConfig({
  plugins: [react(), zeroperlWasm()],
  server: {
    // The WASM backend needs a secure context for crypto.randomUUID, which localhost
    // satisfies. Binding elsewhere over plain http would break every write — see
    // spike/README.md.
    host: 'localhost',
    port: 5173,
  },
  // @geotagger/core is consumed as TypeScript source, so Vite must transpile it rather
  // than treat it as a pre-built dependency.
  optimizeDeps: { exclude: ['@geotagger/core'] },
  build: { target: 'es2023' },
});
