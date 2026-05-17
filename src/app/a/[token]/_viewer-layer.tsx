"use client";

import { useEffect, useState } from "react";
import { useFavoritedIdsActions } from "@/components/gallery/FavoritedIds";
import { useFavoritesCount } from "@/components/gallery/FavoritesCount";
import { useExportSizesActions } from "@/components/gallery/ExportSizesContext";
import type { ViewerContextPayload } from "@/app/api/viewer-context/[token]/route";

interface Props {
  token: string;
}

/**
 * Client-side viewer hydration. The share-page HTML is rendered statically
 * (cover, layout, tiles, GalleryShell providers seeded with token-only data)
 * and cached by Next ISR + the CDN. THIS component runs only in the browser:
 * it calls `/api/viewer-context/{token}` once on mount, pushes the per-viewer
 * favorites / counts / export sizes into the GalleryShell contexts, and
 * optionally renders the "admin preview" banner.
 *
 * Side effects (view tracking, first-view notification, suspicious-IP
 * tally) live inside the API endpoint, so the static HTML stays viewer-
 * agnostic. Failure is silent — a 401/410/429 just leaves the page in its
 * static-shell state, which is still functional (no favorites highlights,
 * download modal shows token-only numbers).
 */
export default function ViewerLayer({ token }: Props): React.ReactNode {
  const { setIds } = useFavoritedIdsActions();
  const { setCount } = useFavoritesCount();
  const { setSizes } = useExportSizesActions();
  const [adminPreview, setAdminPreview] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/viewer-context/${encodeURIComponent(token)}`, {
          method: "GET",
          credentials: "same-origin",
          cache: "no-store",
        });
        if (!res.ok) return;
        const data = (await res.json()) as ViewerContextPayload;
        if (cancelled) return;
        setIds(new Set(data.favoriteIds));
        setCount(data.favoritesCount);
        setSizes(data.exportSizes);
        setAdminPreview(data.isAdminPreview);
      } catch {
        // Static shell stays as-is. The page still works without the per-
        // viewer overlay; the user just won't see their heart highlights
        // until the next successful fetch.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token, setIds, setCount, setSizes]);

  if (!adminPreview) return null;
  return (
    <div className="sticky top-0 z-50 border-b border-rose-400/30 bg-rose-500/15 px-4 py-2 text-center text-xs text-rose-100 backdrop-blur">
      Admin preview — favorites and views are not recorded. Open the link in
      a private window to test as a real visitor.
    </div>
  );
}
