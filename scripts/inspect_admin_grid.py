"""Log into the smoke admin, open an album edit page, and dump the
actual rendered geometry of every PhotoGrid tile (wrapper + inner
PhotoTile). Reports any cell whose inner PhotoTile is taller than its
wrapper, which is the "bottom-right button unreachable" symptom.
"""
import os
import sys
from playwright.sync_api import sync_playwright

BASE = os.environ.get("BASE", "https://gallery.divass.space")
SLUG = os.environ.get("SLUG", "uzhhorod-haca-2026")
EMAIL = os.environ.get("ADMIN_EMAIL", "ggggaggggagggg@gmail.com")
PASSWORD = os.environ.get("ADMIN_PASSWORD", "avionika404")
OUT = "C:/Users/VATS/AppData/Local/Temp"

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    ctx = browser.new_context(viewport={"width": 1440, "height": 900})
    page = ctx.new_page()

    page.on("console", lambda m: print(f"  [console {m.type}] {m.text[:200]}") if m.type in ("error", "warning") else None)

    print(f"[1/3] login as {EMAIL}", flush=True)
    page.goto(f"{BASE}/admin/login", wait_until="networkidle", timeout=60_000)
    page.wait_for_timeout(1200)  # hydration
    # Trigger React change events properly so the form's value is what
    # FormData sees. focus + type does this; fill() sets .value directly
    # which sometimes leaves controlled forms with stale state.
    page.focus('input[name="email"]')
    page.keyboard.type(EMAIL)
    page.focus('input[name="password"]')
    page.keyboard.type(PASSWORD)
    # IMPORTANT: AdminLayout renders the sidebar (including a "Sign out"
    # button[type=submit]) BEFORE the login form's submit button. A plain
    # `button[type="submit"]` selector hits the sidebar's logout, which
    # silently redirects back to /admin/login. Scope to the form that has
    # the email/password fields.
    login_btn = page.locator('main button[type="submit"]:has-text("Sign in")')
    login_btn.click()
    page.wait_for_timeout(3500)
    print(f"  url after submit: {page.url}", flush=True)
    if "login" in page.url:
        page.screenshot(path=f"{OUT}/login-post-submit.png")
        print("  still on login — credentials or rate-limit?")
        sys.exit(1)

    target = f"{BASE}/admin/albums/{SLUG}"
    print(f"[2/3] open {target}", flush=True)
    page.goto(target, wait_until="networkidle", timeout=60_000)
    page.wait_for_selector(".gallery-row", timeout=20_000)
    page.wait_for_timeout(1500)  # let images decode + ResizeObserver settle

    print(f"[3/3] dump tile geometry", flush=True)
    data = page.evaluate("""() => {
      const rows = Array.from(document.querySelectorAll('.gallery-row'));
      const result = [];
      rows.forEach((row, ri) => {
        const rr = row.getBoundingClientRect();
        const wrappers = Array.from(row.querySelectorAll(':scope > div'));
        wrappers.forEach((w, wi) => {
          const wr = w.getBoundingClientRect();
          const tile = w.querySelector(':scope > div');
          if (!tile) return;
          const tr = tile.getBoundingClientRect();
          const tileStyle = getComputedStyle(tile);
          const wrapStyle = getComputedStyle(w);
          const img = tile.querySelector('img');
          const imgInfo = img ? { naturalW: img.naturalWidth, naturalH: img.naturalHeight, w: img.getBoundingClientRect().width, h: img.getBoundingClientRect().height } : null;
          result.push({
            row: ri,
            col: wi,
            row_h: rr.height,
            wrap_w: wr.width, wrap_h: wr.height,
            tile_w: tr.width, tile_h: tr.height,
            wrap_flex: wrapStyle.flex,
            tile_aspect: tileStyle.aspectRatio,
            tile_overflow_y: Math.max(0, tr.bottom - wr.bottom),
            img: imgInfo,
          });
        });
      });
      return result;
    }""")

    print(f"\n  total tiles inspected: {len(data)}")
    overflowing = [d for d in data if d['tile_overflow_y'] > 0.5]
    print(f"  overflowing (tile taller than wrapper): {len(overflowing)}")
    print(f"\n  first 6 tiles:")
    for d in data[:6]:
        print(f"    r{d['row']}c{d['col']}: row_h={d['row_h']:.1f}  wrap={d['wrap_w']:.1f}×{d['wrap_h']:.1f}  tile={d['tile_w']:.1f}×{d['tile_h']:.1f}  overflow_y={d['tile_overflow_y']:.1f}  flex={d['wrap_flex']!r}  aspect={d['tile_aspect']!r}")
        if d['img']:
            print(f"          img natural={d['img']['naturalW']}×{d['img']['naturalH']}  rendered={d['img']['w']:.1f}×{d['img']['h']:.1f}")
    if overflowing:
        print(f"\n  worst overflows:")
        for d in sorted(overflowing, key=lambda x: -x['tile_overflow_y'])[:5]:
            print(f"    r{d['row']}c{d['col']}: overflow_y={d['tile_overflow_y']:.1f}  tile_h={d['tile_h']:.1f} > wrap_h={d['wrap_h']:.1f}  aspect={d['tile_aspect']!r}")

    page.screenshot(path=f"{OUT}/admin-grid.png", full_page=False)
    page.screenshot(path=f"{OUT}/admin-grid-full.png", full_page=True)
    print(f"\n  screenshots: {OUT}/admin-grid.png + admin-grid-full.png")
    browser.close()
