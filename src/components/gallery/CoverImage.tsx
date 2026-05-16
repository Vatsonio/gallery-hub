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

  useEffect(() => {
    progress.register();
    // Stable api — see PhotoTile for the same rationale.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function onResolved(): void {
    if (reportedRef.current) return;
    reportedRef.current = true;
    progress.reportLoaded();
  }

  return (
    <picture>
      {avifSrc ? <source srcSet={avifSrc} type="image/avif" /> : null}
      <img
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
