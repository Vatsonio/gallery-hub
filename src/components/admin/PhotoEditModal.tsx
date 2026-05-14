"use client";
import { useRef, useState } from "react";
import { RotateCw, Sun, Crop as CropIcon } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import type { PhotoTileData } from "./PhotoTile";
import type { PhotoEditPayload, Rotate } from "@/lib/photo-edit";

type Tab = "rotate" | "crop" | "brightness";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  photo: PhotoTileData;
  onSaved: () => void;
}

interface Drag {
  startX: number;
  startY: number;
  baseX: number;
  baseY: number;
  baseW: number;
  baseH: number;
  mode: "move" | "ne" | "nw" | "se" | "sw";
}

/**
 * Composable photo editor.
 *
 * Three tabs:
 *   - Rotate: 90/180/270 buttons
 *   - Crop:   a draggable + resizable rectangle in 0..1 normalized
 *             coordinates, rendered over the preview image
 *   - Brightness: a -100..+100 slider
 *
 * On save, POST /api/photos/[id]/edit with the chosen transforms.
 * We deliberately built the crop UI from scratch instead of bringing
 * in react-image-crop (or any other dep): the requirement is admin-
 * only and the box-drag interaction is a hundred lines.
 */
export function PhotoEditModal({ open, onOpenChange, photo, onSaved }: Props) {
  const [tab, setTab] = useState<Tab>("rotate");
  const [rotate, setRotate] = useState<Rotate | 0>(0);
  const [brightness, setBrightness] = useState<number>(0);
  const [crop, setCrop] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [pending, setPending] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const previewUrl = photo.large_url ?? photo.web_url ?? photo.thumb_url;
  const dragRef = useRef<Drag | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  function startDrag(mode: Drag["mode"], e: React.PointerEvent) {
    if (!crop) return;
    const c = containerRef.current;
    if (!c) return;
    const rect = c.getBoundingClientRect();
    e.preventDefault();
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      baseX: crop.x,
      baseY: crop.y,
      baseW: crop.w,
      baseH: crop.h,
      mode,
    };
    function clamp01(v: number): number { return Math.max(0, Math.min(1, v)); }
    function onMove(ev: PointerEvent) {
      const d = dragRef.current;
      if (!d) return;
      const dx = (ev.clientX - d.startX) / rect.width;
      const dy = (ev.clientY - d.startY) / rect.height;
      let x = d.baseX, y = d.baseY, w = d.baseW, h = d.baseH;
      if (d.mode === "move") {
        x = clamp01(d.baseX + dx);
        y = clamp01(d.baseY + dy);
        if (x + w > 1) x = 1 - w;
        if (y + h > 1) y = 1 - h;
      } else {
        // Resize handles. Each corner pulls the edge it shares.
        if (d.mode.includes("w")) { x = clamp01(d.baseX + dx); w = clamp01(d.baseW - dx); }
        if (d.mode.includes("e")) { w = clamp01(d.baseW + dx); }
        if (d.mode.includes("n")) { y = clamp01(d.baseY + dy); h = clamp01(d.baseH - dy); }
        if (d.mode.includes("s")) { h = clamp01(d.baseH + dy); }
        if (w < 0.05) w = 0.05;
        if (h < 0.05) h = 0.05;
        if (x + w > 1) w = 1 - x;
        if (y + h > 1) h = 1 - y;
      }
      setCrop({ x, y, w, h });
    }
    function onUp() {
      dragRef.current = null;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  async function save() {
    setErr(null);
    const body: PhotoEditPayload = {};
    if (rotate) body.rotate = rotate;
    if (crop) body.crop = crop;
    if (brightness !== 0) body.brightness = brightness;
    if (!body.rotate && !body.crop && body.brightness === undefined) {
      setErr("Pick at least one transform before saving");
      return;
    }
    setPending(true);
    try {
      const res = await fetch(`/api/photos/${photo.id}/edit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error ?? `edit failed: ${res.status}`);
      }
      onSaved();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl border-zinc-800 bg-zinc-950 text-zinc-100">
        <DialogHeader>
          <DialogTitle className="text-lg font-light tracking-wide">Edit photo</DialogTitle>
          <DialogDescription className="text-zinc-400">
            Transforms apply to the original; derivative variants regenerate after save.
          </DialogDescription>
        </DialogHeader>

        <div className="flex gap-2 border-b border-zinc-800 pb-2">
          <Button size="sm" variant={tab === "rotate" ? "default" : "ghost"} onClick={() => setTab("rotate")} className="cursor-pointer">
            <RotateCw className="mr-1 h-4 w-4" aria-hidden /> Rotate
          </Button>
          <Button size="sm" variant={tab === "crop" ? "default" : "ghost"} onClick={() => { setTab("crop"); if (!crop) setCrop({ x: 0.1, y: 0.1, w: 0.8, h: 0.8 }); }} className="cursor-pointer">
            <CropIcon className="mr-1 h-4 w-4" aria-hidden /> Crop
          </Button>
          <Button size="sm" variant={tab === "brightness" ? "default" : "ghost"} onClick={() => setTab("brightness")} className="cursor-pointer">
            <Sun className="mr-1 h-4 w-4" aria-hidden /> Brightness
          </Button>
        </div>

        <div className="relative mx-auto w-full max-w-2xl">
          <div ref={containerRef} className="relative overflow-hidden rounded-md bg-zinc-900" style={{ aspectRatio: photo.width && photo.height ? `${photo.width}/${photo.height}` : "4/3" }}>
            {previewUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={previewUrl}
                alt=""
                className="h-full w-full object-contain"
                style={{
                  transform: `rotate(${rotate}deg)`,
                  filter: brightness !== 0 ? `brightness(${1 + brightness / 100})` : undefined,
                  transition: "transform 0.15s",
                }}
              />
            )}
            {tab === "crop" && crop && (
              <div
                onPointerDown={(e) => startDrag("move", e)}
                className="absolute cursor-move border-2 border-rose-400 bg-rose-400/10"
                style={{
                  left: `${crop.x * 100}%`,
                  top: `${crop.y * 100}%`,
                  width: `${crop.w * 100}%`,
                  height: `${crop.h * 100}%`,
                }}
              >
                {(["nw", "ne", "sw", "se"] as const).map((corner) => (
                  <span
                    key={corner}
                    onPointerDown={(e) => startDrag(corner, e)}
                    className={`absolute h-3 w-3 cursor-${corner}-resize rounded-full bg-rose-400 ring-2 ring-white`}
                    style={{
                      left: corner.includes("w") ? -6 : undefined,
                      right: corner.includes("e") ? -6 : undefined,
                      top: corner.includes("n") ? -6 : undefined,
                      bottom: corner.includes("s") ? -6 : undefined,
                    }}
                  />
                ))}
              </div>
            )}
          </div>
        </div>

        {tab === "rotate" && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm text-zinc-300">Rotation:</span>
            {([0, 90, 180, 270] as const).map((deg) => (
              <Button
                key={deg}
                size="sm"
                variant={rotate === deg ? "default" : "outline"}
                onClick={() => setRotate(deg as Rotate | 0)}
                className="cursor-pointer border-zinc-700 bg-zinc-900 text-zinc-100 hover:bg-zinc-800"
              >
                {deg === 0 ? "Reset" : `${deg}°`}
              </Button>
            ))}
          </div>
        )}

        {tab === "crop" && (
          <p className="text-xs text-zinc-500">
            Drag the box to position, corners to resize. Crop is applied to the original at full resolution.
          </p>
        )}

        {tab === "brightness" && (
          <div className="space-y-2">
            <div className="flex items-center justify-between text-sm text-zinc-300">
              <span>Brightness</span>
              <span className="font-mono text-zinc-400">{brightness > 0 ? `+${brightness}` : brightness}</span>
            </div>
            <input
              type="range"
              min={-100}
              max={100}
              step={1}
              value={brightness}
              onChange={(e) => setBrightness(Number(e.target.value))}
              className="w-full accent-rose-400"
            />
          </div>
        )}

        {err && <p className="text-sm text-rose-300">{err}</p>}

        <div className="flex flex-wrap justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button
            onClick={save}
            disabled={pending}
            className="bg-rose-500 text-white hover:bg-rose-400"
          >
            {pending ? "Saving…" : "Save edits"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
