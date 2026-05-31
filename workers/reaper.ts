import { ListObjectsV2Command, DeleteObjectsCommand } from "@aws-sdk/client-s3";
import { s3Client, BUCKET } from "@/lib/minio";
import { listSoftDeletedAlbumIds, hardDeleteAlbum } from "@/lib/albums";

/**
 * Delete every object under `prefix`. Returns true only if the storage
 * was fully cleared. F23: DeleteObjects returns HTTP 200 even when
 * individual keys fail — the failures appear in the `Errors` array, which
 * the previous code ignored before unconditionally hard-deleting the DB
 * row, orphaning any objects that failed to delete (no row left to point
 * at them, no future pass to revisit). We now surface partial failure so
 * the caller can keep the album soft-deleted for the next sweep.
 */
async function deletePrefix(prefix: string): Promise<boolean> {
  let token: string | undefined;
  let clean = true;
  do {
    const list = await s3Client.send(new ListObjectsV2Command({
      Bucket: BUCKET, Prefix: prefix, ContinuationToken: token,
    }));
    const keys = (list.Contents ?? []).map((o) => ({ Key: o.Key! })).filter((k) => k.Key);
    if (keys.length > 0) {
      const res = await s3Client.send(new DeleteObjectsCommand({
        Bucket: BUCKET,
        Delete: { Objects: keys, Quiet: true },
      }));
      if (res.Errors && res.Errors.length > 0) {
        clean = false;
        console.error(
          `[reaper] ${res.Errors.length} object(s) failed to delete under ${prefix}`,
          res.Errors.slice(0, 3).map((e) => ({ key: e.Key, code: e.Code, msg: e.Message })),
        );
      }
    }
    token = list.IsTruncated ? list.NextContinuationToken : undefined;
  } while (token);
  return clean;
}

export async function handleReap(): Promise<void> {
  // System worker — no admin in the loop. The owner-role branch of
  // listSoftDeletedAlbumIds returns rows across every workspace, which
  // is what we want here (sweep all admins' deleted albums). userId is
  // ignored on the owner path.
  const ids = await listSoftDeletedAlbumIds({ userId: "system", role: "owner" });
  for (const id of ids) {
    const clean = await deletePrefix(`albums/${id}/`);
    if (!clean) {
      // Leave the album soft-deleted (deleted_at still set) so the next
      // hourly pass retries; hard-deleting now would orphan the objects
      // that failed to delete.
      console.error(`[reaper] skipping hard-delete of album ${id} — storage not fully cleared, will retry next pass`);
      continue;
    }
    await hardDeleteAlbum(id);
  }
}
