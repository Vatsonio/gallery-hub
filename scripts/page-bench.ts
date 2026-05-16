/**
 * page-bench.ts — perceived-perf measurement harness for the public share page.
 *
 * Loads `/a/<token>` in a headless chromium with a fresh context (no disk
 * cache, no service worker), and captures:
 *
 *   - TTFB           — `responseStart` from the navigation timing entry
 *   - FCP            — first paint event (`first-contentful-paint`)
 *   - LCP            — last reported `largest-contentful-paint`
 *   - bytesDownloaded — sum of `transferSize` from every resource entry
 *   - imagesLoaded   — count of <img> resources whose `responseEnd` fired
 *   - time-to-first-image — first paint of a real photo tile (responseEnd of
 *                          the first imgproxy URL)
 *   - time-to-50%    — responseEnd of the (N/2)th imgproxy URL, sorted
 *   - time-to-100%   — responseEnd of the last imgproxy URL
 *
 * "Real photo paint" is approximated by the imgproxy URL's `responseEnd`,
 * NOT by the ThumbHash placeholder — the script filters resources whose URL
 * is served by PUBLIC_IMGPROXY_URL (or contains `/imgproxy/`).
 *
 * Usage (PowerShell, dev stack running with imgproxy on :8080):
 *
 *   $env:PAGE_BENCH_TOKEN = "abcdef12"
 *   $env:E2E_BASE_URL = "http://localhost:3000"
 *   npx tsx scripts/page-bench.ts
 *
 * Optional flags:
 *   --token <t>      share-link token (overrides PAGE_BENCH_TOKEN)
 *   --base-url <u>   gallery base URL (overrides E2E_BASE_URL)
 *   --viewport WxH   e.g. 1280x800 (desktop) or 375x667 (iPhone SE)
 *   --label <l>      printed in the output header (baseline | post-w1 | ...)
 *   --runs <n>       repeat N times and print mean of each metric (default 1)
 *   --json           emit a single JSON object after the table for piping
 *
 * The script does NOT spin up the dev server itself — bring your own
 * `npm run dev` + worker. Exits 1 if the token doesn't resolve.
 */
import { chromium, type Browser, type Page } from "@playwright/test";

interface Args {
  token: string;
  baseUrl: string;
  viewport: { width: number; height: number };
  label: string;
  runs: number;
  json: boolean;
}

interface RunMetrics {
  ttfbMs: number;
  fcpMs: number;
  lcpMs: number;
  bytesTotal: number;
  imageBytesTotal: number;
  imagesResolved: number;
  firstImageMs: number | null;
  pct50ImageMs: number | null;
  pct100ImageMs: number | null;
}

function parseArgs(argv: string[]): Args {
  const out: Args = {
    token: process.env.PAGE_BENCH_TOKEN ?? "",
    baseUrl: process.env.E2E_BASE_URL ?? "http://localhost:3000",
    viewport: { width: 1280, height: 800 },
    label: "baseline",
    runs: 1,
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    if (k === "--token" && v) { out.token = v; i++; }
    else if (k === "--base-url" && v) { out.baseUrl = v; i++; }
    else if (k === "--viewport" && v) {
      const m = v.match(/^(\d+)x(\d+)$/);
      if (m) { out.viewport = { width: parseInt(m[1], 10), height: parseInt(m[2], 10) }; }
      i++;
    }
    else if (k === "--label" && v) { out.label = v; i++; }
    else if (k === "--runs" && v) { out.runs = Math.max(1, parseInt(v, 10)); i++; }
    else if (k === "--json") { out.json = true; }
  }
  if (!out.token) {
    console.error("page-bench: --token (or PAGE_BENCH_TOKEN env) is required");
    process.exit(2);
  }
  return out;
}

function fmtMs(v: number | null): string {
  if (v === null) return "  n/a";
  if (v < 10) return `${v.toFixed(1)} ms`;
  return `${Math.round(v)} ms`;
}

