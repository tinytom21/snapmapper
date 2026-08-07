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

export function registerServiceWorker(): void {
  if (!import.meta.env.PROD) return;
  if (!('serviceWorker' in navigator)) return;

  // After load, so 24MB of WASM and the first tiles are not competing with a precache for
  // bandwidth on the very first visit.
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).then(
      (registration) => {
        /*
         * A waiting worker means a new version is installed but not in charge, because the
         * worker deliberately does not `skipWaiting()` — swapping assets under a running page
         * is how staged edits that have not reached disk get lost. It takes over on the next
         * launch. Logged rather than surfaced: nothing is wrong, and nothing needs doing.
         */
        if (registration.waiting) {
          console.info('photo-geotagger: an update is installed and starts on next launch');
        }
      },
      (error: unknown) => {
        console.warn('photo-geotagger: offline support unavailable —', error);
      },
    );
  });
}
