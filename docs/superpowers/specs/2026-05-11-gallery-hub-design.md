# gallery-hub — Design Spec

**Date:** 2026-05-11
**Domain:** `gallery.divass.space`
**Status:** Brainstorm approved, ready for implementation planning

---

## 1. What we're building

A self-hosted client photo gallery for a single photographer (divass). Public-facing site at `gallery.divass.space` and admin at `gallery.divass.space/admin`.

**Inspired by** [picstome](https://github.com/picstome/picstome), but rebuilt from scratch in the existing `personal-hub` stack (Next.js + Postgres + MinIO) instead of porting Laravel/PHP into the infrastructure.

### Core workflow

1. Admin (you) logs in.
2. Creates a private album, uploads photos.
3. Generates a public share link `gallery.divass.space/a/{token}`.
4. Sends the link to a client.
5. Client opens the link, browses photos in a dark-cinematic viewer, double-clicks/taps to favorite individual photos, optionally exports a ZIP (favorites only, or whole album at web-size, or originals).
6. Admin sees which photos the client favorited from the admin album page.

### Out of scope (deliberately cut from picstome)

- Multi-user accounts (single admin)
- Watermarks
- Branding/themes per album
- Contracts and invoicing
- Client comments / multiple revision rounds
- Email notifications to clients (admin can be notified by email — out of MVP)

---

## 2. Visual & interaction design

### Aesthetic — "Dark Cinematic"

- Deep black background (`#0a0a0a` / `#0d0d0d`).
- Inter typography. Heading weights 400–600, generous letter-spacing.
- Accent color **pink/rose** `#ff4d6d` — used for likes/hearts, primary CTAs, the share-link card, and selection indicators. Ties every "favorite" surface together visually.
- Glassmorphism for floating chrome (sticky CTAs, top/bottom bars in the lightbox).
- Lucide-style SVG icons (no emojis as UI).
- Smooth transitions 150–300ms, micro-interactions 50–100ms.

### Public gallery — `/a/{token}`

**Grid:** B1 **justified rows** (Flickr-style). Each row has equal height, photo widths flex by aspect ratio. No cropping — photos preserve native proportions. 16/9 hero image at the top with the album title + meta overlay.

**Mobile:** same justified-row pattern, but 2 photos per row on phones. Bottom tabbar with `All` / `Favorites` / `Export` tabs. Safe-area aware.

**Lightbox / single-photo viewer:**
- Desktop: full-screen photo, dark chrome top + bottom, filmstrip strip at the bottom. Top-right action cluster: Info / Download / ♥ Like / Close. Side-arrow nav buttons.
- Mobile: full-screen photo. Top bar with close + counter + info. Bottom bar with three actions: Like / Save / Share.
- **Double-click (desktop) / double-tap (mobile) anywhere on the photo = toggle like.** Instagram-style heart burst animation on the like action.
- Single click/tap on the photo toggles chrome visibility (immersive mode).
- Keyboard: ← → navigate, L like, D download, F favorites-only, Esc close.
- Mobile gestures: swipe ← → navigate, swipe ↓ to dismiss, pinch to zoom.

**Favorites view:** separate tab/page showing only the photos the current viewer has hearted. Sticky CTA at the bottom (mobile) — **Glass Dock** design: glassmorphic plate with rose-gradient icon block, two-line label ("Export favorites" + "3 photos · 24 MB · ZIP"), trailing chevron. Touch target 44px+.

**Export:** modal with three options
1. Favorites only — originals (~size)
2. Whole album — web-size (2400px max)
3. Whole album — originals (~size)

Returns a ZIP. The ZIP is generated and cached in MinIO under `exports/{share_token}/` for 24h so repeat downloads are instant.

### Admin — `/admin`

**Layout:** sidebar (240px) + main. Sidebar sections: Workspace (Albums / Uploads / Share Links), Insights (Client Selections / Activity), System (Storage / Settings).

**Albums dashboard:** card grid. Each card shows the cover photo, status badge (`● Public` / `● Private` / `○ Draft`), and bottom-overlay stats (photos, favorites, views). "+ New album" placeholder card with drag-drop affordance.

**Album detail page:**
- Title + meta + actions (Preview / Upload photos / overflow menu).
- **Share-link card** with rose-tinted gradient background. Shows the URL, expiry date, view count, favorite count, password status. Icon-button actions: Copy / QR / Settings.
- Stats strip (4 cards): Photos, Views, Favorites (rose accent), Downloads.
- Photo grid (6 cols, square tiles). Each tile shows a rose pill `♥ N` indicating how many times that photo was favorited by clients. Cover badge on the cover photo.

---

## 3. Architecture

### Stack

| Concern | Choice | Notes |
|---|---|---|
| Framework | Next.js 15 (App Router) | Same as `personal-hub`. Server actions for mutations. |
| Database | Postgres 16 | **Own instance.** `gallery-hub` is a fully isolated stack — no shared Postgres with `personal-hub`. |
| DB driver | `postgres.js` | No ORM, raw SQL. Matches `personal-hub`. |
| Object storage | MinIO | **Own instance.** Own MinIO container inside the gallery-hub stack. |
| Image processing | `sharp` | Resize to thumb/web/large. |
| Auth (admin) | `iron-session` | Cookie-based, single admin user. |
| ZIP export | `archiver` | Streamed, writes to MinIO cache. |
| Background jobs | `pg-boss` | Derivative generation. Same Postgres. |
| Email (optional) | Resend | Already in personal-hub stack. Notify admin on first client view. MVP-optional. |
| UI primitives | Tailwind + shadcn/ui | Match personal-hub conventions. |
| Icons | Lucide | SVG only. |
| Hosting | Proxmox + Portainer | Docker image via GitHub Actions, same pipeline as personal-hub. |
| Public access | Cloudflare Tunnel | Existing tunnel — add hostname `gallery.divass.space`. |

### Postgres schema

```sql
-- albums
id              uuid PK
slug            text UNIQUE
title           text NOT NULL
subtitle        text
cover_photo_id  uuid                -- nullable, set after first photo upload
status          enum('draft','published','archived')
created_at      timestamptz
updated_at      timestamptz

-- photos
id              uuid PK
album_id        uuid FK → albums
filename        text                -- original filename
width           int                 -- drives B1 justified layout flex ratios
height          int
orig_bytes      bigint
sort_order      int
taken_at        timestamptz         -- from EXIF if present
status          enum('uploading','processing','ready')
created_at      timestamptz

-- share_links
token           text(12) PK         -- URL slug: /a/{token}, randomly generated
album_id        uuid FK → albums
password_hash   text                -- argon2, nullable
expires_at      timestamptz         -- nullable
allow_download  bool DEFAULT true
created_at      timestamptz

-- favorites
share_token     text FK → share_links
photo_id        uuid FK → photos
viewer_id       text                -- anon UUID stored in HttpOnly cookie
created_at      timestamptz
PRIMARY KEY (share_token, photo_id, viewer_id)

-- view_events
id              bigserial PK
share_token     text FK → share_links
viewer_id       text
event_type      enum('page_view','photo_view','download','favorite_add','favorite_remove')
photo_id        uuid                -- nullable
created_at      timestamptz
INDEX (share_token, created_at)

-- admin_users
id              uuid PK
email           text UNIQUE
password_hash   text                -- argon2
created_at      timestamptz
```

### MinIO bucket layout

```
gallery/
├── albums/{album_id}/{photo_id}/
│   ├── original.jpg     full quality, "оригінали" download
│   ├── large.webp       2400px max — lightbox + ZIP "web-size"
│   ├── web.webp         1600px — main grid
│   └── thumb.webp       400px — filmstrip, admin tiles
└── exports/{share_token}/
    └── favorites-{YYYY-MM-DD}.zip   cached 24h, regenerated on selection change
```

### Key flows

**Anonymous viewer identity.** On first request to `/a/{token}`, middleware checks for `gh_viewer` cookie. If absent, generate UUID, set HttpOnly cookie scoped to the share path, persist across sessions on the same device. This is the identity that owns "this viewer's favorites." A client opening the link from phone vs laptop is two different viewers — both lists are visible to admin.

**Like.** Double-click/tap fires a server action `toggleFavorite(token, photoId)`. Upserts `favorites` row keyed on `(share_token, photo_id, viewer_id)`. Optimistic UI update + heart-burst animation. View event logged.

**Upload.** Admin client requests presigned PUT URLs (one per file) → uploads direct to MinIO bypassing the Next.js server. After all files uploaded, calls `finalizeUpload(albumId, manifest)` which inserts `photos` rows with status `processing` and enqueues `pg-boss` derivative jobs. Worker generates thumb/web/large with `sharp`, writes back to MinIO, marks status `ready`.

**Export ZIP.** API route `/api/export/{token}` streams archive. Reads photo records → fetches selected variant from MinIO → pipes through `archiver` → streams to client and simultaneously to `exports/{share_token}/...zip` for caching. Subsequent requests within 24h serve the cached object directly (presigned GET, 1h TTL on the URL).

**Admin auth.** Single admin row. Login at `/admin/login` (email + password, argon2). `iron-session` cookie, 30-day refresh. Middleware protects all `/admin/*` routes. No SSO, no password reset flow in MVP (you have DB access).

---

## 4. Repository structure

Following `personal-hub` conventions:

```
gallery-hub/
├── Dockerfile
├── docker-compose.yml            # next app + migrations service
├── package.json
├── next.config.mjs
├── tailwind.config.ts
├── tsconfig.json
├── migrations/                   # SQL migrations, applied by one-shot service
│   ├── 001_albums.sql
│   ├── 002_photos.sql
│   ├── 003_share_links.sql
│   ├── 004_favorites.sql
│   ├── 005_view_events.sql
│   └── 006_admin_users.sql
├── scripts/
│   └── seed-admin.ts             # one-shot to create admin from env vars
├── src/
│   ├── app/
│   │   ├── layout.tsx
│   │   ├── page.tsx              # 404 (no marketing landing — share-link-only)
│   │   ├── a/[token]/            # public share routes
│   │   │   ├── page.tsx          # gallery grid
│   │   │   ├── p/[photoId]/page.tsx   # lightbox via routing (deep-linkable)
│   │   │   ├── favorites/page.tsx
│   │   │   └── password/page.tsx # password gate
│   │   ├── admin/
│   │   │   ├── login/page.tsx
│   │   │   ├── layout.tsx        # sidebar shell
│   │   │   ├── albums/page.tsx
│   │   │   ├── albums/[slug]/page.tsx
│   │   │   └── ...
│   │   └── api/
│   │       ├── upload/presign/route.ts
│   │       ├── upload/finalize/route.ts
│   │       └── export/[token]/route.ts
│   ├── lib/
│   │   ├── db.ts                 # postgres.js singleton
│   │   ├── minio.ts              # S3 client + presign helpers
│   │   ├── session.ts            # iron-session config
│   │   ├── images.ts             # sharp variants
│   │   ├── jobs.ts               # pg-boss setup + workers
│   │   └── viewer.ts             # anon viewer_id cookie
│   ├── components/
│   │   ├── gallery/              # JustifiedGrid, Lightbox, HeartBurst, ExportModal, GlassDock
│   │   └── admin/                # AlbumCard, ShareLinkCard, PhotoTile, ...
│   └── styles/globals.css
└── docs/superpowers/specs/2026-05-11-gallery-hub-design.md   # this file
```

---

## 5. Deployment — fully isolated stack

`gallery-hub` is deployed as its own Portainer stack — independent from `personal-hub`. Own Postgres, own MinIO, own everything. Deploys to gallery-hub never touch personal-hub and vice versa.

**Compose services (`docker-compose.yml`):**

- `gallery-app` — Next.js application (built from this repo).
- `gallery-postgres` — Postgres 16 with named volume `gallery_pgdata`.
- `gallery-minio` — MinIO with named volume `gallery_miniodata`. Console exposed only on internal network.
- `gallery-migrate` — one-shot service that runs SQL migrations against `gallery-postgres` then exits. Depends on `gallery-postgres` being healthy.
- `gallery-worker` — pg-boss worker container running derivative generation. Separate from `gallery-app` so heavy `sharp` jobs don't compete with HTTP requests.

**CI/CD pipeline:**

- GitHub Actions on push to `main`: build Docker image for `gallery-app` and `gallery-worker`, push to registry.
- Portainer webhook re-pulls and restarts the gallery-hub stack.

**Cloudflare Tunnel:** add hostname `gallery.divass.space` → `gallery-app:3000`. Existing `personal-hub` tunnel route stays untouched.

**Secrets (Portainer env):**

```
DATABASE_URL=postgresql://gallery:***@gallery-postgres:5432/gallery_hub
MINIO_ENDPOINT=http://gallery-minio:9000
MINIO_ACCESS_KEY=...
MINIO_SECRET_KEY=...
MINIO_BUCKET=gallery
SESSION_PASSWORD=...                       # iron-session, 32+ chars
ADMIN_EMAIL=admin@divass.space
ADMIN_PASSWORD_HASH=...                    # argon2, generated once
WIDGET_TOKEN=...                           # shared with personal-hub, see Section 6
RESEND_API_KEY=...                         # optional
PUBLIC_BASE_URL=https://gallery.divass.space
```

---

## 6. Integration: personal-hub widget

`personal-hub` (at `divass.space`) gets a small widget showing recent gallery activity. The two apps communicate via a single read-only HTTP endpoint over the public URL (Cloudflare Tunnel handles routing). No direct DB or Docker network coupling — that's the price of full stack isolation, and we accept it.

### Endpoint exposed by gallery-hub

```
GET https://gallery.divass.space/api/widget/summary
Authorization: Bearer ${WIDGET_TOKEN}

→ 200 OK
{
  "stats": {
    "albums_total": 14,
    "albums_published": 8,
    "photos_total": 612,
    "storage_bytes": 3_640_000_000
  },
  "recent_albums": [
    {
      "title": "Anna & Oleh",
      "subtitle": "Wedding · Oct 2026",
      "cover_url": "https://gallery.divass.space/img/thumb/...",
      "photo_count": 42,
      "favorite_count": 12,
      "view_count": 38,
      "share_url": "https://gallery.divass.space/a/Hk7eRq8x",
      "status": "published",
      "updated_at": "2026-05-09T..."
    },
    ...
  ],
  "recent_selections": [
    {
      "album_title": "Anna & Oleh",
      "added_count": 3,
      "viewer_id_short": "a4f...",
      "at": "2026-05-10T..."
    }
  ]
}
```

- Returns up to 5 recent albums + 5 recent selection events.
- Cover URLs are short-lived presigned MinIO URLs (1h TTL) — widget should re-fetch every ~30min, not cache forever.
- Auth: bearer token via `WIDGET_TOKEN` env var. Same token is set in `personal-hub` env. No user session, no admin login.
- Rate-limited to a few requests per minute (the widget refresh cadence).

### Widget on personal-hub side

A Next.js server component on personal-hub fetches this endpoint (server-side, with the token in env), revalidates every 5min via `next: { revalidate: 300 }`, and renders the dark-cinematic Gallery panel — title, top-3 recent album cards, total stats, "Open gallery →" link to `gallery.divass.space/admin`. Visual style matches the gallery-hub aesthetic (same rose accent, Inter, Lucide icons).

If the endpoint is unreachable (gallery-hub down), widget shows a graceful empty state — "Gallery offline" with retry — and personal-hub keeps working.

---

## 7. Acceptance criteria (MVP)

- [ ] Admin can log in at `/admin/login`.
- [ ] Admin can create an album, set title/subtitle, mark draft/published.
- [ ] Admin can drag-drop upload photos. Derivatives generate within ~30s of upload completion.
- [ ] Admin can set the cover photo and reorder photos.
- [ ] Admin can generate a share link with optional password and expiry.
- [ ] Admin can copy the share URL and download a QR code.
- [ ] Public visitor opening a valid share link sees the dark-cinematic justified grid with hero header.
- [ ] Public visitor can double-click/tap to favorite a photo. Hearts persist across page reloads on the same device.
- [ ] Public visitor can open lightbox, navigate with arrows or swipe, double-click/tap to favorite, close with Esc/swipe-down.
- [ ] Public visitor can switch to Favorites tab and see only their hearted photos.
- [ ] Public visitor can export ZIP (favorites only / whole album web / whole album originals).
- [ ] Admin can view all favorited photos by viewer (grouped per share link).
- [ ] Mobile experience is fully functional at 375px width with no horizontal scroll.
- [ ] Lightbox preloads neighboring photos for instant navigation.
- [ ] All admin pages have correct `cursor-pointer`, focus states, and 4.5:1 text contrast minimum.

---

## 8. Open questions / deferred

These are intentionally not decided yet — defaults proposed, can be revisited during planning:

- **Original-quality download gating:** default — allowed if `share_links.allow_download = true`. No water-marked previews. Revisit if a client engagement needs it.
- **Selection limit per viewer:** default — unlimited. Photographer-set max (e.g. "pick 30 photos") can be added as `share_links.max_favorites` if needed.
- **Email notify admin on selection:** out of MVP. Add via Resend when there's demand.
- **EXIF preservation:** keep EXIF on `original.jpg`, strip on web/thumb derivatives for privacy.
- **Multi-link per album:** MVP supports one link per album. Multiple links per album (different clients, different passwords) — easy schema change, defer to v2 if needed.
- **Photo deletion in admin:** must handle MinIO cleanup. Use a soft-delete column + reaper job; safer than cascade delete from MinIO directly.

---

## 9. Status & next step

Brainstorm complete. Ready for implementation planning.

**Next:** invoke `superpowers:writing-plans` skill to produce a detailed, step-by-step implementation plan from this spec.
