import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import {
  buildImgproxyUrl,
  imgproxyThumb,
  imgproxyWeb,
  imgproxyLarge,
  isImgproxyEnabled,
  __resetImgproxyContextForTests,
} from "@/lib/imgproxy";

// Fixed dev-only test secrets — never used outside this file.
const TEST_KEY_HEX = "0011223344556677889900aabbccddeeff";
const TEST_SALT_HEX = "ffeeddccbbaa00998877665544332211";
const TEST_BASE = "https://img.test.local";
const TEST_BUCKET = "gallery-test";

function setupEnv(): void {
  process.env.PUBLIC_IMGPROXY_URL = TEST_BASE;
  process.env.IMGPROXY_KEY = TEST_KEY_HEX;
  process.env.IMGPROXY_SALT = TEST_SALT_HEX;
  process.env.IMGPROXY_BUCKET = TEST_BUCKET;
  __resetImgproxyContextForTests();
}

function tearDownEnv(): void {
  delete process.env.PUBLIC_IMGPROXY_URL;
  delete process.env.IMGPROXY_KEY;
  delete process.env.IMGPROXY_SALT;
  delete process.env.IMGPROXY_BUCKET;
  __resetImgproxyContextForTests();
}

function base64url(b: Buffer): string {
  return b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function expectedSig(pathBody: string): string {
  const key = Buffer.from(TEST_KEY_HEX, "hex");
  const salt = Buffer.from(TEST_SALT_HEX, "hex");
  const mac = createHmac("sha256", key).update(salt).update(pathBody).digest();
  return base64url(mac);
}

function decodeSource(encoded: string): string {
  const pad = encoded.length % 4 === 0 ? "" : "=".repeat(4 - (encoded.length % 4));
  return Buffer.from(encoded.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64").toString("utf8");
}

describe("imgproxy URL builder", () => {
  beforeEach(setupEnv);
  afterEach(tearDownEnv);

  it("isImgproxyEnabled true when env wired", () => {
    expect(isImgproxyEnabled()).toBe(true);
  });

  it("isImgproxyEnabled false without env, and builder returns a placeholder", () => {
    tearDownEnv();
    expect(isImgproxyEnabled()).toBe(false);
    expect(buildImgproxyUrl("albums/a/p/original.jpg")).toBe("imgproxy://albums/a/p/original.jpg");
  });

  it("builds a signed URL containing the imgproxy base, signature, processing, and encoded source", () => {
    const url = buildImgproxyUrl("albums/a/p/original.jpg", { width: 400, height: 400, quality: 75 });
    expect(url.startsWith(`${TEST_BASE}/`)).toBe(true);

    // Strip base; the rest is /{sig}/{processing}/{encodedSource}[.{ext}]
    const rest = url.slice(TEST_BASE.length);
    const segments = rest.split("/").filter(Boolean);
    expect(segments.length).toBeGreaterThanOrEqual(3);
    const [sig, resize, quality, encodedSource] = segments;
    expect(sig.length).toBeGreaterThan(20);
    expect(resize).toBe("resize:fit:400:400:0");
    expect(quality).toBe("quality:75");
    // Encoded source should decode back to the s3:// URI.
    expect(decodeSource(encodedSource)).toBe(`s3://${TEST_BUCKET}/albums/a/p/original.jpg`);
  });

  it("signature roundtrips: recomputed HMAC matches the URL's signature segment", () => {
    const url = buildImgproxyUrl("albums/a/p/original.jpg", { width: 1600, height: 1600, quality: 82 });
    const rest = url.slice(TEST_BASE.length);
    const [, ...tail] = rest.split("/").filter(Boolean);
    // Path body the signer signs is exactly "/{processing}/{encodedSource}".
    const pathBody = "/" + tail.join("/");
    const sig = rest.split("/").filter(Boolean)[0];
    expect(sig).toBe(expectedSig(pathBody));
  });

  it("format='auto' omits a trailing extension so imgproxy negotiates via Accept", () => {
    const url = buildImgproxyUrl("albums/a/p/original.jpg", { width: 400, format: "auto" });
    // No `.webp`/`.avif`/`.jpg` suffix in the final segment.
    const last = url.split("/").pop() ?? "";
    expect(last.includes(".")).toBe(false);
  });

  it("format='webp' appends a .webp extension to the encoded source", () => {
    const url = buildImgproxyUrl("albums/a/p/original.jpg", { width: 400, format: "webp" });
    expect(url.endsWith(".webp")).toBe(true);
  });

  it("includes a watermark processing option + wm_url when watermark.key is set", () => {
    const url = buildImgproxyUrl("albums/a/p/original.jpg", {
      width: 1600,
      watermark: { key: "watermarks/album123.png" },
    });
    expect(url).toContain("/watermark:");
    expect(url).toContain("/wm_url:");
    // The wm_url segment encodes the s3:// reference to the watermark PNG.
    const segments = url.split("/");
    const wmSegment = segments.find((s) => s.startsWith("wm_url:"));
    expect(wmSegment).toBeDefined();
    const encoded = wmSegment!.slice("wm_url:".length);
    expect(decodeSource(encoded)).toBe(`s3://${TEST_BUCKET}/watermarks/album123.png`);
  });

  it("appends a cache-bust ?v= to the source URI when `version` is set", () => {
    const url = buildImgproxyUrl("albums/a/p/original.jpg", { width: 400, version: 1700000000 });
    const segments = url.split("/").filter(Boolean);
    const encodedSource = segments[segments.length - 1];
    expect(decodeSource(encodedSource)).toBe(`s3://${TEST_BUCKET}/albums/a/p/original.jpg?v=1700000000`);
  });

  it("different version values produce different signatures", () => {
    const a = buildImgproxyUrl("albums/a/p/original.jpg", { width: 400, version: 1 });
    const b = buildImgproxyUrl("albums/a/p/original.jpg", { width: 400, version: 2 });
    const sigA = a.slice(TEST_BASE.length).split("/").filter(Boolean)[0];
    const sigB = b.slice(TEST_BASE.length).split("/").filter(Boolean)[0];
    expect(sigA).not.toBe(sigB);
  });

  it("imgproxyThumb / imgproxyWeb / imgproxyLarge use the documented size buckets", () => {
    const t = imgproxyThumb("albums/a/p/original.jpg");
    const w = imgproxyWeb("albums/a/p/original.jpg");
    const l = imgproxyLarge("albums/a/p/original.jpg");
    expect(t).toContain("/resize:fit:400:400:0/");
    expect(t).toContain("/quality:75/");
    expect(w).toContain("/resize:fit:1600:1600:0/");
    expect(w).toContain("/quality:82/");
    expect(l).toContain("/resize:fit:2400:2400:0/");
    expect(l).toContain("/quality:86/");
  });

  it("imgproxyWeb honours `version` overrides passed by the caller", () => {
    const v1 = imgproxyWeb("albums/a/p/original.jpg", { version: 100 });
    const v2 = imgproxyWeb("albums/a/p/original.jpg", { version: 200 });
    expect(v1).not.toBe(v2);
  });

  it("rejects non-hex IMGPROXY_KEY at context resolution time", () => {
    process.env.IMGPROXY_KEY = "not-hex-zzzz";
    __resetImgproxyContextForTests();
    expect(() => buildImgproxyUrl("albums/a/p/original.jpg", { width: 400 })).toThrow(/hex/);
  });

  it("default resize mode is 'fit'", () => {
    const url = buildImgproxyUrl("albums/a/p/original.jpg", { width: 100, height: 100 });
    expect(url).toContain("/resize:fit:100:100:0/");
  });

  it("resize 'fill' with explicit gravity emits both segments", () => {
    const url = buildImgproxyUrl("albums/a/p/original.jpg", {
      width: 100,
      height: 100,
      resize: "fill",
      gravity: "ce",
    });
    expect(url).toContain("/resize:fill:100:100:0/");
    expect(url).toContain("/gravity:ce/");
  });

  it("quality is clamped into 1..100", () => {
    const overshoot = buildImgproxyUrl("albums/a/p/original.jpg", { quality: 250 });
    const undershoot = buildImgproxyUrl("albums/a/p/original.jpg", { quality: -50 });
    expect(overshoot).toContain("/quality:100/");
    expect(undershoot).toContain("/quality:1/");
  });
});
