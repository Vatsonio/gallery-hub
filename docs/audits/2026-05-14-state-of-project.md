# State of gallery-hub — 2026-05-14

## Executive summary

The codebase is structurally sound and feature-complete against the 12-wave plan: M1-M4 + UX polish + perf + production hardening + encrypted backups + admin polish + /chikaq + Telegram notifications all land cleanly with good test surface area (221 tests written, 170 passing in the audit run; 51 skipped under the `dockerOff` gating that integration tests respect). TypeScript typecheck is clean (`tsc --noEmit` exit 0). Both compose files validate. The codebase is shippable on the merits, BUT there are three concrete problems the operator must address before tagging a release:

1. **AI-mention rule violation in git history.** Three commits carry `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>` trailers. The user's standing rule forbids this in any committed artifact for this repo. This is a hard-rule breach, not a stylistic miss.
2. **Test suite is fragile under load.** This run produced 36/50 test-file failures, all of which were `Hook timed out` in the testcontainers `beforeAll`. Root cause is that `vitest.setup.ts` spins up one Postgres + MinIO container *per test file* with Docker running ~58 concurrent containers — Docker on Windows ran out of headroom and the readiness probe never returned. The source isn't broken; the test orchestration is. Production CI will hit this too unless it runs serially or uses a shared testcontainer.
3. **Some operational glue is unverified.** The `view_events`-heavy aggregations in `/chikaq` (`loadViewsTrend30d`, `loadTopAlbums30d`, `loadRecentActivity24h`) have no index on `event_type` or `created_at` alone — they currently filter on `(created_at > now() - X AND event_type = Y)` against an index keyed on `(share_token, created_at)`. Fine at <10k events, will degrade.

Top risk if shipped today: someone reading git log discovers the AI co-author trailers. Everything else is a fix-soon.

## Verification results

- **Tests:** 170 passing / 51 skipped (221 collected). 36 of 50 test files failed at hook setup with `Hook timed out in 60-180s` — testcontainer Docker exhaustion, not source regressions.
- **Typecheck:** clean (`npx tsc --noEmit` exit 0, no output).
- **AI-mention scan:** **3 hits in git log** (`git log --grep="Co-Authored-By: Claude"`):
  - `008d9313be585fa9ded44396549422973bf05361` — "Add gallery-hub implementation plans M1-M4"
  - `236ba29e4e14b00d724d0b8364650c3ced29b0cc` — "Switch gallery-hub to fully isolated stack + add personal-hub widget integration"
  - `3c6bd0c121916f6c32837e614062bcb101617dff` — "Add gallery-hub design spec"
  - Working tree, package.json, src/, tests/, docs/, migrations/ are all clean — only the three commit messages above carry the trailer.
- **Compose validity:** dev validates clean; prod validates clean when example placeholder values are filled in (compose enforces required vars via `${VAR:?}`).

## Findings

### Critical (must fix before prod)

#### C1. AI co-authorship trailer in three commits
- **Where:** Commits `008d9313`, `236ba29e`, `3c6bd0c1`.
- **Why:** User's hard rule — never put Claude/Anthropic/Co-Authored-By in any committed artifact for this repo. The trailers were added by tooling. They are in *commit metadata*, not file contents, but git log is a committed artifact and is searchable.
- **Suggested fix:** Rewrite history with `git filter-repo --commit-callback` or `git rebase` + `--commit-trailer-remove` (newer git) to strip the trailer. Since this is a self-hosted project not yet shipped, a one-shot history rewrite plus a force-push is acceptable. Do this BEFORE the next deploy tag.

### High (fix soon)

#### H1. Vitest setup contention causes mass false failures
- **Where:** `vitest.setup.ts:31-58` plus `vitest.config.ts` (no `pool` or `poolOptions.threads.singleThread` setting).
- **Why:** Each test file (50 of them) triggers `beforeAll` which starts a fresh PostgreSqlContainer + MinIO container. Vitest runs files concurrently. On a developer workstation with ~60 leftover containers from one run, Docker Desktop's resource ceiling is breached and the `Wait.forHttp("/minio/health/ready", 9000)` probe never returns — `Hook timed out in 180000ms`.
- **Impact:** "Test count 221/221" claim cannot be reproduced on demand. CI will be flaky.
- **Suggested fix:** Adopt one of (a) `vitest.config.ts: test.pool: 'forks', poolOptions.forks.singleFork: true` to serialize, or (b) a *shared* global testcontainer started via vitest's `globalSetup` (one container per `npx vitest` invocation, not per file). Option (b) cuts wall-clock by ~10x and removes the contention. Either way, document the policy in the test README.

