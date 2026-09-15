# ---- build stage ----
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- runtime stage ----
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Default to the hosted HTTP transport in containers.
ENV MCP_TRANSPORT=http
ENV PORT=8765

# Ownership proof for the MCP Registry: this must match the "name" field in
# server.json exactly, otherwise the registry rejects the image.
LABEL io.modelcontextprotocol.server.name="io.github.ohneben/hubspot-mcp"

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY spec ./spec

# Run as the unprivileged node user shipped with the image.
USER node

EXPOSE 8765
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT:-8765}/health" || exit 1

CMD ["node", "dist/index.js"]