function fmtBytes(v: number): string {
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  return `${(v / 1024 / 1024).toFixed(2)} MB`;
}

/**
 * Sniff which resources are served by imgproxy. We look at the absolute URL
 * for the public imgproxy origin (env-driven) plus a couple of fallback
 * heuristics. False negatives are safer than false positives — counting a
 * non-photo asset as "an image tile" would inflate the time-to-100% metric.
 */
function isImgproxyResource(url: string): boolean {
  const pub = process.env.PUBLIC_IMGPROXY_URL?.replace(/\/+$/, "") ?? "";
  if (pub && url.startsWith(pub)) return true;
  // Fallback: localhost:8080 is the default dev port. We don't match other
  // ports to avoid catching a Next.js asset route by accident.
  if (/^https?:\/\/(?:localhost|127\.0\.0\.1):8080\//.test(url)) return true;
  return false;
}

async function runOnce(browser: Browser, args: Args): Promise<RunMetrics> {
  const context = await browser.newContext({
    viewport: args.viewport,
    // Force a fresh cache for every run — we want first-load numbers.
    storageState: undefined,
    serviceWorkers: "block",
  });
  // Disable HTTP caching at the protocol level (network domain). Playwright
  // creates a fresh context which already starts with an empty cache, but
  // setExtraHTTPHeaders + cacheDisabled belt-and-suspenders prevents 304s
  // from a shared upstream from masking what a cold viewer would see.
  await context.route("**/*", (route) => route.continue());

  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });

  const navUrl = `${args.baseUrl.replace(/\/+$/, "")}/a/${args.token}`;
  const t0 = Date.now();
  const response = await page.goto(navUrl, { waitUntil: "load", timeout: 60_000 });
  if (!response || response.status() >= 400) {
    await context.close();
    throw new Error(`page-bench: navigation failed: ${response?.status() ?? "no response"} for ${navUrl}`);
  }

  // Wait a fixed quiet window after `load` so lazy <img>s and LCP candidates
  // have a chance to fire. We don't use `networkidle` because the gallery
  // page never goes fully idle (PostHog ping, etc.).
  await page.waitForTimeout(3500);

  // Pull the navigation timing + paint entries + a curated resource table.
  const sample = await page.evaluate((tStart) => {
    function safeGetEntries<T extends PerformanceEntry>(type: string): T[] {
      try { return performance.getEntriesByType(type) as T[]; } catch { return []; }
    }
    const nav = (safeGetEntries<PerformanceNavigationTiming>("navigation"))[0];
    const paints = safeGetEntries<PerformanceEntry>("paint");
    const fcpEntry = paints.find((p) => p.name === "first-contentful-paint");
    const resources = safeGetEntries<PerformanceResourceTiming>("resource");

    // `largest-contentful-paint` lives in a different buffer. Read whatever
    // the browser has surfaced so far; the navigation already waited for
    // load + 3.5s grace, which is the LCP-stable window we care about.
    let lcpStart = 0;
    try {
      const lcpEntries = (performance as unknown as {
        getEntriesByType: (t: string) => PerformanceEntry[];
      }).getEntriesByType("largest-contentful-paint");
      if (lcpEntries.length > 0) {
        const last = lcpEntries[lcpEntries.length - 1] as PerformanceEntry & { startTime: number };
        lcpStart = last.startTime;
      }
    } catch { /* not supported */ }

    return {
      ttfbMs: nav ? nav.responseStart : 0,
      fcpMs: fcpEntry ? fcpEntry.startTime : 0,
      lcpMs: lcpStart,
      resources: resources.map((r) => ({
        name: r.name,
        startTime: r.startTime,
        responseEnd: r.responseEnd,
        transferSize: r.transferSize ?? 0,
        encodedBodySize: r.encodedBodySize ?? 0,
      })),
      navStartUnix: tStart,
    };
  }, t0);

  const allResources = sample.resources;
  let bytesTotal = 0;
  let imageBytesTotal = 0;
  const imageEnds: number[] = [];
  for (const r of allResources) {
    bytesTotal += r.transferSize;
    if (isImgproxyResource(r.name)) {
      imageBytesTotal += r.transferSize;
      imageEnds.push(r.responseEnd);
    }
  }
  imageEnds.sort((a, b) => a - b);
  const firstImageMs = imageEnds.length > 0 ? imageEnds[0] : null;
  const pct50ImageMs = imageEnds.length > 0 ? imageEnds[Math.floor((imageEnds.length - 1) / 2)] : null;
  const pct100ImageMs = imageEnds.length > 0 ? imageEnds[imageEnds.length - 1] : null;

  await context.close();

  return {
    ttfbMs: sample.ttfbMs,
    fcpMs: sample.fcpMs,
    lcpMs: sample.lcpMs,
    bytesTotal,
    imageBytesTotal,
    imagesResolved: imageEnds.length,
    firstImageMs,
    pct50ImageMs,
    pct100ImageMs,
  };
}

