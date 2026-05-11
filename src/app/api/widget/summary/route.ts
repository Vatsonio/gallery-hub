import { NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { createRateLimiter } from "@/lib/rateLimiter";
import { loadWidgetSummary } from "@/lib/widgetQuery";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 6 requests / minute is plenty for a single dashboard polling on a 5-minute
// revalidate. Per-token (not per-IP) — the personal-hub consumer is the
// only legitimate caller of this endpoint.
const limiter = createRateLimiter({ max: 6, windowMs: 60_000 });

function constantTimeMatch(a: string, b: string): boolean {
  const A = Buffer.from(a);
  const B = Buffer.from(b);
  if (A.length !== B.length) return false;
  return timingSafeEqual(A, B);
}

export async function GET(req: NextRequest): Promise<Response> {
  const expected = process.env.WIDGET_TOKEN;
  if (!expected) {
    // Endpoint is opt-in. If the operator never configured a token, refuse
    // outright rather than fall back to a default — defaults end up in
    // version control. 503 makes the consumer render its offline state.
    return new Response("widget disabled", { status: 503 });
  }

  const auth = req.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(.+)$/.exec(auth);
  if (!m || !constantTimeMatch(m[1], expected)) {
    return new Response("unauthorized", { status: 401 });
  }

  if (!limiter.allow(expected)) {
    return new Response("rate limited", {
      status: 429,
      headers: { "Retry-After": "60" },
    });
  }

  const baseUrl = process.env.PUBLIC_BASE_URL ?? "http://localhost:3000";
  const data = await loadWidgetSummary(baseUrl);
  return Response.json(data, {
    headers: { "Cache-Control": "no-store" },
  });
}
