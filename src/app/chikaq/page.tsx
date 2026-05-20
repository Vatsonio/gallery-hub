import Link from "next/link";
import { redirect } from "next/navigation";
import {
  Activity,
  ArrowUpRight,
  Bell,
  Camera,
  Database,
  Download,
  Eye,
  HardDrive,
  Heart,
  Images,
  LogOut,
  Shield,
  Sparkles,
  TrendingUp,
} from "lucide-react";
import { requireAdminSessionFromCookies } from "@/lib/auth-check";
import {
  loadInsightsStats,
  loadRecentActivity24h,
  loadTileSparklines,
  loadTopAlbums,
  loadViewsTrend,
  parseChikaqPeriod,
  periodToDays,
  type ChikaqPeriod,
  type RecentActivityRow,
  type ViewsTrendPoint,
} from "@/lib/widgetQuery";
import { getStorageUsage, type StorageUsage } from "@/lib/storage-monitor";
import { logoutAction } from "@/app/admin/logout/actions";
import { formatBytes as fmtBytes, formatCount } from "@/lib/format";
import { AnimatedStatTile } from "@/components/chikaq/AnimatedStatTile";
import { PeriodSwitcher } from "@/components/chikaq/PeriodSwitcher";
import { RefreshedTimer } from "@/components/chikaq/RefreshedTimer";
import { LiveRelativeTime } from "@/components/chikaq/LiveRelativeTime";

export const dynamic = "force-dynamic";

// Reuse the smart byte formatter for tooltips that still need a string
// representation; the tile component already calls fmtBytes internally.
function formatBytes(bytes: number): string {
  return fmtBytes(bytes);
}

/**
 * Zero-fill the window so the sparkline has one point per day, not just
 * the days that recorded a view. Keeps the trend line honest about idle
 * days. Accepts a configurable number of days so the period switcher can
 * widen the window.
 */
function fillDays(points: ViewsTrendPoint[], days: number): ViewsTrendPoint[] {
  const map = new Map(points.map((p) => [p.day, p.views] as const));
  const out: ViewsTrendPoint[] = [];
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - i);
    const key = d.toISOString().slice(0, 10);
    out.push({ day: key, views: map.get(key) ?? 0 });
  }
  return out;
}

/**
 * Minimal SVG sparkline. Rendered server-side, no client JS — the dashboard
 * is admin-only so we keep its hydration cost as close to zero as we can.
 *
 * `gradientId` lets multiple sparklines coexist on a page without colliding
 * on the <defs> `id` attribute. Pass a stable per-instance id from the caller.
 */
