import Link from "next/link";
import Image from "next/image";
import { Badge } from "@/components/ui/badge";
import type { AlbumWithStats } from "@/lib/types";

function statusLabel(s: AlbumWithStats["status"]): { dot: string; text: string; className: string } {
  if (s === "published") return { dot: "●", text: "Public", className: "bg-emerald-500/15 text-emerald-300" };
  if (s === "archived") return { dot: "●", text: "Archived", className: "bg-zinc-500/15 text-zinc-300" };
  return { dot: "○", text: "Draft", className: "bg-zinc-700/30 text-zinc-300" };
}

export function AlbumCard({ album }: { album: AlbumWithStats }) {
  const s = statusLabel(album.status);
  return (
    <Link
      href={`/admin/albums/${album.slug}`}
      className="group relative block aspect-[4/3] overflow-hidden rounded-xl bg-zinc-900 cursor-pointer ring-1 ring-white/5 transition hover:ring-white/15"
    >
      {album.cover_thumb_url ? (
        <Image
          src={album.cover_thumb_url}
          alt={album.title}
          fill
          sizes="(max-width: 768px) 100vw, 33vw"
          unoptimized
          className="object-cover transition-transform duration-300 group-hover:scale-105"
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center text-zinc-600 text-sm">
          No cover
        </div>
      )}
      <div className="absolute inset-x-0 top-0 flex items-start justify-between p-3">
        <Badge className={s.className}>
          <span className="mr-1">{s.dot}</span>
          {s.text}
        </Badge>
      </div>
      <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent p-4">
        <h3 className="text-sm font-medium text-white tracking-wide">{album.title}</h3>
        {album.subtitle && <p className="text-xs text-zinc-400">{album.subtitle}</p>}
        <p className="mt-2 text-xs text-zinc-500">{album.photo_count} photo{album.photo_count === 1 ? "" : "s"}</p>
      </div>
    </Link>
  );
}
