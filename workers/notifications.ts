/**
 * Telegram dispatch worker.
 *
 * Reads a `notification_log` row by id (the queue carries only `logId` — the
 * authoritative payload lives in Postgres so retries always pick up the
 * latest body). Posts to Telegram, then updates `status` + `attempts` +
 * `last_error`.
 *
 * Three defensive behaviours:
 *
 *   - Missing `TELEGRAM_BOT_TOKEN` → log row marked `status='skipped'`
 *     instead of `'failed'`. This lets a dev environment run the worker
 *     without a bot configured.
 *
 *   - Telegram 429 / 5xx → throw so pg-boss retries with the queue's
 *     configured backoff. Non-retriable errors (4xx other than 429) mark
 *     the row `status='failed'` and DO NOT throw — the worker moves on.
 *
 *   - Per-process token-bucket rate limiter caps `sendMessage` calls to
 *     `TELEGRAM_RATE_LIMIT_PER_MINUTE` so a backlog burst won't get the bot
 *     banned. Default 20, well under Telegram's 30/sec global limit.
 */
import { sql } from "@/lib/db";
import { safeCapture } from "@/lib/analytics";

const TELEGRAM_API_BASE = "https://api.telegram.org";

interface NotificationLogRow {
  id: string;
  event_type: string;
  dedup_key: string;
  payload: { text?: string } & Record<string, unknown>;
  chat_id: string;
  status: string;
  attempts: number;
}

interface RateLimiter {
  acquire(): Promise<void>;
}

function createMinuteTokenBucket(maxPerMinute: number): RateLimiter {
  const intervalMs = 60_000;
  let tokens = maxPerMinute;
  let lastRefill = Date.now();
  return {
    async acquire() {
      // Refill proportional to elapsed time. Caps at `maxPerMinute`.
      const now = Date.now();
      const elapsed = now - lastRefill;
      if (elapsed > 0) {
        tokens = Math.min(maxPerMinute, tokens + (elapsed / intervalMs) * maxPerMinute);
        lastRefill = now;
      }
      if (tokens >= 1) {
        tokens -= 1;
        return;
      }
      // Wait just enough to earn one token.
      const waitMs = Math.ceil(((1 - tokens) / maxPerMinute) * intervalMs);
      await new Promise<void>((r) => setTimeout(r, waitMs));
      tokens = 0;
      lastRefill = Date.now();
    },
  };
}

let _limiter: RateLimiter | null = null;
function getLimiter(): RateLimiter {
  if (!_limiter) {
    const cap = Math.max(
      1,
      Number(process.env.TELEGRAM_RATE_LIMIT_PER_MINUTE ?? 20),
    );
    _limiter = createMinuteTokenBucket(cap);
  }
  return _limiter;
}

/** Telegram error envelope as returned by `sendMessage`. */
interface TelegramResponse {
  ok: boolean;
  description?: string;
  error_code?: number;
  result?: unknown;
}

export interface DispatchOutcome {
  status: "sent" | "failed" | "skipped";
  http_status?: number;
  error?: string;
}

/**
 * Hit the Telegram Bot API. Returns the outcome; never throws for plain
 * 4xx — those are recorded as `failed`. Throws for 429 / 5xx / network
 * errors so pg-boss can retry.
 */
async function postToTelegram(
  botToken: string,
  chatId: string,
  text: string,
): Promise<DispatchOutcome> {
  const url = `${TELEGRAM_API_BASE}/bot${botToken}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "MarkdownV2",
      disable_web_page_preview: true,
    }),
  });

  let body: TelegramResponse | null = null;
  try {
    body = (await res.json()) as TelegramResponse;
  } catch {
    body = null;
  }

  if (res.ok && body?.ok) {
    return { status: "sent", http_status: res.status };
  }

  // 429 + 5xx → throw to let pg-boss retry.
  if (res.status === 429 || (res.status >= 500 && res.status < 600)) {
    throw new Error(
      `telegram ${res.status}: ${body?.description ?? "transient error"}`,
    );
  }

  // 4xx (other than 429) is permanent — bad token, bad chat_id, malformed
  // markdown. Record the failure and stop.
  return {
    status: "failed",
    http_status: res.status,
    error: body?.description ?? `http ${res.status}`,
  };
}

export interface HandleNotificationOpts {
  /** Override the env-driven Telegram token (test seam). */
  botToken?: string | null;
  /** Override the fetch implementation (test seam). */
  fetchImpl?: typeof fetch;
}

/**
 * Pull the log row, dispatch, and write back the outcome. Exported so a
 * test can drive it without spinning up pg-boss.
 */
export async function handleNotificationJob(
  logId: string,
  opts: HandleNotificationOpts = {},
): Promise<DispatchOutcome> {
  const rows = await sql<NotificationLogRow[]>`
    SELECT id, event_type, dedup_key, payload, chat_id, status, attempts
      FROM notification_log
     WHERE id = ${logId}
     LIMIT 1
  `;
  const row = rows[0];
  if (!row) {
    return { status: "failed", error: "log row missing" };
  }
  if (row.status === "sent") {
    return { status: "sent" };
  }

  const botToken = opts.botToken ?? process.env.TELEGRAM_BOT_TOKEN ?? "";
  if (!botToken) {
    await sql`
      UPDATE notification_log
         SET status = 'skipped', last_error = 'TELEGRAM_BOT_TOKEN not set'
       WHERE id = ${logId}
    `;
    safeCapture({
      distinctId: "system",
      event: "notification_skipped",
      properties: { event_type: row.event_type, reason: "no_token" },
    });
    return { status: "skipped", error: "no token" };
  }

  await getLimiter().acquire();

  const text = String(row.payload?.text ?? "");
  // Swap in a stubbed fetch when the test seam is set. The default uses the
  // global fetch — Node 18+ provides it natively.
  const originalFetch = globalThis.fetch;
  if (opts.fetchImpl) globalThis.fetch = opts.fetchImpl;

  try {
    const outcome = await postToTelegram(botToken, row.chat_id, text);
    if (outcome.status === "sent") {
      await sql`
        UPDATE notification_log
           SET status = 'sent',
               attempts = attempts + 1,
               sent_at = NOW(),
               last_error = NULL
         WHERE id = ${logId}
      `;
      safeCapture({
        distinctId: "system",
        event: "notification_sent",
        properties: { event_type: row.event_type },
      });
    } else {
      await sql`
        UPDATE notification_log
           SET status = 'failed',
               attempts = attempts + 1,
               last_error = ${outcome.error ?? "unknown"}
         WHERE id = ${logId}
      `;
      safeCapture({
        distinctId: "system",
        event: "notification_failed",
        properties: {
          event_type: row.event_type,
          http_status: outcome.http_status,
          error: outcome.error,
        },
      });
    }
    return outcome;
  } catch (err) {
    // Transient — bump attempts and rethrow so pg-boss retries.
    await sql`
      UPDATE notification_log
         SET attempts = attempts + 1,
             last_error = ${err instanceof Error ? err.message : String(err)}
       WHERE id = ${logId}
    `;
    throw err;
  } finally {
    if (opts.fetchImpl) globalThis.fetch = originalFetch;
  }
}
