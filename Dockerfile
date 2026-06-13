# =============================================================================
# HiveWard — Multi-stage Dockerfile
# =============================================================================
#
# Build:
#   docker build -t hiveward .
#
# Run (SQLite backend, ephemeral data):
#   docker run -p 10101:10101 hiveward
#
# Run with persistent data:
#   docker run -p 10101:10101 -v ./data:/app/data hiveward
#
# =============================================================================

########################
# Stage 1 — Install all dependencies (including dev deps and native builds)
########################
FROM node:24-slim AS deps
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# Copy all workspace manifests so `npm ci` can resolve the monorepo graph
COPY package.json package-lock.json .npmrc ./
COPY apps/api/package.json        apps/api/package.json
COPY apps/web/package.json        apps/web/package.json
COPY packages/adapter/package.json packages/adapter/package.json
COPY packages/shared/package.json  packages/shared/package.json
COPY packages/cli/package.json     packages/cli/package.json

# Install everything (including dev deps needed for building).
# --ignore-scripts prevents premature native compilation, which is done
# explicitly in the next step so it runs against the final node_modules layout.
RUN npm ci --ignore-scripts

# Rebuild native modules (better-sqlite3) against the target Node ABI
RUN npm rebuild better-sqlite3


########################
# Stage 2 — Build web app and CLI
########################
FROM node:24-slim AS builder
WORKDIR /app

COPY --from=deps /app/node_modules   ./node_modules
COPY --from=deps /app/package-lock.json ./
COPY package.json tsconfig.base.json ./

COPY apps/api    apps/api
COPY apps/web    apps/web
COPY packages     packages
COPY scripts     scripts

# Build: web (Vite) + CLI (tsc), typecheck everything
RUN npm run build


########################
# Stage 3 — Production runtime image
########################
FROM node:24-slim AS production
WORKDIR /app

# ca-certificates for HTTPS outbound connections to provider gateways
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# ---- Artifacts from builder ----

# Built web static files (served by the API app)
COPY --from=builder /app/apps/web/dist    apps/web/dist

# API server source (runs via tsx — no tsc compilation needed)
COPY --from=builder /app/apps/api         apps/api

# Shared workspace packages (consumed as TypeScript source via workspace
# symlinks — only src/ is needed at runtime)
COPY --from=builder /app/packages           packages

# Migration and utility scripts
COPY --from=builder /app/scripts            scripts

# Root workspace manifest (required for npm workspace resolution)
COPY --from=builder /app/package.json       ./
COPY --from=builder /app/package-lock.json  ./

# Symlink the CLI dist so `npx hiveward` works inside the container
COPY --from=builder /app/packages/cli/dist  packages/cli/dist

# Full node_modules (including tsx runtime, better-sqlite3 native binary,
# and all workspace transitive deps)
COPY --from=deps    /app/node_modules       ./node_modules

# ---- Runtime state ----
VOLUME /app/data

# ---- Environment ----
ENV NODE_ENV=production \
    PORT=10101

# ---- Port ----
EXPOSE 10101

# ---- Health ----
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD node -e "fetch('http://localhost:10101/healthz').then(r => { process.exit(r.ok ? 0 : 1) }).catch(() => process.exit(1))"

# ---- Entrypoint ----
ENTRYPOINT ["node", "--import", "tsx", "apps/api/src/server.ts"]
