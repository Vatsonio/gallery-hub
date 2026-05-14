/**
 * Telegram notifications — dispatcher core.
 *
 * Two-layer design:
 *
 *   1. `dispatchNotification` writes a row into `notification_log` (ON
 *      CONFLICT DO NOTHING on the (event_type, dedup_key, chat_id) unique
 *      index, so the second caller with the same dedup_key is a no-op) and
 *      enqueues a pg-boss job pointing at the new row's id. Callers can fire
 *      this from any hot path — the dispatcher is idempotent and never
 *      throws via the `safeDispatch` wrapper.
 *
 *   2. The pg-boss worker (workers/notifications.ts) reads the row, hits the
 *      Telegram Bot API, and updates `status` + `attempts` + `last_error`.
 *
 * Three invariants:
 *   - NEVER throw into the caller's flow (every public helper is wrapped via
 *     `safeDispatch`).
 *   - NEVER fire a duplicate Telegram message (the unique index gates it).
 *   - NEVER fire when the matching `notification_rules.enabled = false` or
 *     `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` are unset (the worker logs
 *     `status='skipped'` rather than 'sent').
 */
import { sql } from "@/lib/db";
import { getBoss, NOTIFICATIONS_QUEUE } from "@/lib/jobs";
import { safeCapture } from "@/lib/analytics";

export type NotificationEventType =
  | "first_share_view"
  | "favorites_burst"
  | "export_started"
  | "export_completed"
  | "new_upload"
  | "suspicious_ip"
  | "test";

export interface DispatchArgs {
  event_type: NotificationEventType;
  dedup_key: string;
  payload: Record<string, unknown>;
  /** Telegram-formatted message body (MarkdownV2). */
  text: string;
  /** Override the default chat id — used by replay flows. */
  chat_id?: string | null;
}

export interface DispatchResult {
  /** UUID of the inserted notification_log row, null on dedup hit. */
  id: string | null;
  skipped: boolean;
  skip_reason?: "duplicate" | "disabled" | "no_chat" | "rule_missing";
}

interface NotificationRuleRow {
  event_type: string;
  enabled: boolean;
  threshold: Record<string, unknown> | null;
  min_interval_seconds: number;
}

/** Read the per-event rule. Returns null when no row exists. */
export async function getRule(
  event_type: NotificationEventType,
): Promise<NotificationRuleRow | null> {
  const rows = await sql<NotificationRuleRow[]>`
    SELECT event_type, enabled, threshold, min_interval_seconds
      FROM notification_rules
     WHERE event_type = ${event_type}
     LIMIT 1
  `;
  return rows[0] ?? null;
}

/**
 * Core dispatch. Returns `{skipped: true}` on duplicate / disabled / missing
 * chat-id — callers must NOT treat that as an error.
 */
export async function dispatchNotification(args: DispatchArgs): Promise<DispatchResult> {
  const chat = args.chat_id ?? process.env.TELEGRAM_CHAT_ID ?? "";
  if (!chat) {
    return { id: null, skipped: true, skip_reason: "no_chat" };
  }

  const rule = await getRule(args.event_type);
  if (!rule) {
    return { id: null, skipped: true, skip_reason: "rule_missing" };
  }
  if (!rule.enabled) {
    return { id: null, skipped: true, skip_reason: "disabled" };
  }

  // Atomic insert-if-not-exists. The unique constraint on
  // (event_type, dedup_key, chat_id) collapses repeats.
  const rows = await sql<{ id: string }[]>`
    INSERT INTO notification_log (event_type, dedup_key, payload, chat_id, status)
    VALUES (
      ${args.event_type},
      ${args.dedup_key},
      ${sql.json({ ...args.payload, text: args.text })},
      ${chat},
      'queued'
    )
    ON CONFLICT (event_type, dedup_key, chat_id) DO NOTHING
    RETURNING id
  `;

  if (rows.length === 0) {
    return { id: null, skipped: true, skip_reason: "duplicate" };
  }

  const id = rows[0].id;
  const boss = await getBoss();
  await boss.send(NOTIFICATIONS_QUEUE, { logId: id });
  return { id, skipped: false };
}

/**
 * The default entry point. Wraps `dispatchNotification` in a try/catch so a
 * misbehaving DB or queue can never throw into the caller. Errors are
 * captured to PostHog as `notification_dispatch_failed`.
 */
