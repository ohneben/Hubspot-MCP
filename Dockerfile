# syntax=docker/dockerfile:1.7

# ── Builder stage: compile TypeScript ─────────────────────────────────
FROM node:20-alpine AS builder
WORKDIR /app

# Install all deps (including dev) for the build
COPY package.json package-lock.json* ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Prune dev dependencies so we copy only what's needed
RUN npm prune --omit=dev


# ── Runtime stage: minimal image ─────────────────────────────────────
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    MCP_TRANSPORT=http \
    HOST=0.0.0.0 \
    PORT=8765

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./package.json
COPY spec ./spec

EXPOSE 8765

# Simple healthcheck against the /health endpoint
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/health" || exit 1

CMD ["node", "dist/index.js"]
