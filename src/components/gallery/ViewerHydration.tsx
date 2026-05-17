"use client";

import { useEffect } from "react";
import { useFavoritedIdsActions } from "./FavoritedIds";
import { useFavoritesCount } from "./FavoritesCount";

interface Props {
  /** Photo IDs the viewer has favorited (token-scoped). */
  favoriteIds: string[];
  /** Initial count for the badge — typically `favoriteIds.length`. */
  favoritesCount: number;
}

/**
 * Bridge that takes the server-resolved viewer data (streamed in by the
 * dynamic island under <Suspense>) and pushes it into the client-side
 * favorites contexts. PhotoTile reads these contexts on every render, so
 * the moment this component mounts the previously-empty hearts light up
 * for tiles the viewer has favorited.
 *
 * Renders nothing — the visible changes happen via context.
 */
export default function ViewerHydration({ favoriteIds, favoritesCount }: Props): null {
  const { setIds } = useFavoritedIdsActions();
  const { setCount } = useFavoritesCount();

  useEffect(() => {
    setIds(new Set(favoriteIds));
    // Replace (don't delta) the badge — the static shell seeded 0 because
    // it can't know the per-viewer count at prerender time.
    setCount(favoritesCount);
    // Single hydration on mount; re-running would clobber optimistic
    // toggles that landed between the dynamic-island land and a later
    // re-render of the same component.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return null;
}
