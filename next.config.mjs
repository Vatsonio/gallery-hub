/** @type {import('next').NextConfig} */

// next/image remotePatterns — derived from runtime env if available at build
// time, with hardcoded fallbacks so a CI build without env still emits a
// valid config. The actual CSP + security headers live in middleware.ts
// (they need runtime env that CI doesn't have).
function originOf(value) {
  if (!value) return null;
  try {
    const u = new URL(value);
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

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

const nextConfig = {
  output: "standalone",
  // F8 pentest finding (2026-05-16): Next ships `X-Powered-By: Next.js` on
  // every HTML response by default, which fingerprints the framework +
  // (combined with asset paths) the major version. Suppress.
  poweredByHeader: false,
  // Server actions only carry small text forms (settings, share defaults,
  // favorites toggles, unlock). Photo bytes go through presigned PUTs straight
  // to MinIO, never through an action, so keep the body cap at the 1mb default:
  // a 50mb cap let anonymous actions (unlock, toggleFavorite) push ~1gb of
  // concurrent payload against the container memory limit.
  experimental: { serverActions: { bodySizeLimit: "1mb" } },
  serverExternalPackages: ["sharp", "pg-boss"],
  images: {
    remotePatterns: [
      { protocol: "http", hostname: "gallery-minio" },
      { protocol: "http", hostname: "localhost" },
      ...dynamicMinioPatterns,
      ...dynamicImgproxyPatterns
    ]
  }
};

export default nextConfig;
