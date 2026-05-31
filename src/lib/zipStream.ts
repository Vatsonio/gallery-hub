import archiver from "archiver";
import { PassThrough, type Readable } from "node:stream";
import { sanitizeFilename } from "@/lib/sanitize";

export interface ZipEntry {
  /** Filename inside the ZIP, e.g. "001-IMG_0001.jpg". */
  name: string;
  /** Source stream — typically a MinIO GetObject body. */
  body: Readable | Buffer;
}

/**
 * Defense-in-depth: re-sanitize every ZIP entry name at the archive boundary,
 * even though callers already sanitize at the upload site (F7). A buggy or
 * legacy DB row with `../etc/passwd` in `filename` must not produce a slip-
 * vulnerable archive. We additionally guarantee the name has no path
 * separator (archivers happily emit nested paths if you ask them to).
 */
function safeEntryName(raw: string): string {
  // sanitizeFilename strips `/`, `\`, control chars, leading dots, and NFC-
  // normalizes. Whatever the caller passed (even a prefixed `001-`), we feed
  // the whole string through and trust the output as a single flat name.
  return sanitizeFilename(raw);
}

export interface FanOutZipHandles {
  /** ZIP bytes destined for the HTTP response. */
  toHttp: PassThrough;
  /** Same ZIP bytes destined for the MinIO cache upload. */
  toMinio: PassThrough;
  /** Resolves when the archive has finalized (or rejects on error). */
  done: Promise<void>;
}

/**
 * Build a ZIP archive on the fly and fan its output to two destinations
 * simultaneously: the HTTP response and a MinIO PutObject upload. Both
 * passthroughs MUST be consumed otherwise backpressure will stall the
 * archiver. We deliberately use store-only ("level 0") — JPEG/WebP are
 * already compressed and DEFLATE just burns CPU for ~0% gain.
 */
export function createFanOutZip(entries: AsyncIterable<ZipEntry>): FanOutZipHandles {
  const archive = archiver("zip", { store: true });
  const toHttp = new PassThrough();
  const toMinio = new PassThrough();

  const errored = (err: Error): void => {
    if (!toHttp.destroyed) toHttp.destroy(err);
    if (!toMinio.destroyed) toMinio.destroy(err);
  };

  archive.on("error", errored);
  archive.on("warning", (err) => {
    // ENOENT warnings should never happen for streams, but surface anything
    // else as a hard failure.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") errored(err);
  });

  // Fan-out with real backpressure (F4). The previous handler wrote each
  // chunk to both passthroughs and ignored the boolean return of write(),
  // never pausing the archiver — so the slower of the two consumers (a
  // trickling HTTP client vs the MinIO upload) let its passthrough buffer
  // grow without bound, OOM-killing the process on a large export. We now
  // pause the archiver whenever EITHER consumer signals it's full and only
  // resume once BOTH have drained, bounding in-flight memory to the
  // passthrough highWaterMarks and gating throughput on the slower side.
  let httpReady = true;
  let minioReady = true;
  const maybeResume = (): void => {
    if (httpReady && minioReady) archive.resume();
  };
  archive.on("data", (chunk: Buffer) => {
    const okHttp = toHttp.write(chunk);
    const okMinio = toMinio.write(chunk);
    if (!okHttp) httpReady = false;
    if (!okMinio) minioReady = false;
    if (!okHttp || !okMinio) archive.pause();
  });
  toHttp.on("drain", () => {
    httpReady = true;
    maybeResume();
  });
  toMinio.on("drain", () => {
    minioReady = true;
    maybeResume();
  });
  archive.on("end", () => {
    toHttp.end();
    toMinio.end();
  });

  const done = (async () => {
    try {
      for await (const e of entries) {
        archive.append(e.body, { name: safeEntryName(e.name) });
      }
      await archive.finalize();
    } catch (err) {
      errored(err as Error);
      throw err;
    }
  })();

  return { toHttp, toMinio, done };
}
