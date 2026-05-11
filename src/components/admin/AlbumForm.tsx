"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createAlbumAction, updateAlbumAction } from "@/app/admin/albums/actions";
import type { AlbumRow, AlbumStatus } from "@/lib/types";

interface Props {
  mode: "create" | "edit";
  initial?: Pick<AlbumRow, "id" | "title" | "subtitle" | "status">;
}

export function AlbumForm({ mode, initial }: Props) {
  const router = useRouter();
  const [title, setTitle] = useState(initial?.title ?? "");
  const [subtitle, setSubtitle] = useState(initial?.subtitle ?? "");
  const [status, setStatus] = useState<AlbumStatus>(initial?.status ?? "draft");
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    start(async () => {
      try {
        if (mode === "create") {
          const slug = await createAlbumAction({ title, subtitle: subtitle || null, status });
          router.push(`/admin/albums/${slug}`);
        } else if (initial) {
          await updateAlbumAction(initial.id, { title, subtitle: subtitle || null, status });
          router.refresh();
        }
      } catch (e) {
        setErr((e as Error).message);
      }
    });
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <div>
        <Label htmlFor="title">Title</Label>
        <Input id="title" value={title} onChange={(e) => setTitle(e.target.value)} required minLength={1} maxLength={120} />
      </div>
      <div>
        <Label htmlFor="subtitle">Subtitle</Label>
        <Input id="subtitle" value={subtitle} onChange={(e) => setSubtitle(e.target.value)} maxLength={200} />
      </div>
      <div>
        <Label htmlFor="status">Status</Label>
        <select
          id="status"
          value={status}
          onChange={(e) => setStatus(e.target.value as AlbumStatus)}
          className="block w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-rose-400"
        >
          <option value="draft">Draft</option>
          <option value="published">Published</option>
          <option value="archived">Archived</option>
        </select>
      </div>
      {err && <p className="text-sm text-rose-400">{err}</p>}
      <Button type="submit" disabled={pending} className="cursor-pointer">
        {pending ? "Saving…" : mode === "create" ? "Create album" : "Save"}
      </Button>
    </form>
  );
}
