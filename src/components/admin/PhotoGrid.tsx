"use client";
import { useCallback, useEffect, useState } from "react";
import {
  DndContext, closestCenter, KeyboardSensor, PointerSensor, TouchSensor, useSensor, useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { arrayMove, SortableContext, sortableKeyboardCoordinates, rectSortingStrategy } from "@dnd-kit/sortable";
import { CheckSquare, XSquare } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PhotoTile, type PhotoTileData } from "./PhotoTile";
import AdminLightbox from "./AdminLightbox";
import { BulkActionsBar } from "./BulkActionsBar";
import { CoverPickerDialog } from "./CoverPickerDialog";
import { reorderPhotosAction } from "@/app/admin/albums/actions";
import type { PhotoRow } from "@/lib/types";

interface PhotoWithThumb extends PhotoRow {
  thumb_url: string | null;
  web_url: string | null;
  large_url: string | null;
}

interface ApiResp {
  album: { id: string; slug: string; cover_photo_id: string | null };
  photos: PhotoWithThumb[];
}

export function PhotoGrid({
  slug,
  refreshKey = 0,
  onPendingResolved,
}: {
  slug: string;
  refreshKey?: number;
  /** Called once when the last pending photo transitions to ready. */
  onPendingResolved?: () => void;
}) {
  const [data, setData] = useState<ApiResp | null>(null);
  const [order, setOrder] = useState<string[]>([]);
  const [hadPending, setHadPending] = useState(false);
  const [openPhotoId, setOpenPhotoId] = useState<string | null>(null);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [coverOpen, setCoverOpen] = useState(false);

  const sensors = useSensors(
    // Desktop: small drag distance triggers reorder.
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    // Mobile: require a brief hold before drag starts so the long-press
    // selection gesture (500ms) wins for short presses; the drag
    // activation delay is 200ms which leaves room for both UIs without
    // overlap. Tolerance 8 keeps finger jitter from cancelling.
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const reload = useCallback(async () => {
    const res = await fetch(`/api/albums/${slug}/photos`, { cache: "no-store" });
    if (!res.ok) return;
    const j: ApiResp = await res.json();
    setData(j);
    setOrder(j.photos.map((p) => p.id));
  }, [slug]);

  useEffect(() => { reload(); }, [slug, refreshKey, reload]);

  useEffect(() => {
    if (!data) return;
    const anyProcessing = data.photos.some((p) => p.status !== "ready");
    if (anyProcessing) {
      if (!hadPending) setHadPending(true);
      const t = setInterval(reload, 2000);
      return () => clearInterval(t);
    }
    if (hadPending) {
      setHadPending(false);
      onPendingResolved?.();
    }
  }, [data, slug, hadPending, onPendingResolved, reload]);

  async function onDragEnd(e: DragEndEvent) {
    if (!data || !e.over || e.active.id === e.over.id) return;
    const oldIdx = order.indexOf(String(e.active.id));
    const newIdx = order.indexOf(String(e.over.id));
    const prev = order;
    const next = arrayMove(order, oldIdx, newIdx);
    setOrder(next); // optimistic
    try {
      await reorderPhotosAction(data.album.id, next);
    } catch {
      setOrder(prev); // revert on server error
    }
  }

  function toggleSelect(id: string) {
    setSelectedIds((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function enterSelection(seedId?: string) {
    setSelectionMode(true);
    if (seedId) setSelectedIds(new Set([seedId]));
  }

  function exitSelection() {
    setSelectionMode(false);
    setSelectedIds(new Set());
  }

  if (!data) return <p className="text-sm text-zinc-500">Loading photos…</p>;
  if (data.photos.length === 0) return <p className="text-sm text-zinc-500">No photos yet — drag some in.</p>;

  const byId = new Map(data.photos.map((p) => [p.id, p]));
  const tiles: PhotoTileData[] = order.map((id) => {
    const p = byId.get(id)!;
    return {
      id: p.id,
      thumb_url: p.thumb_url,
      web_url: p.web_url,
      large_url: p.large_url,
      status: p.status,
      isCover: data.album.cover_photo_id === p.id,
      albumId: data.album.id,
      width: p.width,
      height: p.height,
    };
  });

  const readyOrder = order.filter((id) => byId.get(id)?.status === "ready");
  const openIdx = openPhotoId ? readyOrder.indexOf(openPhotoId) : -1;
  const openPhoto = openPhotoId ? byId.get(openPhotoId) ?? null : null;
  const prevId = openIdx > 0 ? readyOrder[openIdx - 1] : null;
  const nextId = openIdx >= 0 && openIdx < readyOrder.length - 1 ? readyOrder[openIdx + 1] : null;

  return (
    <div>
      {/* Selection toolbar trigger */}
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        {!selectionMode ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() => enterSelection()}
            className="cursor-pointer border-zinc-700 bg-zinc-900 text-zinc-200 hover:bg-zinc-800"
          >
            <CheckSquare className="mr-1 h-4 w-4" aria-hidden /> Select
          </Button>
        ) : (
          <Button
            size="sm"
            variant="outline"
            onClick={exitSelection}
            className="cursor-pointer border-zinc-700 bg-zinc-900 text-zinc-200 hover:bg-zinc-800"
          >
            <XSquare className="mr-1 h-4 w-4" aria-hidden /> Done
          </Button>
        )}
        <p className="text-xs text-zinc-500">
          {selectionMode ? "Tap photos to select · long-press also works on desktop" : "Drag to reorder · long-press to multi-select"}
        </p>
      </div>

      {selectionMode && (
        <BulkActionsBar
          albumId={data.album.id}
          selectedIds={[...selectedIds]}
          onClear={exitSelection}
          onCommitted={() => { reload(); }}
        />
      )}

      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={order} strategy={rectSortingStrategy} disabled={selectionMode}>
          <div className="columns-2 sm:columns-3 md:columns-4 lg:columns-6 gap-3 px-1">
            {tiles.map((t) => {
              const ratio = t.width && t.height ? t.height / t.width : 1;
              const estH = Math.max(120, Math.round(280 * ratio));
              return (
                <div
                  className="group mb-3 break-inside-avoid gallery-row"
                  key={t.id}
                  style={{ ["--row-h" as string]: `${estH}px` }}
                >
                  <PhotoTile
                    photo={t}
                    onChange={reload}
                    onPreview={setOpenPhotoId}
                    selectionMode={selectionMode}
                    selected={selectedIds.has(t.id)}
                    onToggleSelect={toggleSelect}
                    onLongPress={(id) => enterSelection(id)}
                    onPickCover={() => setCoverOpen(true)}
                  />
                </div>
              );
            })}
          </div>
        </SortableContext>
        {openPhoto && (openPhoto.large_url || openPhoto.web_url) && (
          <AdminLightbox
            photoUrl={openPhoto.large_url ?? openPhoto.web_url!}
            prevId={prevId}
            nextId={nextId}
            index={openIdx}
            total={readyOrder.length}
            onClose={() => setOpenPhotoId(null)}
            onNavigate={setOpenPhotoId}
          />
        )}
      </DndContext>

      <CoverPickerDialog
        open={coverOpen}
        onOpenChange={setCoverOpen}
        slug={slug}
        albumId={data.album.id}
        currentCoverId={data.album.cover_photo_id}
        onChanged={reload}
      />
    </div>
  );
}
