"use client";
import { useEffect, useState, useTransition } from "react";
import Image from "next/image";
import { Check, ImageIcon } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { setCoverAction } from "@/app/admin/albums/actions";
import { useToast } from "@/components/ui/Toast";

interface PhotoOption {
  id: string;
  thumb_url: string | null;
  web_url: string | null;
  status: string;
}

interface ApiResp {
  album: { id: string; slug: string; cover_photo_id: string | null };
  photos: PhotoOption[];
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  slug: string;
  albumId: string;
  currentCoverId: string | null;
  onChanged?: () => void;
}

/**
 * Modal that lets the admin pick an album cover from a grid of the
 * album's `ready` photos. The currently selected cover gets a rose
 * ring; clicking another photo + confirming commits via setCoverAction.
 */
export function CoverPickerDialog({ open, onOpenChange, slug, albumId, currentCoverId, onChanged }: Props) {
  const toast = useToast();
  const [data, setData] = useState<ApiResp | null>(null);
  const [selected, setSelected] = useState<string | null>(currentCoverId);
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setErr(null);
    setSelected(currentCoverId);
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/albums/${slug}/photos`, { cache: "no-store" });
        if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
        const j: ApiResp = await res.json();
        if (!cancelled) setData(j);
      } catch (e) {
        if (!cancelled) setErr((e as Error).message);
      }
    })();
    return () => { cancelled = true; };
  }, [open, slug, currentCoverId]);

  function commit() {
    if (!selected) return;
    start(async () => {
      try {
        await setCoverAction(albumId, selected);
        toast.success("Cover updated");
        onChanged?.();
        onOpenChange(false);
      } catch (e) {
        const msg = (e as Error).message;
        setErr(msg);
        toast.error(`Cover update failed: ${msg}`);
      }
    });
  }

  const ready = data?.photos.filter((p) => p.status === "ready") ?? [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl border-zinc-800 bg-zinc-950 text-zinc-100">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-lg font-light tracking-wide">
            <ImageIcon className="h-4 w-4 text-rose-300" aria-hidden /> Choose album cover
          </DialogTitle>
          <DialogDescription className="text-zinc-400">
            Pick the photo clients see first. The current cover has a rose ring.
          </DialogDescription>
        </DialogHeader>

        {!data && !err && <p className="py-8 text-center text-sm text-zinc-500">Loading photos…</p>}
        {err && <p className="py-8 text-center text-sm text-rose-300">{err}</p>}

        {data && ready.length === 0 && (
          <p className="py-8 text-center text-sm text-zinc-500">
            No ready photos yet — upload some first.
          </p>
        )}

        {data && ready.length > 0 && (
          <div className="max-h-[60vh] overflow-y-auto pr-1">
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-5">
              {ready.map((p) => {
                const url = p.thumb_url ?? p.web_url;
                const isSelected = selected === p.id;
                const isCurrent = currentCoverId === p.id;
                return (
                  <button
                    type="button"
                    key={p.id}
                    onClick={() => setSelected(p.id)}
                    className={`relative aspect-square cursor-pointer overflow-hidden rounded-md bg-zinc-900 ring-2 transition ${
                      isSelected
                        ? "ring-rose-400"
                        : isCurrent
                          ? "ring-rose-400/40"
                          : "ring-transparent hover:ring-zinc-700"
                    }`}
                    aria-label="Pick this photo as cover"
                  >
                    {url ? (
                      <Image src={url} alt="" fill sizes="160px" className="object-cover" />
                    ) : (
                      <div className="flex h-full w-full items-center justify-center text-xs text-zinc-500">
                        {p.status}
                      </div>
                    )}
                    {isSelected && (
                      <span className="absolute right-1 top-1 rounded-full bg-rose-500 p-1 text-white shadow">
                        <Check className="h-3 w-3" aria-hidden />
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button
            onClick={commit}
            disabled={pending || !selected || selected === currentCoverId}
            className="bg-rose-500 text-white hover:bg-rose-400"
          >
            {pending ? "Saving…" : "Set as cover"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
