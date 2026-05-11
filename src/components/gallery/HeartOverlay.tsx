"use client";

import { Heart } from "lucide-react";
import { cn } from "@/lib/utils";

interface Props {
  favorited: boolean;
  /** Optional click handler. If omitted the overlay is purely decorative. */
  onClick?: (e: React.MouseEvent) => void;
  className?: string;
  /** Smaller variant for grid tile corners. */
  size?: "sm" | "md";
}

/**
 * Small corner indicator for a grid tile.
 * Filled rose heart when favorited, outline ghost otherwise.
 */
export default function HeartOverlay({
  favorited,
  onClick,
  className,
  size = "sm",
}: Props) {
  const dim = size === "sm" ? "h-7 w-7" : "h-9 w-9";
  const icon = size === "sm" ? "h-3.5 w-3.5" : "h-4 w-4";

  // The `key` flips on toggle so the pulse animation replays on each
  // state change (filled → outlined or vice versa).
  const inner = (
    <Heart
      key={favorited ? "f" : "o"}
      className={cn(icon, "transition heart-pulse-anim")}
      fill={favorited ? "#ff4d6d" : "none"}
      color={favorited ? "#ff4d6d" : "rgba(255,255,255,0.85)"}
      strokeWidth={2}
    />
  );

  if (!onClick) {
    return (
      <span
        aria-hidden
        className={cn(
          "pointer-events-none absolute right-1.5 top-1.5 inline-flex items-center justify-center rounded-full bg-black/40 backdrop-blur-sm",
          dim,
          className,
        )}
      >
        {inner}
      </span>
    );
  }

  return (
    <button
      type="button"
      aria-label={favorited ? "Remove from favorites" : "Add to favorites"}
      aria-pressed={favorited}
      onClick={(e) => {
        e.stopPropagation();
        e.preventDefault();
        onClick(e);
      }}
      className={cn(
        "absolute right-1.5 top-1.5 inline-flex items-center justify-center rounded-full bg-black/50 backdrop-blur-sm text-white hover:bg-black/70 active:scale-95 transition cursor-pointer",
        dim,
        className,
      )}
    >
      {inner}
    </button>
  );
}