function Sparkline({
  points,
  label,
  height = 80,
  gradientId = "sparkfill",
}: {
  points: ViewsTrendPoint[];
  label: string;
  height?: number;
  gradientId?: string;
}): React.JSX.Element {
  const max = Math.max(1, ...points.map((p) => p.views));
  const w = 360;
  const h = height;
  const stepX = points.length > 1 ? w / (points.length - 1) : w;
  const coords = points.map((p, i) => {
    const x = i * stepX;
    const y = h - (p.views / max) * h;
    return { x, y };
  });
  const d = coords
    .map((c, i) => `${i === 0 ? "M" : "L"} ${c.x.toFixed(1)} ${c.y.toFixed(1)}`)
    .join(" ");
  const area = `M 0 ${h} ${coords
    .map((c) => `L ${c.x.toFixed(1)} ${c.y.toFixed(1)}`)
    .join(" ")} L ${w} ${h} Z`;
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      className="w-full h-full"
      role="img"
      aria-label={label}
    >
      <defs>
        <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor="#ff4d6d" stopOpacity="0.35" />
          <stop offset="100%" stopColor="#ff4d6d" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${gradientId})`} />
      <path d={d} fill="none" stroke="#ff4d6d" strokeWidth="1.5" />
    </svg>
  );
}

function ActivityRow({ row }: { row: RecentActivityRow }): React.JSX.Element {
  const Icon = row.kind === "favorite" ? Heart : row.kind === "download" ? Download : Eye;
  const tint =
    row.kind === "favorite"
      ? "text-rose-accent"
      : row.kind === "download"
        ? "text-amber-300"
        : "text-text-muted";
  return (
    <li className="flex items-center gap-3 px-4 py-3 border-b border-line last:border-b-0 hover:bg-bg-card/40 transition">
      <Icon className={`size-4 ${tint}`} />
      <span className="text-sm text-text/90">
        {row.viewer_id_short}
        {row.detail ? <span className="text-text-muted"> · {row.detail}</span> : null}
      </span>
      <span className="text-sm text-text-muted">· {row.album_title}</span>
      <span className="ml-auto text-xs text-text-muted/70 tabular-nums">
        <LiveRelativeTime iso={row.at} />
      </span>
    </li>
  );
}

function relativeTime(d: Date): string {
  // Retained for the StorageCard subtitle helper which uses the same
  // tier definitions. Kept inline because formatRelativeTime accepts a
  // Date instance directly and this thin wrapper preserves the old API.
  const diff = Date.now() - d.getTime();
  const min = Math.round(diff / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.round(h / 24);
  return `${days}d ago`;
}

interface PageProps {
  // Next.js 15 passes searchParams as a Promise to async server components.
  searchParams?: Promise<{ period?: string }>;
}

function periodLabel(period: ChikaqPeriod): string {
  switch (period) {
    case "7d": return "Last 7 days";
    case "30d": return "Last 30 days";
    case "90d": return "Last 90 days";
    case "all": return "All time";
  }
}

function sparklineDaysFor(period: ChikaqPeriod): number {
  // The "all" case is capped to 365 days client-side; sparklines need a
  // bounded zero-fill window so they don't try to render thousands of bars.
  const days = periodToDays(period);
  return days ?? 90;
}

export default async function ChikaqPage({ searchParams }: PageProps): Promise<React.JSX.Element> {
  const auth = await requireAdminSessionFromCookies();
  if (!auth.ok) redirect("/admin/login?next=/chikaq");

  const sp = (await searchParams) ?? {};
  const period: ChikaqPeriod = parseChikaqPeriod(sp.period ?? null);
  const days = periodToDays(period);

  // Storage usage walks the bucket — guard it so a slow/broken MinIO can't
  // 500 the whole dashboard. Failure → null and the Storage card renders a
  // diagnostic stub instead.
  const storagePromise: Promise<StorageUsage | null> = getStorageUsage().catch((err) => {
    console.error("[chikaq] storage usage failed", err);
    return null;
  });
  const [stats, trendRaw, topAlbums, activity, storage, tileSeries] = await Promise.all([
    loadInsightsStats(),
    loadViewsTrend(days),
    loadTopAlbums(5, days),
    loadRecentActivity24h(20),
    storagePromise,
    loadTileSparklines(days),
  ]);
  const fillCount = sparklineDaysFor(period);
  const trend = fillDays(trendRaw, fillCount);
  const totalViews = trend.reduce((s, p) => s + p.views, 0);
  // Window-relative comparison: split the filled trend in half and compare
  // the back half against the front half. For "7d" that's "last 4 days vs
  // prior 3"; for "all" we use whatever was filled.
  const half = Math.floor(trend.length / 2);
  const prevHalf = trend.slice(0, half).reduce((s, p) => s + p.views, 0);
  const lastHalf = trend.slice(half).reduce((s, p) => s + p.views, 0);
  const deltaPct = prevHalf === 0 ? null : Math.round(((lastHalf - prevHalf) / prevHalf) * 100);

  const dashboardUrl = process.env.POSTHOG_DASHBOARD_URL ?? "";
  const posthogHost = process.env.POSTHOG_HOST ?? process.env.NEXT_PUBLIC_POSTHOG_HOST ?? "";
  const analyticsEnabled = (process.env.POSTHOG_KEY ?? "").length > 0;
  const renderedAtIso = new Date().toISOString();

  return (
    <div className="min-h-screen bg-bg text-text">
      {/* Standalone header — /chikaq lives outside the admin sidebar chrome. */}
      <header className="border-b border-line bg-bg-elevated">
        <div className="mx-auto max-w-6xl px-6 py-6 flex items-center gap-4">
          <Sparkles className="size-5 text-rose-accent" />
          <div className="flex-1">
            <h1 className="text-xl font-light tracking-tight">
              Привіт, Chikaq
            </h1>
            <p className="mt-1 flex items-center gap-3 text-xs text-text-muted">
              <span>{periodLabel(period)}</span>
              <span aria-hidden>·</span>
              <RefreshedTimer renderedAtIso={renderedAtIso} />
              <span aria-hidden>·</span>
              <span
                className={`inline-flex items-center gap-1.5 ${
                  analyticsEnabled ? "text-emerald-300" : "text-text-muted"
                }`}
                title={
                  analyticsEnabled
                    ? "POSTHOG_KEY is set — server-side events are being captured"
                    : "POSTHOG_KEY is empty — analytics is disabled"
                }
              >
                <span
                  className={`inline-block size-1.5 rounded-full ${
                    analyticsEnabled ? "bg-emerald-400" : "bg-text-muted"
                  }`}
                />
                {analyticsEnabled ? "Analytics live" : "Analytics off"}
              </span>
            </p>
          </div>
          <Link
            href="/admin/notifications"
            className="hidden sm:inline-flex items-center gap-1 rounded-lg border border-line bg-bg-card hover:bg-bg-elevated px-3 py-1.5 text-sm transition"
          >
            <Bell className="size-4" />
            Notification settings
          </Link>
          <Link
            href="/admin/albums"
            className="hidden sm:inline-flex items-center gap-1 rounded-lg border border-line bg-bg-card hover:bg-bg-elevated px-3 py-1.5 text-sm transition"
          >
            <Images className="size-4" />
            Back to admin
          </Link>
          <form action={logoutAction}>
            <button
              type="submit"
              className="inline-flex items-center gap-1 rounded-lg border border-line bg-bg-card hover:bg-bg-elevated px-3 py-1.5 text-sm transition cursor-pointer"
            >
              <LogOut className="size-4 text-text-muted" />
              Sign out
            </button>
          </form>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-8 space-y-8">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-medium uppercase tracking-widest text-text-muted">Overview</h2>
          <PeriodSwitcher defaultPeriod="30d" />
        </div>
        {/* Stat tiles — animated count-up on mount, sparklines beneath. */}
        <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <AnimatedStatTile
            label="Albums"
            value={stats.albums_total}
            icon={<Images className="size-4" />}
            emptyHint="No albums yet"
          />
          <AnimatedStatTile
            label="Photos"
            value={stats.photos_total}
            icon={<Camera className="size-4" />}
            sparkline={
              <Sparkline
                points={fillDays(tileSeries.photos, fillCount)}
                label="Photos created"
                height={32}
                gradientId="sparkfill-photos"
              />
            }
            emptyHint="No photos yet"
          />
          <AnimatedStatTile
            label="Storage"
            value={stats.storage_bytes}
            asBytes
            icon={<HardDrive className="size-4" />}
            sparkline={
              <Sparkline
                points={fillDays(tileSeries.storage, fillCount)}
                label="Storage growth"
                height={32}
                gradientId="sparkfill-storage"
              />
            }
            emptyHint="No data"
          />
          <AnimatedStatTile
            label={`Views (${period})`}
            value={totalViews}
            accent
            icon={<Eye className="size-4" />}
            sparkline={
              <Sparkline
                points={trend}
                label="Views trend"
                height={32}
                gradientId="sparkfill-views"
              />
            }
            emptyHint="No views yet — share a link to start tracking"
          />
        </section>

        {/* Trend + top albums */}
        <section className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          <Panel
            title="Views"
            subtitle={
              deltaPct === null
                ? "no baseline yet"
                : `${deltaPct >= 0 ? "↑" : "↓"} ${Math.abs(deltaPct)}% vs prior half`
            }
            Icon={TrendingUp}
          >
            <div className="h-20">
              <Sparkline points={trend} label={`Views, ${periodLabel(period)}`} height={80} gradientId="sparkfill-large" />
            </div>
            <p className="mt-2 text-2xl font-light text-text">
              {formatCount(totalViews)}{" "}
              <span className="text-sm text-text-muted">page views</span>
            </p>
          </Panel>
          <Panel title="Top albums by views" Icon={Eye}>
            {topAlbums.length === 0 ? (
              <p className="text-sm text-text-muted">
                No views recorded yet — share a link to start tracking.
              </p>
            ) : (
              <ul className="space-y-2">
                {topAlbums.map((a) => {
                  const maxViews = Math.max(...topAlbums.map((x) => x.views));
                  const pct = Math.round((a.views / Math.max(1, maxViews)) * 100);
                  return (
                    <li key={a.album_id} className="space-y-1">
                      <div className="flex items-center justify-between text-sm">
                        <span className="truncate pr-3 text-text/90">{a.title}</span>
                        <span className="tabular-nums text-text-muted">{formatCount(a.views)}</span>
                      </div>
                      <div className="h-1.5 rounded-full bg-bg-card overflow-hidden">
                        <div
                          className="h-full bg-rose-accent/80 transition-[width] duration-500 ease-out"
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </Panel>
        </section>

        {/* Recent activity */}
        <section>
          <Panel
            title="Recent activity"
            subtitle="last 24h, grouped per viewer"
            Icon={Activity}
            noBodyPadding
          >
            {activity.length === 0 ? (
              <p className="px-4 py-6 text-sm text-text-muted">
                Nothing yet — share a link and watch this fill up.
              </p>
            ) : (
              <ul className="divide-y divide-line">
                {activity.map((r, i) => (
                  <ActivityRow key={`${r.kind}-${r.at}-${i}`} row={r} />
                ))}
              </ul>
            )}
          </Panel>
        </section>

        {/* Storage usage */}
        <section>
          <StorageCard storage={storage} />
        </section>

        {/* PostHog embed */}
        <section>
          <Panel title="Deep analytics" subtitle="PostHog dashboard" Icon={Sparkles}>
            {dashboardUrl ? (
              <>
                <div className="rounded-lg overflow-hidden border border-line bg-black">
                  <iframe
                    src={dashboardUrl}
                    className="block w-full h-[640px]"
                    title="PostHog dashboard"
                    loading="lazy"
                  />
                </div>
                {posthogHost ? (
                  <a
                    href={posthogHost}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-3 inline-flex items-center gap-1 text-xs text-text-muted hover:text-rose-300 transition"
                  >
                    Open PostHog in a new tab
                    <ArrowUpRight className="size-3" />
                  </a>
                ) : null}
              </>
            ) : (
              <div className="rounded-lg border border-dashed border-line bg-bg-card/60 px-6 py-10 text-center">
                <p className="text-sm text-text-muted">
                  No PostHog dashboard configured.
                </p>
                <p className="mt-2 text-xs text-text-muted/80 max-w-md mx-auto">
                  Inside PostHog, build a dashboard, toggle{" "}
                  <span className="text-text/80">Share dashboard</span>, copy the
                  URL into the{" "}
                  <code className="px-1 py-0.5 rounded bg-bg-elevated">
                    POSTHOG_DASHBOARD_URL
                  </code>{" "}
                  env var, and reload.
                </p>
                {posthogHost ? (
                  <a
                    href={posthogHost}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-4 inline-flex items-center gap-1 rounded-lg bg-rose-accent hover:bg-rose-hover text-white px-4 py-2 text-sm font-medium transition"
                  >
                    Open PostHog
                    <ArrowUpRight className="size-4" />
                  </a>
                ) : null}
              </div>
            )}
          </Panel>
        </section>

        {/* Cloudflare */}
        <section>
          <Panel title="Security & traffic" Icon={Shield}>
            <p className="text-sm text-text-muted">
              DDoS, per-IP, and geo analytics live in Cloudflare. We surface a
              one-click jump-off here; the live numbers are managed there.
            </p>
            <a
              href="https://dash.cloudflare.com/?to=/:account/zones"
              target="_blank"
              rel="noopener noreferrer"
              className="mt-3 inline-flex items-center gap-1 rounded-lg bg-rose-accent hover:bg-rose-hover text-white px-4 py-2 text-sm font-medium transition"
            >
              Open Cloudflare dashboard
              <ArrowUpRight className="size-4" />
            </a>
          </Panel>
        </section>
      </main>
    </div>
  );
}

// Tile was replaced by AnimatedStatTile (client component, animated count-up
// with optional sparkline). The old Tile is intentionally removed.

function formatRelativeTimestamp(iso: string | null): string {
  if (!iso) return "never";
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "unknown";
  return `${relativeTime(at)} (${at.toISOString().replace("T", " ").slice(0, 19)} UTC)`;
}

function StorageCard({ storage }: { storage: StorageUsage | null }): React.JSX.Element {
  if (!storage) {
    return (
      <Panel title="Storage" subtitle="usage + backup status" Icon={Database}>
        <p className="text-sm text-text-muted">
          Could not read storage usage — check the gallery-app logs. MinIO or
          Postgres may be unreachable.
        </p>
      </Panel>
    );
  }
  const rows: Array<{ label: string; value: string; sub?: string }> = [
    {
      label: "MinIO bucket",
      value: formatBytes(storage.minio_bytes),
      sub: `${storage.minio_objects.toLocaleString()} objects`,
    },
    {
      label: "Photos (originals)",
      value: formatBytes(storage.photos_orig_bytes_sum),
      sub: "SUM(orig_bytes) FROM photos",
    },
    {
      label: "Postgres DB",
      value: formatBytes(storage.postgres_db_size_bytes),
      sub: "pg_database_size(current_database())",
    },
    {
      label: "Last backup",
      value: formatRelativeTimestamp(storage.last_backup_at),
      sub: "deploy/scripts/pg-backup.sh",
    },
    {
      label: "Last mirror",
      value: formatRelativeTimestamp(storage.last_mirror_at),
      sub: "deploy/scripts/minio-mirror.sh",
    },
  ];
  return (
    <Panel title="Storage" subtitle="usage + backup status" Icon={Database}>
      <ul className="divide-y divide-line text-sm">
        {rows.map((r) => (
          <li
            key={r.label}
            className="flex items-baseline justify-between gap-4 py-2 first:pt-0 last:pb-0"
          >
            <div className="min-w-0">
              <p className="text-text/90">{r.label}</p>
              {r.sub ? (
                <p className="text-[10px] text-text-muted/70">{r.sub}</p>
              ) : null}
            </div>
            <span className="tabular-nums text-text">{r.value}</span>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

function Panel({
  title,
  subtitle,
  Icon,
  children,
  noBodyPadding,
}: {
  title: string;
  subtitle?: string;
  Icon: typeof Camera;
  children: React.ReactNode;
  noBodyPadding?: boolean;
}): React.JSX.Element {
  return (
    <section className="rounded-xl border border-line bg-bg-elevated overflow-hidden">
      <header className="flex items-center gap-2 px-4 py-3 border-b border-line">
        <Icon className="size-4 text-text-muted" />
        <h2 className="text-sm font-medium tracking-wide">{title}</h2>
        {subtitle ? (
          <span className="text-xs text-text-muted">· {subtitle}</span>
        ) : null}
      </header>
      <div className={noBodyPadding ? "" : "px-4 py-4"}>{children}</div>
    </section>
  );
}
