"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useDropzone } from "react-dropzone";
import { CheckCircle2, ChevronDown, UploadCloud } from "lucide-react";
import type {
  PresignRequestBody, PresignResponse, FinalizeRequestBody,
} from "@/lib/types";
import { formatBytes, formatDuration, formatEta, formatRate } from "@/lib/format";
import { useCountUpInt } from "@/lib/useCountUp";

interface Props {
  albumId: string;
  onComplete?: () => void;
}

interface RowState {
  id: string;            // local key
  filename: string;
  size: number;
  contentType: string;
  width?: number;
  height?: number;
  photoId?: string;
  progress: number;      // 0..100
  status: "pending" | "uploading" | "uploaded" | "error";
  error?: string;
}

/**
 * Sample of "bytes uploaded by wall-clock time", retained for the rolling
 * throughput calculation. We trim entries older than 3s on each push so
 * the average stays responsive to network speed changes without flapping
 * frame-to-frame.
 */
interface ThroughputSample {
  at: number;
  bytes: number;
}

const THROUGHPUT_WINDOW_MS = 3000;

/**
 * Returns rolling-average bytes-per-second over the last 3 seconds of
 * samples. We compute against the *earliest* in-window sample rather
 * than wall-clock so paused tabs don't divide by a huge denominator and
 * report 0 B/s when the upload immediately resumes.
 */
function computeRate(samples: ThroughputSample[]): number {
  if (samples.length < 2) return 0;
  const earliest = samples[0];
  const latest = samples[samples.length - 1];
  const dtMs = latest.at - earliest.at;
  if (dtMs <= 0) return 0;
  const dBytes = latest.bytes - earliest.bytes;
  return Math.max(0, (dBytes / dtMs) * 1000);
}

/**
 * Top-of-upload summary chrome. Renders a live progress bar, the
 * uploaded/total file counter, elapsed / ETA timers, throughput, and
 * total bytes. When uploads finish it cross-fades into a soft success
 * chip that lingers 4s before being dismissed by the parent component.
 *
 * Tick cadence:
 *   * `nowTick` advances every 100ms so the elapsed timer reads smoothly.
 *   * Throughput and ETA recompute on the same tick (they're cheap maths
 *     over a small sample buffer).
 *   * Count-up animations are driven by useCountUp's RAF loop, so the
 *     headline numbers feel snappy without an extra interval.
 */
