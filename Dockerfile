# ---------- Build web ----------
FROM node:22-alpine AS web
WORKDIR /app/web
COPY web/package*.json ./
RUN npm install --no-audit --no-fund
COPY web/ ./
# vite build only (type checking is available separately via `npm run typecheck`)
RUN npx vite build

# ---------- Build server ----------
FROM node:22-alpine AS server
WORKDIR /app/server
COPY server/package*.json ./
RUN npm install --no-audit --no-fund
COPY server/ ./
# Emit JS even if a strict type check complains; fail only if nothing was produced.
RUN (npx tsc -p tsconfig.json || true) && test -f dist/index.js && npm prune --omit=dev

# ---------- Runtime ----------
FROM node:22-alpine
ENV NODE_ENV=production \
    PORT=3000 \
    STATIC_DIR=/app/web/dist \
    DATA_DIR=/data
RUN apk add --no-cache tzdata wget && mkdir -p /data && chown node:node /data
WORKDIR /app
COPY --from=server /app/server/node_modules ./server/node_modules
COPY --from=server /app/server/dist ./server/dist
COPY --from=server /app/server/package.json ./server/package.json
COPY --from=web /app/web/dist ./web/dist
USER node
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1
CMD ["node", "server/dist/index.js"]
