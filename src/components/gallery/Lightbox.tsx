"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  X,
  Download,
  ChevronLeft,
  ChevronRight,
  Heart,
  Share2,
  Info,
} from "lucide-react";
import HeartBurst from "./HeartBurst";
import { createDoubleTapDetector } from "@/lib/double-tap";
import { toggleFavorite } from "@/app/a/[token]/_actions";

interface Props {
  token: string;
  photoId: string;
  photoUrl: string;
  originalUrl: string | null;
  downloadFilename: string;
  prevHref: string | null;
  nextHref: string | null;
  backHref: string;
  index: number;
  total: number;
  initialFavorited: boolean;
}

export default function Lightbox({
  token,
  photoId,
  photoUrl,
  originalUrl,
  downloadFilename,
  prevHref,
  nextHref,
  backHref,
  index,
  total,
  initialFavorited,
}: Props) {
  const router = useRouter();
  const downloadEl = useRef<HTMLAnchorElement>(null);
  const touchStart = useRef<{ x: number; y: number } | null>(null);
  const [touchTranslate, setTouchTranslate] = useState(0);
  const [favorited, setFavorited] = useState(initialFavorited);
  const [burst, setBurst] = useState(0);
  const [, startTransition] = useTransition();
  const inflight = useRef(false);

  useEffect(() => {
    setFavorited(initialFavorited);
  }, [initialFavorited, photoId]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        router.push(backHref);
      } else if (e.key === "ArrowLeft" && prevHref) {
        router.push(prevHref);
      } else if (e.key === "ArrowRight" && nextHref) {
        router.push(nextHref);
      } else if (e.key === "f" || e.key === "F") {
        commitToggle(!favorited);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router, backHref, prevHref, nextHref, favorited]);

  function commitToggle(intent: boolean) {
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

  function onTouchStart(e: React.TouchEvent) {
    const t = e.touches[0];
    touchStart.current = { x: t.clientX, y: t.clientY };
  }
  function onTouchMove(e: React.TouchEvent) {
    if (!touchStart.current) return;
    const dx = e.touches[0].clientX - touchStart.current.x;
    setTouchTranslate(dx);
  }
  function onTouchEnd(e: React.TouchEvent) {
    if (!touchStart.current) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - touchStart.current.x;
    const dy = t.clientY - touchStart.current.y;
    touchStart.current = null;
    setTouchTranslate(0);
    const absX = Math.abs(dx);
    const absY = Math.abs(dy);
    // Pure tap (<10px both axes) → double-tap detector.
    if (absX < 10 && absY < 10) {
      detectorRef.current.tap();
      return;
    }
    if (absY > absX && dy > 80) {
      router.push(backHref);
      return;
    }
    // ~50px threshold so accidental vertical scrolls don't trigger nav
    if (absX > 50 && absX > absY) {
      if (dx < 0 && nextHref) router.push(nextHref);
      else if (dx > 0 && prevHref) router.push(prevHref);
    }
  }

  function triggerDownload() {
    if (downloadEl.current) downloadEl.current.click();
  }

  function onLikeClick() {
    commitToggle(!favorited);
  }

  async function share() {
    const url = typeof window !== "undefined" ? window.location.href : "";
    if (typeof navigator !== "undefined" && "share" in navigator) {
      try {
        await navigator.share({ url });
        return;
      } catch {
        // user cancelled or share failed; fall through to clipboard
      }
    }
    try {
      await navigator.clipboard?.writeText(url);
      alert("Link copied");
    } catch {
      alert(url);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 bg-black flex items-center justify-center select-none"
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
    >
      {/* Relative wrapper so HeartBurst can overlay the image centered. */}
      <div className="relative max-h-screen max-w-full flex items-center justify-center">
        <img
          src={photoUrl}
          alt=""
          draggable={false}
          className="max-h-screen max-w-full object-contain transition-transform"
          style={{ transform: touchTranslate ? `translateX(${touchTranslate}px)` : undefined }}
          onDoubleClick={(e) => {
            // Desktop fallback for double-tap.
            e.preventDefault();
            commitToggle(true);
          }}
        />
        <HeartBurst trigger={burst} />
      </div>

      {/* Top bar: close + counter + info (placeholder) */}
      <div
        className="fixed top-0 inset-x-0 z-20 flex items-center justify-between px-4 py-3 bg-gradient-to-b from-black/70 to-transparent"
        style={{ paddingTop: "max(12px, env(safe-area-inset-top))" }}
      >
        <button
          aria-label="Close"
          onClick={() => router.push(backHref)}
          className="h-11 w-11 flex items-center justify-center rounded-full bg-white/10 backdrop-blur-md text-white hover:bg-white/20 transition"
        >
          <X className="h-5 w-5" aria-hidden />
        </button>
        <div className="text-sm text-white/90 tabular-nums tracking-wide">
          {index + 1} / {total}
        </div>
        <button
          aria-label="Info"
          onClick={() => {
            /* placeholder */
          }}
          className="h-11 w-11 flex items-center justify-center rounded-full bg-white/10 backdrop-blur-md text-white hover:bg-white/20 transition"
        >
          <Info className="h-5 w-5" aria-hidden />
        </button>
      </div>

      {/* Desktop-only side arrows */}
      {prevHref && (
        <button
          aria-label="Previous"
          onClick={() => router.push(prevHref)}
          className="hidden sm:flex absolute left-4 top-1/2 -translate-y-1/2 h-11 w-11 items-center justify-center rounded-full bg-black/50 backdrop-blur-md text-white hover:bg-black/70 transition"
        >
          <ChevronLeft className="h-5 w-5" aria-hidden />
        </button>
      )}
      {nextHref && (
        <button
          aria-label="Next"
          onClick={() => router.push(nextHref)}
          className="hidden sm:flex absolute right-4 top-1/2 -translate-y-1/2 h-11 w-11 items-center justify-center rounded-full bg-black/50 backdrop-blur-md text-white hover:bg-black/70 transition"
        >
          <ChevronRight className="h-5 w-5" aria-hidden />
        </button>
      )}

      {/* Desktop favorite + download in top-right (mobile uses bottom bar) */}
      <button
        aria-label={favorited ? "Remove from favorites" : "Add to favorites"}
        aria-pressed={favorited}
        onClick={onLikeClick}
        className="hidden sm:flex absolute right-4 h-11 w-11 items-center justify-center rounded-full bg-black/50 backdrop-blur-md text-white hover:bg-black/70 transition"
        style={{ top: "max(12px, env(safe-area-inset-top))" }}
      >
        <Heart
          className="h-5 w-5"
          fill={favorited ? "#ff4d6d" : "none"}
          color={favorited ? "#ff4d6d" : "currentColor"}
          aria-hidden
        />
      </button>
      {originalUrl && (
        <>
          <a
            ref={downloadEl}
            href={originalUrl}
            download={downloadFilename}
            className="hidden"
            aria-hidden
          />
          <button
            aria-label="Download"
            onClick={triggerDownload}
            className="hidden sm:flex absolute right-4 h-11 w-11 items-center justify-center rounded-full bg-black/50 backdrop-blur-md text-white hover:bg-black/70 transition"
            style={{ top: "max(64px, calc(env(safe-area-inset-top) + 64px))" }}
          >
            <Download className="h-5 w-5" aria-hidden />
          </button>
        </>
      )}

      {/* Mobile bottom bar: like / save / share */}
      <div
        className="fixed bottom-0 inset-x-0 z-20 flex items-center justify-around px-6 pt-4 bg-gradient-to-t from-black/80 to-transparent sm:hidden"
        style={{ paddingBottom: "max(20px, env(safe-area-inset-bottom))" }}
      >
        <button
          aria-label={favorited ? "Remove from favorites" : "Add to favorites"}
          aria-pressed={favorited}
          onClick={onLikeClick}
          className="h-11 w-11 flex items-center justify-center rounded-full bg-white/10 backdrop-blur-md text-white hover:bg-white/20 transition"
        >
          <Heart
            className="h-5 w-5"
            fill={favorited ? "#ff4d6d" : "none"}
            color={favorited ? "#ff4d6d" : "currentColor"}
            aria-hidden
          />
        </button>
        {originalUrl && (
          <button
            aria-label="Save"
            onClick={triggerDownload}
            className="h-11 w-11 flex items-center justify-center rounded-full bg-white/10 backdrop-blur-md text-white hover:bg-white/20 transition"
          >
            <Download className="h-5 w-5" aria-hidden />
          </button>
        )}
        <button
          aria-label="Share"
          onClick={share}
          className="h-11 w-11 flex items-center justify-center rounded-full bg-white/10 backdrop-blur-md text-white hover:bg-white/20 transition"
        >
          <Share2 className="h-5 w-5" aria-hidden />
        </button>
      </div>
    </div>
  );
}