function UploadSummaryStrip({
  rows,
  startedAt,
  finishedAt,
  bytesTotal,
  bytesUploaded,
  filesTotal,
  filesUploaded,
  filesErrored,
}: {
  rows: RowState[];
  startedAt: number | null;
  finishedAt: number | null;
  bytesTotal: number;
  bytesUploaded: number;
  filesTotal: number;
  filesUploaded: number;
  filesErrored: number;
}): React.JSX.Element | null {
  const [nowTick, setNowTick] = useState<number>(() => Date.now());
  const samplesRef = useRef<ThroughputSample[]>([]);

  // Drive a 100ms heartbeat while uploads are in flight so timers and
  // throughput stay live. Stop the heartbeat once the success chip has
  // been displayed for long enough to be observed; the parent ultimately
  // hides this component after the same window expires.
  useEffect(() => {
    if (startedAt === null) return;
    if (finishedAt !== null && nowTick - finishedAt > 4500) return;
    const id = window.setInterval(() => setNowTick(Date.now()), 100);
    return () => window.clearInterval(id);
    // We deliberately depend on the booleans (startedAt/finishedAt) and
    // not on `nowTick` itself — the interval is the only thing that
    // should drive `nowTick`. eslint-disable-next-line.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startedAt, finishedAt]);

  // Push a throughput sample on every nowTick — but only while uploading,
  // not after completion. Drop entries that fall outside the rolling
  // window so the buffer stays bounded.
  useEffect(() => {
    if (startedAt === null || finishedAt !== null) return;
    const buf = samplesRef.current;
    buf.push({ at: nowTick, bytes: bytesUploaded });
    const cutoff = nowTick - THROUGHPUT_WINDOW_MS;
    while (buf.length > 1 && buf[0].at < cutoff) buf.shift();
  }, [nowTick, bytesUploaded, startedAt, finishedAt]);

  // Headline counter animates from the previous "uploaded" count to the
  // current one. Even on a fast LAN where files complete back-to-back,
  // this gives the eye a moment to read the count change.
  const animatedUploaded = useCountUpInt(filesUploaded, { durationMs: 400 });
  // Bytes don't use the same count-up — they're already changing rapidly
  // on every chunk, and double-animating produces choppy text. Render
  // them straight.

  if (startedAt === null) return null;

  const elapsedSec = ((finishedAt ?? nowTick) - startedAt) / 1000;
  const fraction = bytesTotal > 0 ? Math.min(1, bytesUploaded / bytesTotal) : 0;
  const rate = finishedAt === null ? computeRate(samplesRef.current) : (bytesTotal / Math.max(elapsedSec, 0.001));
  const remainingBytes = Math.max(0, bytesTotal - bytesUploaded);
  const etaSec = rate > 0 && remainingBytes > 0 ? remainingBytes / rate : null;

  const allDone = finishedAt !== null && filesErrored === 0 && filesUploaded === filesTotal;

  return (
    <div
      className="mb-3 rounded-xl border border-white/5 bg-white/[0.03] p-4 ring-1 ring-white/5 transition-opacity duration-300"
      role="status"
      aria-live="polite"
    >
      {allDone ? (
        <div className="flex items-center gap-2 text-sm">
          <CheckCircle2 className="h-4 w-4 text-emerald-400" aria-hidden />
          <span className="text-white/90">
            {filesTotal} {filesTotal === 1 ? "photo" : "photos"} uploaded in {formatDuration(elapsedSec)}
          </span>
          <span className="text-white/40">·</span>
          <span className="tabular-nums text-white/60">{formatRate((bytesTotal / Math.max(elapsedSec, 0.001)))} avg</span>
        </div>
      ) : (
        <>
          <div className="mb-2 flex items-baseline justify-between gap-3">
            <p className="text-sm text-white/90">
              Uploading{" "}
              <span className="tabular-nums font-medium text-white">{animatedUploaded}</span>{" "}
              <span className="text-white/40">of</span>{" "}
              <span className="tabular-nums font-medium text-white">{filesTotal}</span>
              {filesErrored > 0 && (
                <span className="ml-2 text-xs text-rose-300">· {filesErrored} failed</span>
              )}
            </p>
            <p className="tabular-nums text-xs text-white/60">
              {Math.round(fraction * 100)}%
            </p>
          </div>
          <div className="relative h-1.5 overflow-hidden rounded-full bg-white/5">
            <div
              className="absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-rose-500 via-rose-400 to-rose-300 transition-[width] duration-200 ease-out"
              style={{ width: `${fraction * 100}%` }}
            />
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
            <Stat label="Elapsed" value={formatDuration(elapsedSec)} />
            <Stat label="ETA" value={formatEta(etaSec) ?? "—"} />
            <Stat label="Throughput" value={formatRate(rate)} />
            <Stat label="Bytes" value={`${formatBytes(bytesUploaded)} / ${formatBytes(bytesTotal)}`} />
          </div>
        </>
      )}
      {/* When unhandled state — rows present but nothing in flight — render nothing extra here. */}
      <span className="sr-only">{rows.length} files queued</span>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] uppercase tracking-widest text-white/40">{label}</span>
      <span className="tabular-nums text-white/85">{value}</span>
    </div>
  );
}

async function measure(file: File): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new window.Image();
    img.onload = () => {
      const r = { width: img.naturalWidth, height: img.naturalHeight };
      URL.revokeObjectURL(url);
      resolve(r);
    };
    img.onerror = (e) => { URL.revokeObjectURL(url); reject(e); };
    img.src = url;
  });
}

function uploadXHR(url: string, file: File, onProgress: (p: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.setRequestHeader("Content-Type", file.type);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) return resolve();
      // Surface the server response so we can diagnose 4xx/5xx instead of guessing.
      const body = (xhr.responseText || "").slice(0, 240).replace(/\s+/g, " ");
      console.error("[upload] PUT failed", { url, status: xhr.status, body });
      reject(new Error(`PUT ${xhr.status}: ${body || xhr.statusText || "no body"}`));
    };
    xhr.onerror = () => {
      console.error("[upload] PUT network error (CORS/DNS/refused)", { url });
      reject(new Error("network error (likely CORS or unreachable — open DevTools Network tab)"));
    };
    xhr.send(file);
  });
}

