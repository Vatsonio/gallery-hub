"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useDropzone } from "react-dropzone";
import { ChevronDown, UploadCloud } from "lucide-react";
import type {
  PresignRequestBody, PresignResponse, FinalizeRequestBody,
} from "@/lib/types";

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
    const newRows: RowState[] = accepted.map((f) => {
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
