/**
 * Server-side PostHog adapter.
 *
 * Two design rules:
 *   1. Analytics must NEVER break a user flow. Every capture goes through
 *      `safeCapture` which swallows errors and returns void.
 *   2. The client is constructed lazily and reused. If `POSTHOG_KEY` is
 *      unset (dev without analytics, or PostHog is down), all calls are
 *      no-ops — no network, no logging noise.
 */
import { PostHog } from "posthog-node";

interface CaptureArgs {
  distinctId: string;
  event: string;
  properties?: Record<string, unknown>;
}

let client: PostHog | null = null;
let initialized = false;

/**
 * Lazily construct the PostHog Node client. Returns null when analytics is
 * disabled (no env). The result is cached for the process lifetime; the
 * client maintains an internal flush queue so consecutive captures share a
 * single batched HTTP write.
 */
export function getPostHogClient(): PostHog | null {
  if (initialized) return client;
  initialized = true;
  const key = process.env.POSTHOG_KEY;
  const host = process.env.POSTHOG_HOST;
  if (!key) {
    client = null;
    return null;
  }
  try {
    client = new PostHog(key, {
      host: host || "https://us.posthog.com",
      // Small flush windows keep latency low for short-lived serverless
      // invocations; the client also auto-flushes on shutdown.
      flushAt: 10,
      flushInterval: 5_000,
    });
  } catch {
    client = null;
  }
  return client;
}

/**
 * Synchronous-looking server capture. Will queue the event and return
 * immediately. Errors are swallowed — analytics is not in the user's
 * critical path.
 */
export function capture(args: CaptureArgs): void {
  const ph = getPostHogClient();
  if (!ph) return;
  ph.capture({
    distinctId: args.distinctId,
    event: args.event,
    properties: args.properties,
  });
}

/**
 * The default capture entry point for the app. Wraps `capture` in a
 * try/catch so a misbehaving SDK can never throw into a server action,
 * route handler, or page render.
 */
export function safeCapture(args: CaptureArgs): void {
  try {
    capture(args);
  } catch {
    // Analytics failures are never allowed to surface.
  }
}

/**
 * Test hook — wipes the cached client so a test can swap env and reinit.
 */
export function _resetAnalyticsForTests(): void {
  if (client) {
    void client.shutdown().catch(() => undefined);
  }
  client = null;
  initialized = false;
}
