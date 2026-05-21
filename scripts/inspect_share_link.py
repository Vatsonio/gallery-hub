"""One-shot reconnaissance of the public share-link page.

Open the URL, scroll progressively to the bottom (triggers any lazy/
infinite-scroll loaders), capture console messages, and dump:
  - Full-page screenshot to /tmp/share-bottom.png
  - DOM snapshot to /tmp/share-bottom.html
  - Console errors / warnings to stdout
"""
import sys
from playwright.sync_api import sync_playwright

URL = "https://gallery.divass.space/a/cpLUTHI4PNxM"

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    ctx = browser.new_context(viewport={"width": 1280, "height": 900})
    page = ctx.new_page()

    console_messages: list[tuple[str, str]] = []
    page_errors: list[str] = []
    page.on("console", lambda msg: console_messages.append((msg.type, msg.text)))
    page.on("pageerror", lambda err: page_errors.append(str(err)))

    print(f"navigating: {URL}", flush=True)
    page.goto(URL, wait_until="networkidle", timeout=60_000)
    title = page.title()
    print(f"title: {title!r}", flush=True)

    # Progressive scroll to trigger any lazy load / infinite-scroll.
    last_h = 0
    for i in range(20):
        page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
        page.wait_for_timeout(800)
        h = page.evaluate("document.body.scrollHeight")
        if h == last_h:
            break
        last_h = h
    print(f"settled scrollHeight: {last_h}", flush=True)

    # Capture bottom-of-page in particular.
    page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
    page.wait_for_timeout(500)
    page.screenshot(path="C:/Users/VATS/AppData/Local/Temp/share-bottom.png", full_page=True)
    page.screenshot(path="C:/Users/VATS/AppData/Local/Temp/share-viewport.png", full_page=False)

    # Element census near the bottom of the document.
    bottom_html = page.evaluate("""() => {
      const all = Array.from(document.querySelectorAll('main *, body > *'));
      const tail = all.slice(-30).map(el => ({
        tag: el.tagName.toLowerCase(),
        id: el.id || null,
        cls: (el.className && typeof el.className === 'string') ? el.className.slice(0, 80) : null,
        text: (el.innerText || '').trim().slice(0, 80) || null,
      }));
      return tail;
    }""")
    print("\n-- last 30 elements --", flush=True)
    for el in bottom_html:
        print(f"  <{el['tag']}>" + (f" #{el['id']}" if el['id'] else "") +
              (f" .{el['cls']}" if el['cls'] else "") +
              (f"  {el['text']!r}" if el['text'] else ""), flush=True)

    print("\n-- console messages --", flush=True)
    if not console_messages:
        print("  (none)", flush=True)
    for typ, txt in console_messages:
        if typ in ("error", "warning", "warn"):
            print(f"  [{typ}] {txt}", flush=True)

    print("\n-- page errors --", flush=True)
    if not page_errors:
        print("  (none)", flush=True)
    for err in page_errors:
        print(f"  {err}", flush=True)

    print("\nscreenshots:")
    print("  C:/Users/VATS/AppData/Local/Temp/share-bottom.png  (full)")
    print("  C:/Users/VATS/AppData/Local/Temp/share-viewport.png  (viewport at bottom)")
    browser.close()
