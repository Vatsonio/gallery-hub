"use client";

import { useEffect, useMemo, useState } from "react";
import { FileImage, Heart, ImageIcon } from "lucide-react";
import MobileTabBar from "@/components/gallery/MobileTabBar";
import GlassDock from "@/components/gallery/GlassDock";
import ExportModal, {
  type ExportOption,
  type ExportOptionId,
} from "@/components/gallery/ExportModal";
import type { ExportSizes } from "@/lib/exportSizes";

interface Props {
  token: string;
  /** Number of favorites the current viewer has (for the dock + tab badge). */
  favoritesCount: number;
  /** Optional human-readable size of the favorited set (e.g. "23 MB"). */
  favoritesSizeLabel?: string;
  /** Byte totals + counts for the three export options. */
  exportSizes: ExportSizes;
  children: React.ReactNode;
}

/**
 * Client-side shell hosting the floating export dock + mobile tab bar +
 * three-option export modal. Wraps server-rendered gallery / favorites
 * children. The shell never fetches — its parent server component
 * supplies all data so the dock and modal render correctly on first
 * paint.
 */
export default function GalleryShell({
  token,
  favoritesCount,
  favoritesSizeLabel,
  exportSizes,
  children,
}: Props) {
  const [exportOpen, setExportOpen] = useState(false);
  const [preselect, setPreselect] = useState<ExportOptionId | undefined>(undefined);

  // Restore scroll position when returning from the single-photo lightbox.
  // PhotoTile writes sessionStorage[gh:return-scroll:<token>] before nav;
  // we read it on mount and scroll back, then clear. Entry is honored only
  // if it's <5 minutes old to avoid jumping on later organic visits.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const key = `gh:return-scroll:${token}`;
    try {
      const raw = sessionStorage.getItem(key);
      if (!raw) return;
      sessionStorage.removeItem(key);
      const parsed = JSON.parse(raw) as { y?: number; at?: number };
      if (
        typeof parsed.y !== "number" ||
        typeof parsed.at !== "number" ||
        Date.now() - parsed.at > 5 * 60 * 1000
      ) {
        return;
      }
      // Two rafs: first lets the layout settle, second runs after images
      // claim their reserved sizes. Reduce-motion users get an instant jump.
      const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          window.scrollTo({ top: parsed.y!, behavior: reduce ? "auto" : "auto" });
        });
      });
    } catch {
      // sessionStorage may throw in private modes; not fatal.
    }
  }, [token]);

  const options = useMemo<ExportOption[]>(
    () => [
      {
        id: "favorites-original",
        scope: "favorites",
        variant: "original",
        icon: Heart,
        title: "Favorites — originals",
        subtitle: `${exportSizes.favoritesCount} photo${exportSizes.favoritesCount === 1 ? "" : "s"} · full quality`,
        bytes: exportSizes.favoritesOriginalBytes,
        disabled: exportSizes.favoritesCount === 0,
      },
      {
        id: "all-web",
        scope: "all",
        variant: "web",
        icon: ImageIcon,
        title: "Whole album — web size",
        subtitle: `${exportSizes.totalCount} photo${exportSizes.totalCount === 1 ? "" : "s"} · 2400px max`,
        bytes: exportSizes.allWebBytes,
        disabled: exportSizes.totalCount === 0,
      },
      {
        id: "all-original",
        scope: "all",
        variant: "original",
        icon: FileImage,
        title: "Whole album — originals",
        subtitle: `${exportSizes.totalCount} photo${exportSizes.totalCount === 1 ? "" : "s"} · full quality`,
        bytes: exportSizes.allOriginalBytes,
        disabled: exportSizes.totalCount === 0,
      },
    ],
    [exportSizes],
  );

  // Decide which dock to show. Favorites win when the viewer has any
  // hearted photos; otherwise fall back to a "Save all" CTA so the user
  // can grab the whole album without picking favorites first.
  const showFavoritesDock = favoritesCount > 0;
  const showSaveAllDock =
    !showFavoritesDock && exportSizes.totalCount > 0;

  return (
    <>
      {children}
      {showFavoritesDock && (
        <GlassDock
          variant="favorites"
          count={favoritesCount}
          sizeLabel={favoritesSizeLabel}
          onClick={() => {
            setPreselect("favorites-original");
            setExportOpen(true);
          }}
        />
      )}
      {showSaveAllDock && (
        <GlassDock
          variant="save-all"
          count={exportSizes.totalCount}
          onClick={() => {
            setPreselect("all-original");
            setExportOpen(true);
          }}
        />
      )}
      <MobileTabBar token={token} favoritesCount={favoritesCount} />
      <ExportModal
        open={exportOpen}
        onClose={() => setExportOpen(false)}
        token={token}
        options={options}
        preselect={preselect}
      />
    </>
  );
}
