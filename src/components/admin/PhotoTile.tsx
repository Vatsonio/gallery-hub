"use client";
import Image from "next/image";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical, MoreVertical, Star, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { setCoverAction, deletePhotoAction } from "@/app/admin/albums/actions";

export interface PhotoTileData {
  id: string;
  thumb_url: string | null;
  web_url?: string | null;
  status: "uploading" | "processing" | "ready";
  isCover: boolean;
  albumId: string;
  width: number;
  height: number;
}

export function PhotoTile({
  photo,
  onChange,
  onPreview,
}: {
  photo: PhotoTileData;
  onChange: () => void;
  onPreview?: (id: string) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: photo.id });
  const aspectRatio = photo.width && photo.height ? `${photo.width}/${photo.height}` : "1/1";
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    aspectRatio,
  };
  const displayUrl = photo.web_url ?? photo.thumb_url;
  const canPreview = Boolean(onPreview && photo.status === "ready");
  return (
    <div ref={setNodeRef} style={style} className="relative w-full overflow-hidden rounded-lg bg-zinc-900 ring-1 ring-white/5 select-none [-webkit-touch-callout:none] [-webkit-tap-highlight-color:transparent]">
      {displayUrl ? (
        <Image src={displayUrl} alt="" fill sizes="(max-width:640px) 50vw, (max-width:768px) 33vw, (max-width:1024px) 25vw, 16vw" className="object-cover" />
      ) : (
        <div className="flex h-full w-full items-center justify-center text-xs text-zinc-500">
          {photo.status}
        </div>
      )}
      {canPreview && (
        <button
          type="button"
          aria-label="Open photo"
          onClick={() => onPreview?.(photo.id)}
          className="absolute inset-0 z-0 cursor-zoom-in"
        />
      )}
      {photo.isCover && (
        <Badge className="absolute left-2 top-2 z-10 bg-rose-500/90 text-white">Cover</Badge>
      )}
      <button
        {...attributes} {...listeners}
        aria-label="Drag to reorder"
        className="absolute right-2 top-2 z-10 cursor-grab rounded bg-black/60 p-1 text-white opacity-0 transition group-hover:opacity-100"
      >
        <GripVertical className="h-3 w-3" aria-hidden />
      </button>
      <div className="absolute bottom-2 right-2 z-10">
        <DropdownMenu>
          <DropdownMenuTrigger className="cursor-pointer rounded bg-black/60 p-1 text-white">
            <MoreVertical className="h-3 w-3" aria-hidden />
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem
              className="cursor-pointer"
              onClick={async () => { await setCoverAction(photo.albumId, photo.id); onChange(); }}
            >
              <Star className="mr-2 h-3 w-3" aria-hidden /> Set as cover
            </DropdownMenuItem>
            <DropdownMenuItem
              className="cursor-pointer text-rose-300"
              onClick={async () => {
                if (confirm("Delete this photo?")) { await deletePhotoAction(photo.id); onChange(); }
              }}
            >
              <Trash2 className="mr-2 h-3 w-3" aria-hidden /> Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}
