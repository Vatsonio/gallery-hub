"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
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
  /** Index within the grid — used to stagger the fade-in animation. */
  index?: number;
  /** Visual size: justified-row tiles use object-cover. */
  className?: string;
}

const DOUBLE_TAP_WINDOW_MS = 280;

/**
 * A single grid tile.
 *
 * On touch devices, we *defer* single-tap navigation by ~DOUBLE_TAP_WINDOW_MS
 * so a second tap can claim the gesture as a double-tap (favorite). The
 * root is a <div>, not a <Link>, because a real anchor click navigates
 * synchronously and steals the first tap before we can decide.
 *
 * On non-touch (desktop) pointer events, a single click navigates
 * immediately (no defer) — desktop has a native dblclick that the user
 * is unlikely to use here anyway, but we still wire it for parity.
 */
export default function PhotoTile({
  token,
  photoId,
  href,
  webUrl,
  flexStyle,
  initialFavorited,
  index = 0,
  className,
}: Props) {
  const router = useRouter();
  const [favorited, setFavorited] = useState(initialFavorited);
  const [burst, setBurst] = useState(0);
  const [, startTransition] = useTransition();
  const inflight = useRef(false);
  const pendingNavTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastTouchTapAt = useRef(0);

  useEffect(() => {
    return () => {
      if (pendingNavTimer.current) clearTimeout(pendingNavTimer.current);
    };
  }, []);

  function cancelPendingNav(): void {
    if (pendingNavTimer.current) {
      clearTimeout(pendingNavTimer.current);
      pendingNavTimer.current = null;
    }
  }

  function rememberReturnScroll(): void {
    if (typeof window === "undefined") return;
    try {
      sessionStorage.setItem(
        `gh:return-scroll:${token}`,
        JSON.stringify({ y: window.scrollY, photoId, at: Date.now() }),
      );
    } catch {
      // sessionStorage can throw in private modes; not fatal.
    }
  }

  function navigateToPhoto(): void {
    rememberReturnScroll();
    router.push(href);
  }

  function commitToggle(intent: boolean): void {
    // Optimistic update; reconcile with server response.
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

  function onHeartClick(): void {
    commitToggle(!favorited);
  }

  function handleTouchEnd(e: React.TouchEvent): void {
    // Only register single-finger taps without significant movement.
    if (e.changedTouches.length !== 1) return;
    // Prevent the synthetic mouse click that browsers fire ~300ms after
    // touchend. Desktop clicks (real mouse) still navigate via onClick.
    e.preventDefault();
    const now = Date.now();
    if (now - lastTouchTapAt.current <= DOUBLE_TAP_WINDOW_MS) {
      // Second tap — claim as double-tap.
      cancelPendingNav();
      lastTouchTapAt.current = 0;
      commitToggle(true);
      return;
    }
    lastTouchTapAt.current = now;
    cancelPendingNav();
    pendingNavTimer.current = setTimeout(() => {
      pendingNavTimer.current = null;
      lastTouchTapAt.current = 0;
      navigateToPhoto();
    }, DOUBLE_TAP_WINDOW_MS);
  }

  function handleClick(e: React.MouseEvent): void {
    // Touch path calls preventDefault on touchend so this never fires
    // for taps — guard anyway.
    if (e.defaultPrevented) return;
    // Defer navigation by the double-tap window so onDoubleClick has a
    // chance to claim the gesture as a favorite. onDoubleClick calls
    // cancelPendingNav() to abort the navigation. detail >= 2 means
    // this click is the second of a double — abort eagerly so the
    // navigation doesn't fire on the trailing edge.
    if (e.detail >= 2) {
      cancelPendingNav();
      return;
    }
    cancelPendingNav();
    pendingNavTimer.current = setTimeout(() => {
      pendingNavTimer.current = null;
      navigateToPhoto();
    }, DOUBLE_TAP_WINDOW_MS);
  }

  return (
    <div
      role="link"
      tabIndex={0}
      aria-label="Open photo"
      style={{ ...flexStyle, ["--i" as string]: String(Math.min(index, 60)) }}
      className={`photo-tile group relative block overflow-hidden bg-white/5 cursor-pointer select-none [-webkit-touch-callout:none] [-webkit-tap-highlight-color:transparent] ${className ?? ""}`}
      onTouchEnd={handleTouchEnd}
      onClick={handleClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          navigateToPhoto();
        }
      }}
      onDoubleClick={(e) => {
        // Desktop fallback — toggle on actual dblclick.
        e.preventDefault();
        cancelPendingNav();
        commitToggle(true);
      }}
    >
      <img
        src={webUrl}
        alt=""
        loading="lazy"
        decoding="async"
        draggable={false}
        className="h-full w-full object-cover transition-transform duration-500 ease-out sm:group-hover:scale-[1.04]"
      />
      <HeartBurst trigger={burst} />
      <HeartOverlay favorited={favorited} onClick={onHeartClick} />
    </div>
  );
}
