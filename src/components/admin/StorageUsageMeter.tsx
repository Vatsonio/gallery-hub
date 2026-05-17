"use client";

interface Props {
  usedBytes: number;
  maxBytes: number;
  warningPct: number;
  photoCount: number;
}

function formatGB(bytes: number): string {
  const gb = bytes / 1_000_000_000;
  if (gb < 0.01) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  return `${gb.toFixed(2)} GB`;
}

export function StorageUsageMeter({
  usedBytes,
  maxBytes,
  warningPct,
  photoCount,
}: Props) {
  const safeMax = maxBytes > 0 ? maxBytes : 1;
  const rawPct = (usedBytes / safeMax) * 100;
  const pct = Math.min(100, rawPct);
  const overWarn = rawPct >= warningPct;
  const overMax = rawPct >= 100;

  const barColor = overMax
    ? "bg-red-500"
    : overWarn
      ? "bg-rose-400"
      : "bg-emerald-400";
  const numColor = overMax
    ? "text-red-400"
    : overWarn
      ? "text-rose-300"
      : "text-text";

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <p className={`text-2xl font-light tabular-nums ${numColor}`}>
            {formatGB(usedBytes)}{" "}
            <span className="text-text-muted text-base">
              of {(maxBytes / 1_000_000_000).toFixed(0)} GB
            </span>
          </p>
          <p className="text-xs text-text-muted mt-1">
            {photoCount.toLocaleString()} ready photo
            {photoCount === 1 ? "" : "s"}
          </p>
        </div>
        <p className={`text-sm tabular-nums ${numColor}`}>
          {rawPct.toFixed(1)}%
        </p>
      </div>
      <div className="h-3 w-full overflow-hidden rounded-full bg-bg-card ring-1 ring-line">
        <div
          className={`h-full transition-all ${barColor}`}
          style={{ width: `${pct}%` }}
          aria-valuenow={Math.round(rawPct)}
          aria-valuemin={0}
          aria-valuemax={100}
          role="progressbar"
        />
      </div>
      {overMax ? (
        <p className="text-xs text-red-400">
          Over capacity. Uploads may be blocked when the hard cap toggle is on.
        </p>
      ) : overWarn ? (
        <p className="text-xs text-rose-300">
          Approaching capacity (over {warningPct}% threshold).
        </p>
      ) : null}
    </div>
  );
}
