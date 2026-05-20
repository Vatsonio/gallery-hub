/**
 * Next.js calls `register()` once per server process on startup (Node and
 * Edge runtimes). Use it as a low-friction place to print build metadata so
 * operators can confirm at a glance which image is actually running.
 *
 * See https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const version = process.env.APP_VERSION ?? "dev";
  const node = process.versions.node;
  const startedAt = new Date().toISOString();
  // eslint-disable-next-line no-console
  console.log(
    `[gallery-hub] starting · version=${version} · node=${node} · ${startedAt}`,
  );
}
