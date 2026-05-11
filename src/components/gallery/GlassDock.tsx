"use client";

import { ChevronRight, Download, Heart, ImageIcon } from "lucide-react";

interface Props {
  count: number;
  /** Optional human-readable size like "23 MB". */
  sizeLabel?: string;
  onClick: () => void;
  /**
   * "favorites" → "Export favorites (N)" copy with rose accent
   * "save-all" → "Save all (N)" copy with neutral accent. Used when the
   * viewer has no favorites yet but the album is downloadable.
   */
  variant?: "favorites" | "save-all";
}

/**
 * Floating CTA above the mobile tab bar. Two variants:
 *  - favorites: rose accent, "Export favorites (N)"
 *  - save-all: neutral accent, "Save all (N)"
 *
 * The shell picks the variant based on viewer state. Hidden when
 * count === 0 regardless of variant.
 */
export default function GlassDock({
  count,
  sizeLabel,
  onClick,
  variant = "favorites",
}: Props) {
  if (count === 0) return null;
  const isFav = variant === "favorites";
  const Icon = isFav ? Heart : ImageIcon;
  const title = isFav ? "Export favorites" : "Save all";
  const accent = isFav
    ? "from-[#ff4d6d] to-[#b32340]"
    : "from-white/15 to-white/5";
  return (
    <button
      type="button"
      onClick={onClick}
      data-dock-variant={variant}
      className="glass-dock fixed left-1/2 -translate-x-1/2 z-40 flex w-[min(92vw,480px)] items-center gap-3 rounded-2xl px-4 py-3 text-left cursor-pointer hover:bg-white/[0.04] transition glass-dock-anim sm:bottom-[1.5rem] bottom-[max(0.5rem,env(safe-area-inset-bottom))]"
    >
      <span
        className={`grid h-11 w-11 place-items-center rounded-xl bg-gradient-to-br shrink-0 ${accent}`}
      >
        {isFav ? (
          <Download className="h-5 w-5 text-white" />
        ) : (
          <Icon className="h-5 w-5 text-white" />
        )}
      </span>
      <span className="flex-1 min-w-0">
        <span className="block text-sm font-medium text-white">{title}</span>
        <span className="block text-xs text-white/60 truncate">
          {count} photo{count === 1 ? "" : "s"}
          {sizeLabel ? ` · ${sizeLabel}` : ""} · ZIP
        </span>
      </span>
      <ChevronRight className="h-5 w-5 text-white/60 shrink-0" />
    </button>
  );
}