function mean(values: Array<number | null>): number | null {
  const nums = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  if (nums.length === 0) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  console.log(
    `[page-bench] label=${args.label} token=${args.token} viewport=${args.viewport.width}x${args.viewport.height} base=${args.baseUrl} runs=${args.runs}`,
  );

  const browser = await chromium.launch({ headless: true });
  const runs: RunMetrics[] = [];
  try {
    for (let i = 0; i < args.runs; i++) {
      const m = await runOnce(browser, args);
      runs.push(m);
      if (args.runs > 1) {
        console.log(`[page-bench] run ${i + 1}/${args.runs}: imagesResolved=${m.imagesResolved} total-100%=${fmtMs(m.pct100ImageMs)}`);
      }
    }
  } finally {
    await browser.close();
  }

  const summary: RunMetrics = {
    ttfbMs: mean(runs.map((r) => r.ttfbMs)) ?? 0,
    fcpMs: mean(runs.map((r) => r.fcpMs)) ?? 0,
    lcpMs: mean(runs.map((r) => r.lcpMs)) ?? 0,
    bytesTotal: Math.round(mean(runs.map((r) => r.bytesTotal)) ?? 0),
    imageBytesTotal: Math.round(mean(runs.map((r) => r.imageBytesTotal)) ?? 0),
    imagesResolved: Math.round(mean(runs.map((r) => r.imagesResolved)) ?? 0),
    firstImageMs: mean(runs.map((r) => r.firstImageMs)),
    pct50ImageMs: mean(runs.map((r) => r.pct50ImageMs)),
    pct100ImageMs: mean(runs.map((r) => r.pct100ImageMs)),
  };

  console.log("");
  console.log(`| metric              | value |`);
  console.log(`|---------------------|------:|`);
  console.log(`| TTFB                | ${fmtMs(summary.ttfbMs)} |`);
  console.log(`| FCP                 | ${fmtMs(summary.fcpMs)} |`);
  console.log(`| LCP                 | ${fmtMs(summary.lcpMs)} |`);
  console.log(`| first photo paint   | ${fmtMs(summary.firstImageMs)} |`);
  console.log(`| time to 50% images  | ${fmtMs(summary.pct50ImageMs)} |`);
  console.log(`| time to 100% images | ${fmtMs(summary.pct100ImageMs)} |`);
  console.log(`| images resolved     | ${summary.imagesResolved} |`);
  console.log(`| image bytes         | ${fmtBytes(summary.imageBytesTotal)} |`);
  console.log(`| total bytes         | ${fmtBytes(summary.bytesTotal)} |`);

  if (args.json) {
    console.log("");
    console.log(JSON.stringify({ label: args.label, viewport: args.viewport, runs: args.runs, ...summary }));
  }
}

main().catch((err) => {
  console.error("[page-bench] FAILED", err);
  process.exit(1);
});
