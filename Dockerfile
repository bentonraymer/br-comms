# Everything is built on the native build platform; nothing compiles under emulation.
# mediasoup's postinstall is skipped and its prebuilt worker for the target arch is fetched directly.

FROM --platform=$BUILDPLATFORM node:24-bookworm-slim AS build
ARG TARGETARCH
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY . .
RUN npm run build && npm prune --omit=dev --ignore-scripts
RUN set -e; \
    V=$(node -p "require('./node_modules/mediasoup/package.json').version"); \
    case "$TARGETARCH" in amd64) A=x64 ;; arm64) A=arm64 ;; *) echo "unsupported arch: $TARGETARCH" >&2; exit 1 ;; esac; \
    URL="https://github.com/versatica/mediasoup/releases/download/$V/mediasoup-worker-$V-linux-$A-kernel6.tgz"; \
    echo "fetching $URL"; \
    node -e "fetch(process.argv[1]).then(r=>{if(!r.ok)throw new Error('HTTP '+r.status);return r.arrayBuffer()}).then(b=>require('fs').writeFileSync('/tmp/worker.tgz',Buffer.from(b)))" "$URL"; \
    mkdir -p /app/worker && tar xzf /tmp/worker.tgz -C /app/worker && test -x /app/worker/mediasoup-worker

FROM node:24-bookworm-slim
ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=3000 \
    RTC_PORT=40000 \
    MEDIASOUP_WORKER_BIN=/app/worker/mediasoup-worker
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/worker ./worker
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 3000/tcp 40000/udp 40000/tcp
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--no-warnings=ExperimentalWarning", "dist/server.js"]
