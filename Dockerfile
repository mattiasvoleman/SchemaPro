# =============================================================================
# SchemaPro API (NestJS gateway) — multi-stage build
#
# Node 22, not 20: @supabase/supabase-js constructs a RealtimeClient inside
# createClient(), which requires a native WebSocket global — added in Node 22.
# SupabaseAdminService calls createClient() in its CONSTRUCTOR, so on Node 20 a
# deployment with Supabase configured throws at boot:
#   "Node.js detected but native WebSocket not found."
# Verified directly against node:20-slim and node:22-slim. Do not lower this
# without checking that call path.
#
# Both stages pin the same digest, which is what actually decides the bytes —
# `22-slim` moves with every upstream patch release, so two builds of the same
# commit would otherwise not be the same image. The tag stays in front of the
# digest so a reader can see what is pinned. Refresh both lines together, and
# deliberately (a pin also freezes base-image CVE fixes until someone moves it):
#   docker buildx imagetools inspect node:22-slim --format '{{.Manifest.Digest}}'
#
# Pinned 2026-08-22 → node 22.23.2 (index published 2026-08-05).
# =============================================================================
FROM node:22-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436 AS builder

# OpenSSL is required by Prisma's schema engine, which `prisma migrate deploy`
# runs (the compose `migrate` service uses this image). Prisma 7 has no Rust
# query engine any more; queries go through @prisma/adapter-pg.
RUN apt-get update && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build

# prisma.config.ts names the schema and, for migrate, the DIRECT_URL datasource.
# `prisma generate` needs no database variable to read it.
COPY package.json package-lock.json prisma.config.ts ./
COPY prisma ./prisma
RUN npm ci --no-audit --no-fund \
    && npx prisma generate

COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src
RUN npm run build \
    # Drop dev dependencies but keep the generated Prisma client.
    && npm prune --omit=dev


# =============================================================================
# Runtime
# =============================================================================
# Same digest as the builder stage above — see the note there before changing it.
FROM node:22-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436 AS runtime

ENV NODE_ENV=production

RUN apt-get update && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 1001 appgroup \
    && useradd --uid 1001 --gid appgroup --no-create-home --shell /usr/sbin/nologin appuser

WORKDIR /app

COPY --from=builder /build/package.json ./package.json
COPY --from=builder /build/node_modules ./node_modules
COPY --from=builder /build/prisma ./prisma
# The compose `migrate` service runs `prisma migrate deploy` from this image,
# and without the config the CLI has no datasource to migrate.
COPY --from=builder /build/prisma.config.ts ./prisma.config.ts
COPY --from=builder /build/dist ./dist

USER appuser

EXPOSE 4000

CMD ["node", "dist/main.js"]
