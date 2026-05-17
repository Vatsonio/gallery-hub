"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";

interface FavoritesCountValue {
  /** Current live count. Seeded from the server-rendered prop, then bumped by tile toggles. */
  count: number;
  /**
   * Adjust the count by `delta`. Used optimistically by PhotoTile + Lightbox the
   * moment a heart is tapped; the server action confirms shortly after and the
   * effect of a mismatch is reconciled by the caller (it can call bump again
   * with the opposite delta to roll back).
   */
  bump: (delta: number) => void;
  /**
   * Replace the count outright. Used by the PPR viewer-hydration island
   * when the dynamic favorites lookup streams in — the static shell
   * couldn't know the per-viewer count at prerender time, so it seeded 0.
   */
  setCount: (next: number) => void;
}

const FavoritesCountContext = createContext<FavoritesCountValue>({
  count: 0,
  bump: () => undefined,
  setCount: () => undefined,
});

/**
 * Hook for any client component that wants to read or mutate the live
 * favorites count without prop-drilling. Returns the stable `bump` setter
 * by reference so callers can pin it in a dependency list.
 */
export function useFavoritesCount(): FavoritesCountValue {
  return useContext(FavoritesCountContext);
}

interface ProviderProps {
  /** Server-rendered count for the current viewer. Acts as the initial value. */
  initial: number;
  children: React.ReactNode;
}

/**
 * Wraps the gallery client tree so PhotoTile (grid) and Lightbox (zoom)
 * can keep the badge in the MobileTabBar + the export-modal subtitle in
 * sync without a route revalidation round-trip. When the server re-renders
 * (e.g. the viewer hits the "Favorites" tab and back), the new initial
 * value reseeds the context so we never drift from authoritative state.
 */
export function FavoritesCountProvider({ initial, children }: ProviderProps): React.ReactNode {
  const [count, setCount] = useState(initial);

  // Re-sync whenever a fresh server render hands us a new initial value
  // (route changes, refresh, etc.). Without this, navigating back from
  // /favorites to /a/{token} would leave the badge frozen on the count
  // we last optimistically computed.
  useEffect(() => {
    setCount(initial);
  }, [initial]);

  const bump = useCallback((delta: number): void => {
    setCount((c) => Math.max(0, c + delta));
  }, []);

  const setCountDirect = useCallback((next: number): void => {
    setCount(Math.max(0, next));
  }, []);

  return (
    <FavoritesCountContext.Provider value={{ count, bump, setCount: setCountDirect }}>
      {children}
    </FavoritesCountContext.Provider>
  );
}
