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

const cspHeader = [
  "default-src 'self'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  `img-src 'self' data: blob: https: ${minioOrigins.join(" ")}`.trim(),
  "font-src 'self' data: https:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  `connect-src 'self' ${minioOrigins.join(" ")}`.trim(),
  "upgrade-insecure-requests"
].join("; ");

const nextConfig = {
  output: "standalone",
  experimental: { serverActions: { bodySizeLimit: "50mb" } },
  serverExternalPackages: ["sharp", "pg-boss"],
  images: {
    remotePatterns: [
      { protocol: "http", hostname: "gallery-minio" },
      { protocol: "http", hostname: "localhost" },
      { protocol: "https", hostname: "gallery.divass.space" }
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
