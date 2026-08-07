import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import 'maplibre-gl/dist/maplibre-gl.css';
import './styles.css';
import { App } from './App.tsx';
import { UPDATE_READY_EVENT, registerServiceWorker } from './register-sw.ts';

const root = document.getElementById('root');
if (!root) throw new Error('#root is missing from index.html');

/*
 * A window event rather than a callback threaded into React, because registration happens on
 * `load` — before or after the first render depending on the device — and an event has no ordering
 * requirement. `App` listens for it.
 */
registerServiceWorker(() => window.dispatchEvent(new Event(UPDATE_READY_EVENT)));

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
