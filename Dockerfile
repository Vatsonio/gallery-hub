# syntax=docker/dockerfile:1.6
FROM node:22-alpine AS base

# ── deps ──────────────────────────────────────────────────────────────────────
FROM base AS deps
RUN apk add --no-cache libc6-compat
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ── builder ───────────────────────────────────────────────────────────────────
FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# ── runner ────────────────────────────────────────────────────────────────────
FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

RUN addgroup --system --gid 1001 nodejs \
 && adduser  --system --uid 1001 nextjs

RUN mkdir -p ./public
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

# Migration assets — run via the gallery-migrate one-shot service.
# `src/` is required because scripts/migrate.ts dynamically imports
# `../src/lib/minio` (bucket provision) and scripts/seed-admin.ts
# imports `../src/lib/passwords` (argon2 hash). Without these copies
# the one-shot exits 0 but logs ERR_MODULE_NOT_FOUND and the prod
# stack ends up with no bucket and no admin row.
COPY --from=builder --chown=nextjs:nodejs /app/migrations ./migrations
COPY --from=builder --chown=nextjs:nodejs /app/scripts ./scripts
COPY --from=builder --chown=nextjs:nodejs /app/src ./src
COPY --from=builder --chown=nextjs:nodejs /app/tsconfig.json ./tsconfig.json
COPY --from=deps    --chown=nextjs:nodejs /app/node_modules ./node_modules

USER nextjs
EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Build metadata baked into the image. CI passes APP_VERSION=sha-<git sha>
# via --build-arg; at runtime compose can still override it (env wins over
# ENV). This shows up in the admin sidebar footer + the startup log line
# (src/instrumentation.ts) so operators can spot stale containers at a
# glance.
ARG APP_VERSION=dev
ENV APP_VERSION=${APP_VERSION}

CMD ["node", "server.js"]