export async function safeDispatch(args: DispatchArgs): Promise<DispatchResult> {
  try {
    return await dispatchNotification(args);
  } catch (err) {
    safeCapture({
      distinctId: "system",
      event: "notification_dispatch_failed",
      properties: {
        event_type: args.event_type,
        error: err instanceof Error ? err.message : String(err),
      },
    });
    return { id: null, skipped: true, skip_reason: "rule_missing" };
  }
}

// ───────────────────────────────────────────────────────────────────────────
//  MarkdownV2 escaping. Telegram is picky: every reserved char in the body
//  must be backslash-escaped, including inside URLs. Reserved set per
//  https://core.telegram.org/bots/api#markdownv2-style.
// ───────────────────────────────────────────────────────────────────────────
const MD_V2_RESERVED = /[_*[\]()~`>#+\-=|{}.!\\]/g;
export function escapeMarkdownV2(s: string): string {
  return s.replace(MD_V2_RESERVED, (c) => `\\${c}`);
}

/** Stable hour-bucket key (YYYY-MM-DDTHH:00:00Z) for dedup_key composition. */
export function hourBucket(d: Date = new Date()): string {
  const iso = d.toISOString();
  return iso.slice(0, 13) + ":00:00Z";
}

/** Stable minute-bucket key (YYYY-MM-DDTHH:MM:00Z). */
export function minuteBucket(d: Date = new Date()): string {
  const iso = d.toISOString();
  return iso.slice(0, 16) + ":00Z";
}

// ───────────────────────────────────────────────────────────────────────────
//  Helper builders. Each one composes the dedup_key + Markdown payload and
//  calls safeDispatch. Returning the DispatchResult so tests can assert on
//  skip reasons; callers in event-site code generally ignore the return.
// ───────────────────────────────────────────────────────────────────────────

export interface FirstShareViewArgs {
  album_title: string;
  share_token: string;
  viewer_id: string;
}
export async function notifyFirstShareView(a: FirstShareViewArgs): Promise<DispatchResult> {
  const text =
    `*First view\\!* 👀\n` +
    `Album: _${escapeMarkdownV2(a.album_title)}_\n` +
    `Viewer: \`${escapeMarkdownV2(a.viewer_id.slice(0, 8))}\``;
  return safeDispatch({
    event_type: "first_share_view",
    dedup_key: `first_share_view:${a.share_token}`,
    payload: { ...a },
    text,
  });
}

export interface FavoritesBurstArgs {
  album_title: string;
  share_token: string;
  viewer_id: string;
  /** Current count of favorites for this (token, viewer) within the burst window. */
  count: number;
}
export async function notifyFavoritesBurst(a: FavoritesBurstArgs): Promise<DispatchResult> {
  const rule = await getRule("favorites_burst");
  const threshold = (rule?.threshold ?? {}) as { min_count?: number };
  const min = Math.max(1, Number(threshold.min_count ?? 3));
  if (a.count < min) {
    return { id: null, skipped: true, skip_reason: "disabled" };
  }
  const text =
    `❤️ *${a.count}* favorites in _${escapeMarkdownV2(a.album_title)}_\n` +
    `Viewer: \`${escapeMarkdownV2(a.viewer_id.slice(0, 8))}\``;
  return safeDispatch({
    event_type: "favorites_burst",
    dedup_key: `favorites_burst:${a.share_token}:${a.viewer_id}:${hourBucket()}`,
    payload: { ...a },
    text,
  });
}

export interface ExportStartedArgs {
  album_title: string;
  share_token: string;
  viewer_id: string;
  scope: string;
  variant: string;
}
export async function notifyExportStarted(a: ExportStartedArgs): Promise<DispatchResult> {
  const text =
    `⬇️ Export started\n` +
    `Album: _${escapeMarkdownV2(a.album_title)}_\n` +
    `Scope: ${escapeMarkdownV2(a.scope)} \\(${escapeMarkdownV2(a.variant)}\\)`;
  return safeDispatch({
    event_type: "export_started",
    dedup_key: `export_started:${a.share_token}:${a.viewer_id}:${a.scope}:${minuteBucket()}`,
    payload: { ...a },
    text,
  });
}

