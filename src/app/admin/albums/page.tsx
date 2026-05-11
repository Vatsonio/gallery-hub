import { Plus, Images } from "lucide-react";

export default function AlbumsPage() {
  return (
    <div className="px-8 py-8">
      <header className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-semibold tracking-wider">Albums</h1>
          <p className="text-text-muted text-sm mt-1">Create albums and share them with clients.</p>
        </div>
        <button
          type="button"
          disabled
          title="Album creation lands in M2"
          className="inline-flex items-center gap-2 rounded-lg bg-bg-card border border-line px-3 py-2 text-sm text-text-muted cursor-not-allowed"
        >
          <Plus className="size-4" />
          New album
        </button>
      </header>

      <div className="rounded-2xl border border-dashed border-line p-12 flex flex-col items-center justify-center text-center bg-bg-elevated">
        <div className="size-12 rounded-full bg-bg-card border border-line flex items-center justify-center mb-4">
          <Images className="size-5 text-text-muted" />
        </div>
        <p className="text-sm font-medium">No albums yet</p>
        <p className="text-text-muted text-sm mt-1 max-w-sm">
          Album creation, photo uploads, and share links arrive in the next milestone.
        </p>
      </div>
    </div>
  );
}