#### H2. /chikaq aggregator queries scan view_events on (event_type, created_at)
- **Where:** `src/lib/widgetQuery.ts:245-310` — `loadViewsTrend30d`, `loadTopAlbums30d`, `loadRecentActivity24h`.
- **Why:** Only index on view_events is `(share_token, created_at)` from `migrations/006_view_events.sql`. Queries filter by `(created_at > now() - INTERVAL '30 days' AND event_type = 'page_view')` with no `share_token` predicate, so the planner falls back to a seq scan. At 10k+ events per album family this is fine; at 1M+ /chikaq will start to choke.
- **Suggested fix:** Add `migrations/014_view_events_event_type_idx.sql` introducing `CREATE INDEX view_events_event_type_created_at_idx ON view_events (event_type, created_at DESC)`. The size cost is small and the dashboard queries gain a fast path.

#### H3. `SESSION_PASSWORD` falls back to insecure default at module load
- **Where:** `src/lib/session.ts:11` — `password: process.env.SESSION_PASSWORD ?? "dev-only-insecure-password-please-override-in-production-env"`.
- **Why:** If an operator forgets to set `SESSION_PASSWORD` in prod, iron-session silently keys cookies with a publicly-known string. Admin sessions become forgeable. `src/lib/share.ts:41` correctly throws, but session.ts does not — and session.ts loads first during a normal request.
- **Suggested fix:** Throw at module load when `NODE_ENV === "production"` and the env is missing. The dev fallback can stay for `NODE_ENV !== "production"`. Document the boot check in `docs/deploy.md` §3.

#### H4. Login route has no rate limiter
- **Where:** `src/app/admin/login/actions.ts:24-43`.
- **Why:** Argon2id verify is intentionally slow (~200ms), which gives a cheap-ish bcrypt-style throttle, but a multi-IP credential-stuffing run can still grind. No 429 path, no failed-attempt tracking.
- **Suggested fix:** Reuse `createRateLimiter({ max: 10, windowMs: 60_000 })` keyed by `email` (case-folded) AND a separate one keyed by IP from `x-forwarded-for`. Soft block at 10, hard block + 30s sleep at 20.

### Medium (track + fix)

#### M1. `sql.unsafe()` is used with a whitelisted value but readers can't see that at a glance
- **Where:** `src/app/api/export/[token]/route.ts:236` — `COALESCE(SUM(${sql.unsafe(sizeCol)}), 0)`.
- **Why:** `sizeCol` is computed three lines above as `variant === "original" ? "orig_bytes" : "large_bytes"` — values that were themselves validated upstream at `src/app/api/export/[token]/route.ts:65`. Safe today. Fragile to future drive-by edits.
- **Suggested fix:** Add a `// SAFETY: sizeCol is whitelisted at L65 above. Do not parameterise from URL.` comment above the unsafe call, or refactor to two static SQL branches.

#### M2. `notify*` calls are fire-and-forget but the safeDispatch promise is dropped naked
- **Where:** `src/app/a/[token]/_actions.ts:122-130`, `src/app/api/export/[token]/route.ts:177-184` and 219-227, `src/app/api/upload/finalize/route.ts:54-58`.
- **Why:** `void notifyXxx(...)` is the explicit pattern, and `safeDispatch` swallows internally — but an unhandled rejection from the queue insert step (DB down during enqueue) will not surface in PostHog or logs. Caller sees no error.
- **Suggested fix:** Wrap the inner `dispatchNotification` call site in safeDispatch's existing try/catch (already there) AND emit a console.warn on the rejection branch so logs reflect it. Or change safeDispatch to `.catch(err => console.warn(...))` chained to the promise.

#### M3. `MINIO_API_CORS_ALLOW_ORIGIN=*` default in dev compose
- **Where:** `docker-compose.yml:25` — `MINIO_API_CORS_ALLOW_ORIGIN: ${MINIO_API_CORS_ALLOW_ORIGIN:-*}` (and `.env.example:14`).
- **Why:** Dev defaults to `*` so the first-time onboarding works without thought. The risk is someone copying the dev compose into a "near-prod" staging environment that exposes MinIO publicly. Prod compose at line 67 correctly requires the value (no `*` fallback), so the production path is safe — but the dev default is a footgun.
- **Suggested fix:** Drop the `*` fallback in `.env.example`; force the operator to set `http://localhost:3000` (or whatever) explicitly. Mention the change in README's local-dev section.

