"use client";

import { useCallback, useEffect, useState } from "react";
import { X, Loader2, MapPin, Lock } from "lucide-react";
import { formatCount } from "@/lib/format";

interface ViewerRow {
  ip: string;
  country: string | null;
  city: string | null;
  region: string | null;
  view_count: number;
  viewers: number;
  first_seen: string | null;
  last_seen: string | null;
  unlock_ok: number;
  unlock_fail: number;
}

interface ViewersResponse {
  album_id: string;
  days: number;
  password_protected: boolean;
  geoip_enabled: boolean;
  rows: ViewerRow[];
}

/** ISO 3166-1 alpha-2 → regional-indicator flag emoji. */
function flag(code: string | null): string {
  if (!code || code.length !== 2) return "";
  const cc = code.toUpperCase();
  if (!/^[A-Z]{2}$/.test(cc)) return "";
  return String.fromCodePoint(...[...cc].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}

function location(r: ViewerRow): string {
  const parts = [r.city, r.region, r.country].filter(Boolean) as string[];
  const label = parts.length > 0 ? parts.join(", ") : "Unknown";
  const f = flag(r.country);
  return f ? `${f} ${label}` : label;
}

function fmtTime(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function PasswordCell({
  r,
  protectedAlbum,
}: {
  r: ViewerRow;
  protectedAlbum: boolean;
}): React.JSX.Element {
  if (!protectedAlbum) return <span className="text-text-muted">—</span>;
  const entered = r.unlock_ok > 0 || r.view_count > 0;
  if (entered) {
    return (
      <span className="text-emerald-300">
        ✓ entered
        {r.unlock_fail > 0 ? (
          <span className="text-text-muted"> ({r.unlock_fail} failed)</span>
        ) : null}
      </span>
    );
  }
  if (r.unlock_fail > 0) {
    return <span className="text-rose-400">✗ failed ({r.unlock_fail})</span>;
  }
  return <span className="text-text-muted">—</span>;
}

export function AlbumViewersCell({
  albumId,
  albumTitle,
  views,
}: {
  albumId: string;
  albumTitle: string;
  views: number;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<ViewersResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const res = await fetch(`/api/admin/albums/${albumId}/viewers?days=30`, {
        cache: "no-store",
      });
      if (!res.ok) throw new Error(`Failed to load (HTTP ${res.status})`);
      setData((await res.json()) as ViewersResponse);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [albumId]);

  useEffect(() => {
    if (open && !data && !loading) void load();
  }, [open, data, loading, load]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={views === 0}
        className="tabular-nums underline decoration-dotted underline-offset-4 hover:text-rose-300 transition disabled:cursor-default disabled:no-underline disabled:hover:text-text cursor-pointer"
        title={views > 0 ? "Show visitor IPs & locations" : "No views yet"}
      >
        {formatCount(views)}
      </button>

      {open ? (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-4 backdrop-blur-sm"
          onClick={() => setOpen(false)}
        >
          <div
            className="mt-12 w-full max-w-3xl rounded-2xl border border-line bg-bg-elevated shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <header className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
              <div>
                <h3 className="text-base font-light text-white">
                  Visitors — {albumTitle}
                </h3>
                <p className="text-xs text-text-muted">
                  IPs & locations, last 30 days
                  {data && !data.geoip_enabled ? (
                    <span className="ml-1 text-amber-300/80">
                      (country only — set GEOIP_DB_PATH for city)
                    </span>
                  ) : null}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded-md p-1 text-text-muted hover:text-white hover:bg-white/5 transition cursor-pointer"
                aria-label="Close"
              >
                <X className="size-5" />
              </button>
            </header>

            <div className="max-h-[70vh] overflow-y-auto p-1">
              {loading ? (
                <div className="flex items-center justify-center gap-2 py-16 text-text-muted">
                  <Loader2 className="size-4 animate-spin" /> Loading…
                </div>
              ) : err ? (
                <div className="py-16 text-center text-rose-400">{err}</div>
              ) : !data || data.rows.length === 0 ? (
                <div className="px-4 py-16 text-center text-text-muted">
                  No visitor data in this window.
                  <span className="block mt-1 text-xs">
                    Only views recorded after the latest deploy carry IP/location.
                  </span>
                </div>
              ) : (
                <table className="w-full text-sm">
                  <thead className="text-text-muted">
                    <tr>
                      <th className="px-4 py-2 text-left font-medium">IP</th>
                      <th className="px-4 py-2 text-left font-medium">
                        <span className="inline-flex items-center gap-1">
                          <MapPin className="size-3" /> Location
                        </span>
                      </th>
                      <th className="px-4 py-2 text-right font-medium">Views</th>
                      <th className="px-4 py-2 text-left font-medium">
                        <span className="inline-flex items-center gap-1">
                          <Lock className="size-3" /> Password
                        </span>
                      </th>
                      <th className="px-4 py-2 text-right font-medium">Last seen</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.rows.map((r) => (
                      <tr key={r.ip} className="border-t border-line">
                        <td className="px-4 py-2 font-mono text-xs text-text">{r.ip}</td>
                        <td className="px-4 py-2 text-text-muted">{location(r)}</td>
                        <td className="px-4 py-2 text-right tabular-nums">
                          {r.view_count}
                          {r.viewers > 1 ? (
                            <span className="text-text-muted"> · {r.viewers} ppl</span>
                          ) : null}
                        </td>
                        <td className="px-4 py-2">
                          <PasswordCell r={r} protectedAlbum={data.password_protected} />
                        </td>
                        <td className="px-4 py-2 text-right text-xs text-text-muted">
                          {fmtTime(r.last_seen)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
