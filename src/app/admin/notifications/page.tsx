import { Bell, CheckCircle2, AlertTriangle, RefreshCw } from "lucide-react";
import { requireAdmin } from "@/lib/session";
import { sql } from "@/lib/db";
import { updateRule, testNotification, replayFailed } from "./actions";

export const dynamic = "force-dynamic";

interface RuleRow {
  event_type: string;
  enabled: boolean;
  threshold: Record<string, unknown> | null;
  min_interval_seconds: number;
}

interface LogRow {
  id: string;
  event_type: string;
  status: string;
  attempts: number;
  last_error: string | null;
  chat_id: string;
  created_at: Date;
  sent_at: Date | null;
}

const RULE_LABELS: Record<string, string> = {
  first_share_view: "First share view",
  favorites_burst: "Favorites burst",
  export_started: "Export started",
  export_completed: "Export completed",
  new_upload: "New upload",
  suspicious_ip: "Suspicious IP",
};

const STATUS_TINT: Record<string, string> = {
  sent: "text-emerald-300",
  queued: "text-amber-300",
  failed: "text-rose-400",
  skipped: "text-text-muted",
};

/**
 * Admin notifications surface. Shows three things:
 *  - Setup banner: bot-token + chat-id status, last successful send.
 *  - Rules: per-event toggle + threshold JSON + min-interval debounce.
 *  - Recent log: last 50 dispatches with status + error + replay button.
 */
