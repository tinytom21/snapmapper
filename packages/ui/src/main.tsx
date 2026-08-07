import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import 'maplibre-gl/dist/maplibre-gl.css';
import './styles.css';
import { App } from './App.tsx';
import { registerServiceWorker } from './register-sw.ts';

const root = document.getElementById('root');
if (!root) throw new Error('#root is missing from index.html');

registerServiceWorker();

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
