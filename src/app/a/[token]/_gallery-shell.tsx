"use client";

import { useEffect, useMemo, useState } from "react";
import { FileImage, Heart, ImageIcon } from "lucide-react";
// FileImage is used in both the export-modal options list and the footer
// save-all button below.
import MobileTabBar from "@/components/gallery/MobileTabBar";
import ExportModal, {
  type ExportOption,
  type ExportOptionId,
} from "@/components/gallery/ExportModal";
import PageLoadProgress from "@/components/gallery/PageLoadProgress";
import { ToastProvider } from "@/components/ui/Toast";
import type { ExportSizes } from "@/lib/exportSizes";

/**
 * How many photo tiles can register with the page-load progress bar.
 * Includes the cover hero (it registers via the same context). The cap
 * keeps the bar tracking only critical-render content — tiles below the
 * fold with loading="lazy" may never enter the viewport, so including
 * them would freeze progress at <100%. The cap matches roughly a typical
 * desktop first screen (4 rows × 4 cols + cover).
 */
const PROGRESS_CAP = 32;

interface Props {
  token: string;
  /** Number of favorites the current viewer has (for the dock + tab badge). */
  favoritesCount: number;
  /** Optional human-readable size of the favorited set (e.g. "23 MB"). */
  favoritesSizeLabel?: string;
  /** Byte totals + counts for the three export options. */
  exportSizes: ExportSizes;
  /** True when the viewer is an admin previewing — favorites won't persist. */
  isAdminPreview?: boolean;
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
  isAdminPreview = false,
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

  // No floating CTA anymore. Both whole-album and favorites exports are
  // entered from the footer "Save all" button → ExportModal picks the
  // right scope. Keeps the chrome quiet during browsing.
  const showSaveAllFooter = exportSizes.totalCount > 0;

  return (
    // ToastProvider wraps everything so ExportModal (and any future
    // child) can surface validation/error feedback. Mounting it here
    // — rather than at the share layout — keeps the toast surface
    // out of the public landing's password / locked screens, where
    // we never need it.
    <ToastProvider>
      <PageLoadProgress
        cap={PROGRESS_CAP}
        enabled={exportSizes.totalCount > 0}
      >
        {isAdminPreview && (
          <div className="sticky top-0 z-50 border-b border-rose-400/30 bg-rose-500/15 px-4 py-2 text-center text-xs text-rose-100 backdrop-blur">
            Admin preview — favorites and views are not recorded. Open the link in
            a private window to test as a real visitor.
          </div>
        )}
        {children}
        {showSaveAllFooter && (
          <footer className="mx-auto flex w-full max-w-screen-2xl flex-col items-center gap-4 px-4 pb-[calc(max(0.5rem,env(safe-area-inset-bottom))+8rem)] pt-10 sm:pb-20">
            <button
              type="button"
              onClick={() => {
                setPreselect("all-original");
                setExportOpen(true);
              }}
              className="group inline-flex items-center gap-3 rounded-full border border-white/10 bg-white/[0.04] px-5 py-3 text-sm font-medium text-white/90 backdrop-blur hover:border-white/20 hover:bg-white/[0.08] transition cursor-pointer"
            >
              <FileImage className="h-4 w-4 text-white/70 group-hover:text-white transition" />
              <span>Save all</span>
              <span className="text-white/50">
                {exportSizes.totalCount} photo{exportSizes.totalCount === 1 ? "" : "s"}
              </span>
            </button>
            <span className="text-[10px] uppercase tracking-[0.2em] text-white/25">
              gallery.divass.space
            </span>
          </footer>
        )}
        <MobileTabBar
          token={token}
          favoritesCount={favoritesCount}
        />
        <ExportModal
          open={exportOpen}
          onClose={() => setExportOpen(false)}
          token={token}
          options={options}
          preselect={preselect}
        />
      </PageLoadProgress>
    </ToastProvider>
  );
}
