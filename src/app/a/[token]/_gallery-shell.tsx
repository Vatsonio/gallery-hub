"use client";

import { useState } from "react";
import MobileTabBar from "@/components/gallery/MobileTabBar";
import GlassDock from "@/components/gallery/GlassDock";
import ExportModalPlaceholder from "@/components/gallery/ExportModalPlaceholder";

interface Props {
  token: string;
  /** Number of favorites the current viewer has (for the dock + tab badge). */
  favoritesCount: number;
  /** Optional human-readable size of the favorited set (e.g. "23 MB"). */
  favoritesSizeLabel?: string;
  children: React.ReactNode;
}

/**
 * Client-side shell hosting the floating export dock + mobile tab
 * bar + placeholder export modal. Wraps the server-rendered gallery
 * or favorites content as children.
 */
export default function GalleryShell({
  token,
  favoritesCount,
  favoritesSizeLabel,
  children,
}: Props) {
  const [exportOpen, setExportOpen] = useState(false);
  return (
    <>
      {children}
      <GlassDock
        count={favoritesCount}
        sizeLabel={favoritesSizeLabel}
        onClick={() => setExportOpen(true)}
      />
      <MobileTabBar token={token} favoritesCount={favoritesCount} />
      <ExportModalPlaceholder
        open={exportOpen}
        onOpenChange={setExportOpen}
      />
    </>
  );
}
