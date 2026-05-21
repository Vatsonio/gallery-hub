"""Progressive-scroll capture: walks the share page from top to bottom
in viewport-sized chunks so content-visibility:auto rows actually
materialise and any gaps in the layout become real (not Playwright
stitching artefacts).
"""
import sys
from playwright.sync_api import sync_playwright

URL = "https://gallery.divass.space/a/cpLUTHI4PNxM"
OUT = "C:/Users/VATS/AppData/Local/Temp"

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    ctx = browser.new_context(viewport={"width": 1280, "height": 900})
    page = ctx.new_page()

    console: list[tuple[str, str]] = []
    page.on("console", lambda m: console.append((m.type, m.text)))

    page.goto(URL, wait_until="networkidle", timeout=60_000)
    total = page.evaluate("document.body.scrollHeight")
    print(f"scrollHeight={total}", flush=True)

    # Walk by ~900px steps. At each stop wait for images in the new
    # viewport to settle, then count visible <img> elements that have
    # actually decoded (naturalWidth > 0) — that's the canary that
    # content-visibility unfroze the row.
    step = 900
    y = 0
    chunk_idx = 0
    while y < total:
        page.evaluate(f"window.scrollTo(0, {y})")
        page.wait_for_timeout(700)
        decoded = page.evaluate("""() => {
          const imgs = Array.from(document.querySelectorAll('img'));
          let decoded = 0, missing = 0;
          for (const i of imgs) {
            const r = i.getBoundingClientRect();
            const inView = r.bottom > 0 && r.top < window.innerHeight;
            if (!inView) continue;
            if (i.naturalWidth > 0) decoded++;
            else missing++;
          }
          return { decoded, missing };
        }""")
        path = f"{OUT}/share-chunk-{chunk_idx:02d}.png"
        page.screenshot(path=path, full_page=False)
        print(f"  y={y}  decoded={decoded['decoded']} missing={decoded['missing']}  -> {path}", flush=True)
        chunk_idx += 1
        y += step

    print(f"\nconsole entries: {len(console)}")
    for typ, txt in console:
        if typ in ("error", "warning", "warn"):
            print(f"  [{typ}] {txt[:200]}")
    browser.close()
