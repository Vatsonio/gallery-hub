"use client";

import { useEffect } from "react";
import { ChevronLeft, ChevronRight, X } from "lucide-react";

interface Props {
  photoUrl: string;
  prevId: string | null;
  nextId: string | null;
  index: number;
  total: number;
  onClose: () => void;
  onNavigate: (id: string) => void;
}

/**
 * Minimal admin-side lightbox. Click-to-expand with prev/next arrows and
 * ESC / backdrop-click close. No like/save/share controls — admins don't
 * need them when previewing their own album.
 */
export default function AdminLightbox({
  photoUrl,
  prevId,
  nextId,
  index,
  total,
  onClose,
  onNavigate,
}: Props) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowLeft" && prevId) onNavigate(prevId);
      else if (e.key === "ArrowRight" && nextId) onNavigate(nextId);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, onNavigate, prevId, nextId]);

  return (
    <div
      className="fixed inset-0 z-50 bg-black/95 flex items-center justify-center select-none"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="relative max-h-screen max-w-full flex items-center justify-center"
        onClick={(e) => e.stopPropagation()}
      >
        <img
          src={photoUrl}
          alt=""
          draggable={false}
          className="max-h-screen max-w-full object-contain"
        />
      </div>

      <div
        className="fixed top-0 inset-x-0 z-10 flex items-center justify-between px-4 py-3 bg-gradient-to-b from-black/70 to-transparent"
        style={{ paddingTop: "max(12px, env(safe-area-inset-top))" }}
      >
        <button
          aria-label="Close"
          onClick={onClose}
          className="h-11 w-11 flex items-center justify-center rounded-full bg-white/10 backdrop-blur-md text-white hover:bg-white/20 transition cursor-pointer"
        >
          <X className="h-5 w-5" aria-hidden />
        </button>
        <div className="text-sm text-white/90 tabular-nums tracking-wide">
          {index + 1} / {total}
        </div>
        <div className="h-11 w-11" aria-hidden />
      </div>

      {prevId && (
        <button
          aria-label="Previous"
          onClick={(e) => {
            e.stopPropagation();
            onNavigate(prevId);
          }}
          className="hidden sm:flex absolute left-4 top-1/2 -translate-y-1/2 h-11 w-11 items-center justify-center rounded-full bg-black/50 backdrop-blur-md text-white hover:bg-black/70 transition cursor-pointer"
        >
          <ChevronLeft className="h-5 w-5" aria-hidden />
        </button>
      )}
      {nextId && (
        <button
          aria-label="Next"
          onClick={(e) => {
            e.stopPropagation();
            onNavigate(nextId);
          }}
          className="hidden sm:flex absolute right-4 top-1/2 -translate-y-1/2 h-11 w-11 items-center justify-center rounded-full bg-black/50 backdrop-blur-md text-white hover:bg-black/70 transition cursor-pointer"
        >
          <ChevronRight className="h-5 w-5" aria-hidden />
        </button>
      )}
    </div>
  );
}
