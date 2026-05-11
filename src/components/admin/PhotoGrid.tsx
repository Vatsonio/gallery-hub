"use client";
import { useEffect, useState } from "react";
import {
  DndContext, closestCenter, KeyboardSensor, PointerSensor, useSensor, useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { arrayMove, SortableContext, sortableKeyboardCoordinates, rectSortingStrategy } from "@dnd-kit/sortable";
import { PhotoTile, type PhotoTileData } from "./PhotoTile";
import AdminLightbox from "./AdminLightbox";
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

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  async function reload() {
    const res = await fetch(`/api/albums/${slug}/photos`, { cache: "no-store" });
    if (!res.ok) return;
    const j: ApiResp = await res.json();
    setData(j);
    setOrder(j.photos.map((p) => p.id));
  }

  useEffect(() => { reload(); }, [slug, refreshKey]);

  useEffect(() => {
    if (!data) return;
    const anyProcessing = data.photos.some((p) => p.status !== "ready");
    if (anyProcessing) {
      if (!hadPending) setHadPending(true);
      const t = setInterval(reload, 2000);
      return () => clearInterval(t);
    }
    // Transition from pending → all ready: tell the host to refresh
    // any server-rendered surfaces (stats, badges) once.
    if (hadPending) {
      setHadPending(false);
      onPendingResolved?.();
    }
  }, [data, slug, hadPending, onPendingResolved]);

  async function onDragEnd(e: DragEndEvent) {
    if (!data || !e.over || e.active.id === e.over.id) return;
    const oldIdx = order.indexOf(String(e.active.id));
    const newIdx = order.indexOf(String(e.over.id));
    const next = arrayMove(order, oldIdx, newIdx);
    setOrder(next);
    await reorderPhotosAction(data.album.id, next);
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
      status: p.status,
      isCover: data.album.cover_photo_id === p.id,
      albumId: data.album.id,
      width: p.width,
      height: p.height,
    };
  });

  // Only `ready` photos in the navigation list — pending photos have no
  // presigned large_url yet, so lightbox prev/next skips over them.
  const readyOrder = order.filter((id) => byId.get(id)?.status === "ready");
  const openIdx = openPhotoId ? readyOrder.indexOf(openPhotoId) : -1;
  const openPhoto = openPhotoId ? byId.get(openPhotoId) ?? null : null;
  const prevId = openIdx > 0 ? readyOrder[openIdx - 1] : null;
  const nextId = openIdx >= 0 && openIdx < readyOrder.length - 1 ? readyOrder[openIdx + 1] : null;

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
      <SortableContext items={order} strategy={rectSortingStrategy}>
        <div className="columns-2 sm:columns-3 md:columns-4 lg:columns-6 gap-3 px-1">
          {tiles.map((t) => (
            <div className="group mb-3 break-inside-avoid" key={t.id}>
              <PhotoTile photo={t} onChange={reload} onPreview={setOpenPhotoId} />
            </div>
          ))}
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
  );
}
