import { useCallback } from 'react';
import { useExtensions } from '../lib/extensions';
import { type TilePlugin, tileTitle } from './tilePlugins';

/**
 * A tile's name, re-resolved when the extensions list arrives.
 *
 * `tileTitle` reads the session cache synchronously, so on the first paint an
 * extension tile may still read its id ("note"). Subscribing to the list here is
 * what turns that into the display name ("Note") once it is known — without every
 * caller having to remember why it re-renders.
 */
export function useTileTitle(): (
  plugin: TilePlugin | undefined,
  params?: Record<string, string>,
) => string | undefined {
  const { items } = useExtensions();
  return useCallback(
    (plugin, params) => tileTitle(plugin, params),
    // The list is the dependency that matters: it is what `tileTitle` reads.
    [items],
  );
}
