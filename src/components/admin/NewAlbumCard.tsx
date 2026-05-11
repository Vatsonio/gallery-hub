"use client";
import { Plus } from "lucide-react";
import Link from "next/link";

export function NewAlbumCard() {
  return (
    <Link
      href="/admin/albums/new"
      className="flex aspect-[4/3] cursor-pointer flex-col items-center justify-center rounded-xl border border-dashed border-white/15 text-zinc-400 transition hover:border-rose-400/60 hover:text-rose-300"
    >
      <Plus className="h-8 w-8" aria-hidden />
      <span className="mt-2 text-sm">New album</span>
    </Link>
  );
}
