"use client";

import { Heart } from "lucide-react";
import { useEffect, useState } from "react";

interface Props {
  /** A monotonically increasing counter; bumping it (re)triggers the burst. */
  trigger: number;
}

/**
 * Transient rose-tinted heart that scales + fades on double-tap.
 * Renders absolutely-positioned inside the parent (parent must be `relative`).
 */
export default function HeartBurst({ trigger }: Props) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (trigger === 0) return;
    setVisible(true);
    const t = setTimeout(() => setVisible(false), 650);
    return () => clearTimeout(t);
  }, [trigger]);

  if (!visible) return null;
  return (
    <div
      className="pointer-events-none absolute inset-0 flex items-center justify-center z-10"
      aria-hidden
    >
      <Heart
        className="h-24 w-24 sm:h-32 sm:w-32 drop-shadow-2xl heart-burst-anim"
        fill="#ff4d6d"
        color="#ffb6c1"
        strokeWidth={1.5}
      />
    </div>
  );
}