export function Dropzone({ albumId, onComplete }: Props) {
  const [rows, setRows] = useState<RowState[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [finishedAt, setFinishedAt] = useState<number | null>(null);
  const [showSummary, setShowSummary] = useState(false);
  const fileMap = useRef<Map<string, File>>(new Map());

  // Drive the collapse: expand the moment work appears, collapse the
  // moment everything has finished (uploaded or errored). Errors keep
  // the panel open so the user notices what failed.
  const inFlight = useMemo(
    () => rows.some((r) => r.status === "pending" || r.status === "uploading"),
    [rows],
  );
  const hasErrors = useMemo(
    () => rows.some((r) => r.status === "error"),
    [rows],
  );

  // Aggregate metrics for the top summary strip. Bytes-uploaded is
  // derived from progress% × file size so the headline number actually
  // reflects bytes flushed to MinIO, not files completed — a single 50MB
  // RAW shouldn't sit at "0 MB / 980 MB" until it lands.
  const summary = useMemo(() => {
    let bytesTotal = 0;
    let bytesUploaded = 0;
    let filesUploaded = 0;
    let filesErrored = 0;
    for (const r of rows) {
      bytesTotal += r.size;
      if (r.status === "error") {
        filesErrored++;
      } else if (r.status === "uploaded") {
        bytesUploaded += r.size;
        filesUploaded++;
      } else if (r.status === "uploading") {
        bytesUploaded += Math.round((r.progress / 100) * r.size);
      }
    }
    return { bytesTotal, bytesUploaded, filesUploaded, filesErrored };
  }, [rows]);

  // Mark the timer's start the first frame any file is in flight, and
  // stop it when nothing is in flight any longer. The timer keeps
  // ticking via the summary strip until parent state clears it.
  useEffect(() => {
    if (rows.length === 0) {
      setStartedAt(null);
      setFinishedAt(null);
      setShowSummary(false);
      return;
    }
    if (inFlight && startedAt === null) {
      setStartedAt(Date.now());
      setFinishedAt(null);
      setShowSummary(true);
    } else if (!inFlight && startedAt !== null && finishedAt === null) {
      setFinishedAt(Date.now());
    }
  }, [rows.length, inFlight, startedAt, finishedAt]);

  // After successful completion the success chip lingers 4s, then fades
  // away to keep the upload UI uncluttered.
  useEffect(() => {
    if (finishedAt === null) return;
    const t = window.setTimeout(() => setShowSummary(false), 4000);
    return () => window.clearTimeout(t);
  }, [finishedAt]);

  useEffect(() => {
    if (rows.length === 0) return;
    if (inFlight || hasErrors) {
      setExpanded(true);
    } else {
      // small delay so the user sees the last "100%" before it tucks away.
      const t = setTimeout(() => setExpanded(false), 1200);
      return () => clearTimeout(t);
    }
  }, [inFlight, hasErrors, rows.length]);

  const onDrop = useCallback(async (accepted: File[]) => {
    // Browsers (and react-dropzone) don't guarantee the dropped File[]
    // order matches the photographer's intent — Windows Explorer drag
    // often hands them back in OS selection order or arbitrary indexed
    // order, and `Promise.all(measure)` can't reorder anything because
    // the issue is upstream. Sort by filename with numeric-aware compare
    // ("DSC0009.jpg" < "DSC0010.jpg") so the gallery's sort_order matches
    // the natural camera-roll sequence.
    const sortedAccepted = [...accepted].sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }),
    );
    const newRows: RowState[] = sortedAccepted.map((f) => {
      const id = crypto.randomUUID();
      fileMap.current.set(id, f);
      return {
        id, filename: f.name, size: f.size, contentType: f.type || "image/jpeg",
        progress: 0, status: "pending",
      };
    });
    setRows((prev) => [...prev, ...newRows]);

    await Promise.all(newRows.map(async (r) => {
      try {
        const dim = await measure(fileMap.current.get(r.id)!);
        setRows((prev) => prev.map((x) => x.id === r.id ? { ...x, ...dim } : x));
        r.width = dim.width; r.height = dim.height;
      } catch {
        setRows((prev) => prev.map((x) => x.id === r.id ? { ...x, status: "error", error: "could not read image" } : x));
      }
    }));

    const body: PresignRequestBody = {
      album_id: albumId,
      files: newRows
        .filter((r) => r.width && r.height)
        .map((r) => ({ filename: r.filename, size: r.size, contentType: r.contentType })),
    };
    const presignRes = await fetch("/api/upload/presign", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!presignRes.ok) {
      setRows((prev) => prev.map((x) => newRows.some((n) => n.id === x.id) ? { ...x, status: "error", error: "presign failed" } : x));
      return;
    }
    const { items } = (await presignRes.json()) as PresignResponse;

    const eligible = newRows.filter((r) => r.width && r.height);
    eligible.forEach((r, i) => { r.photoId = items[i].photo_id; });
    setRows((prev) => prev.map((x) => {
      const e = eligible.find((er) => er.id === x.id);
      return e ? { ...x, photoId: e.photoId, status: "uploading" } : x;
    }));

    const queue = [...eligible];
    async function worker() {
      while (queue.length > 0) {
        const r = queue.shift()!;
        const idx = eligible.indexOf(r);
        const url = items[idx].put_url;
        const file = fileMap.current.get(r.id)!;
        try {
          await uploadXHR(url, file, (p) =>
            setRows((prev) => prev.map((x) => x.id === r.id ? { ...x, progress: p } : x))
          );
          setRows((prev) => prev.map((x) => x.id === r.id ? { ...x, status: "uploaded", progress: 100 } : x));
        } catch (e) {
          setRows((prev) => prev.map((x) => x.id === r.id ? { ...x, status: "error", error: (e as Error).message } : x));
        }
      }
    }
    // Concurrency floor. With 150 files × 5–15 MB each going to MinIO, four
    // workers is the dominant client-side bottleneck — the browser supports
    // dozens of concurrent connections to a single host and MinIO scales
    // out PUT throughput linearly to ~16 streams. Default 10 lands the
    // sweet spot on consumer hardware (200-file batches drop ~50% in
    // wall-clock vs four workers) without saturating slow uplinks. Override
    // via NEXT_PUBLIC_UPLOAD_CONCURRENCY for tuning.
    const envConc = parseInt(process.env.NEXT_PUBLIC_UPLOAD_CONCURRENCY ?? "", 10);
    const concurrency = Math.max(1, Math.min(32, Number.isFinite(envConc) && envConc > 0 ? envConc : 10));
    const workers: Promise<void>[] = [];
    for (let i = 0; i < concurrency; i++) workers.push(worker());
    await Promise.all(workers);

    const finalizeBody: FinalizeRequestBody = {
      album_id: albumId,
      photos: eligible
        .filter((r) => r.photoId && r.width && r.height)
        .map((r) => ({
          photo_id: r.photoId!, filename: r.filename,
          width: r.width!, height: r.height!, size: r.size,
        })),
    };
    if (finalizeBody.photos.length > 0) {
      await fetch("/api/upload/finalize", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(finalizeBody),
      });
    }
    onComplete?.();
  }, [albumId, onComplete]);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: { "image/jpeg": [".jpg", ".jpeg"], "image/png": [".png"], "image/webp": [".webp"] },
    multiple: true,
  });

  return (
    <div>
      <div
        {...getRootProps()}
        className={`flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed p-10 transition ${
          isDragActive ? "border-rose-400 bg-rose-400/5" : "border-white/10 hover:border-white/25"
        }`}
      >
        <input {...getInputProps()} />
        <UploadCloud className="h-8 w-8 text-zinc-400" aria-hidden />
        <p className="mt-3 text-sm text-zinc-300">
          {isDragActive ? "Drop to upload" : "Drag photos here, or click to select"}
        </p>
        <p className="mt-1 text-xs text-zinc-500">JPG / PNG / WebP, up to 50 MB each</p>
      </div>
      {showSummary && (
        <div className="mt-4">
          <UploadSummaryStrip
            rows={rows}
            startedAt={startedAt}
            finishedAt={finishedAt}
            bytesTotal={summary.bytesTotal}
            bytesUploaded={summary.bytesUploaded}
            filesTotal={rows.length}
            filesUploaded={summary.filesUploaded}
            filesErrored={summary.filesErrored}
          />
        </div>
      )}
      {rows.length > 0 && (
        <div className="mt-4">
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="flex w-full items-center justify-between gap-3 rounded-lg border border-white/5 bg-white/[0.02] px-3 py-2 text-xs text-zinc-300 hover:bg-white/[0.04] transition cursor-pointer"
          >
            <span className="flex items-center gap-2">
              <span className="font-medium text-white/80">
                {inFlight
                  ? `Uploading ${rows.filter((r) => r.status === "uploaded").length} / ${rows.length}`
                  : hasErrors
                    ? `${rows.filter((r) => r.status === "error").length} error${rows.filter((r) => r.status === "error").length === 1 ? "" : "s"}`
                    : `${rows.length} uploaded`}
              </span>
              {!inFlight && !hasErrors && (
                <span className="text-emerald-400/80">✓</span>
              )}
            </span>
            <ChevronDown
              className={`h-4 w-4 text-zinc-400 transition-transform duration-300 ${expanded ? "rotate-180" : ""}`}
              aria-hidden
            />
          </button>
          <div
            className={`grid transition-[grid-template-rows] duration-300 ease-out ${expanded ? "grid-rows-[1fr]" : "grid-rows-[0fr]"}`}
          >
            <div className="overflow-hidden">
              <ul className="mt-2 max-h-72 space-y-1 overflow-y-auto pr-1 text-xs">
                {rows.map((r) => (
                  <li key={r.id} className="flex items-center gap-2 text-zinc-400">
                    <span className="w-48 truncate">{r.filename}</span>
                    <span className="flex-1">
                      <span className="block h-1 overflow-hidden rounded bg-zinc-800">
                        <span
                          className={`block h-full ${r.status === "error" ? "bg-rose-500" : "bg-rose-400"}`}
                          style={{ width: `${r.progress}%` }}
                        />
                      </span>
                    </span>
                    <span className="w-20 text-right">
                      {r.status === "error" ? r.error : `${r.progress}%`}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
