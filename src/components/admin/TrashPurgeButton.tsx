"use client";

import { Trash2, Loader2 } from "lucide-react";
import { useState, useTransition } from "react";
import { purgeSoftDeletedAlbumsAction } from "@/app/admin/albums/actions";

interface Props {
  /** Pre-render count of soft-deleted albums waiting to be purged. */
  initialCount: number;
}

function formatBytes(b: number): string {
  if (b <= 0) return "0 B";
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 ** 3) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  return `${(b / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/**
 * One-click "Empty trash" — wipes the MinIO objects + DB rows of every album
 * currently flagged `deleted_at IS NOT NULL`. Owner-only (the wrapping page
 * already requireOwner()s; the server action re-gates).
 */
export function TrashPurgeButton({ initialCount }: Props): React.ReactNode {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<null | {
    ok: boolean;
    albums: number;
    bytes: number;
    s3: number;
    error?: string;
  }>(null);
  const [count, setCount] = useState(initialCount);

  function onClick(): void {
    if (pending || count === 0) return;
    if (!confirm(`Purge ${count} trashed album${count === 1 ? "" : "s"}? Files and DB rows are erased — no undo.`)) {
      return;
    }
    startTransition(async () => {
      try {
        const r = await purgeSoftDeletedAlbumsAction();
        setResult({
          ok: true,
          albums: r.albumsPurged,
          bytes: r.totalBytesFreed,
          s3: r.totalS3ObjectsDeleted,
        });
        setCount(0);
      } catch (err) {
        setResult({
          ok: false,
          albums: 0,
          bytes: 0,
          s3: 0,
          error: (err as Error).message || "purge failed",
        });
      }
    });
  }

  return (
    <div className="rounded-xl border border-line bg-bg-card p-4 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-white">Empty trash</p>
          <p className="mt-0.5 text-xs text-text-muted">
            Reap MinIO objects + DB rows of {count} previously-deleted album
            {count === 1 ? "" : "s"}. No undo.
          </p>
        </div>
        <button
          type="button"
          onClick={onClick}
          disabled={pending || count === 0}
          className="inline-flex items-center gap-2 rounded-lg bg-rose-500/15 hover:bg-rose-500/25 disabled:opacity-50 disabled:cursor-not-allowed border border-rose-500/30 transition px-3 py-2 text-sm font-medium text-rose-200 cursor-pointer"
        >
          {pending ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Trash2 className="size-4" />
          )}
          {pending ? "Purging…" : count === 0 ? "Nothing to purge" : `Purge ${count}`}
        </button>
      </div>
      {result && result.ok && (
        <p className="text-xs text-emerald-300">
          Purged {result.albums} album{result.albums === 1 ? "" : "s"} ·
          freed {formatBytes(result.bytes)} · removed {result.s3} object
          {result.s3 === 1 ? "" : "s"} from storage.
        </p>
      )}
      {result && !result.ok && (
        <p className="text-xs text-rose-300">Failed: {result.error}</p>
      )}
    </div>
  );
}
