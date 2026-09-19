# Darsly single-service image: API (NestJS) that also serves the built web app.
# Includes ffmpeg/ffprobe for the Phase-3 encrypted-HLS pipeline and openssl for
# Prisma. The API build also builds apps/web/dist, which ServeStatic serves.
FROM node:20-slim

# System deps: ffmpeg for transcoding, openssl+ca-certificates for Prisma/TLS,
# curl to fetch yt-dlp/deno below, unzip because the deno installer needs it.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg openssl ca-certificates curl unzip \
  && rm -rf /var/lib/apt/lists/*

# yt-dlp: the PyInstaller-frozen `yt-dlp_linux` build — no system Python
# needed, which node:20-slim doesn't have. Pulled fresh at every image build
# rather than pinned: YouTube changes what breaks an extractor often enough
# that a pinned version goes stale — a rebuild is the update mechanism, same
# as any other scraping-based tool; no version stays correct forever.
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux \
  -o /usr/local/bin/yt-dlp \
  && chmod a+rx /usr/local/bin/yt-dlp

# deno: yt-dlp's own words are that extraction without a JS runtime "has been
# deprecated" — some YouTube videos now withhold format URLs until a JS
# challenge is solved, and deno is the one runtime it fully supports out of
# the box (a system node was tried and yt-dlp marks it "unsupported").
RUN curl -fsSL https://deno.land/install.sh | DENO_INSTALL=/usr/local sh \
  && chmod a+rx /usr/local/bin/deno

WORKDIR /app

# redis-memory-server (apps/api devDependency — used only by the standalone
# scripts/audit-multi-replica.mjs a developer runs by hand locally, never by
# this image) tries to download/compile a real Redis binary in its own
# postinstall. This image has no `make`, so that compile step is the one
# devDependency install that must not run here. Every other devDependency
# genuinely IS needed below — typescript, @nestjs/cli etc. build the app in
# this same stage — so `--omit=dev` isn't the fix; skipping just this one
# package's postinstall, the way its own maintainers built it to be skipped
# in CI, is.
ENV REDISMS_DISABLE_POSTINSTALL=1

# Install with full workspaces (the shared-types "prepare" script compiles on
# install, so the whole source tree must be present first).
COPY . .
RUN npm ci

# Builds shared-types (via prepare, already run), the API, and apps/web/dist.
RUN npm run build --workspace=@darsly/api

ENV NODE_ENV=production
# HLS/attachments live here; mount a Railway volume at this path to persist them.
ENV STORAGE_LOCAL_PATH=/data/storage
RUN mkdir -p /data/storage

# start = prisma migrate deploy && node dist/main.js (honors $PORT)
CMD ["npm", "run", "start", "--workspace=@darsly/api"]
