"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Dropzone } from "./Dropzone";
import { PhotoGrid } from "./PhotoGrid";

interface Props {
  albumId: string;
  slug: string;
}

/**
 * Pairs the Dropzone with the PhotoGrid so that finishing an upload
 * immediately re-fetches the grid and refreshes the server-rendered
 * album page (stats, share-link summary, etc). Without this wrapper
 * the grid would only reload on the next manual page refresh.
 */
export default function AlbumUploadAndGrid({ albumId, slug }: Props) {
  const router = useRouter();
  const [refreshKey, setRefreshKey] = useState(0);

  function onUploadComplete() {
    setRefreshKey((k) => k + 1);
    // router.refresh re-fetches the server component so header stats,
    // photo count, and share-link counters update without a hard reload.
    router.refresh();
  }

  return (
    <div className="space-y-8">
      <section>
        <h2 className="mb-3 text-sm font-medium uppercase tracking-wider text-zinc-500">Upload</h2>
        <Dropzone albumId={albumId} onComplete={onUploadComplete} />
      </section>
      <section>
        <h2 className="mb-3 text-sm font-medium uppercase tracking-wider text-zinc-500">Photos</h2>
        <PhotoGrid
          slug={slug}
          refreshKey={refreshKey}
          onPendingResolved={() => router.refresh()}
        />
      </section>
    </div>
  );
}
