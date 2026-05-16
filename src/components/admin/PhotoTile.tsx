"use client";
import Image from "next/image";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Check, GripVertical, MoreVertical, Star, Trash2, Image as ImageIcon, Pencil } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { setCoverAction, deletePhotoAction } from "@/app/admin/albums/actions";
import { createLongPress } from "@/lib/long-press";
import { useToast } from "@/components/ui/Toast";
import { useMemo } from "react";

export interface PhotoTileData {
  id: string;
  thumb_url: string | null;
  web_url?: string | null;
  large_url?: string | null;
  status: "uploading" | "processing" | "ready";
  isCover: boolean;
  albumId: string;
  width: number;
  height: number;
}

interface Props {
  photo: PhotoTileData;
  onChange: () => void;
  onPreview?: (id: string) => void;
  /** When true, tile renders a checkbox overlay and clicks toggle selection. */
  selectionMode?: boolean;
  selected?: boolean;
  onToggleSelect?: (id: string) => void;
  /** Fired when a long-press is detected — host uses it to enter selectionMode. */
  onLongPress?: (id: string) => void;
  /** Open the photo editor (rotate/crop/brightness). */
  onEdit?: (photo: PhotoTileData) => void;
  /** Open the cover-picker dialog directly. */
  onPickCover?: () => void;
}

export function PhotoTile({
  photo,
  onChange,
  onPreview,
  selectionMode = false,
  selected = false,
  onToggleSelect,
  onLongPress,
  onEdit,
  onPickCover,
}: Props) {
  const toast = useToast();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: photo.id,
    disabled: selectionMode, // never start a drag while selecting
  });
  const aspectRatio = photo.width && photo.height ? `${photo.width}/${photo.height}` : "1/1";
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    aspectRatio,
    boxShadow: isDragging ? "0 12px 28px rgba(0,0,0,0.45)" : undefined,
    scale: isDragging ? "1.03" : undefined,
  };
  const displayUrl = photo.web_url ?? photo.thumb_url;

  const longPress = useMemo(() => {
    if (!onLongPress) return null;
    return createLongPress(() => onLongPress(photo.id), { delayMs: 500 });
  }, [onLongPress, photo.id]);

  const canPreview = Boolean(onPreview && photo.status === "ready" && !selectionMode);

  function handleTileClick() {
    if (selectionMode && onToggleSelect) {
      onToggleSelect(photo.id);
      return;
    }
    if (canPreview && onPreview) onPreview(photo.id);
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`relative w-full overflow-hidden rounded-lg bg-zinc-900 ring-1 select-none [-webkit-touch-callout:none] [-webkit-tap-highlight-color:transparent] ${
        selected ? "ring-2 ring-rose-400" : "ring-white/5"
      }`}
      onPointerDown={(e) => longPress?.onPointerDown({ clientX: e.clientX, clientY: e.clientY })}
      onPointerMove={(e) => longPress?.onPointerMove({ clientX: e.clientX, clientY: e.clientY })}
      onPointerUp={() => longPress?.onPointerUp()}
      onPointerCancel={() => longPress?.onPointerCancel()}
    >
      {displayUrl ? (
        <Image src={displayUrl} alt="" fill sizes="(max-width:640px) 50vw, (max-width:768px) 33vw, (max-width:1024px) 25vw, 16vw" unoptimized className="object-cover" />
      ) : (
        <div className="flex h-full w-full items-center justify-center text-xs text-zinc-500">
          {photo.status}
        </div>
      )}

      {(canPreview || selectionMode) && (
        <button
          type="button"
          aria-label={selectionMode ? (selected ? "Unselect photo" : "Select photo") : "Open photo"}
          onClick={handleTileClick}
          className={`absolute inset-0 z-0 ${selectionMode ? "cursor-pointer" : "cursor-zoom-in"}`}
        />
      )}

      {/* Selection checkbox (top-left, opposite the drag handle) */}
      {selectionMode && (
        <div className="pointer-events-none absolute left-2 top-2 z-10">
          <span
            className={`flex h-6 w-6 items-center justify-center rounded-full ring-2 transition ${
              selected
                ? "bg-rose-500 text-white ring-white"
                : "bg-black/60 text-transparent ring-white/70"
            }`}
          >
            <Check className="h-3 w-3" aria-hidden />
          </span>
        </div>
      )}

      {photo.isCover && !selectionMode && (
        <Badge className="absolute left-2 top-2 z-10 bg-rose-500/90 text-white">Cover</Badge>
      )}

      {!selectionMode && (
        <button
          {...attributes} {...listeners}
          aria-label="Drag to reorder"
          className="absolute right-2 top-2 z-10 cursor-grab rounded bg-black/60 p-1 text-white opacity-0 transition group-hover:opacity-100 touch-none"
        >
          <GripVertical className="h-3 w-3" aria-hidden />
        </button>
      )}

      {!selectionMode && (
        <div className="absolute bottom-2 right-2 z-10">
          <DropdownMenu>
            <DropdownMenuTrigger className="cursor-pointer rounded bg-black/60 p-1 text-white">
              <MoreVertical className="h-3 w-3" aria-hidden />
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              {onEdit && photo.status === "ready" && (
                <DropdownMenuItem className="cursor-pointer" onClick={() => onEdit(photo)}>
                  <Pencil className="mr-2 h-3 w-3" aria-hidden /> Edit
                </DropdownMenuItem>
              )}
              <DropdownMenuItem
                className="cursor-pointer"
                onClick={async () => {
                  try {
                    await setCoverAction(photo.albumId, photo.id);
                    toast.success("Cover updated");
                    onChange();
                  } catch {
                    toast.error("Could not update cover");
                  }
                }}
              >
                <Star className="mr-2 h-3 w-3" aria-hidden /> Set as cover
              </DropdownMenuItem>
              {onPickCover && (
                <DropdownMenuItem className="cursor-pointer" onClick={onPickCover}>
                  <ImageIcon className="mr-2 h-3 w-3" aria-hidden /> Choose cover…
                </DropdownMenuItem>
              )}
              <DropdownMenuItem
                className="cursor-pointer text-rose-300"
                onClick={async () => {
                  if (!confirm("Delete this photo?")) return;
                  try {
                    await deletePhotoAction(photo.id);
                    toast.success("Photo deleted");
                    onChange();
                  } catch {
                    toast.error("Delete failed");
                  }
                }}
              >
                <Trash2 className="mr-2 h-3 w-3" aria-hidden /> Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}
    </div>
  );
}
