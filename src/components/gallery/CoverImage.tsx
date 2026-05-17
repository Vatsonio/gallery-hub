"use client";

import { useEffect, useRef } from "react";
import { usePhotoLoadProgress } from "./PageLoadProgress";

interface Props {
  src: string;
  /** Optional AVIF mirror — when present rendered as a <picture><source>. */
  avifSrc?: string | null;
  /** Alt text — kept empty by default because the album title sits above it. */
  alt?: string;
  className?: string;
}

/**
 * Cover hero <img> wrapper that also participates in the page-load
 * progress bar. The cover is the largest single asset on the share page
 * (often a 2400×1600 AVIF) so it pulls outsized weight in the user's
 * perception of "is this thing done loading yet?". Counting it alongside
 * the first row of grid tiles keeps the progress bar honest.
 *
 * Server-only callers can keep using a plain <img> — this client wrapper
 * is the integration point with the progress context.
 */
export default function CoverImage({ src, avifSrc, alt = "", className }: Props) {
  const progress = usePhotoLoadProgress();
  const reportedRef = useRef(false);
  const imgRef = useRef<HTMLImageElement>(null);

  useEffect(() => {
    // Cover registers on TWO channels: the progress-bar counter (so the
    // top-of-viewport bar counts it as one of N), and the splash-overlay
    // cover gate (so PageSplash knows it has to wait for the LCP image
    // before fading out). Both calls are idempotent.
    progress.register();
    progress.registerCover();
    // Cached-image race: if the cover was served from preload (rel=preload
    // with as=image in the share page head) it can already be `complete`
    // by the time React attaches onLoad. Without this manual check the
    // event never fires and the progress bar freezes at (N-1)/N forever.
    // See PhotoTile for the same workaround on grid tiles.
    const el = imgRef.current;
    if (el && el.complete && !reportedRef.current) {
      reportedRef.current = true;
      progress.reportLoaded();
      progress.reportCoverLoaded();
    }
    // Stable api — see PhotoTile for the same rationale.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function onResolved(): void {
    if (reportedRef.current) return;
    reportedRef.current = true;
    progress.reportLoaded();
    progress.reportCoverLoaded();
  }

  return (
    <picture>
      {avifSrc ? <source srcSet={avifSrc} type="image/avif" /> : null}
      <img
        ref={imgRef}
        src={src}
        alt={alt}
        fetchPriority="high"
        decoding="sync"
        onLoad={onResolved}
        onError={onResolved}
        className={className}
      />
    </picture>
  );
}
