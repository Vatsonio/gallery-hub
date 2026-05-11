import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { s3SignerClient, BUCKET } from "@/lib/minio";

export interface PresignGetOptions {
  /**
   * Optional response Content-Disposition override. When set, MinIO will
   * include this header in the response — used to force a download
   * with a stable filename instead of inline rendering. Example:
   *   responseContentDisposition: 'attachment; filename="cabo-sunset.jpg"'
   */
  responseContentDisposition?: string;
  /** Optional response Content-Type override. */
  responseContentType?: string;
}

// Presigned URLs are handed to the browser, so they must use the PUBLIC
// MinIO endpoint (MINIO_PUBLIC_ENDPOINT) rather than the internal Docker
// hostname (gallery-minio:9000) which the browser can't reach.
export async function presignPut(key: string, contentType: string, expiresInSeconds = 900): Promise<string> {
  const cmd = new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    ContentType: contentType,
  });
  return getSignedUrl(s3SignerClient, cmd, { expiresIn: expiresInSeconds });
}

export async function presignGet(
  key: string,
  expiresInSeconds = 3600,
  opts: PresignGetOptions = {},
): Promise<string> {
  const cmd = new GetObjectCommand({
    Bucket: BUCKET,
    Key: key,
    ResponseContentDisposition: opts.responseContentDisposition,
    ResponseContentType: opts.responseContentType,
  });
  return getSignedUrl(s3SignerClient, cmd, { expiresIn: expiresInSeconds });
}

/**
 * Quote a filename for use in a Content-Disposition header value.
 * Strips control chars and double-quotes to keep header parsing happy.
 */
export function contentDispositionAttachment(filename: string): string {
  const safe = filename
    .replace(/[\r\n"]/g, "")
    .replace(/[^\x20-\x7E]/g, "_") // ASCII-safe fallback
    .slice(0, 200) || "download";
  // RFC 5987 filename* lets us encode the original UTF-8 filename too.
  const encoded = encodeURIComponent(filename);
  return `attachment; filename="${safe}"; filename*=UTF-8''${encoded}`;
}
