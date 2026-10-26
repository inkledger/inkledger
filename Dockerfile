# syntax=docker/dockerfile:1
# Pinned by digest (reproducible builds; Dependabot proposes updates).
FROM node:24-alpine@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53 AS build
WORKDIR /app
RUN apk add --no-cache python3 make g++ && corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm run build && pnpm prune --prod --ignore-scripts \
    # Kept by the prune as drizzle-orm's optional peers, never loaded by the server: PGlite (tests,
    # pglite: URLs only), TypeScript (types), better-sqlite3 (a migration script). ~70 MB less.
    && rm -rf node_modules/.pnpm/@electric-sql+pglite@* node_modules/.pnpm/typescript@* node_modules/.pnpm/better-sqlite3@*

FROM node:24-alpine@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53
LABEL org.opencontainers.image.source="https://github.com/inkledger/inkledger" \
      org.opencontainers.image.description="inkledger — your time, from every tracker" \
      org.opencontainers.image.licenses="MIT"
WORKDIR /app
ENV NODE_ENV=production \
    PORT=47823 \
    MIGRATIONS_DIR=/app/drizzle
# pg_dump / pg_restore: scheduled backups (Settings → Backup).
RUN apk add --no-cache tzdata postgresql17-client && mkdir -p /app/data /backups && chown node:node /app/data /backups
COPY --from=build --chown=node:node /app/package.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/drizzle ./drizzle
USER node
EXPOSE 47823
VOLUME ["/app/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT}/api/health || exit 1
CMD ["node", "dist/boot.js"]
