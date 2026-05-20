import Link from "next/link";
import {
  Activity,
  BarChart3,
  Database,
  Download,
  Eye,
  HardDrive,
  Heart,
  Users as UsersIcon,
} from "lucide-react";
import { requireOwner } from "@/lib/auth-check";
import {
  getStorageMetrics,
  getViewsMetrics,
  getFavoritesMetrics,
  getTopAlbums,
  getRecentExports,
  getSystemHealth,
} from "@/lib/metrics";
import { getDiskInfo, type DiskRow } from "@/lib/disk-info";
import { formatBytes, formatCount, formatRelativeTime } from "@/lib/format";
import { MetricsKpiTile } from "@/components/admin/MetricsKpiTile";
import { MetricsSparkline } from "@/components/admin/MetricsSparkline";

export const dynamic = "force-dynamic";

function pctDelta(curr: number, prior: number): number | null {
  if (prior === 0) return curr === 0 ? 0 : null;
  return ((curr - prior) / prior) * 100;
}

function formatAbsolute(iso: string | null): string {
  if (!iso) return "never";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "unknown";
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mi = String(d.getUTCMinutes()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
}

export default async function MetricsPage(): Promise<React.JSX.Element> {
  await requireOwner();

  const [storage, views, favorites, topAlbums, recentExports, health, disks] = await Promise.all([
    getStorageMetrics(),
    getViewsMetrics(),
    getFavoritesMetrics(),
    getTopAlbums(10),
    getRecentExports(20),
    getSystemHealth(),
    getDiskInfo(),
  ]);

  const delta = pctDelta(views.views7d, views.views7dPrior);

  return (
    <div className="p-6 max-w-screen-xl">
      <div className="flex items-center gap-3">
        <span className="grid h-9 w-9 place-items-center rounded-lg bg-rose-500/15 text-rose-300">
          <BarChart3 className="h-4 w-4" />
        </span>
        <div className="flex-1">
          <h1 className="text-2xl font-light text-white">Metrics</h1>
          <p className="text-sm text-text-muted">
            Operational health at a glance. PostHog still owns granular product analytics.
          </p>
        </div>
        <span
          className="rounded-full border border-line bg-bg-elevated px-3 py-1 font-mono text-[11px] text-text-muted"
          title="APP_VERSION baked into the running image"
        >
          v{process.env.APP_VERSION ?? "dev"}
        </span>
      </div>

      {/* Section A — KPIs */}
      <section className="mt-6 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <MetricsKpiTile
          label="Storage used"
          value={formatBytes(storage.bytes)}
          subLine={`${formatCount(storage.photos)} photos across ${formatCount(storage.albums)} albums`}
          icon={<HardDrive className="h-4 w-4" />}
        />
        <MetricsKpiTile
          label="Views (7d)"
          value={formatCount(views.views7d)}
          subLine={
            delta === null
              ? "no baseline yet"
              : `vs prior 7d (${formatCount(views.views7dPrior)})`
          }
          deltaPct={delta}
          icon={<Eye className="h-4 w-4" />}
          accent
        />
        <MetricsKpiTile
          label="Active viewers (7d)"
          value={formatCount(views.activeViewers7d)}
          subLine={`${formatCount(views.newViewers7d)} new this week`}
          icon={<UsersIcon className="h-4 w-4" />}
        />
        <MetricsKpiTile
          label="Favorites (7d)"
          value={formatCount(favorites.favorites7d)}
          subLine={`${formatCount(favorites.favoritesAllTime)} all-time`}
          icon={<Heart className="h-4 w-4" />}
        />
      </section>

      {/* Section B — Views over time */}
      <section className="mt-8">
        <header className="flex items-baseline justify-between mb-3">
          <h2 className="text-sm uppercase tracking-widest text-text-muted">
            Views over time
          </h2>
          <p className="text-xs text-text-muted">last 30 days</p>
        </header>
        <div className="rounded-xl border border-line bg-bg-elevated p-4">
          <div className="h-20">
            <MetricsSparkline
              points={views.viewsByDay30d}
              label="Daily page views, last 30 days"
            />
          </div>
          <div className="mt-2 flex items-center justify-between text-xs text-text-muted tabular-nums">
            <span>{views.viewsByDay30d[0]?.date ?? ""}</span>
            <span>
              total{" "}
              <span className="text-text">
                {formatCount(
                  views.viewsByDay30d.reduce((s, p) => s + p.count, 0),
                )}
              </span>
            </span>
            <span>{views.viewsByDay30d[views.viewsByDay30d.length - 1]?.date ?? ""}</span>
          </div>
        </div>
      </section>

      {/* Section C — Top albums */}
      <section className="mt-8">
        <header className="flex items-baseline justify-between mb-3">
          <h2 className="text-sm uppercase tracking-widest text-text-muted">
            Top albums
          </h2>
          <p className="text-xs text-text-muted">by views, last 30 days</p>
        </header>
        <div className="overflow-hidden rounded-xl border border-line bg-bg-elevated">
          <table className="w-full text-sm">
            <thead className="bg-bg-card text-text-muted">
              <tr>
                <th className="px-4 py-3 text-left font-medium">Title</th>
                <th className="px-4 py-3 text-right font-medium">Views (30d)</th>
                <th className="px-4 py-3 text-right font-medium">Favorites</th>
                <th className="px-4 py-3 text-right font-medium">Downloads</th>
                <th className="px-4 py-3 text-right font-medium">Created</th>
              </tr>
            </thead>
            <tbody className="text-text">
              {topAlbums.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-12 text-center text-text-muted">
                    No albums yet.
                  </td>
                </tr>
              ) : (
                topAlbums.map((a) => (
                  <tr key={a.id} className="border-t border-line">
                    <td className="px-4 py-3">
                      <Link
                        href={`/admin/albums/${a.slug}`}
                        className="text-text hover:text-rose-300 transition"
                      >
                        {a.title}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {formatCount(a.views30d)}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {formatCount(a.favoritesLifetime)}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {formatCount(a.downloadsLifetime)}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-text-muted">
                      {formatAbsolute(a.created_at)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* Section D — Recent exports */}
      <section className="mt-8">
        <header className="flex items-baseline justify-between mb-3">
          <h2 className="text-sm uppercase tracking-widest text-text-muted">
            Recent exports
          </h2>
          <p className="text-xs text-text-muted">last 20 downloads</p>
        </header>
        <div className="overflow-hidden rounded-xl border border-line bg-bg-elevated">
          <table className="w-full text-sm">
            <thead className="bg-bg-card text-text-muted">
              <tr>
                <th className="px-4 py-3 text-left font-medium">Album</th>
                <th className="px-4 py-3 text-left font-medium">Scope</th>
                <th className="px-4 py-3 text-left font-medium">Variant</th>
                <th className="px-4 py-3 text-right font-medium">Bytes</th>
                <th className="px-4 py-3 text-right font-medium">When</th>
              </tr>
            </thead>
            <tbody className="text-text">
              {recentExports.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-12 text-center text-text-muted">
                    No exports yet.
                  </td>
                </tr>
              ) : (
                recentExports.map((e) => (
                  <tr key={e.id} className="border-t border-line">
                    <td className="px-4 py-3 truncate max-w-[20rem]">
                      <Download className="inline size-3.5 mr-1.5 text-text-muted" />
                      {e.albumTitle}
                    </td>
                    <td className="px-4 py-3 text-text-muted">{e.scope}</td>
                    <td className="px-4 py-3 text-text-muted">{e.variant}</td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {formatBytes(e.bytes)}
                    </td>
                    <td
                      className="px-4 py-3 text-right tabular-nums text-text-muted"
                      title={formatAbsolute(e.created_at)}
                    >
                      {formatRelativeTime(e.created_at)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* Section E — System health */}
      <section className="mt-8 grid grid-cols-1 lg:grid-cols-2 gap-3">
        <div className="rounded-xl border border-line bg-bg-elevated p-5">
          <header className="flex items-center gap-2 mb-3">
            <Activity className="size-4 text-text-muted" />
            <h2 className="text-sm uppercase tracking-widest text-text-muted">
              Photo pipeline
            </h2>
          </header>
          <dl className="grid grid-cols-3 gap-3 text-sm">
            <div>
              <dt className="text-text-muted text-xs">Ready</dt>
              <dd className="text-xl font-light text-text tabular-nums">
                {formatCount(health.photosByStatus.ready)}
              </dd>
            </div>
            <div>
              <dt className="text-text-muted text-xs">Processing</dt>
              <dd className="text-xl font-light text-text tabular-nums">
                {formatCount(health.photosByStatus.processing)}
              </dd>
            </div>
            <div>
              <dt className="text-text-muted text-xs">Uploading</dt>
              <dd className="text-xl font-light text-text tabular-nums">
                {formatCount(health.photosByStatus.uploading)}
              </dd>
            </div>
          </dl>
          <p className="mt-3 text-[11px] text-text-muted/80">
            Worker pulse · last ready{" "}
            <span
              className="text-text/80"
              title={formatAbsolute(health.lastPhotoReadyAt)}
            >
              {health.lastPhotoReadyAt
                ? formatRelativeTime(health.lastPhotoReadyAt)
                : "never"}
            </span>
          </p>
        </div>

        <div className="rounded-xl border border-line bg-bg-elevated p-5">
          <header className="flex items-center gap-2 mb-3">
            <Activity className="size-4 text-text-muted" />
            <h2 className="text-sm uppercase tracking-widest text-text-muted">
              Notification queue
            </h2>
          </header>
          <dl className="grid grid-cols-3 gap-3 text-sm">
            <div>
              <dt className="text-text-muted text-xs">Queued</dt>
              <dd
                className={`text-xl font-light tabular-nums ${
                  health.notifications.queued > 50 ? "text-amber-300" : "text-text"
                }`}
              >
                {formatCount(health.notifications.queued)}
              </dd>
            </div>
            <div>
              <dt className="text-text-muted text-xs">Sent (24h)</dt>
              <dd className="text-xl font-light text-text tabular-nums">
                {formatCount(health.notifications.sent24h)}
              </dd>
            </div>
            <div>
              <dt className="text-text-muted text-xs">Failed (24h)</dt>
              <dd
                className={`text-xl font-light tabular-nums ${
                  health.notifications.failed24h > 0 ? "text-rose-300" : "text-text"
                }`}
              >
                {formatCount(health.notifications.failed24h)}
              </dd>
            </div>
          </dl>
          <p className="mt-3 text-[11px] text-text-muted/80">
            Persistent queue is normal at zero — failures here usually mean
            invalid Telegram credentials.
          </p>
        </div>

        <div className="rounded-xl border border-line bg-bg-elevated p-5">
          <header className="flex items-center gap-2 mb-3">
            <Database className="size-4 text-text-muted" />
            <h2 className="text-sm uppercase tracking-widest text-text-muted">
              view_events table
            </h2>
          </header>
          <dl className="grid grid-cols-2 gap-3 text-sm">
            <div>
              <dt className="text-text-muted text-xs">Rows (est.)</dt>
              <dd className="text-xl font-light text-text tabular-nums">
                {formatCount(health.viewEventsRows)}
              </dd>
            </div>
            <div>
              <dt className="text-text-muted text-xs">On disk</dt>
              <dd className="text-xl font-light text-text tabular-nums">
                {formatBytes(health.viewEventsBytes)}
              </dd>
            </div>
          </dl>
          <p className="mt-2 text-[10px] text-text-muted/80">
            pg_total_relation_size including indexes and TOAST.
          </p>
        </div>

        <div className="rounded-xl border border-line bg-bg-elevated p-5 lg:col-span-2">
          <header className="flex items-center gap-2 mb-3">
            <UsersIcon className="size-4 text-text-muted" />
            <h2 className="text-sm uppercase tracking-widest text-text-muted">
              Admin logins
            </h2>
          </header>
          <ul className="divide-y divide-line text-sm">
            {health.admins.map((a) => (
              <li
                key={a.id}
                className="flex items-baseline justify-between gap-4 py-2 first:pt-0 last:pb-0"
              >
                <div className="min-w-0">
                  <p className="text-text/90 truncate">
                    {a.name ?? a.email}
                    {a.name ? (
                      <span className="text-text-muted text-xs ml-2">{a.email}</span>
                    ) : null}
                  </p>
                  <p className="text-[10px] uppercase tracking-widest text-text-muted">
                    {a.role}
                  </p>
                </div>
                <span
                  className="text-xs text-text-muted tabular-nums"
                  title={formatAbsolute(a.last_login_at)}
                >
                  {a.last_login_at ? formatRelativeTime(a.last_login_at) : "never"}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* Section F — Filesystems visible to the gallery-app process */}
      <section className="mt-8">
        <h2 className="text-sm uppercase tracking-widest text-text-muted mb-3">
          Filesystems
        </h2>
        <DiskTable rows={disks} />
        <p className="mt-3 text-[11px] text-text-muted">
          What the gallery-app container sees. Mounted Docker volumes appear here when
          they are bind-mounted into the container — overlay-only paths are pseudo
          and hidden. On a Proxmox LXC without Docker this is the host&apos;s full mount
          table.
        </p>
      </section>
    </div>
  );
}

function DiskTable({ rows }: { rows: DiskRow[] }): React.JSX.Element {
  if (rows.length === 0) {
    return (
      <div className="rounded-2xl border border-line bg-bg-elevated p-6 text-sm text-text-muted">
        No filesystem info available in this runtime — df isn&apos;t on PATH and
        statfs() returned nothing. On Linux prod this should populate; on Windows
        dev it&apos;s expected to be empty.
      </div>
    );
  }
  return (
    <div className="overflow-x-auto rounded-2xl border border-line bg-bg-elevated">
      <table className="w-full text-sm">
        <thead className="bg-bg-card text-text-muted text-xs uppercase tracking-widest">
          <tr>
            <th className="px-4 py-2 text-left">Mount</th>
            <th className="px-4 py-2 text-left">Source</th>
            <th className="px-4 py-2 text-left">FS</th>
            <th className="px-4 py-2 text-right">Size</th>
            <th className="px-4 py-2 text-right">Used</th>
            <th className="px-4 py-2 text-right">Free</th>
            <th className="px-4 py-2 text-left">Usage</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <DiskRowView key={`${r.source}|${r.mount}`} row={r} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DiskRowView({ row }: { row: DiskRow }): React.JSX.Element {
  const meterColor =
    row.usePct >= 95
      ? "bg-rose-500"
      : row.usePct >= 80
        ? "bg-amber-500"
        : "bg-emerald-500";
  return (
    <tr className="border-t border-line">
      <td className="px-4 py-2 font-mono text-xs">{row.mount}</td>
      <td className="px-4 py-2 font-mono text-xs text-text-muted truncate max-w-[18rem]">
        {row.source}
      </td>
      <td className="px-4 py-2 text-xs text-text-muted">{row.fstype}</td>
      <td className="px-4 py-2 text-right tabular-nums">{formatBytes(row.totalBytes)}</td>
      <td className="px-4 py-2 text-right tabular-nums">{formatBytes(row.usedBytes)}</td>
      <td className="px-4 py-2 text-right tabular-nums text-text-muted">
        {formatBytes(row.availBytes)}
      </td>
      <td className="px-4 py-2">
        <div className="flex items-center gap-2">
          <div className="h-1.5 w-24 rounded-full bg-bg-card overflow-hidden">
            <div
              className={`h-full ${meterColor}`}
              style={{ width: `${Math.min(100, row.usePct)}%` }}
            />
          </div>
          <span className="text-xs tabular-nums text-text-muted">{row.usePct}%</span>
        </div>
      </td>
    </tr>
  );
}
