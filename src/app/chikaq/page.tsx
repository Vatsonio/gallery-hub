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
import { requireAdminSessionFromCookies } from "@/lib/session";
import {
  loadInsightsStats,
  loadRecentActivity24h,
  loadTopAlbums30d,
  loadViewsTrend30d,
  type RecentActivityRow,
  type ViewsTrendPoint,
} from "@/lib/widgetQuery";
import { getStorageUsage, type StorageUsage } from "@/lib/storage-monitor";
import { logoutAction } from "@/app/admin/logout/actions";

export const dynamic = "force-dynamic";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const mb = bytes / 1_000_000;
  if (mb < 1) return `${(bytes / 1000).toFixed(0)} KB`;
  if (mb < 1000) return `${mb.toFixed(0)} MB`;
  return `${(mb / 1000).toFixed(1)} GB`;
}

/**
 * Zero-fill the 30-day window so the sparkline has 30 points, not just the
 * days that recorded a view. Keeps the trend line honest about idle days.
 */
function fill30Days(points: ViewsTrendPoint[]): ViewsTrendPoint[] {
  const map = new Map(points.map((p) => [p.day, p.views] as const));
  const out: ViewsTrendPoint[] = [];
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  for (let i = 29; i >= 0; i--) {
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
 */
function Sparkline({ points }: { points: ViewsTrendPoint[] }): React.JSX.Element {
  const max = Math.max(1, ...points.map((p) => p.views));
  const w = 360;
  const h = 80;
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
      className="w-full h-20"
      role="img"
      aria-label="Views trend, last 30 days"
    >
      <defs>
        <linearGradient id="sparkfill" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor="#ff4d6d" stopOpacity="0.35" />
          <stop offset="100%" stopColor="#ff4d6d" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill="url(#sparkfill)" />
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
  const when = new Date(row.at);
  const ago = relativeTime(when);
  return (
    <li className="flex items-center gap-3 px-4 py-3 border-b border-line last:border-b-0 hover:bg-bg-card/40 transition">
      <Icon className={`size-4 ${tint}`} />
      <span className="text-sm text-text/90">
        {row.viewer_id_short}
        {row.detail ? <span className="text-text-muted"> · {row.detail}</span> : null}
      </span>
      <span className="text-sm text-text-muted">· {row.album_title}</span>
      <span className="ml-auto text-xs text-text-muted/70 tabular-nums">{ago}</span>
    </li>
  );
}

function relativeTime(d: Date): string {
  const diff = Date.now() - d.getTime();
  const min = Math.round(diff / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.round(h / 24);
  return `${days}d ago`;
}

export default async function ChikaqPage(): Promise<React.JSX.Element> {
  const auth = await requireAdminSessionFromCookies();
  if (!auth.ok) redirect("/admin/login?next=/chikaq");

  // Storage usage walks the bucket — guard it so a slow/broken MinIO can't
  // 500 the whole dashboard. Failure → null and the Storage card renders a
  // diagnostic stub instead.
  const storagePromise: Promise<StorageUsage | null> = getStorageUsage().catch((err) => {
    console.error("[chikaq] storage usage failed", err);
    return null;
  });
  const [stats, trendRaw, topAlbums, activity, storage] = await Promise.all([
    loadInsightsStats(),
    loadViewsTrend30d(),
    loadTopAlbums30d(5),
    loadRecentActivity24h(20),
    storagePromise,
  ]);
  const trend = fill30Days(trendRaw);
  const totalViews = trend.reduce((s, p) => s + p.views, 0);
  const prev15 = trend.slice(0, 15).reduce((s, p) => s + p.views, 0);
  const last15 = trend.slice(15).reduce((s, p) => s + p.views, 0);
  const deltaPct = prev15 === 0 ? null : Math.round(((last15 - prev15) / prev15) * 100);

  const dashboardUrl = process.env.POSTHOG_DASHBOARD_URL ?? "";
  const refreshedAt = new Date().toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
  });

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
            <p className="text-xs text-text-muted">
              Last 30 days · refreshed {refreshedAt}
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
        {/* Stat tiles */}
        <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Tile
            label="Albums"
            value={stats.albums_total.toString()}
            Icon={Images}
          />
          <Tile
            label="Photos"
            value={stats.photos_total.toLocaleString()}
            Icon={Camera}
          />
          <Tile
            label="Storage"
            value={formatBytes(stats.storage_bytes)}
            Icon={HardDrive}
          />
          <Tile
            label="Views (30d)"
            value={totalViews.toLocaleString()}
            Icon={Eye}
            accent
          />
        </section>

        {/* Trend + top albums */}
        <section className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          <Panel
            title="Views"
            subtitle={
              deltaPct === null
                ? "no baseline yet"
                : `${deltaPct >= 0 ? "↑" : "↓"} ${Math.abs(deltaPct)}% vs prior 15 days`
            }
            Icon={TrendingUp}
          >
            <Sparkline points={trend} />
            <p className="mt-2 text-2xl font-light text-text">
              {totalViews.toLocaleString()}{" "}
              <span className="text-sm text-text-muted">page views</span>
            </p>
          </Panel>
          <Panel title="Top albums by views" Icon={Eye}>
            {topAlbums.length === 0 ? (
              <p className="text-sm text-text-muted">No views recorded yet.</p>
            ) : (
              <ul className="space-y-2">
                {topAlbums.map((a) => {
                  const maxViews = Math.max(...topAlbums.map((x) => x.views));
                  const pct = Math.round((a.views / Math.max(1, maxViews)) * 100);
                  return (
                    <li key={a.album_id} className="space-y-1">
                      <div className="flex items-center justify-between text-sm">
                        <span className="truncate pr-3 text-text/90">{a.title}</span>
                        <span className="tabular-nums text-text-muted">{a.views}</span>
                      </div>
                      <div className="h-1.5 rounded-full bg-bg-card overflow-hidden">
                        <div
                          className="h-full bg-rose-accent/80"
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
              <div className="rounded-lg overflow-hidden border border-line bg-black">
                <iframe
                  src={dashboardUrl}
                  className="block w-full h-[640px]"
                  title="PostHog dashboard"
                  loading="lazy"
                />
              </div>
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

function Tile({
  label,
  value,
  Icon,
  accent,
}: {
  label: string;
  value: string;
  Icon: typeof Camera;
  accent?: boolean;
}): React.JSX.Element {
  return (
    <div className="rounded-xl border border-line bg-bg-elevated p-4 flex items-center gap-3">
      <div
        className={`rounded-lg p-2 ${
          accent ? "bg-rose-accent/15 text-rose-accent" : "bg-bg-card text-text-muted"
        }`}
      >
        <Icon className="size-4" />
      </div>
      <div className="min-w-0">
        <p className="text-[10px] uppercase tracking-widest text-text-muted">{label}</p>
        <p
          className={`text-xl font-light truncate ${
            accent ? "text-rose-accent" : "text-text"
          }`}
        >
          {value}
        </p>
      </div>
    </div>
  );
}

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
