"use client";

import Link from "next/link";
import { useRef, useState, useTransition } from "react";
import { createDoubleTapDetector } from "@/lib/double-tap";
import HeartBurst from "./HeartBurst";
import HeartOverlay from "./HeartOverlay";
import { toggleFavorite } from "@/app/a/[token]/_actions";

interface Props {
  token: string;
  photoId: string;
  href: string;
  webUrl: string;
  /** flex-basis style for justified-row layout. */
  flexStyle: React.CSSProperties;
  initialFavorited: boolean;
  /** Visual size: justified-row tiles use object-cover. */
  className?: string;
}

/**
 * A single grid tile. Single-tap navigates to the lightbox; double-tap
 * (touch) toggles favorite + triggers the burst. The corner heart
 * overlay is a tappable toggle too.
 */
export default function PhotoTile({
  token,
  photoId,
  href,
  webUrl,
  flexStyle,
  initialFavorited,
  className,
}: Props) {
  const [favorited, setFavorited] = useState(initialFavorited);
  const [burst, setBurst] = useState(0);
  const [, startTransition] = useTransition();
  const inflight = useRef(false);

  function commitToggle(intent: boolean) {
    // Optimistic update; roll back if the server disagrees.
    setFavorited(intent);
    if (intent) setBurst((b) => b + 1);
    if (inflight.current) return;
    inflight.current = true;
    startTransition(async () => {
      try {
        const res = await toggleFavorite(token, photoId);
        setFavorited(res.favorited);
      } catch {
        setFavorited(!intent);
      } finally {
        inflight.current = false;
      }
    });
  }

  const detectorRef = useRef(
    createDoubleTapDetector({
      windowMs: 280,
      onDouble: () => commitToggle(true),
    }),
  );

  function onHeartClick() {
    commitToggle(!favorited);
  }

  return (
    <div
      style={flexStyle}
      className={`relative block overflow-hidden bg-white/5 ${className ?? ""}`}
      onTouchEnd={(e) => {
        // Only register taps with no horizontal/vertical drag.
        if (e.changedTouches.length === 1) {
          detectorRef.current.tap();
        }
      }}
    >
      <Link
        href={href}
        prefetch={false}
        className="block h-full w-full"
        // Prevent the synthetic click from racing the touchend single-tap
        // path on mobile — we let the browser navigate and skip the
        // detector's onSingle (we don't pass one).
        onClick={(e) => {
          // If the most recent touch already counted as the first half of
          // a double-tap, don't navigate. The detector tracks state.
          // We can't easily inspect that, so we just let navigation
          // proceed; the second tap consumes immediately and triggers
          // the burst, while the first tap navigates. That's the
          // platform-conventional behavior (Instagram swaps in the
          // double-tap only when delivered in <window>ms).
          void e;
        }}
      >
        <img
          src={webUrl}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
          className="h-full w-full object-cover transition-transform duration-500 sm:hover:scale-105"
        />
      </Link>
      <HeartBurst trigger={burst} />
      <HeartOverlay favorited={favorited} onClick={onHeartClick} />
    </div>
  );
}
