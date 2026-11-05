# ---- web + server bundle: built once on the native build platform (no emulation) ----
FROM --platform=$BUILDPLATFORM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
# Scripts skipped: mediasoup's native worker isn't needed to bundle JS.
RUN npm ci --ignore-scripts
COPY . .
RUN npm run build

# ---- production dependencies for the target architecture ----
FROM node:24-bookworm-slim AS deps
# Toolchain only used if mediasoup has no prebuilt worker for this platform.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-pip make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# ---- runtime ----
FROM node:24-bookworm-slim
ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=3000 \
    RTC_PORT=40000
WORKDIR /app
COPY package.json ./
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 3000/tcp 40000/udp 40000/tcp
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--no-warnings=ExperimentalWarning", "dist/server.js"]
