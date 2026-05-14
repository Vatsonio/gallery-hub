import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { setupTestDb, teardownTestDb, resetTestDb } from "./_helpers";
import { sql } from "@/lib/db";
import { dispatchNotification } from "@/lib/notifications";
import { handleNotificationJob } from "../../workers/notifications";
import { getBoss } from "@/lib/jobs";

beforeAll(async () => {
  await setupTestDb();
  process.env.TELEGRAM_CHAT_ID = "test-chat-1";
});
afterAll(async () => {
  const boss = await getBoss().catch(() => null);
  if (boss) await boss.stop({ graceful: true, wait: false }).catch(() => undefined);
  await teardownTestDb();
});
beforeEach(async () => {
  await resetTestDb();
  // The notification_rules / notification_log tables are NOT touched by
  // resetTestDb (it only TRUNCATEs the gallery tables). Clean them here so
  // the rule re-enable + log inserts have predictable state.
  await sql`TRUNCATE TABLE notification_log RESTART IDENTITY`;
  await sql`UPDATE notification_rules SET enabled = TRUE`;
});

describe("dispatchNotification — durable queue + dedup", () => {
  it("inserts a notification_log row on first call", async () => {
    const r = await dispatchNotification({
      event_type: "first_share_view",
      dedup_key: "first_share_view:tok-1",
      payload: { share_token: "tok-1" },
      text: "hello",
    });
    expect(r.skipped).toBe(false);
    expect(r.id).toBeTruthy();

    const rows = await sql<{ status: string }[]>`
      SELECT status FROM notification_log WHERE id = ${r.id!}
    `;
    expect(rows[0].status).toBe("queued");
  });

  it("collapses a duplicate dispatch (same dedup_key) into a no-op", async () => {
    const k = "first_share_view:tok-2";
    const a = await dispatchNotification({
      event_type: "first_share_view",
      dedup_key: k,
      payload: {},
      text: "first",
    });
    const b = await dispatchNotification({
      event_type: "first_share_view",
      dedup_key: k,
      payload: {},
      text: "second (should be dropped)",
    });
    expect(a.skipped).toBe(false);
    expect(b.skipped).toBe(true);
    expect(b.skip_reason).toBe("duplicate");

    const rows = await sql<{ id: string }[]>`
      SELECT id FROM notification_log
       WHERE event_type = 'first_share_view' AND dedup_key = ${k}
    `;
    expect(rows.length).toBe(1);
  });

  it("returns skipped=no_chat when TELEGRAM_CHAT_ID is empty", async () => {
    const prior = process.env.TELEGRAM_CHAT_ID;
    process.env.TELEGRAM_CHAT_ID = "";
    try {
      const r = await dispatchNotification({
        event_type: "new_upload",
        dedup_key: "new_upload:test:bucket",
        payload: {},
        text: "x",
      });
      expect(r.skipped).toBe(true);
      expect(r.skip_reason).toBe("no_chat");
    } finally {
      process.env.TELEGRAM_CHAT_ID = prior;
    }
  });

  it("returns skipped=disabled when the rule is toggled off", async () => {
    await sql`
      UPDATE notification_rules SET enabled = FALSE
       WHERE event_type = 'new_upload'
    `;
    const r = await dispatchNotification({
      event_type: "new_upload",
      dedup_key: "new_upload:disabled-test",
      payload: {},
      text: "x",
    });
    expect(r.skipped).toBe(true);
    expect(r.skip_reason).toBe("disabled");
  });
});

describe("worker handleNotificationJob — Telegram interaction", () => {
  it("marks the row 'sent' when Telegram returns ok:true", async () => {
    const ins = await sql<{ id: string }[]>`
      INSERT INTO notification_log
        (event_type, dedup_key, payload, chat_id, status)
      VALUES
        ('test', 'worker-test-ok', '{"text":"hi"}'::jsonb, 'chat-x', 'queued')
      RETURNING id
    `;
    const id = ins[0].id;

    let calledUrl = "";
    const stub: typeof fetch = async (input) => {
      calledUrl = typeof input === "string" ? input : (input as Request).url;
      return new Response(JSON.stringify({ ok: true, result: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    const outcome = await handleNotificationJob(id, {
      botToken: "fake-token-123",
      fetchImpl: stub,
    });
    expect(outcome.status).toBe("sent");
    expect(calledUrl).toContain("/botfake-token-123/sendMessage");

    const rows = await sql<{ status: string; attempts: number; sent_at: Date | null }[]>`
      SELECT status, attempts, sent_at FROM notification_log WHERE id = ${id}
    `;
    expect(rows[0].status).toBe("sent");
    expect(rows[0].attempts).toBe(1);
    expect(rows[0].sent_at).not.toBeNull();
  });

  it("marks 'skipped' when bot token is absent", async () => {
    const ins = await sql<{ id: string }[]>`
      INSERT INTO notification_log
        (event_type, dedup_key, payload, chat_id, status)
      VALUES
        ('test', 'worker-test-skipped', '{"text":"x"}'::jsonb, 'chat-x', 'queued')
      RETURNING id
    `;
    const id = ins[0].id;
    const outcome = await handleNotificationJob(id, { botToken: "" });
    expect(outcome.status).toBe("skipped");
    const rows = await sql<{ status: string; last_error: string | null }[]>`
      SELECT status, last_error FROM notification_log WHERE id = ${id}
    `;
    expect(rows[0].status).toBe("skipped");
    expect(rows[0].last_error).toContain("TELEGRAM_BOT_TOKEN");
  });

  it("marks 'failed' on a 4xx response (chat not found)", async () => {
    const ins = await sql<{ id: string }[]>`
      INSERT INTO notification_log
        (event_type, dedup_key, payload, chat_id, status)
      VALUES
        ('test', 'worker-test-failed', '{"text":"x"}'::jsonb, 'bad-chat', 'queued')
      RETURNING id
    `;
    const id = ins[0].id;
    const stub: typeof fetch = async () =>
      new Response(JSON.stringify({ ok: false, description: "chat not found" }), {
        status: 400,
      });

    const outcome = await handleNotificationJob(id, {
      botToken: "fake",
      fetchImpl: stub,
    });
    expect(outcome.status).toBe("failed");
    const rows = await sql<{ status: string; last_error: string | null }[]>`
      SELECT status, last_error FROM notification_log WHERE id = ${id}
    `;
    expect(rows[0].status).toBe("failed");
    expect(rows[0].last_error).toContain("chat not found");
  });

  it("throws on 429 so pg-boss can retry", async () => {
    const ins = await sql<{ id: string }[]>`
      INSERT INTO notification_log
        (event_type, dedup_key, payload, chat_id, status)
      VALUES
        ('test', 'worker-test-429', '{"text":"x"}'::jsonb, 'chat', 'queued')
      RETURNING id
    `;
    const id = ins[0].id;
    const stub: typeof fetch = async () =>
      new Response(JSON.stringify({ ok: false, description: "rate limited" }), {
        status: 429,
      });
    await expect(
      handleNotificationJob(id, { botToken: "fake", fetchImpl: stub }),
    ).rejects.toThrow(/429/);
    const rows = await sql<{ attempts: number; status: string }[]>`
      SELECT attempts, status FROM notification_log WHERE id = ${id}
    `;
    expect(rows[0].attempts).toBe(1);
    // Still queued because we threw before flipping the status.
    expect(rows[0].status).toBe("queued");
  });
});
