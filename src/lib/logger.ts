import pino, { type Logger } from "pino";

/**
 * Structured (JSON) logger for server-side code — workers, route handlers,
 * server actions, lib modules. NODE-ONLY: never import this from a
 * "use client" component or Edge middleware (pino uses Node APIs).
 *
 * Prod: one JSON line per log → stdout, picked up by Docker and shown in the
 * Dozzle log viewer (deploy/portainer-stack.yml). JSON lets you filter by
 * level / field across every container in one place instead of `docker logs`
 * per container.
 *
 * Dev: pretty, colourised output via pino-pretty (a devDependency).
 *
 * Level: `LOG_LEVEL` env (trace|debug|info|warn|error|fatal), default "info".
 */
const isProd = process.env.NODE_ENV === "production";
const level = process.env.LOG_LEVEL ?? (isProd ? "info" : "debug");

export const logger: Logger = pino({
  level,
  // Redact secrets / PII so they never land in a log line even if an object
  // carrying them is logged by accident. `remove: true` drops the key.
  redact: {
    paths: [
      "password",
      "*.password",
      "bot_token",
      "*.bot_token",
      "token",
      "*.token",
      "authorization",
      "*.authorization",
      "cookie",
      "*.cookie",
      "headers.cookie",
      "headers.authorization",
      "req.headers.cookie",
      "req.headers.authorization",
      "password_hash",
      "*.password_hash",
    ],
    remove: true,
  },
  base: { service: process.env.SERVICE_NAME ?? undefined },
  // Pretty output in dev only; prod stays raw JSON for the aggregator.
  transport: isProd
    ? undefined
    : {
        target: "pino-pretty",
        options: { colorize: true, translateTime: "SYS:HH:MM:ss", ignore: "pid,hostname" },
      },
});

/** Child logger tagged with a component name, e.g. log("worker"). */
export function log(component: string): Logger {
  return logger.child({ component });
}
