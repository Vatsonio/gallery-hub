# Telegram Notifications

gallery-hub fires real-time push notifications to a Telegram chat whenever
a client interacts with one of your galleries. Six events ship out of the
box: first share view, favorites burst, export started, export completed,
new upload, and suspicious IP. Each rule has its own enabled/threshold/
debounce config in `/admin/notifications`.

The dispatcher is two-layered: every event writes an idempotent row into
`notification_log` (a Postgres-backed durable queue), and the gallery
worker reads that row, hits the Telegram Bot API, and updates the row's
status. Failures are retried with exponential backoff (3 attempts, then
the row stays in `failed` for manual replay from the admin UI).

---

## 1. Create the bot

1. Open Telegram and message [`@BotFather`](https://t.me/BotFather).
2. Send `/newbot`. Pick a display name (e.g. `Gallery Hub`) and a unique
   username ending in `bot` (e.g. `divass_gallery_hub_bot`).
3. BotFather replies with a token shaped like
   `123456789:AAH...`. Save it — this is `TELEGRAM_BOT_TOKEN`.
4. (Optional) Send `/setdescription` and `/setuserpic` so the bot looks
   the part in your chat list.

## 2. Get your chat id

The simplest path:

1. Search for `@userinfobot` in Telegram and start a chat with it. It
   replies with your numeric user id. That id is `TELEGRAM_CHAT_ID`.

If you want notifications to land in a group instead of a 1:1 chat:

1. Create a group, add your new bot to it.
2. Send any message in the group.
3. Hit `https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/getUpdates` in
   your browser. Look for `"chat":{"id":-100...` — that negative number
   is the group's chat id. Use it as `TELEGRAM_CHAT_ID`.

## 3. Configure env vars

Add the following to `.env` (dev) or `.env.prod` (production):

```
TELEGRAM_BOT_TOKEN=123456789:AAH...
TELEGRAM_CHAT_ID=987654321
TELEGRAM_RATE_LIMIT_PER_MINUTE=20
```

`TELEGRAM_RATE_LIMIT_PER_MINUTE` is a per-worker token-bucket cap on
`sendMessage` calls. The default of 20/min is far under Telegram's
global 30/sec limit but high enough that bursts (e.g. a favorites
storm) don't get throttled.

Restart `gallery-app` and `gallery-worker` so the env changes propagate.

## 4. Verify the connection

1. Sign in to `/admin/notifications`.
2. The setup banner should now read `Bot connected` once you click
   **Test send** and the row hits `status='sent'` (refresh after a few
   seconds — the worker picks the job up asynchronously).
3. Check your Telegram chat — you should see
   `🧪 Test notification — gallery-hub is wired up.`

If the banner stays red:
- Banner shows `TELEGRAM_BOT_TOKEN: missing` → env var didn't reach the app.
- Banner shows `last successful send: never` after a test → look at the
  most-recent row in the Recent dispatches table; the `Error` column
  shows the Telegram API response.

## 5. Tuning rules

Open `/admin/notifications` → each row has:

- **Enabled** — toggles dispatch entirely for that event.
- **Threshold** — JSON object. Currently meaningful for:
  - `favorites_burst`: `{"min_count": 3, "window_seconds": 3600}` — fires
    only when the rolling 1h count for a (token, viewer) pair reaches 3.
  - `suspicious_ip`: `{"min_tokens": 5, "window_seconds": 3600}` — fires
    when one IP hits ≥5 distinct share tokens within an hour.
- **Min interval (s)** — per-rule debounce honoured by the dispatcher in
  addition to the dedup key.

Leave threshold blank to remove the gate.

## 6. Adding more chat_ids (multi-recipient)

Out of the box gallery-hub dispatches to a single `TELEGRAM_CHAT_ID`.
To send to multiple chats, the cleanest path is:

1. Extend `notification_rules` with a `chat_ids JSONB` column (array of
   strings) and migrate existing rows from the env var.
2. Change `dispatchNotification()` in `src/lib/notifications.ts` to fan
   out across the array — one `notification_log` row per chat so each
   recipient retries independently.
3. (Optional) Per-rule `chat_ids` so e.g. `suspicious_ip` only pings
   security but `favorites_burst` pings the whole studio.

Until that lands, the simplest workaround is a Telegram group: add your
bot plus all the humans who want notifications and use the negative
group id as `TELEGRAM_CHAT_ID`.

## 7. Markdown formatting cheat sheet

The dispatcher uses MarkdownV2. When you write payloads (or test sends
via the admin UI), escape these reserved characters with `\`:

```
_ * [ ] ( ) ~ ` > # + - = | { } . !
```

Quick reference:

| Want | Markdown |
| ---- | -------- |
| **bold** | `*bold*` |
| _italic_ | `_italic_` |
| `code` | `` `code` `` |
| [link](https://example.com) | `[link](https://example.com)` |
| literal dot | `\.` |
| literal hyphen | `\-` |

The helper `escapeMarkdownV2()` in `src/lib/notifications.ts` does this
automatically for any user-supplied string (album title, viewer id,
etc.) — only the structural markup is hand-written.

## 8. Operational notes

- Failed dispatches sit at `status='failed'` indefinitely. Click
  **Replay** in `/admin/notifications` to re-queue.
- The IP-tracker is per-process (in-memory). On a multi-worker deploy
  each `gallery-app` instance counts independently — that's a tradeoff
  for keeping the hot path Postgres-free. The dedup key still collapses
  duplicate alerts across processes within the hour bucket.
- PostHog captures `notification_sent` / `notification_failed` /
  `notification_skipped` so you can build a dashboard on top.
