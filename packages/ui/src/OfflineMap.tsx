/**
 * What the map has kept, and a way to get rid of it.
 *
 * Caching happens by itself as you look at ground — there is no button for that, because a button
 * would mean remembering to press it before losing signal, which is the same "remember to start the
 * logger" problem that made Timeline worth supporting.
 *
 * What does need saying is how much has accumulated and how to clear it, because this is the one
 * thing in the app that grows without being asked to.
 */

import { useCallback, useEffect, useState } from 'react';

import { clearTileCache, tileCacheStats, type TileCacheStats } from './offline-tiles.ts';

export function OfflineMap() {
  const [stats, setStats] = useState<TileCacheStats | null>(null);
  const [working, setWorking] = useState(false);

  const refresh = useCallback(() => {
    void tileCacheStats().then(setStats);
  }, []);

  useEffect(refresh, [refresh]);

  if (!stats) return null;

  return (
    <div className="offline-map">
      <p className="note">
        {stats.entries === 0
          ? 'No map data saved yet. Ground you look at while online is kept, so it is there '
            + 'again when you are not.'
          : `${stats.entries.toLocaleString()} map tiles saved (${formatBytes(stats.bytes)}). `
            + 'That ground works with no connection.'}
      </p>
      {stats.entries > 0 && (
        <div className="row">
          <button
            type="button"
            className="link"
            disabled={working}
            onClick={async () => {
              setWorking(true);
              await clearTileCache();
              refresh();
              setWorking(false);
            }}
          >
            {working ? 'Clearing…' : 'Clear saved map data'}
          </button>
        </div>
      )}
    </div>
  );
}

/** One decimal past a megabyte is noise; below one, it is the whole answer. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