export default async function NotificationsPage(): Promise<React.JSX.Element> {
  await requireAdmin();

  const [rules, logs, lastSent] = await Promise.all([
    sql<RuleRow[]>`
      SELECT event_type, enabled, threshold, min_interval_seconds
        FROM notification_rules
       ORDER BY event_type ASC
    `,
    sql<LogRow[]>`
      SELECT id, event_type, status, attempts, last_error, chat_id, created_at, sent_at
        FROM notification_log
       ORDER BY created_at DESC
       LIMIT 50
    `,
    sql<{ sent_at: Date | null }[]>`
      SELECT sent_at FROM notification_log
       WHERE status = 'sent'
       ORDER BY sent_at DESC LIMIT 1
    `,
  ]);

  const hasToken = !!process.env.TELEGRAM_BOT_TOKEN;
  const hasChat = !!process.env.TELEGRAM_CHAT_ID;
  const lastSentAt = lastSent[0]?.sent_at ?? null;
  const connected = hasToken && hasChat && !!lastSentAt;

  return (
    <div className="p-6 max-w-screen-xl">
      <div className="flex items-center gap-3">
        <span className="grid h-9 w-9 place-items-center rounded-lg bg-amber-500/15 text-amber-300">
          <Bell className="h-4 w-4" />
        </span>
        <div>
          <h1 className="text-2xl font-light text-white">Notifications</h1>
          <p className="text-sm text-text-muted">
            Telegram push alerts for client activity.
          </p>
        </div>
      </div>

      {/* Setup status banner */}
      <section
        className={`mt-6 rounded-xl border p-4 flex items-start gap-3 ${
          connected
            ? "border-emerald-500/30 bg-emerald-500/5"
            : "border-rose-500/30 bg-rose-500/5"
        }`}
      >
        {connected ? (
          <CheckCircle2 className="size-5 text-emerald-300 mt-0.5" />
        ) : (
          <AlertTriangle className="size-5 text-rose-300 mt-0.5" />
        )}
        <div className="flex-1 min-w-0">
          <p
            className={`font-medium ${
              connected ? "text-emerald-300" : "text-rose-300"
            }`}
          >
            {connected ? "Bot connected" : "Setup required"}
          </p>
          <p className="text-sm text-text-muted mt-0.5">
            TELEGRAM_BOT_TOKEN: {hasToken ? "set" : "missing"} ·
            TELEGRAM_CHAT_ID: {hasChat ? "set" : "missing"} ·
            last successful send:{" "}
            {lastSentAt
              ? new Date(lastSentAt).toLocaleString()
              : "never"}
          </p>
          {!connected ? (
            <p className="text-xs text-text-muted/80 mt-2">
              See <code className="px-1 rounded bg-bg-elevated">docs/notifications.md</code> for setup steps.
            </p>
          ) : null}
        </div>
        <form
          action={async () => {
            "use server";
            await testNotification();
          }}
        >
          <button
            type="submit"
            className="rounded-lg bg-bg-card hover:bg-bg-elevated px-3 py-1.5 text-sm transition border border-line cursor-pointer"
            disabled={!hasToken || !hasChat}
          >
            Test send
          </button>
        </form>
      </section>

      {/* Rules table */}
      <section className="mt-8">
        <h2 className="text-sm uppercase tracking-widest text-text-muted mb-3">
          Rules
        </h2>
        <div className="overflow-hidden rounded-xl border border-line bg-bg-elevated">
          <table className="w-full text-sm">
            <thead className="bg-bg-card text-text-muted">
              <tr>
                <th className="px-4 py-3 text-left font-medium">Event</th>
                <th className="px-4 py-3 text-left font-medium">Enabled</th>
                <th className="px-4 py-3 text-left font-medium">Threshold (JSON)</th>
                <th className="px-4 py-3 text-left font-medium">Min interval (s)</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="text-text">
              {rules.map((r) => (
                <tr key={r.event_type} className="border-t border-line">
                  <td className="px-4 py-3 font-medium">
                    {RULE_LABELS[r.event_type] ?? r.event_type}
                  </td>
                  <td className="px-4 py-3" colSpan={4}>
                    <form
                      action={async (fd: FormData) => {
                        "use server";
                        await updateRule({
                          event_type: r.event_type,
                          enabled: fd.get("enabled") === "on",
                          threshold: String(fd.get("threshold") ?? ""),
                          min_interval_seconds: Number(
                            fd.get("min_interval_seconds") ?? 0,
                          ),
                        });
                      }}
                      className="grid grid-cols-[80px_1fr_120px_100px] gap-3 items-center"
                    >
                      <label className="inline-flex items-center gap-2">
                        <input
                          type="checkbox"
                          name="enabled"
                          defaultChecked={r.enabled}
                          className="size-4 accent-amber-300"
                        />
                        <span className="text-xs text-text-muted">on</span>
                      </label>
                      <input
                        type="text"
                        name="threshold"
                        defaultValue={r.threshold ? JSON.stringify(r.threshold) : ""}
                        placeholder='{"min_count": 3}'
                        className="w-full rounded-md bg-bg-card border border-line px-2 py-1 text-xs font-mono"
                      />
                      <input
                        type="number"
                        name="min_interval_seconds"
                        defaultValue={r.min_interval_seconds}
                        min={0}
                        max={86_400}
                        className="w-full rounded-md bg-bg-card border border-line px-2 py-1 text-xs tabular-nums"
                      />
                      <button
                        type="submit"
                        className="rounded-md bg-amber-500/20 hover:bg-amber-500/30 text-amber-200 px-3 py-1 text-xs transition cursor-pointer"
                      >
                        Save
                      </button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Recent log */}
      <section className="mt-8">
        <h2 className="text-sm uppercase tracking-widest text-text-muted mb-3">
          Recent dispatches
        </h2>
        <div className="overflow-hidden rounded-xl border border-line bg-bg-elevated">
          <table className="w-full text-sm">
            <thead className="bg-bg-card text-text-muted">
              <tr>
                <th className="px-4 py-3 text-left font-medium">When</th>
                <th className="px-4 py-3 text-left font-medium">Event</th>
                <th className="px-4 py-3 text-left font-medium">Status</th>
                <th className="px-4 py-3 text-left font-medium">Attempts</th>
                <th className="px-4 py-3 text-left font-medium">Error</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="text-text">
              {logs.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-12 text-center text-text-muted">
                    No dispatches yet.
                  </td>
                </tr>
              ) : (
                logs.map((l) => (
                  <tr key={l.id} className="border-t border-line">
                    <td className="px-4 py-3 text-text-muted text-xs tabular-nums">
                      {new Date(l.created_at).toLocaleString()}
                    </td>
                    <td className="px-4 py-3">
                      {RULE_LABELS[l.event_type] ?? l.event_type}
                    </td>
                    <td className={`px-4 py-3 ${STATUS_TINT[l.status] ?? ""}`}>
                      {l.status}
                    </td>
                    <td className="px-4 py-3 tabular-nums">{l.attempts}</td>
                    <td className="px-4 py-3 text-xs text-text-muted max-w-[24rem] truncate">
                      {l.last_error ?? ""}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {l.status === "failed" || l.status === "skipped" ? (
                        <form
                          action={async () => {
                            "use server";
                            await replayFailed(l.id);
                          }}
                        >
                          <button
                            type="submit"
                            className="inline-flex items-center gap-1 rounded-md bg-bg-card hover:bg-white/10 px-2 py-1 text-xs transition cursor-pointer"
                          >
                            <RefreshCw className="size-3" />
                            Replay
                          </button>
                        </form>
                      ) : null}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
