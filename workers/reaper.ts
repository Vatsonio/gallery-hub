import { ListObjectsV2Command, DeleteObjectsCommand } from "@aws-sdk/client-s3";
import { s3Client, BUCKET } from "@/lib/minio";
import { listSoftDeletedAlbumIds, hardDeleteAlbum } from "@/lib/albums";

async function deletePrefix(prefix: string): Promise<void> {
  let token: string | undefined;
  do {
    const list = await s3Client.send(new ListObjectsV2Command({
      Bucket: BUCKET, Prefix: prefix, ContinuationToken: token,
    }));
    const keys = (list.Contents ?? []).map((o) => ({ Key: o.Key! })).filter((k) => k.Key);
    if (keys.length > 0) {
      await s3Client.send(new DeleteObjectsCommand({
        Bucket: BUCKET,
        Delete: { Objects: keys, Quiet: true },
      }));
    }
    token = list.IsTruncated ? list.NextContinuationToken : undefined;
  } while (token);
}

export async function handleReap(): Promise<void> {
  const ids = await listSoftDeletedAlbumIds();
  for (const id of ids) {
    await deletePrefix(`albums/${id}/`);
    await hardDeleteAlbum(id);
  }
}
