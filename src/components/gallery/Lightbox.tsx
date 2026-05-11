"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { X, Download, ChevronLeft, ChevronRight } from "lucide-react";

interface Props {
  photoUrl: string;
  originalUrl: string | null;
  downloadFilename: string;
  prevHref: string | null;
  nextHref: string | null;
  backHref: string;
}

export default function Lightbox({
  photoUrl,
  originalUrl,
  downloadFilename,
  prevHref,
  nextHref,
  backHref,
}: Props) {
  const router = useRouter();
  const downloadEl = useRef<HTMLAnchorElement>(null);
  const touchStart = useRef<{ x: number; y: number } | null>(null);
  const [touchTranslate, setTouchTranslate] = useState(0);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        router.push(backHref);
      } else if (e.key === "ArrowLeft" && prevHref) {
        router.push(prevHref);
      } else if (e.key === "ArrowRight" && nextHref) {
        router.push(nextHref);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [router, backHref, prevHref, nextHref]);

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
    if (absY > absX && dy > 80) {
      router.push(backHref);
      return;
    }
    if (absX > 60 && absX > absY) {
      if (dx < 0 && nextHref) router.push(nextHref);
      else if (dx > 0 && prevHref) router.push(prevHref);
    }
  }

  function triggerDownload() {
    if (downloadEl.current) downloadEl.current.click();
  }

  return (
    <div
      className="fixed inset-0 z-50 bg-black flex items-center justify-center select-none"
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
    >
      <img
        src={photoUrl}
        alt=""
        draggable={false}
        className="max-h-screen max-w-full object-contain transition-transform"
        style={{ transform: touchTranslate ? `translateX(${touchTranslate}px)` : undefined }}
      />

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

      <div className="absolute right-4 top-4 flex items-center gap-2">
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
              className="h-11 w-11 flex items-center justify-center rounded-full bg-black/50 backdrop-blur-md text-white hover:bg-black/70 transition"
            >
              <Download className="h-5 w-5" aria-hidden />
            </button>
          </>
        )}
        <button
          aria-label="Close"
          onClick={() => router.push(backHref)}
          className="h-11 w-11 flex items-center justify-center rounded-full bg-black/50 backdrop-blur-md text-white hover:bg-black/70 transition"
        >
          <X className="h-5 w-5" aria-hidden />
        </button>
      </div>
    </div>
  );
}
