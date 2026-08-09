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
# =============================================================================
FROM node:22-slim AS builder

# OpenSSL is required by the Prisma query engine.
RUN apt-get update && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build

COPY package.json package-lock.json ./
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
FROM node:22-slim AS runtime

ENV NODE_ENV=production

RUN apt-get update && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 1001 appgroup \
    && useradd --uid 1001 --gid appgroup --no-create-home --shell /usr/sbin/nologin appuser

WORKDIR /app

COPY --from=builder /build/package.json ./package.json
COPY --from=builder /build/node_modules ./node_modules
COPY --from=builder /build/prisma ./prisma
COPY --from=builder /build/dist ./dist

USER appuser

EXPOSE 4000

CMD ["node", "dist/main.js"]
