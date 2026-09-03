ARG PURETEXT_FONT_IMAGE=billlin0904/puretext:api-v0.5.13
FROM ${PURETEXT_FONT_IMAGE} AS subtitle-font-assets

FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY scripts/generate-subtitle-font-metrics.mjs ./scripts/generate-subtitle-font-metrics.mjs
COPY --from=subtitle-font-assets /app/fonts/subtitles ./fonts/subtitles
RUN PURETEXT_SUBTITLE_FONTS_DIR=/app/fonts/subtitles \
    PURETEXT_SUBTITLE_FONT_CATALOG=/app/src/renderer/subtitle-font-catalog.generated.ts \
    PURETEXT_SUBTITLE_FONT_METRICS_OUTPUT=/app/src/renderer/subtitle-font-metrics.generated.ts \
    node ./scripts/generate-subtitle-font-metrics.mjs
RUN npm run build

FROM node:24-bookworm-slim AS runtime
ARG SERVICE_VERSION=0.1.11
ARG SERVICE_COMMIT=unknown
ARG SERVICE_BUILT_AT=unknown
ENV NODE_ENV=production \
    NVIDIA_VISIBLE_DEVICES=all \
    NVIDIA_DRIVER_CAPABILITIES=compute,video,utility \
    PURETEXT_VIDEO_ENCODER=nvenc \
    PURETEXT_SUBTITLE_FONTS_DIR=/app/fonts/subtitles \
    PURETEXT_STRICT_SUBTITLE_FONTS=true \
    RENDER_WORKER_VERSION=${SERVICE_VERSION} \
    SERVICE_COMMIT=${SERVICE_COMMIT} \
    SERVICE_BUILT_AT=${SERVICE_BUILT_AT}
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates ffmpeg fontconfig fonts-noto-cjk tini \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY --from=build /app/fonts/subtitles ./fonts/subtitles
COPY healthcheck.mjs ./healthcheck.mjs
RUN mkdir -p /var/lib/puretext-render-worker \
    && chown -R node:node /app /var/lib/puretext-render-worker
USER node
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "--enable-source-maps", "dist/src/index.js"]
