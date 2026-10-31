# Reflipped game server image. Build context is the repo root:
#   docker build -t reflipped .
# The compose flavours in docker/ (stack, api, proxy) build it as the `reflipped` service.

FROM node:22-bookworm AS build
WORKDIR /app
COPY package.json package-lock.json ./
# better-sqlite3 compiles here if no prebuilt binary matches.
RUN npm ci
COPY tsconfig.json tailwind.config.js ./
COPY assets ./assets
COPY src ./src
COPY web ./web
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    LISTEN_HOST=0.0.0.0 \
    LISTEN_PORT=8000 \
    ADMIN_HOST=0.0.0.0 \
    ADMIN_PORT=8001 \
    DATABASE_DIR=/data/database \
    LOG_FILE=/data/logs/reflipped.log \
    CDN_DIR=/srv/cdn \
    CDN_OVERLAY_DIR=/srv/cdn-overlay
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/out ./out
COPY --from=build /app/web ./web
COPY --from=build /app/assets ./assets
# Translations, column map and glossary for `node out/i18n/build.js` (the compose flavours mount the repo's instead).
COPY i18n ./i18n
# /data holds the database and the log; the node user (uid 1000) must own it.
RUN mkdir -p /data /srv/cdn /srv/cdn-overlay && chown node:node /data
USER node
VOLUME /data
EXPOSE 8000 8001 18888
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
    CMD node -e "require('net').connect(8000,'127.0.0.1').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))"
CMD ["node", "out/server.js"]
