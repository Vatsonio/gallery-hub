"use client";
import { useEffect, useState, useTransition } from "react";
import { Trash2, ArrowRightCircle, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  bulkDeletePhotosAction,
  bulkMovePhotosAction,
  listAlbumsForPickerAction,
  type AlbumSummary,
} from "@/app/admin/albums/actions";
import { useToast } from "@/components/ui/Toast";

interface Props {
  albumId: string;
  selectedIds: string[];
  onClear: () => void;
  onCommitted: () => void;
}

/**
 * Sticky toolbar shown when at least one photo is selected. Hosts the
 * Delete and Move-to actions; Cancel clears selection.
 */
export function BulkActionsBar({ albumId, selectedIds, onClear, onCommitted }: Props) {
  const toast = useToast();
  const [pending, start] = useTransition();
  const [moveOpen, setMoveOpen] = useState(false);
  const [albums, setAlbums] = useState<AlbumSummary[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const count = selectedIds.length;

  useEffect(() => {
    if (!moveOpen || albums) return;
    listAlbumsForPickerAction()
      .then(setAlbums)
      .catch((e: unknown) => setErr((e as Error).message));
  }, [moveOpen, albums]);

  if (count === 0) return null;

  function doDelete() {
    setErr(null);
    if (!confirm(`Delete ${count} photo${count === 1 ? "" : "s"}? This cannot be undone.`)) return;
    const n = count;
    start(async () => {
      try {
        await bulkDeletePhotosAction(albumId, selectedIds);
        toast.success(`${n} ${n === 1 ? "photo" : "photos"} deleted`);
        onCommitted();
        onClear();
      } catch (e) {
        const msg = (e as Error).message;
        setErr(msg);
        toast.error(`Delete failed: ${msg}`);
      }
    });
  }

  function doMove(dstId: string) {
    setErr(null);
    const n = count;
    start(async () => {
      try {
        await bulkMovePhotosAction(albumId, dstId, selectedIds);
        setMoveOpen(false);
        toast.success(`${n} ${n === 1 ? "photo" : "photos"} moved`);
        onCommitted();
        onClear();
      } catch (e) {
        const msg = (e as Error).message;
        setErr(msg);
        toast.error(`Move failed: ${msg}`);
      }
    });
  }

  return (
    <>
      <div className="sticky top-0 z-30 -mx-1 mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 backdrop-blur supports-[backdrop-filter]:bg-rose-500/10">
        <span className="text-sm font-medium text-rose-100">
          {count} selected
        </span>
        <span className="text-rose-300/60">·</span>
        <Button
          size="sm"
          variant="ghost"
          onClick={doDelete}
          disabled={pending}
          className="cursor-pointer text-rose-100 hover:bg-rose-500/20 hover:text-white"
        >
          <Trash2 className="mr-1 h-4 w-4" aria-hidden /> Delete
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setMoveOpen(true)}
          disabled={pending}
          className="cursor-pointer text-rose-100 hover:bg-rose-500/20 hover:text-white"
        >
          <ArrowRightCircle className="mr-1 h-4 w-4" aria-hidden /> Move to…
        </Button>
        <span className="ml-auto flex items-center gap-2">
          {err && <span className="text-xs text-rose-200">{err}</span>}
          <Button
            size="sm"
            variant="ghost"
            onClick={onClear}
            disabled={pending}
            className="cursor-pointer text-rose-200 hover:bg-rose-500/20 hover:text-white"
          >
            <X className="mr-1 h-4 w-4" aria-hidden /> Cancel
          </Button>
        </span>
      </div>

      <Dialog open={moveOpen} onOpenChange={setMoveOpen}>
        <DialogContent className="max-w-md border-zinc-800 bg-zinc-950 text-zinc-100">
          <DialogHeader>
            <DialogTitle className="text-lg font-light tracking-wide">Move to album</DialogTitle>
            <DialogDescription className="text-zinc-400">
              Photos move with their originals and variants — keys repoint to the new album.
            </DialogDescription>
          </DialogHeader>
          {!albums && !err && <p className="py-4 text-center text-sm text-zinc-500">Loading…</p>}
          {err && <p className="py-4 text-center text-sm text-rose-300">{err}</p>}
          {albums && (
            <div className="max-h-[50vh] space-y-1 overflow-y-auto">
              {albums
                .filter((a) => a.id !== albumId)
                .map((a) => (
                  <button
                    key={a.id}
                    type="button"
                    onClick={() => doMove(a.id)}
                    disabled={pending}
                    className="block w-full cursor-pointer rounded-md px-3 py-2 text-left text-sm text-zinc-200 transition hover:bg-zinc-800 disabled:opacity-50"
                  >
                    <span className="font-medium">{a.title}</span>
                    <span className="ml-2 text-xs text-zinc-500">/{a.slug}</span>
                  </button>
                ))}
              {albums.filter((a) => a.id !== albumId).length === 0 && (
                <p className="py-4 text-center text-sm text-zinc-500">
                  No other albums — create one first.
                </p>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