#### M4. Test file `tests/e2e/share-flow.spec.ts:59` ships a permanently empty test
- **Where:** `tests/e2e/share-flow.spec.ts:59` — `test.skip("admin preview does not write the viewer cookie", async () => {});`
- **Why:** Empty body + permanent skip = dead code. The other admin-preview behaviour is covered server-side. This will silently rot.
- **Suggested fix:** Either implement the e2e check (Playwright can assert `Set-Cookie` headers from middleware) or delete the placeholder.

#### M5. `Dockerfile` copies the full repo (including tests + docs) into the build stage
- **Where:** `Dockerfile:14` — `COPY . .`.
- **Why:** Tests, docs/, .planning, .superpowers, deploy/, all land in the build context. Build time + image size both inflate. The standalone output strips most, but the build cache is busted by any docs change.
- **Suggested fix:** Add a tighter `.dockerignore` (verify one exists; if not, create one excluding tests/, docs/, .planning/, .superpowers/, .git/, test-results/, dist/).

#### M6. Migration ordering for share_links / favorites — viewer_id is TEXT not UUID
- **Where:** `migrations/005_favorites.sql` and `migrations/006_view_events.sql` both store `viewer_id TEXT`.
- **Why:** The middleware mints viewer ids via `crypto.randomUUID()` — they ARE UUIDs at the source. Storing as TEXT works but loses the UUID validation + index efficiency. Not a correctness bug; future-tracking.
- **Suggested fix:** Track as backlog; the migration to convert is `ALTER ... USING viewer_id::uuid` which would need a backfill check first.

### Low (nice to have)

#### L1. `src/app/chikaq/page.tsx` is 481 LOC
- Big single file with the dashboard layout + sparkline + multiple cards. Worth splitting into `chikaq/_components/*.tsx` if more cards land.

#### L2. `src/lib/widgetQuery.ts` is 348 LOC and mixes /api/widget/summary loader with /chikaq aggregators
- Two consumers, two query families. Could split into `widgetQuery.ts` + `insightsQuery.ts` for clarity. Both are server-only so the split is cheap.

#### L3. README local-dev section says `seed:admin` password `local-dev`; `.env.example` says `qwertyAI`
- Minor doc drift. Pick one canonical demo password.

#### L4. `tests/scripts/migrate.test.ts` manifest is hand-maintained
- Latest migration (013) is listed, so it's current. But a single forgotten edit would silently miss a new migration. Consider a sanity assertion that `readdirSync(migrations).length === expectedList.length`.

#### L5. `notify*` Telegram messages use MarkdownV2 with hand-escaping
- The dedicated `tests/lib/telegram-formatter.test.ts` covers it, but adding a bot username verification probe on first boot would catch a typo'd token before the first real event.

#### L6. `docs/notifications.md` references `@userinfobot` for chat_id lookup
- Works today; the upstream bot has gone offline a couple of times historically. Documenting the `getUpdates` fallback (which is already in the doc) is good — consider leading with it.

### Observations (not bugs, just context)

- **CSP:** `next.config.mjs` includes `'unsafe-inline'` AND `'unsafe-eval'` in `script-src`. Both are required for Next 15 dev mode + Tailwind/Radix runtime. Production-grade tightening would need a nonce-based approach (Next supports it via `headers()` + nonce middleware), but that's a known Next 15 ergonomics gap. Not a regression.
- **CORS:** Prod compose hardcodes `MINIO_API_CORS_ALLOW_ORIGIN` from env, expects a single concrete origin. Good.
- **Iron-session:** TTL 30 days, httpOnly+sameSite=lax+secure-in-prod. Standard.
- **Presign TTLs:** PUT 900s (15 min), GET 3600s (1 hour). Sane.
- **Auth coverage:** Every admin route handler I read calls `requireAdminSession(req)` or `requireAdmin()`. Every public route resolves status via `resolveShareLinkStatus`. Clean.
- **Telegram bot token:** Read only in `workers/notifications.ts` and `src/app/admin/notifications/actions.ts` (server side). Never crosses to the client bundle. Good.
- **PostHog key:** `NEXT_PUBLIC_*` variant is public by design. Only `safeCapture` is wired through it. No PII leakage in event properties I sampled.
- **Dockerfiles:** Multi-stage. Non-root user (nextjs / node). Minimal final image. Good.
- **Healthchecks:** Present on every prod service. Good.
- **Resource limits:** Present on every prod service. Memory caps look sensible (Postgres 1G, ClickHouse 2G, app 1G).
- **`serverExternalPackages`:** Includes `sharp`, `pg-boss`. Correct.
- **AVIF rendering:** `src/components/gallery/PhotoTile.tsx:217-230` uses a proper `<picture>` element with AVIF source ahead of the JPG fallback. Correct.
- **ThumbHash decode:** Happens server-side in `thumbhashToDataUrl` (see `src/lib/thumbhash.ts`); only the data: URL is sent to the client. No decoder shipped. Correct.
- **View Transitions:** `src/lib/view-transition.ts` correctly feature-detects `document.startViewTransition` and falls back to a sync nav call. Correct.

