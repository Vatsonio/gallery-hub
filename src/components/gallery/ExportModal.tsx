"use client";

import { useEffect, useState } from "react";
import { Download, FileImage, Heart, ImageIcon, Loader2, X, type LucideIcon } from "lucide-react";
import { useToast } from "@/components/ui/Toast";

export type ExportOptionId = "favorites-original" | "all-web" | "all-original";

export interface ExportOption {
  id: ExportOptionId;
  scope: "favorites" | "all";
  variant: "original" | "web";
  icon: LucideIcon;
  title: string;
  subtitle: string;
  bytes: number;
  /**
   * Prefix the size with "≈" — set for variants whose final ZIP size
   * we don't know until imgproxy renders (currently the web variant,
   * an estimate of ~22% of the originals).
   */
  approxBytes?: boolean;
  /** Disable selection (e.g. zero favorites). */
  disabled?: boolean;
}

interface Props {
  open: boolean;
  onClose: () => void;
  token: string;
  options: ExportOption[];
  /**
   * Preselect a specific option on open. Falls back to the first
   * enabled option if the preselect is missing or disabled.
   */
  preselect?: ExportOptionId;
}

/**
 * Mirror of the route's ExportErrorReason union. Kept in sync by
 * matching against `reason` strings — TypeScript can't enforce that
 * across a network boundary, so the runtime defaults gracefully if a
 * server adds a new code the client hasn't shipped yet.
 */
type KnownReason =
  | "no_favorites"
  | "admin_preview_no_favorites"
  | "empty_album"
  | "download_disabled"
  | "rate_limited"
  | "locked"
  | "expired"
  | "not_found"
  | "bad_params";

interface ProbeError {
  reason: KnownReason | string;
  message: string;
}

/**
 * Run a side-effect-free pre-flight against the export route. Returns
 * `null` on success (204) and a structured error on any 4xx/5xx. We
 * deliberately swallow network errors into a generic "try again" so
 * the modal still recovers from a transient blip — the user can
 * retry from the same UI.
 *
 * Exported so the unit test can exercise the branches against a
 * mocked global fetch without rendering the component tree.
 */
export async function probeExport(
  token: string,
  scope: string,
  variant: string,
): Promise<ProbeError | null> {
  try {
    const res = await fetch(
      `/api/export/${token}?scope=${scope}&variant=${variant}&probe=1`,
      { method: "GET", credentials: "same-origin" },
    );
    if (res.status === 204) return null;
    const text = await res.text();
    try {
      const parsed = JSON.parse(text) as ProbeError;
      if (typeof parsed.message === "string" && typeof parsed.reason === "string") {
        return parsed;
      }
    } catch {
      // pre-JSON server (rolling deploy) or HTML error page — fall through
    }
    return {
      reason: "unknown",
      message: text || `Export failed (HTTP ${res.status}).`,
    };
  } catch {
    return {
      reason: "network",
      message: "Couldn't reach the server. Please try again.",
    };
  }
}

function fmtBytes(b: number): string {
  if (b <= 0) return "—";
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 ** 3) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  return `${(b / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export default function ExportModal({
  open,
  onClose,
  token,
  options,
  preselect,
}: Props) {
  const toast = useToast();
  const firstEnabled = options.find((o) => !o.disabled)?.id ?? options[0]?.id;
  const initial =
    preselect && options.some((o) => o.id === preselect && !o.disabled)
      ? preselect
      : firstEnabled;
  const [selected, setSelected] = useState<ExportOptionId | undefined>(initial);
  const [submitting, setSubmitting] = useState(false);

  // Reset selection whenever the modal opens so a stale id doesn't survive
  // option-list changes (e.g. after the favorites set shifts). Honor the
  // caller's preselect when valid.
  useEffect(() => {
    if (open) {
      const target =
        preselect && options.some((o) => o.id === preselect && !o.disabled)
          ? preselect
          : firstEnabled;
      setSelected(target);
    }
  }, [open, firstEnabled, preselect, options]);

  // Esc-to-close.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  const active = options.find((o) => o.id === selected && !o.disabled);

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/80 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby="export-modal-title"
    >
      <div
        className="w-full sm:max-w-md bg-neutral-950 border-t sm:border border-white/10 sm:rounded-2xl p-6 pb-[max(1.5rem,env(safe-area-inset-bottom))]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-5">
          <h2 id="export-modal-title" className="text-white text-lg font-medium tracking-wide">
            Export
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="text-neutral-400 hover:text-white transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="space-y-2 mb-6">
          {options.map((opt) => {
            const sel = opt.id === selected && !opt.disabled;
            const Icon = opt.icon;
            return (
              <button
                key={opt.id}
                type="button"
                disabled={opt.disabled}
                onClick={() => !opt.disabled && setSelected(opt.id)}
                className={`w-full flex items-center gap-3 p-4 rounded-xl border text-left transition
                  ${opt.disabled
                    ? "border-white/5 bg-white/[0.01] opacity-50 cursor-not-allowed"
                    : sel
                      ? "border-rose-500/70 bg-rose-500/5"
                      : "border-white/10 bg-white/[0.02] hover:border-white/20"}`}
              >
                <div
                  className={`w-10 h-10 rounded-lg flex items-center justify-center
                    ${sel ? "bg-rose-500/15 text-rose-400" : "bg-white/[0.04] text-neutral-400"}`}
                >
                  <Icon className="w-5 h-5" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-white text-sm font-medium">{opt.title}</div>
                  <div className="text-neutral-400 text-xs mt-0.5">{opt.subtitle}</div>
                </div>
                <div className="text-neutral-500 text-xs tabular-nums">
                  {opt.approxBytes && opt.bytes > 0 ? "≈ " : ""}
                  {fmtBytes(opt.bytes)}
                </div>
              </button>
            );
          })}
        </div>

        {active ? (
          <button
            type="button"
            disabled={submitting}
            onClick={async () => {
              if (submitting) return;
              setSubmitting(true);
              try {
                // Pre-flight the server. The probe tells us whether the
                // download would succeed without starting the zip stream —
                // a black "nothing to export" page is impossible by
                // construction because we never navigate to the URL
                // unless the server has greenlit it.
                const err = await probeExport(token, active.scope, active.variant);
                if (err) {
                  toast.warning(err.message);
                  return;
                }
                // Honest 200 — trigger the real download. We use
                // window.location.assign to drive the browser's native
                // file-save UX (Content-Disposition: attachment) rather
                // than a hidden anchor click; the streaming response
                // never replaces the gallery page.
                window.location.assign(
                  `/api/export/${token}?scope=${active.scope}&variant=${active.variant}`,
                );
                onClose();
              } finally {
                setSubmitting(false);
              }
            }}
            className="flex items-center justify-center gap-2 w-full h-12 rounded-xl bg-[#ff4d6d] hover:bg-[#ff6b85] text-white font-medium transition disabled:opacity-70 disabled:cursor-wait"
          >
            {submitting ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Preparing…
              </>
            ) : (
              <>
                <Download className="w-4 h-4" />
                Download ZIP
              </>
            )}
          </button>
        ) : (
          <div className="flex items-center justify-center w-full h-12 rounded-xl bg-white/[0.04] text-white/40 text-sm">
            Pick an option to download
          </div>
        )}

        <p className="mt-3 text-center text-[10px] uppercase tracking-widest text-white/30">
          ZIPs are cached for 24 hours
        </p>
      </div>
    </div>
  );
}

export const EXPORT_ICONS = { Heart, ImageIcon, FileImage };
