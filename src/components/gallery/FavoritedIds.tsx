"use client";

import { createContext, useCallback, useContext, useMemo, useState } from "react";

/**
 * Set of photo IDs the current viewer has favorited. `null` means the
 * favorites lookup hasn't resolved yet (the static shell renders before
 * the dynamic viewer island streams in). Components consuming this
 * should treat `null` as "loading, default to unfilled hearts" — never
 * as "no favorites".
 */
type FavoritedIds = ReadonlySet<string> | null;

interface FavoritedIdsValue {
  ids: FavoritedIds;
  /**
   * Replace the set with a freshly-resolved one. Called once by the
   * viewer hydrator the moment the dynamic island lands.
   */
  setIds: (next: ReadonlySet<string>) => void;
  /**
   * Add or remove a single photoId from the set. Driven by PhotoTile's
   * heart taps so a re-render (e.g. switching tabs) doesn't unlearn the
   * optimistic toggle while the server confirms. No-op when ids is null
   * — at that point the viewer layer still owns the source of truth.
   */
  toggle: (photoId: string, favorited: boolean) => void;
}

const Ctx = createContext<FavoritedIdsValue>({
  ids: null,
  setIds: () => undefined,
  toggle: () => undefined,
});

export function useFavoritedIds(): FavoritedIds {
  return useContext(Ctx).ids;
}

export function useFavoritedIdsActions(): Pick<FavoritedIdsValue, "setIds" | "toggle"> {
  const v = useContext(Ctx);
  return useMemo(() => ({ setIds: v.setIds, toggle: v.toggle }), [v.setIds, v.toggle]);
}

interface ProviderProps {
  children: React.ReactNode;
}

export function FavoritedIdsProvider({ children }: ProviderProps): React.ReactNode {
  const [ids, setState] = useState<FavoritedIds>(null);

  const setIds = useCallback((next: ReadonlySet<string>): void => {
    setState(new Set(next));
  }, []);

  const toggle = useCallback((photoId: string, favorited: boolean): void => {
    setState((cur) => {
      if (cur === null) return cur;
      const next = new Set(cur);
      if (favorited) next.add(photoId);
      else next.delete(photoId);
      return next;
    });
  }, []);

  const value = useMemo<FavoritedIdsValue>(
    () => ({ ids, setIds, toggle }),
    [ids, setIds, toggle],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
