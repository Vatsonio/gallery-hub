"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from "lucide-react";

export type ToastKind = "success" | "warning" | "error" | "info";

export interface ToastInput {
  /** The message shown to the user. Plain string — no React nodes. */
  message: string;
  kind?: ToastKind;
  /** Auto-dismiss delay in ms. Default 3000; hovering pauses the timer. */
  durationMs?: number;
}

interface ToastEntry extends ToastInput {
  id: string;
  /** Wall-clock ms when this entry started counting down. */
  startedAt: number;
}

interface ToastContextValue {
  show: (input: ToastInput) => void;
  /** Convenience: equivalent to show({ message, kind: "success" }). */
  success: (message: string) => void;
  warning: (message: string) => void;
  error: (message: string) => void;
  info: (message: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

/**
 * Public hook. Throws when invoked outside a ToastProvider so we get a
 * clear stack trace instead of silently dropping toasts.
 */
export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used inside <ToastProvider>");
  return ctx;
}

const MAX_TOASTS = 3;

/**
 * Provider for the toast stack. Mounts a portal-free fixed container
 * (bottom-right desktop / top mobile) and exposes `show` through context.
 *
 * Stack policy:
 *   * Hard cap of 3 visible toasts. Newer entries push older ones out.
 *   * 3s default auto-dismiss with hover-to-pause: when the cursor enters
 *     the container we freeze the per-toast clocks and resume them on
 *     leave. This matches the design spec without per-toast timers
 *     fighting each other.
 *   * Slide-in from the trailing edge with a soft fade.
 */
export function ToastProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [toasts, setToasts] = useState<ToastEntry[]>([]);
  const [paused, setPaused] = useState(false);
  // Mirror of `toasts` we can read from the timer loop without closing
  // over a stale value. setToasts already keeps the source of truth.
  const toastsRef = useRef<ToastEntry[]>([]);
  toastsRef.current = toasts;

  const dismiss = useCallback((id: string) => {
    setToasts((cur) => cur.filter((t) => t.id !== id));
  }, []);

  const show = useCallback((input: ToastInput) => {
    const id =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `t-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setToasts((cur) => {
      const next: ToastEntry = {
        id,
        message: input.message,
        kind: input.kind ?? "success",
        durationMs: input.durationMs ?? 3000,
        startedAt: Date.now(),
      };
      const merged = [...cur, next];
      // Keep the newest MAX_TOASTS — drop oldest to maintain visual stack.
      return merged.length > MAX_TOASTS ? merged.slice(merged.length - MAX_TOASTS) : merged;
    });
  }, []);

  // Auto-dismiss tick. Single shared interval so we don't leak N timers
  // for a busy admin session. Each tick checks whether any toast has
  // outlived its durationMs and drops it. Pause flag freezes ageing by
  // bumping each toast's `startedAt` so the elapsed pause doesn't count.
  useEffect(() => {
    const id = window.setInterval(() => {
      if (paused) {
        // Slide the "started" reference forward by 250ms so when we
        // resume, the elapsed delta excludes the pause window.
        setToasts((cur) => cur.map((t) => ({ ...t, startedAt: t.startedAt + 250 })));
        return;
      }
      const now = Date.now();
      setToasts((cur) => cur.filter((t) => now - t.startedAt < (t.durationMs ?? 3000)));
    }, 250);
    return () => window.clearInterval(id);
  }, [paused]);

  const value: ToastContextValue = useMemo(() => ({
    show,
    success: (message: string) => show({ message, kind: "success" }),
    warning: (message: string) => show({ message, kind: "warning" }),
    error: (message: string) => show({ message, kind: "error" }),
    info: (message: string) => show({ message, kind: "info" }),
  }), [show]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        aria-live="polite"
        aria-atomic="false"
        onMouseEnter={() => setPaused(true)}
        onMouseLeave={() => setPaused(false)}
        className="pointer-events-none fixed inset-x-0 top-0 z-[60] flex flex-col items-stretch gap-2 px-4 pt-[max(12px,env(safe-area-inset-top))] sm:inset-x-auto sm:top-auto sm:bottom-6 sm:right-6 sm:items-end sm:px-0 sm:pt-0 sm:pb-[max(0px,env(safe-area-inset-bottom))]"
      >
        {toasts.map((t) => (
          <ToastCard key={t.id} entry={t} onDismiss={() => dismiss(t.id)} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

const KIND_BORDER: Record<ToastKind, string> = {
  success: "border-l-rose-400",
  warning: "border-l-amber-400",
  error: "border-l-red-500",
  info: "border-l-zinc-400",
};

const KIND_ICON: Record<ToastKind, typeof CheckCircle2> = {
  success: CheckCircle2,
  warning: AlertTriangle,
  error: XCircle,
  info: Info,
};

const KIND_ICON_COLOR: Record<ToastKind, string> = {
  success: "text-rose-300",
  warning: "text-amber-300",
  error: "text-red-400",
  info: "text-zinc-400",
};

function ToastCard({ entry, onDismiss }: { entry: ToastEntry; onDismiss: () => void }): React.JSX.Element {
  const Icon = KIND_ICON[entry.kind ?? "success"];
  return (
    <div
      role="status"
      className={
        "toast-anim pointer-events-auto flex w-full items-start gap-3 rounded-xl border border-white/10 border-l-4 bg-zinc-900/85 px-4 py-3 shadow-2xl backdrop-blur-md ring-1 ring-white/5 sm:w-auto sm:min-w-[18rem] sm:max-w-sm " +
        (KIND_BORDER[entry.kind ?? "success"])
      }
    >
      <Icon className={`h-4 w-4 shrink-0 mt-0.5 ${KIND_ICON_COLOR[entry.kind ?? "success"]}`} aria-hidden />
      <span className="flex-1 text-sm text-white/90">{entry.message}</span>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={onDismiss}
        className="-mr-1 -mt-1 rounded-md p-1 text-white/40 hover:bg-white/10 hover:text-white/80 transition-colors duration-150"
      >
        <X className="h-3.5 w-3.5" aria-hidden />
      </button>
    </div>
  );
}
