"use server";

import { revalidatePath } from "next/cache";
import { sql } from "@/lib/db";
import { requireAdmin } from "@/lib/auth-check";
import {
  dispatchNotification,
  type NotificationEventType,
} from "@/lib/notifications";
import { getBoss, NOTIFICATIONS_QUEUE } from "@/lib/jobs";
import { randomUUID } from "node:crypto";

export interface UpdateRuleInput {
  event_type: string;
  enabled: boolean;
  threshold: string;
  min_interval_seconds: number;
}

/**
 * Update one notification rule. `threshold` is the raw JSON string from the
 * admin form — we parse + validate before persisting so a typo'd payload
 * can't silently break the dispatcher's threshold reads.
 */
export async function updateRule(input: UpdateRuleInput): Promise<{ ok: true } | { error: string }> {
  await requireAdmin();
  if (!input.event_type) return { error: "event_type required" };

  let parsed: string | null = null;
  if (input.threshold.trim().length > 0) {
    try {
      const v = JSON.parse(input.threshold) as unknown;
      if (v && typeof v === "object" && !Array.isArray(v)) {
        parsed = JSON.stringify(v);
      } else {
        return { error: "threshold must be a JSON object" };
      }
    } catch {
      return { error: "threshold must be valid JSON or empty" };
    }
  }
  const min = Math.max(0, Math.min(86_400, Math.floor(input.min_interval_seconds)));

  // Cast through ::jsonb so postgres.js sends the value as text and Postgres
  // re-parses it — avoids the strict JSONValue typing on sql.json().
  await sql`
    UPDATE notification_rules
       SET enabled = ${input.enabled},
           threshold = ${parsed}::jsonb,
           min_interval_seconds = ${min},
           updated_at = NOW()
     WHERE event_type = ${input.event_type}
  `;
  revalidatePath("/admin/notifications");
  return { ok: true };
}

/**
 * Send a synthetic notification so the photographer can verify their
 * Telegram setup. Uses the `test` event_type (no rule row, so the
 * dispatcher's enabled gate is bypassed via a direct write).
 */
export async function testNotification(): Promise<{ ok: true; id: string } | { error: string }> {
  await requireAdmin();
  const chat = process.env.TELEGRAM_CHAT_ID ?? "";
  if (!chat) return { error: "TELEGRAM_CHAT_ID not set" };

  // Direct insert (no rule lookup) — keeps test sends working even when all
  // rules are disabled. The unique-index will collapse repeats within the
  // same minute, which is the desired behaviour for a debounce.
  const dedup = `test:${new Date().toISOString().slice(0, 16)}`;
  const rows = await sql<{ id: string }[]>`
    INSERT INTO notification_log (event_type, dedup_key, payload, chat_id, status)
    VALUES (
      'test',
      ${dedup},
      ${sql.json({
        text: "🧪 *Test notification* — gallery\\-hub is wired up\\.",
      })},
      ${chat},
      'queued'
    )
    ON CONFLICT (event_type, dedup_key, chat_id) DO NOTHING
    RETURNING id
  `;
  if (rows.length === 0) {
    return { error: "another test was sent within this minute — try again shortly" };
  }
  const boss = await getBoss();
  await boss.send(NOTIFICATIONS_QUEUE, { logId: rows[0].id });
  revalidatePath("/admin/notifications");
  return { ok: true, id: rows[0].id };
}

/**
 * Re-enqueue a failed notification. Marks the row back to `queued` and
 * sends a fresh pg-boss job pointing at it.
 */
export async function replayFailed(
  notification_id: string,
): Promise<{ ok: true } | { error: string }> {
  await requireAdmin();
  const rows = await sql<{ id: string }[]>`
    UPDATE notification_log
       SET status = 'queued', last_error = NULL
     WHERE id = ${notification_id}
       AND status IN ('failed', 'skipped')
     RETURNING id
  `;
  if (rows.length === 0) {
    return { error: "row not found or not in a re-queueable status" };
  }
  const boss = await getBoss();
  await boss.send(NOTIFICATIONS_QUEUE, { logId: rows[0].id });
  revalidatePath("/admin/notifications");
  return { ok: true };
}

/** Test-only helper to manipulate the dispatch path in integration suites. */
export async function _testDispatchForAdmin(args: {
  event_type: NotificationEventType;
  text: string;
}): Promise<string> {
  await requireAdmin();
  const r = await dispatchNotification({
    event_type: args.event_type,
    dedup_key: `admin_test:${randomUUID()}`,
    payload: { source: "admin" },
    text: args.text,
  });
  return r.id ?? "";
}
