import { sql } from "@/lib/db";

export interface StorageUsage {
  usedBytes: number;
  photoCount: number;
}

export async function getStorageUsage(): Promise<StorageUsage> {
  const rows = await sql<{ bytes: string | null; photos: number }[]>`
    SELECT COALESCE(SUM(orig_bytes), 0)::text AS bytes,
           COUNT(*)::int AS photos
      FROM photos
     WHERE status = 'ready'
  `;
  const r = rows[0];
  if (!r) return { usedBytes: 0, photoCount: 0 };
  return {
    usedBytes: r.bytes ? Number(r.bytes) : 0,
    photoCount: Number(r.photos ?? 0),
  };
}
