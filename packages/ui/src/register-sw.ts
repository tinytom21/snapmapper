/**
 * Register the service worker, which is what lets this run on a phone with no server.
 *
 * Guarded three ways, and each guard is a real failure rather than defensiveness:
 *
 * - **Production only.** In dev the modules are unbundled and served on demand; a worker
 *   holding a cached shell in front of that serves stale files convincingly.
 * - **`serviceWorker` in navigator.** Absent outside a secure context, exactly like
 *   `crypto.randomUUID` and `showOpenFilePicker`. Already the cause of one wrong conclusion
 *   in this project, so it is checked rather than assumed.
 * - **Never throws.** Registration failing means no offline support, which is a downgrade,
 *   not a breakage. The app works over the network regardless, and taking the page down over
 *   it would turn a missing feature into a blank screen.
 */

/** Dispatched on `window` when an update is installed and waiting. */
export const UPDATE_READY_EVENT = 'snapmapper:update-ready';

/** Set once an update is installed and waiting, so the app can offer to take it. */
let waiting: ServiceWorker | null = null;

export function registerServiceWorker(onUpdateReady?: () => void): void {
  if (!import.meta.env.PROD) return;
  if (!('serviceWorker' in navigator)) return;

  // After load, so 24MB of WASM and the first tiles are not competing with a precache for
  // bandwidth on the very first visit.
  window.addEventListener('load', () => {
    /*
     * `BASE_URL`, not '/'. On a GitHub Pages project site the app lives at `/<repo>/`, and a
     * worker's scope cannot rise above its own directory — registering at '/' from there is
     * rejected outright. Vite fills this in at build time and it always ends in a slash.
     */
    const base = import.meta.env.BASE_URL;
    navigator.serviceWorker.register(`${base}sw.js`, { scope: base }).then(
      (registration) => {
        /*
         * A waiting worker means a new version is installed but not in charge, because the
         * worker deliberately does not `skipWaiting()` — swapping assets under a running page
         * is how staged edits that have not reached disk get lost.
         *
         * It used to be logged and nothing more, which was a mistake: an update that appears
         * only on the next launch is indistinguishable from a deploy that never happened, and
         * that is precisely how it looked from the outside. So the app is told, and offers a
         * Reload the user can take when it suits them.
         */
        const announce = (worker: ServiceWorker | null) => {
          if (!worker || !navigator.serviceWorker.controller) return;
          waiting = worker;
          onUpdateReady?.();
        };

        announce(registration.waiting);

        registration.addEventListener('updatefound', () => {
          const installing = registration.installing;
          if (!installing) return;
          installing.addEventListener('statechange', () => {
            if (installing.state === 'installed') announce(registration.waiting);
          });
        });
      },
      (error: unknown) => {
        console.warn('snapmapper: offline support unavailable —', error);
      },
    );
  });
}

/**
 * Take the waiting update, then reload onto it.
 *
 * The reload is driven by `controllerchange` rather than fired straight after the message,
 * because the new worker has to be in charge *before* the page asks for assets again — reloading
 * too early gets the old shell back and the update appears not to have happened. The flag stops
 * the second controller change of a session from reloading a page nobody asked to reload.
 */
export function activateUpdate(): void {
  const worker = waiting;
  if (!worker) return;

  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
    reloading = true;
    window.location.reload();
  });

  worker.postMessage('skip-waiting');
}
