"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DndContext, closestCenter, KeyboardSensor, PointerSensor, TouchSensor, useSensor, useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { arrayMove, SortableContext, sortableKeyboardCoordinates, rectSortingStrategy } from "@dnd-kit/sortable";
import { CalendarClock, CheckSquare, Loader2, XSquare } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PhotoTile, type PhotoTileData } from "./PhotoTile";
import AdminLightbox from "./AdminLightbox";
import { BulkActionsBar } from "./BulkActionsBar";
import { CoverPickerDialog } from "./CoverPickerDialog";
import { PhotoEditModal } from "./PhotoEditModal";
import {
  reorderPhotosAction,
  reorderPhotosByDateAction,
} from "@/app/admin/albums/actions";
import { layoutJustifiedRows } from "@/lib/justified";
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
  const [editPhoto, setEditPhoto] = useState<PhotoTileData | null>(null);
  const [reorderingByDate, setReorderingByDate] = useState(false);
  const [containerWidth, setContainerWidth] = useState<number | null>(null);

  // Callback ref — fires whenever the container DOM node attaches OR
  // detaches. Crucial because the component has early returns (loading /
  // empty states) that mount the container conditionally; a useEffect
  // with `[]` deps would have run before the container existed, with a
  // null ref, and never re-fire when data loaded. The result was
  // containerWidth stuck at the fallback (1100) while the real layout
  // had ~1128 px, so flex-grow stretched every tile ~3% wider than the
  // justified math expected and PhotoTile's aspectRatio rule made each
  // tile ~6 px taller than its wrapper — pushing the bottom-right
  // MoreVertical button below the cell.
  const roRef = useRef<ResizeObserver | null>(null);
  const containerRef = useCallback((node: HTMLDivElement | null) => {
    roRef.current?.disconnect();
    roRef.current = null;
    if (!node) return;
    const measure = () => {
      const w = node.getBoundingClientRect().width;
      if (w > 0) setContainerWidth(w);
    };
    measure();
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0;
      if (w > 0) setContainerWidth(w);
    });
    ro.observe(node);
    roRef.current = ro;
  }, []);

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

  async function onReorderByDate() {
    if (!data || reorderingByDate) return;
    setReorderingByDate(true);
    try {
      await reorderPhotosByDateAction(data.album.id);
      await reload();
    } finally {
      setReorderingByDate(false);
    }
  }

  // Hooks-before-early-returns rule: build tiles + rows always; the
  // early returns below are pure render branches that don't touch hook
  // call order.
  const byId = useMemo(
    () => new Map((data?.photos ?? []).map((p) => [p.id, p])),
    [data],
  );
  const tiles: PhotoTileData[] = useMemo(() => {
    if (!data) return [];
    return order.flatMap((id) => {
      const p = byId.get(id);
      if (!p) return [];
      return [{
        id: p.id,
        thumb_url: p.thumb_url,
        web_url: p.web_url,
        large_url: p.large_url,
        status: p.status,
        isCover: data.album.cover_photo_id === p.id,
        albumId: data.album.id,
        width: p.width,
        height: p.height,
      }];
    });
  }, [data, order, byId]);

  // Justified-row layout — same engine as the public gallery view. Photos
  // in each row scale together to fill 100% of width, so heights inside a
  // row are uniform and rows align as clean horizontal lines (no
  // "ragged" empty cells from CSS Grid's tallest-item-wins behaviour).
  // Photos still processing without measured dims are stamped with a
  // default 3:2 landscape so the row math doesn't divide by zero.
  const effectiveWidth = containerWidth ?? 1100;
  const targetRowHeight = effectiveWidth >= 1024 ? 220 : effectiveWidth >= 640 ? 180 : 140;
  const rows = useMemo(() => {
    if (tiles.length === 0) return [];
    return layoutJustifiedRows({
      photos: tiles.map((t) => ({
        id: t.id,
        width: t.width || 600,
        height: t.height || 400,
      })),
      containerWidth: effectiveWidth,
      targetRowHeight,
      gap: 8,
      maxLastRowScale: 1.6,
    });
  }, [tiles, effectiveWidth, targetRowHeight]);

  if (!data) return <p className="text-sm text-zinc-500">Loading photos…</p>;
  if (data.photos.length === 0) return <p className="text-sm text-zinc-500">No photos yet — drag some in.</p>;

  const readyOrder = order.filter((id) => byId.get(id)?.status === "ready");
  const openIdx = openPhotoId ? readyOrder.indexOf(openPhotoId) : -1;
  const openPhoto = openPhotoId ? byId.get(openPhotoId) ?? null : null;
  const prevId = openIdx > 0 ? readyOrder[openIdx - 1] : null;
  const nextId = openIdx >= 0 && openIdx < readyOrder.length - 1 ? readyOrder[openIdx + 1] : null;

  return (
    <div>
      {/* Selection + reorder toolbar */}
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
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
          <Button
            size="sm"
            variant="outline"
            onClick={onReorderByDate}
            disabled={reorderingByDate || selectionMode}
            title="Sort photos by EXIF capture date (falls back to upload time)"
            className="cursor-pointer border-zinc-700 bg-zinc-900 text-zinc-200 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {reorderingByDate ? (
              <Loader2 className="mr-1 h-4 w-4 animate-spin" aria-hidden />
            ) : (
              <CalendarClock className="mr-1 h-4 w-4" aria-hidden />
            )}
            Reorder by date
          </Button>
        </div>
        <p className="text-xs text-zinc-500">
          {selectionMode ? "Tap photos to select · long-press also works on desktop" : "Drag to reorder · long-press to multi-select"}
        </p>
      </div>

      {selectionMode && (
        <>
          <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-zinc-400">
            <span className="tabular-nums">
              Selected <span className="text-zinc-200">{selectedIds.size}</span> / {data.photos.length}
            </span>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setSelectedIds(new Set(data.photos.map((p) => p.id)))}
              disabled={selectedIds.size === data.photos.length}
              className="cursor-pointer border-zinc-700 bg-zinc-900 text-zinc-200 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Select all
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setSelectedIds(new Set())}
              disabled={selectedIds.size === 0}
              className="cursor-pointer border-zinc-700 bg-zinc-900 text-zinc-200 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Deselect
            </Button>
          </div>
          <BulkActionsBar
            albumId={data.album.id}
            selectedIds={[...selectedIds]}
            onClear={exitSelection}
            onCommitted={() => { reload(); }}
          />
        </>
      )}

      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={order} strategy={rectSortingStrategy} disabled={selectionMode}>
          {/* Justified-row layout: each row's tiles flex-grow together to
            * fill 100% of containerWidth at the row's chosen height. Wide
            * and portrait shots coexist without leaving "tallest-tile" gaps
            * the CSS Grid version was bleeding into the screenshot. The
            * containerWidth comes from ResizeObserver so the layout
            * recomputes when the sidebar collapses on narrower viewports. */}
          <div ref={containerRef} className="flex flex-col gap-2 px-1">
            {rows.map((row, rowIdx) => {
              const totalRowWidth = row.items.reduce((s, it) => s + it.width, 0);
              // Last row that didn't fill the container: pin tile widths
              // to their natural justified size with `flex: 0 0 Wpx` instead
              // of letting `flex-grow` stretch them. Without this, an
              // underfilled tail row distributes the full container width
              // among 1–3 tiles, blowing each up ~1.5–2× wider than
              // computed; PhotoTile's aspectRatio then renders ~2× taller
              // than the wrapper's `h-full = row.height`, pushing the
              // bottom-right MoreVertical button below the cell bounds.
              const underfilled =
                rowIdx === rows.length - 1 &&
                totalRowWidth < effectiveWidth * 0.97;
              return (
                <div
                  key={`row-${rowIdx}`}
                  className="gallery-row flex w-full gap-2"
                  style={{
                    height: row.height,
                    ["--row-h" as string]: `${Math.round(row.height)}px`,
                  }}
                >
                  {row.items.map((item) => {
                    const tile = tiles.find((t) => t.id === item.id);
                    if (!tile) return null;
                    return (
                      <div
                        key={tile.id}
                        className="group relative h-full"
                        style={{
                          flex: underfilled
                            ? `0 0 ${item.width}px`
                            : `${item.width / totalRowWidth} 0 0`,
                        }}
                      >
                        <PhotoTile
                          photo={tile}
                          onChange={reload}
                          onPreview={setOpenPhotoId}
                          selectionMode={selectionMode}
                          selected={selectedIds.has(tile.id)}
                          onToggleSelect={toggleSelect}
                          onLongPress={(id) => enterSelection(id)}
                          onEdit={setEditPhoto}
                          onPickCover={() => setCoverOpen(true)}
                        />
                      </div>
                    );
                  })}
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

      {editPhoto && (
        <PhotoEditModal
          open={editPhoto !== null}
          onOpenChange={(o) => { if (!o) setEditPhoto(null); }}
          photo={editPhoto}
          onSaved={() => { setEditPhoto(null); reload(); }}
        />
      )}
    </div>
  );
}
