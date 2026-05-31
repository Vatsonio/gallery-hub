"use client";

import { useEffect, type ReactNode } from "react";
import posthog from "posthog-js";

interface Props {
  /** PostHog Project API key. Pass null/undefined to disable. */
  apiKey?: string | null;
  /** PostHog host. Defaults to PostHog Cloud if absent. */
  host?: string | null;
  /** Stable per-viewer id (the `gh_viewer` cookie) so client + server share the same distinct id. */
  distinctId?: string | null;
  children: ReactNode;
}

/**
 * Client-side PostHog initializer.
 *
 * Lives at the top of the public share layout so admin pages never load it.
 * The init runs once on mount; subsequent renders are no-ops. Pageview
 * capture is on by default — posthog-js wires into the History API and
 * fires `$pageview` on push/replace/popstate.
 */
export default function PostHogProvider({
  apiKey,
  host,
  distinctId,
  children,
}: Props): React.JSX.Element {
  useEffect(() => {
    if (!apiKey) return;
    // posthog-js guards re-init internally, but checking `__loaded` keeps
    // hot-reloads quiet and avoids redundant identify() calls.
    const w = window as unknown as { __posthog_inited?: boolean };
    if (w.__posthog_inited) return;
    w.__posthog_inited = true;

    posthog.init(apiKey, {
      api_host: host || "https://us.posthog.com",
      capture_pageview: true,
      capture_pageleave: true,
      // Cookieless mode is overkill for a private gallery; the gh_viewer
      // cookie already gives us a stable id, so we just bind to it.
      persistence: "localStorage+cookie",
      // Disable autocapture spam — the gallery is image-heavy and most
      // clicks are not informative. We rely on explicit server captures
      // plus default pageviews/pageleaves.
      autocapture: false,
      // Respect Do Not Track.
      respect_dnt: true,
      // F19: hard-disable session replay locally. This provider mounts for
      // every non-admin viewer of a PRIVATE gallery; with `false`, replay
      // deferred to PostHog remote config, so a one-click enable in the
      // PostHog UI would silently start recording clients browsing their
      // own private photos. `true` kills it at the client regardless of
      // remote config. Set NEXT_PUBLIC_PH_SESSION_REPLAY=1 to opt back in.
      disable_session_recording:
        process.env.NEXT_PUBLIC_PH_SESSION_REPLAY !== "1",
    });

    if (distinctId) {
      posthog.identify(distinctId);
    }
  }, [apiKey, host, distinctId]);

  return <>{children}</>;
}
