/**
 * Pure header-IP resolution. Lives outside any `"use server"` file so it can
 * be exported synchronously and unit-tested directly. Server actions import
 * the async wrapper from this module.
 *
 * F2 pentest finding (2026-05-16): the previous implementation trusted
 * `x-forwarded-for` unconditionally — any deployment reachable on a port
 * other than the trusted proxy could rotate source IPs by spoofing XFF and
 * brute-force at full speed. Header trust is now gated on
 * `TRUST_PROXY_HEADERS=1` so the deployment owner has to opt-in.
 */
export interface IpHeaderSource {
  get(name: string): string | null;
}

export function resolveIpFromHeaders(h: IpHeaderSource): string {
  const trustProxy = process.env.TRUST_PROXY_HEADERS === "1";
  if (trustProxy) {
    const cf = h.get("cf-connecting-ip");
    if (cf) return cf.trim();
    const xff = h.get("x-forwarded-for");
    if (xff) {
      const first = xff.split(",")[0];
      if (first) return first.trim();
    }
    const real = h.get("x-real-ip");
    if (real) return real.trim();
  }
  return "unknown";
}
