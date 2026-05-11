"use client";

import { ChevronRight, Download } from "lucide-react";

interface Props {
  count: number;
  /** Optional human-readable size like "23 MB". */
  sizeLabel?: string;
  onClick: () => void;
}

/**
 * Floating "Export favorites" CTA. Visible only when at least one
 * favorite exists. Sits above the mobile tab bar on small screens and
 * floats centered on desktop. The actual export pipeline lands in M4
 * — this just opens the placeholder modal.
 */
export default function GlassDock({ count, sizeLabel, onClick }: Props) {
  if (count === 0) return null;
  return (
    <button
      type="button"
      onClick={onClick}
      className="glass-dock fixed left-1/2 -translate-x-1/2 z-30 flex w-[min(92vw,480px)] items-center gap-3 rounded-2xl px-4 py-3 text-left cursor-pointer hover:bg-white/[0.04] transition"
      style={{
        // Above mobile tabbar (which sits at safe-area-inset-bottom), tucked
        // close to bottom on desktop.
        bottom:
          "calc(env(safe-area-inset-bottom, 0px) + 5.5rem)",
      }}
    >
      <span className="grid h-11 w-11 place-items-center rounded-xl bg-gradient-to-br from-[#ff4d6d] to-[#b32340] shrink-0">
        <Download className="h-5 w-5 text-white" />
      </span>
      <span className="flex-1 min-w-0">
        <span className="block text-sm font-medium text-white">
          Export favorites
        </span>
        <span className="block text-xs text-white/60 truncate">
          {count} photo{count === 1 ? "" : "s"}
          {sizeLabel ? ` · ${sizeLabel}` : ""} · ZIP
        </span>
      </span>
      <ChevronRight className="h-5 w-5 text-white/60 shrink-0" />
    </button>
  );
}
