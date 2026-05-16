/** @type {import('next').NextConfig} */

// Extract scheme://host[:port] from any URL-ish string; tolerant of empty input.
function originOf(value) {
  if (!value) return null;
  try {
    const u = new URL(value);
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

// Browsers PUT directly to MinIO (presigned URLs) and GET <Image> thumbnails
// from it. Both must be in connect-src and img-src or CSP will block them.
const minioOrigins = [
  originOf(process.env.MINIO_PUBLIC_ENDPOINT),
  originOf(process.env.MINIO_ENDPOINT)
].filter(Boolean);

// imgproxy serves every gallery image in the on-demand era. Allow the
// public-facing origin in img-src so the browser can <img src=...> it,
// and connect-src so a future <link rel=preload> works too.
const imgproxyOrigins = [
  originOf(process.env.PUBLIC_IMGPROXY_URL),
  originOf(process.env.IMGPROXY_URL)
].filter(Boolean);

// Build next/image remotePatterns dynamically from the MinIO endpoints so the
// gallery still works if someone switches to next/image down the line.
function patternFromOrigin(value) {
  const o = originOf(value);
  if (!o) return null;
  const u = new URL(o);
  return {
    protocol: u.protocol.replace(":", ""),
    hostname: u.hostname,
    port: u.port || undefined,
    pathname: "/**"
  };
}

const dynamicMinioPatterns = [
  patternFromOrigin(process.env.MINIO_PUBLIC_ENDPOINT),
  patternFromOrigin(process.env.MINIO_ENDPOINT)
].filter(Boolean);

const dynamicImgproxyPatterns = [
  patternFromOrigin(process.env.PUBLIC_IMGPROXY_URL),
  patternFromOrigin(process.env.IMGPROXY_URL)
].filter(Boolean);

const cspHeader = [
  "default-src 'self'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  `img-src 'self' data: blob: https: ${minioOrigins.join(" ")} ${imgproxyOrigins.join(" ")}`.trim().replace(/\s+/g, " "),
  "font-src 'self' data: https:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  `connect-src 'self' ${minioOrigins.join(" ")} ${imgproxyOrigins.join(" ")}`.trim().replace(/\s+/g, " "),
  "upgrade-insecure-requests"
].join("; ");

const nextConfig = {
  output: "standalone",
  // F8 pentest finding (2026-05-16): Next ships `X-Powered-By: Next.js` on
  // every HTML response by default, which fingerprints the framework +
  // (combined with asset paths) the major version. Suppress.
  poweredByHeader: false,
  experimental: { serverActions: { bodySizeLimit: "50mb" } },
  serverExternalPackages: ["sharp", "pg-boss"],
  images: {
    remotePatterns: [
      { protocol: "http", hostname: "gallery-minio" },
      { protocol: "http", hostname: "localhost" },
      { protocol: "https", hostname: "gallery.divass.space" },
      { protocol: "https", hostname: "img.gallery.divass.space" },
      ...dynamicMinioPatterns,
      ...dynamicImgproxyPatterns
    ]
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "Content-Security-Policy", value: cspHeader },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" }
        ]
      }
    ];
  }
};

export default nextConfig;
