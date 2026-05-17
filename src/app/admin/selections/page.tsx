import Link from "next/link";
import { Heart } from "lucide-react";
import { sql } from "@/lib/db";
import { requireAdmin } from "@/lib/auth-check";
import { ADMIN_PREVIEW_VIEWER_ID } from "@/lib/viewer";

export const dynamic = "force-dynamic";

interface SelectionRow {
  share_token: string;
  album_id: string;
  album_title: string;
  album_slug: string;
  viewer_id: string;
  photo_count: string;
  last_at: Date;
}

/**
 * Index of (album, viewer) pairs that have at least one favorite,
 * ordered by recency. Admin-only.
 */
export default async function SelectionsPage() {
  await requireAdmin();
  const rows = await sql<SelectionRow[]>`
    SELECT
      f.share_token,
      a.id AS album_id,
      a.title AS album_title,
      a.slug AS album_slug,
      f.viewer_id,
      COUNT(*)::text AS photo_count,
      MAX(f.created_at) AS last_at
    FROM favorites f
    JOIN share_links sl ON sl.token = f.share_token
    JOIN albums a ON a.id = sl.album_id
    WHERE a.deleted_at IS NULL
      AND f.viewer_id <> ${ADMIN_PREVIEW_VIEWER_ID}
    GROUP BY f.share_token, a.id, a.title, a.slug, f.viewer_id
    ORDER BY MAX(f.created_at) DESC
    LIMIT 100
  `;

  return (
    <div className="p-6 max-w-screen-xl">
      <div className="flex items-center gap-3">
        <span className="grid h-9 w-9 place-items-center rounded-lg bg-[#ff4d6d]/15 text-[#ff4d6d]">
          <Heart className="h-4 w-4 fill-current" />
        </span>
        <div>
          <h1 className="text-2xl font-light text-white">Client Selections</h1>
          <p className="text-sm text-text-muted">
            Recent favorite activity grouped by viewer.
          </p>
        </div>
      </div>

      <div className="mt-6 overflow-hidden rounded-xl border border-line bg-bg-elevated">
        <table className="w-full text-sm">
          <thead className="bg-bg-card text-text-muted">
            <tr>
              <th className="px-4 py-3 text-left font-medium">Album</th>
              <th className="px-4 py-3 text-left font-medium">Viewer</th>
              <th className="px-4 py-3 text-left font-medium">Hearted</th>
              <th className="px-4 py-3 text-left font-medium">Last activity</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody className="text-text">
            {rows.length === 0 ? (
              <tr>
                <td
                  colSpan={5}
                  className="px-4 py-12 text-center text-text-muted"
                >
                  No client selections yet.
                </td>
              </tr>
            ) : (
              rows.map((r) => (
                <tr
                  key={`${r.share_token}-${r.viewer_id}`}
                  className="border-t border-line"
                >
                  <td className="px-4 py-3">{r.album_title}</td>
                  <td className="px-4 py-3 font-mono text-xs text-text-muted">
                    {r.viewer_id.slice(0, 8)}…
                  </td>
                  <td className="px-4 py-3 text-[#ff4d6d] tabular-nums">
                    {r.photo_count}
                  </td>
                  <td className="px-4 py-3 text-text-muted">
                    {new Date(r.last_at).toLocaleString()}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Link
                      href={`/admin/selections/${r.album_slug}?viewer=${encodeURIComponent(r.viewer_id)}`}
                      className="rounded-md bg-bg-card px-3 py-1.5 text-xs text-text hover:bg-white/10 transition"
                    >
                      View
                    </Link>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
