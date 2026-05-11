"use client";
import { useEffect, useState } from "react";
import {
  DndContext, closestCenter, KeyboardSensor, PointerSensor, useSensor, useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { arrayMove, SortableContext, sortableKeyboardCoordinates, rectSortingStrategy } from "@dnd-kit/sortable";
import { PhotoTile, type PhotoTileData } from "./PhotoTile";
import { reorderPhotosAction } from "@/app/admin/albums/actions";
import type { PhotoRow } from "@/lib/types";

interface PhotoWithThumb extends PhotoRow {
  thumb_url: string | null;
}

interface ApiResp {
  album: { id: string; slug: string; cover_photo_id: string | null };
  photos: PhotoWithThumb[];
}

export function PhotoGrid({ slug }: { slug: string }) {
  const [data, setData] = useState<ApiResp | null>(null);
  const [order, setOrder] = useState<string[]>([]);

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

  useEffect(() => { reload(); }, [slug]);

  useEffect(() => {
    if (!data) return;
    const anyProcessing = data.photos.some((p) => p.status !== "ready");
    if (!anyProcessing) return;
    const t = setInterval(reload, 2000);
    return () => clearInterval(t);
  }, [data, slug]);

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
      status: p.status,
      isCover: data.album.cover_photo_id === p.id,
      albumId: data.album.id,
    };
  });

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
      <SortableContext items={order} strategy={rectSortingStrategy}>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
          {tiles.map((t) => (
            <div className="group" key={t.id}>
              <PhotoTile photo={t} onChange={reload} />
            </div>
          ))}
        </div>
      </SortableContext>
    </DndContext>
  );
}
