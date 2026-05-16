"use client";

import { useEffect, useState } from "react";
import { Calendar, Camera, Download, Eye, HardDrive, Heart } from "lucide-react";
import { formatBytes, formatCount } from "@/lib/format";
import { useCountUp, useCountUpInt } from "@/lib/useCountUp";

interface Props {
  photos: number;
  views: number;
  favorites: number;
  downloads: number;
  /** Bytes of all originals in this album. */
  storageBytes?: number;
  /** Bytes across the whole library — used for the relative-share bar. */
  libraryBytes?: number;
  /** Earliest taken_at, ISO. */
  shotFrom?: string | null;
  /** Latest taken_at, ISO. */
  shotTo?: string | null;
  /** Most-used camera label. */
  topCamera?: string | null;
  /** Percentage of EXIF-tagged photos shot with the top camera. */
  topCameraPct?: number | null;
}

/**
 * Stat card with hover-raise + animated number. Numeric values are
 * count-up animated; string values render immediately. The card lifts
 * with a soft rose outline on hover so the user gets a tactile cue
 * without distracting hover noise.
 */
function Card({
  label,
  value,
  rawValue,
  asBytes,
  accent,
  Icon,
  tooltip,
  trailing,
}: {
  label: string;
  /** Pre-formatted string fallback when there's no number to animate. */
  value?: string;
  /** Numeric value to count up to. When provided, `value` is ignored. */
  rawValue?: number;
  asBytes?: boolean;
  accent?: boolean;
  Icon: typeof Camera;
  tooltip?: string;
  /** Optional secondary line beneath the headline (chip, bar, etc.). */
  trailing?: React.ReactNode;
}): React.JSX.Element {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setArmed(true));
    return () => cancelAnimationFrame(id);
  }, []);
  const target = armed ? (rawValue ?? 0) : 0;
  const animated = useCountUp(target, { durationMs: 800 });
  const display = rawValue !== undefined
    ? (asBytes ? formatBytes(animated) : formatCount(Math.round(animated)))
    : (value ?? "");
  return (
    <div
      className="group relative flex flex-col gap-3 rounded-lg bg-zinc-900 p-4 ring-1 ring-white/5 transition-all duration-200 hover:ring-rose-400/30 hover:shadow-[0_0_0_1.5px_rgba(255,77,109,0.18)]"
      title={tooltip}
    >
      <div className="flex items-center gap-3">
        <div className={`rounded-md p-2 ${accent ? "bg-rose-500/15 text-rose-300" : "bg-zinc-800 text-zinc-400"}`}>
          <Icon className="h-4 w-4" aria-hidden />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-xs text-zinc-500">{label}</p>
          <p className={`tabular-nums text-xl font-light truncate ${accent ? "text-rose-300" : "text-white"}`}>
            {display}
          </p>
        </div>
      </div>
      {trailing && (
        <div className="text-xs text-zinc-500">{trailing}</div>
      )}
    </div>
  );
}

function formatShotRange(from: string | null | undefined, to: string | null | undefined): string | null {
  if (!from && !to) return null;
  const fmt = new Intl.DateTimeFormat("en-GB", { month: "short", day: "numeric" });
  if (from && to) {
    const f = new Date(from);
    const t = new Date(to);
    if (isNaN(f.getTime()) || isNaN(t.getTime())) return null;
    // Same UTC day → render once.
    if (Math.abs(t.getTime() - f.getTime()) < 86_400_000) return fmt.format(f);
    return `${fmt.format(f)} → ${fmt.format(t)}`;
  }
  const single = new Date((from || to) as string);
  if (isNaN(single.getTime())) return null;
  return fmt.format(single);
}

export function StatsStrip({
  photos,
  views,
  favorites,
  downloads,
  storageBytes,
  libraryBytes,
  shotFrom,
  shotTo,
  topCamera,
  topCameraPct,
}: Props): React.JSX.Element {
  const dateRange = formatShotRange(shotFrom, shotTo);
  const storagePct = storageBytes && libraryBytes && libraryBytes > 0
    ? Math.max(2, Math.min(100, Math.round((storageBytes / libraryBytes) * 100)))
    : null;

  // Camera chip animates the percentage up too — small touch but ties
  // the chip's visual cadence to the rest of the strip.
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setArmed(true));
    return () => cancelAnimationFrame(id);
  }, []);
  const animatedPct = useCountUpInt(armed ? (topCameraPct ?? 0) : 0, { durationMs: 800 });

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <Card
        label="Photos"
        rawValue={photos}
        Icon={Camera}
        trailing={
          topCamera ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-zinc-800/70 px-2 py-0.5 text-[10px] text-zinc-300">
              <Camera className="h-3 w-3 text-zinc-500" aria-hidden />
              <span className="truncate max-w-[10rem]">{topCamera}</span>
              {topCameraPct !== null && topCameraPct !== undefined && (
                <span className="tabular-nums text-zinc-500">({animatedPct}%)</span>
              )}
            </span>
          ) : (
            dateRange ? (
              <span className="inline-flex items-center gap-1 text-[10px] text-zinc-500">
                <Calendar className="h-3 w-3" aria-hidden />
                Shot {dateRange}
              </span>
            ) : null
          )
        }
      />
      <Card
        label="Views"
        rawValue={views}
        Icon={Eye}
        trailing={dateRange && topCamera ? (
          <span className="inline-flex items-center gap-1 text-[10px] text-zinc-500">
            <Calendar className="h-3 w-3" aria-hidden />
            Shot {dateRange}
          </span>
        ) : null}
      />
      <Card label="Favorites" rawValue={favorites} accent Icon={Heart} />
      <Card
        label={storageBytes !== undefined ? "Storage" : "Downloads"}
        rawValue={storageBytes !== undefined ? storageBytes : downloads}
        asBytes={storageBytes !== undefined}
        Icon={storageBytes !== undefined ? HardDrive : Download}
        tooltip={storageBytes !== undefined ? "Album originals total" : undefined}
        trailing={
          storageBytes !== undefined && storagePct !== null ? (
            <div className="flex items-center gap-2">
              <div className="h-1 flex-1 overflow-hidden rounded-full bg-zinc-800">
                <div
                  className="h-full rounded-full bg-rose-400/70 transition-[width] duration-500 ease-out"
                  style={{ width: `${storagePct}%` }}
                />
              </div>
              <span className="text-[10px] tabular-nums text-zinc-500">
                {storagePct}% of library
              </span>
            </div>
          ) : null
        }
      />
    </div>
  );
}
