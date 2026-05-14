"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Image as ImageIcon, Stamp, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AlbumForm } from "@/components/admin/AlbumForm";
import { CoverPickerDialog } from "@/components/admin/CoverPickerDialog";
import {
  updateAlbumWatermarkAction,
  regenerateAlbumDerivativesAction,
} from "@/app/admin/albums/actions";
import type { AlbumRow } from "@/lib/types";

interface Props {
  album: Pick<AlbumRow, "id" | "slug" | "title" | "subtitle" | "status" | "cover_photo_id"> & {
    watermark_enabled?: boolean;
    watermark_text?: string | null;
  };
}

export function AlbumSettingsPanel({ album }: Props) {
  const router = useRouter();
  const [coverOpen, setCoverOpen] = useState(false);
  const [wmEnabled, setWmEnabled] = useState<boolean>(album.watermark_enabled ?? false);
  const [wmText, setWmText] = useState<string>(album.watermark_text ?? "");
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [regenPending, startRegen] = useTransition();

  function saveWatermark() {
    setErr(null);
    setMsg(null);
    start(async () => {
      try {
        await updateAlbumWatermarkAction(album.id, wmEnabled, wmText.trim() || null);
        setMsg("Watermark settings saved");
        router.refresh();
      } catch (e) {
        setErr((e as Error).message);
      }
    });
  }

  function regenerate() {
    setErr(null);
    setMsg(null);
    if (!confirm("Re-encode every photo in this album? This may take a few minutes.")) return;
    startRegen(async () => {
      try {
        const r = await regenerateAlbumDerivativesAction(album.id);
        setMsg(`Queued ${r.enqueued} photo${r.enqueued === 1 ? "" : "s"} for regeneration`);
      } catch (e) {
        setErr((e as Error).message);
      }
    });
  }

  return (
    <div className="grid gap-8 lg:grid-cols-2">
      <section className="space-y-4">
        <h3 className="text-xs font-medium uppercase tracking-wider text-zinc-500">Cover</h3>
        <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-4">
          <p className="text-sm text-zinc-300">
            {album.cover_photo_id
              ? "A cover photo is set."
              : "No cover yet — clients see a placeholder."}
          </p>
          <Button
            onClick={() => setCoverOpen(true)}
            variant="outline"
            className="mt-3 cursor-pointer border-zinc-700 bg-zinc-900 text-zinc-100 hover:bg-zinc-800"
          >
            <ImageIcon className="mr-2 h-4 w-4" aria-hidden /> Choose cover
          </Button>
        </div>

        <h3 className="text-xs font-medium uppercase tracking-wider text-zinc-500">Watermark</h3>
        <div className="space-y-3 rounded-lg border border-zinc-800 bg-zinc-950 p-4">
          <label className="flex items-center gap-2 text-sm text-zinc-200">
            <input
              type="checkbox"
              checked={wmEnabled}
              onChange={(e) => setWmEnabled(e.target.checked)}
              className="h-4 w-4 cursor-pointer accent-rose-500"
            />
            <Stamp className="h-4 w-4 text-rose-300" aria-hidden />
            Stamp web + large variants with a wordmark
          </label>
          <div>
            <Label htmlFor="wmText" className="text-xs text-zinc-400">
              Wordmark text (leave blank for the default)
            </Label>
            <Input
              id="wmText"
              value={wmText}
              onChange={(e) => setWmText(e.target.value)}
              placeholder="(c) your-name.com"
              disabled={!wmEnabled}
              maxLength={80}
            />
          </div>
          <p className="text-xs text-zinc-500">
            Originals stay clean. Only browser-facing variants are stamped.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              onClick={saveWatermark}
              disabled={pending}
              className="cursor-pointer bg-rose-500 text-white hover:bg-rose-400"
            >
              {pending ? "Saving…" : "Save watermark"}
            </Button>
            <Button
              onClick={regenerate}
              disabled={regenPending}
              variant="outline"
              className="cursor-pointer border-zinc-700 bg-zinc-900 text-zinc-100 hover:bg-zinc-800"
            >
              <RefreshCw className="mr-2 h-4 w-4" aria-hidden />
              {regenPending ? "Queuing…" : "Regenerate variants"}
            </Button>
          </div>
          {msg && <p className="text-xs text-emerald-400">{msg}</p>}
          {err && <p className="text-xs text-rose-400">{err}</p>}
        </div>
      </section>

      <section>
        <h3 className="text-xs font-medium uppercase tracking-wider text-zinc-500">Album</h3>
        <div className="mt-4 rounded-lg border border-zinc-800 bg-zinc-950 p-4">
          <AlbumForm
            mode="edit"
            initial={{ id: album.id, title: album.title, subtitle: album.subtitle, status: album.status }}
          />
        </div>
      </section>

      <CoverPickerDialog
        open={coverOpen}
        onOpenChange={setCoverOpen}
        slug={album.slug}
        albumId={album.id}
        currentCoverId={album.cover_photo_id}
        onChanged={() => router.refresh()}
      />
    </div>
  );
}