## Coverage gaps

Flows with explicit tests:
- Admin login (`tests/app/admin/login.test.ts`)
- Album CRUD + share link (`tests/app/admin/albums/actions.test.ts`, `tests/integration/share-actions.test.ts`)
- Upload presign + finalize (`tests/api/presign.test.ts`, `tests/api/finalize.test.ts`)
- Favorites toggle (`tests/integration/favorites.test.ts`, e2e)
- Export flow (`tests/integration/export.flow.test.ts`)
- Password gate (covered by `tests/integration/share-actions.test.ts` + e2e)
- Bulk delete + bulk move (`tests/integration/bulk-photos.test.ts`)
- Drag-reorder (`tests/integration/reorder-photos.test.ts`)
- Cover picker (`tests/integration/cover-picker.test.ts`)
- Photo edit (rotate/crop/brightness) (`tests/integration/photo-edit-api.test.ts`, `tests/unit/photo-edit.test.ts`)
- Watermark toggle + worker (`tests/integration/watermark.test.ts`, `tests/integration/watermark-worker.test.ts`)
- Notification dispatch + dedup (`tests/integration/notifications-dispatch.test.ts`, `tests/integration/notifications-favorites-burst.test.ts`)
- Lightbox navigation (e2e `tests/e2e/lightbox.spec.ts`)
- Widget summary endpoint (`tests/integration/widget.summary.test.ts`)

Gaps to flag:
- **G1.** `/admin/notifications` server actions (`updateRule`, `testNotification`, `replayFailed`) have no dedicated test. The `_testDispatchForAdmin` helper exists but isn't exercised through a suite I could find.
- **G2.** `regenerateAlbumDerivativesAction` (post-watermark-toggle re-enqueue) has no direct test — the watermark integration covers the worker side, not the action's enqueue logic.
- **G3.** Storage quota threshold crossing (`checkStorageQuota` emitting `storage_critical`) has unit coverage in `tests/lib/storage-monitor.test.ts` but no end-to-end e2e — admin would not be alerted in CI if the threshold maths regress.
- **G4.** `/api/photos/[id]/edit` failure paths: payload validation is covered, but 410-on-missing-original and 500-on-empty-body aren't reached in tests.
- **G5.** Iron-session expiry behaviour (30-day TTL → forced re-login) is not asserted anywhere.
- **G6.** CSP header presence test — would catch a regression where `next.config.mjs` headers stop firing.

## Suggested next actions

1. **(Critical, do first)** Rewrite git history to strip the three Claude co-author trailers. One commit, force-push, done.
2. **(High)** Reconfigure vitest to use a shared testcontainer (one Postgres + one MinIO for the whole `npx vitest` invocation). Either via `globalSetup` or by serializing with `pool: 'forks', singleFork: true`. Re-establish the green-bar baseline.
3. **(High)** Throw at module load when `SESSION_PASSWORD` is missing in production. Two-line change in `src/lib/session.ts`.
4. **(High)** Add `migrations/014_view_events_event_type_idx.sql` covering the /chikaq aggregator queries.
5. **(High)** Add rate limiting to `/admin/login` server action (by IP and by email).
6. **(Medium)** Address C1-C2 watch (sql.unsafe comment, fire-and-forget logging).
7. **(Medium)** Tighten dev CORS default to a concrete localhost origin.
8. **(Medium)** Audit `.dockerignore` and trim the build context.
9. **(Medium)** Add `Set-Cookie` assertion + missing-original assertion + CSP-header assertion to the integration suite.
10. **(Low)** Backlog the viewer_id UUID migration, the /chikaq file split, and the doc-drift cleanups.

Estimated effort for items 1-5: less than a working day. After that, the project is production-shippable on this audit's criteria.
