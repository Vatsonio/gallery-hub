// Presentation-layer formatters used by metrics, timers and stat tiles.
//
// These helpers are pure (no I/O, no Date.now() reads) and deterministic
// for a given input — that's deliberate. The dashboard renders many of
// them server-side, the upload widget renders them at 100ms cadence on
// the client, and tests rely on stable output across both. Locale is
// pinned to en-GB-u-nu-latn so thin-space grouping is consistent
// regardless of the user agent's UI language.

const NBSP_THIN = " "; // U+202F NARROW NO-BREAK SPACE — used as thousands separator.

/**
 * Group thousands with a narrow no-break space, matching the design spec
 * ("1 247" not "1,247"). Falls back to "0" for nullish / NaN inputs so we
 * never render a stray "NaN" or "undefined" in a stat tile.
 */
export function formatCount(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "0";
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(Math.trunc(value));
  // Manual grouping — Intl.NumberFormat with "narrowNbsp" support is
  // patchy across Node versions, and a hand-rolled three-digit chunker
  // gives us deterministic output for tests.
  const s = abs.toString();
  if (s.length <= 3) return sign + s;
  const parts: string[] = [];
  let i = s.length;
  while (i > 0) {
    const start = Math.max(0, i - 3);
    parts.unshift(s.slice(start, i));
    i = start;
  }
  return sign + parts.join(NBSP_THIN);
}

/**
 * Smart byte formatter. Picks KB / MB / GB so the rendered number stays
 * between 0.1 and 999.9. Uses 1000-based (decimal) units to match the
 * way photographers think about file sizes — a 25 MB RAW is 25 megabytes,
 * not 23.84 mebibytes. One decimal place once we leave bytes.
 */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return "0 B";
  const b = Math.max(0, bytes);
  if (b < 1000) return `${Math.round(b)} B`;
  if (b < 1_000_000) return `${(b / 1000).toFixed(1)} KB`;
  if (b < 1_000_000_000) return `${(b / 1_000_000).toFixed(1)} MB`;
  if (b < 1_000_000_000_000) return `${(b / 1_000_000_000).toFixed(2)} GB`;
  return `${(b / 1_000_000_000_000).toFixed(2)} TB`;
}

/**
 * Format a wall-clock duration as m:ss or h:mm:ss. NaN / negative inputs
 * collapse to "0:00" so a glitched timer never renders "-1:NaN". Inputs
 * larger than one hour rotate to the three-segment form.
 */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) {
    return "0:00";
  }
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = s.toString().padStart(2, "0");
  if (h > 0) {
    const mm = m.toString().padStart(2, "0");
    return `${h}:${mm}:${ss}`;
  }
  return `${m}:${ss}`;
}

/**
 * Throughput formatter for "MB/s" indicators. Re-uses formatBytes for the
 * numerator so the unit switches as throughput climbs (KB/s → MB/s → GB/s).
 * Suffixed with "/s" rather than "ps" — pilots and photographers both read
 * "/s" without hesitation.
 */
export function formatRate(bytesPerSecond: number | null | undefined): string {
  if (bytesPerSecond === null || bytesPerSecond === undefined || !Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) {
    return "0 B/s";
  }
  return `${formatBytes(bytesPerSecond)}/s`;
}

/**
 * Relative-time formatter for the activity feed and the "refreshed N seconds
 * ago" indicator. Accepts a Date or an ISO timestamp; `now` defaults to
 * Date.now() but is pure-pluggable so tests can pin the wall clock without
 * vi.useFakeTimers().
 */
export function formatRelativeTime(at: Date | string, now: number = Date.now()): string {
  const then = at instanceof Date ? at.getTime() : new Date(at).getTime();
  if (Number.isNaN(then)) return "unknown";
  const diff = now - then;
  if (diff < 0) return "in the future";
  const sec = Math.round(diff / 1000);
  if (sec < 5) return "just now";
  if (sec < 60) return `${sec} sec ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.round(h / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months} mo ago`;
  return `${Math.round(months / 12)}y ago`;
}

/**
 * Format an ETA as "~M:SS remaining" or "<1 sec remaining" near completion.
 * Returns null for non-finite / negative inputs so the caller can hide the
 * row instead of rendering a placeholder. This is what the upload chrome
 * uses to gate visibility of the ETA strip.
 */
export function formatEta(secondsRemaining: number | null | undefined): string | null {
  if (secondsRemaining === null || secondsRemaining === undefined || !Number.isFinite(secondsRemaining)) return null;
  if (secondsRemaining < 0) return null;
  if (secondsRemaining < 1) return "<1 sec remaining";
  return `~${formatDuration(secondsRemaining)} remaining`;
}
