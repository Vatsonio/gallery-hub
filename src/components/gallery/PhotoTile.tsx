"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import HeartBurst from "./HeartBurst";
import HeartOverlay from "./HeartOverlay";
import { toggleFavorite } from "@/app/a/[token]/_actions";
import { startViewTransition, setViewTransitionName } from "@/lib/view-transition";
import { usePhotoLoadProgress } from "./PageLoadProgress";

interface Props {
  token: string;
  photoId: string;
  href: string;
  webUrl: string;
  /**
   * Optional AVIF mirror of the web variant. When present we render a
   * <picture> with AVIF first so AVIF-capable browsers save ~50% of
   * bytes; everywhere else falls back to webUrl automatically.
   */
  avifUrl?: string | null;
  /**
   * Optional responsive srcSet (`"<url> 400w, <url> 800w, <url> 1600w"`).
   * When present the browser picks the most appropriate width for the
   * actual layout box × DPR — mobile saves ~75% bytes vs always shipping
   * 1600w. Pair with `sizes` (defaults to the tile's CSS width).
   */
  srcSet?: string | null;
  /**
   * `sizes` attribute hint for srcSet matching. Defaults to a sensible
   * approximation of justified-row tile widths — pass an override at
   * the call site when the layout shape is different (e.g. selections).
   */
  sizes?: string;
  /** flex-basis style for justified-row layout. */
  flexStyle: React.CSSProperties;
  initialFavorited: boolean;
  /** Index within the grid — used to stagger the fade-in animation. */
  index?: number;
  /** Visual size: justified-row tiles use object-cover. */
  className?: string;
  /**
   * Loading hint. Maps to the three combinations the gallery actually
   * uses:
   *
   *   - `"high"` — above-the-fold tile. fetchPriority=high, loading=eager,
   *     decoding=sync. Reserve for the first ~32 tiles.
   *   - `"low"`  — below-the-fold tile, but still eager: fetchPriority=low,
   *     loading=eager, decoding=async. The browser starts the request
   *     immediately, but queues it behind high-priority work. By the time
   *     the user scrolls, the tile is already painted. Costs no extra
   *     bandwidth on a viewer who scrolls anyway; the only cost is that
   *     a viewer who never scrolls below the fold paid for the bytes.
   *   - `"lazy"` — opt-out for hidden / off-route consumers. Only registers
   *     with the page-load progress when explicitly above-the-fold.
   *
   * Defaults to `"lazy"` so any unaudited callsite keeps the old
   * memory-friendly behavior. The share-page renderer always passes an
   * explicit value.
   */
  priority?: "high" | "low" | "lazy";
  /**
   * Pre-decoded ThumbHash PNG (as a data: URL). Rendered behind the
   * real image and faded out via onLoad so users see a blurry preview
   * instantly instead of the empty bg-white/5 placeholder.
   */
  thumbhashDataUrl?: string | null;
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
  avifUrl,
  srcSet,
  // Default sizes hint: ~50vw at the mobile breakpoint (2 photos per row),
  // ~33vw on tablets, ~25vw on desktop. Conservative enough that the
  // browser doesn't downshift below the actual rendered width on retina
  // displays; aggressive enough that the 400w variant gets selected on
  // small viewports.
  sizes = "(max-width: 640px) 50vw, (max-width: 1024px) 33vw, 25vw",
  flexStyle,
  initialFavorited,
  index = 0,
  className,
  priority = "lazy",
  thumbhashDataUrl,
}: Props) {
  // Only above-the-fold tiles ("high") count toward the page-splash /
  // progress bar critical-render set. Below-the-fold tiles ("low") still
  // download eagerly so they're ready when the user scrolls, but their
  // load timing must not gate the splash dismiss — we'd be holding the
  // splash for tiles the user can't see.
  const isAboveFold = priority === "high";
  // Browser hints — see the Props.priority docblock for the matrix.
  const loadingHint = priority === "lazy" ? "lazy" : "eager";
  const decodingHint = priority === "high" ? "sync" : "async";
  const fetchPriorityHint =
    priority === "high" ? "high" : priority === "low" ? "low" : "auto";
  const router = useRouter();
  const [favorited, setFavorited] = useState(initialFavorited);
  const [burst, setBurst] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [, startTransition] = useTransition();
  const inflight = useRef(false);
  const pendingNavTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastTouchTapAt = useRef(0);
  const imgRef = useRef<HTMLImageElement>(null);
  // Only above-the-fold tiles register with the page-load progress bar.
  // Lazy tiles further down may never enter the viewport, which would
  // freeze the bar below 100% indefinitely.
  const progress = usePhotoLoadProgress();
  const reportedRef = useRef(false);

  useEffect(() => {
    return () => {
      if (pendingNavTimer.current) clearTimeout(pendingNavTimer.current);
    };
  }, []);

  useEffect(() => {
    if (isAboveFold) progress.register();
    // Cached-image race: when the browser already has the image in
    // memory/disk cache, the <img> can be `.complete === true` before
    // React attaches the onLoad listener. The onLoad event never fires,
    // the resolved counter never increments, the opacity transition
    // never runs, and the tile stays invisible behind the thumbhash.
    // We flip `loaded` for every tile (above-fold or not) and additionally
    // report progress for above-the-fold tiles. We don't gate on
    // `naturalWidth > 0` because a cached 404 still counts as resolved
    // (matches the onError path below).
    const el = imgRef.current;
    if (el && el.complete && !reportedRef.current) {
      reportedRef.current = true;
      setLoaded(true);
      if (isAboveFold) progress.reportLoaded();
    }
    // `register` and `reportLoaded` come from a stable useMemo in the
    // provider — re-running this effect on identity churn would
    // double-count, so we intentionally pass an empty dep array. The
    // provider api is referentially stable for the page lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Single shared callback for onLoad/onError so a broken URL still
  // increments the resolved counter — otherwise one 404 would freeze
  // the bar. Also guarded with reportedRef so the cached-image fast
  // path in the mount effect above cannot double-count when a delayed
  // onLoad fires later in the same tick.
  function onImgResolved(): void {
    setLoaded(true);
    if (!isAboveFold) return;
    if (reportedRef.current) return;
    reportedRef.current = true;
    progress.reportLoaded();
  }

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
    // Tag the tile <img> with a unique view-transition-name so a
    // supporting browser can morph it into the lightbox hero. Only the
    // currently-clicked tile gets the name (set right before navigation,
    // cleared on unmount via cleanup ref) — applying it to every tile
    // would trigger duplicate-name warnings.
    const cleanup = setViewTransitionName(imgRef.current, `photo-${photoId}`);
    startViewTransition(() => {
      router.push(href);
    });
    // Schedule cleanup well after the transition would have finished.
    // Even if the user navigates back before then, React unmount will
    // null the style anyway.
    window.setTimeout(cleanup, 800);
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
      {thumbhashDataUrl ? (
        <img
          src={thumbhashDataUrl}
          alt=""
          aria-hidden
          draggable={false}
          className={`pointer-events-none absolute inset-0 h-full w-full object-cover transition-opacity duration-300 ${loaded ? "opacity-0" : "opacity-100"}`}
        />
      ) : null}
      <picture>
        {avifUrl ? <source srcSet={avifUrl} type="image/avif" /> : null}
        <img
          ref={imgRef}
          src={webUrl}
          srcSet={srcSet ?? undefined}
          sizes={srcSet ? sizes : undefined}
          alt=""
          loading={loadingHint}
          decoding={decodingHint}
          fetchPriority={fetchPriorityHint}
          draggable={false}
          onLoad={onImgResolved}
          onError={onImgResolved}
          className={`relative h-full w-full object-cover transition-[opacity,transform] duration-300 ease-out sm:group-hover:scale-[1.04] ${thumbhashDataUrl && !loaded ? "opacity-0" : "opacity-100"}`}
        />
      </picture>
      <HeartBurst trigger={burst} />
      <HeartOverlay favorited={favorited} onClick={onHeartClick} />
    </div>
  );
}
