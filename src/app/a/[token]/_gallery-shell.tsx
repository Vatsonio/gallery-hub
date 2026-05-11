"use client";

import { useMemo, useState } from "react";
import { FileImage, Heart, ImageIcon } from "lucide-react";
import MobileTabBar from "@/components/gallery/MobileTabBar";
import GlassDock from "@/components/gallery/GlassDock";
import ExportModal, { type ExportOption } from "@/components/gallery/ExportModal";
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

  return (
    <>
      {children}
      <GlassDock
        count={favoritesCount}
        sizeLabel={favoritesSizeLabel}
        onClick={() => setExportOpen(true)}
      />
      <MobileTabBar token={token} favoritesCount={favoritesCount} />
      <ExportModal
        open={exportOpen}
        onClose={() => setExportOpen(false)}
        token={token}
        options={options}
      />
    </>
  );
}