export interface ExportCompletedArgs extends ExportStartedArgs {
  total_bytes: number;
  cache_hit: boolean;
}
function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const mb = n / 1_000_000;
  if (mb < 1) return `${(n / 1000).toFixed(0)} KB`;
  if (mb < 1000) return `${mb.toFixed(1)} MB`;
  return `${(mb / 1000).toFixed(2)} GB`;
}
export async function notifyExportCompleted(a: ExportCompletedArgs): Promise<DispatchResult> {
  const text =
    `✅ Export ready \\(${escapeMarkdownV2(formatBytes(a.total_bytes))}\\)\n` +
    `Album: _${escapeMarkdownV2(a.album_title)}_\n` +
    `Scope: ${escapeMarkdownV2(a.scope)} \\(${escapeMarkdownV2(a.variant)}\\)` +
    (a.cache_hit ? ` · cache hit` : "");
  return safeDispatch({
    event_type: "export_completed",
    dedup_key: `export_completed:${a.share_token}:${a.viewer_id}:${a.scope}:${minuteBucket()}`,
    payload: { ...a },
    text,
  });
}

export interface NewUploadArgs {
  album_id: string;
  album_title: string;
  photo_count: number;
}
export async function notifyNewUpload(a: NewUploadArgs): Promise<DispatchResult> {
  const text =
    `📸 *${a.photo_count}* new photo${a.photo_count === 1 ? "" : "s"} uploaded\n` +
    `Album: _${escapeMarkdownV2(a.album_title)}_`;
  return safeDispatch({
    event_type: "new_upload",
    dedup_key: `new_upload:${a.album_id}:${hourBucket()}`,
    payload: { ...a },
    text,
  });
}

export interface SuspiciousIpArgs {
  ip: string;
  token_count: number;
  tokens_sample: string[];
}
export async function notifySuspiciousIp(a: SuspiciousIpArgs): Promise<DispatchResult> {
  const sample = a.tokens_sample.slice(0, 3).join(", ");
  const text =
    `🚨 Suspicious IP\n` +
    `\`${escapeMarkdownV2(a.ip)}\` hit *${a.token_count}* share tokens in 1h\n` +
    `Sample: ${escapeMarkdownV2(sample)}`;
  return safeDispatch({
    event_type: "suspicious_ip",
    dedup_key: `suspicious_ip:${a.ip}:${hourBucket()}`,
    payload: { ...a },
    text,
  });
}

// ───────────────────────────────────────────────────────────────────────────
//  Suspicious-IP in-memory tracker. Used by the gallery page render to
//  detect token-spraying (one IP that hits many share tokens in a short
//  window). Edge runtime is intentionally avoided — we run inside the node
//  page render where `safeDispatch` can talk to Postgres.
// ───────────────────────────────────────────────────────────────────────────

interface IpTrackerEntry {
  tokens: Set<string>;
  firstSeenAt: number;
}

const IP_TRACKER = new Map<string, IpTrackerEntry>();
const IP_TRACKER_MAX = 10_000;
const IP_TRACKER_WINDOW_MS = 60 * 60 * 1000;

/**
 * Record an IP→token hit. When the IP's distinct-token count crosses the
 * `suspicious_ip` rule threshold, fires `notifySuspiciousIp` (which is
 * itself dedup'd per hour bucket — so one IP only generates one alert/hour
 * even after the threshold is repeatedly crossed).
 */
export async function recordIpTokenHit(ip: string, token: string): Promise<void> {
  const now = Date.now();

  // Periodic LRU eviction: when the map is full, drop the oldest entries by
  // firstSeenAt. Cheap O(n) sweep but only when capped — keeps memory bounded
  // without per-hit timer overhead.
  if (IP_TRACKER.size >= IP_TRACKER_MAX) {
    const oldest = [...IP_TRACKER.entries()]
      .sort((a, b) => a[1].firstSeenAt - b[1].firstSeenAt)
      .slice(0, Math.floor(IP_TRACKER_MAX / 4));
    for (const [k] of oldest) IP_TRACKER.delete(k);
  }

  let entry = IP_TRACKER.get(ip);
  if (!entry || now - entry.firstSeenAt > IP_TRACKER_WINDOW_MS) {
    entry = { tokens: new Set<string>(), firstSeenAt: now };
    IP_TRACKER.set(ip, entry);
  }
  entry.tokens.add(token);

  const rule = await getRule("suspicious_ip").catch(() => null);
  const threshold = (rule?.threshold ?? {}) as { min_tokens?: number };
  const min = Math.max(2, Number(threshold.min_tokens ?? 5));
  if (entry.tokens.size >= min) {
    await notifySuspiciousIp({
      ip,
      token_count: entry.tokens.size,
      tokens_sample: [...entry.tokens],
    });
  }
}

/** Test hook: reset the in-memory IP tracker between tests. */
export function _resetIpTrackerForTests(): void {
  IP_TRACKER.clear();
}
