# Darsly single-service image: API (NestJS) that also serves the built web app.
# Includes ffmpeg/ffprobe for the encrypted-HLS pipeline and openssl for Prisma.

FROM node:20-slim

# System deps: ffmpeg for transcoding, openssl+ca-certificates for Prisma/TLS,
# curl to fetch yt-dlp/deno below, unzip because the deno installer needs it,
# poppler-utils for paper exam import — pdfinfo/pdftoppm/pdftotext turn an
# uploaded PDF into one page each. `pdftotext` in particular is what keeps that
# feature cheap: a PDF exported from Word carries the whole exam as text, and
# reading it costs nothing instead of a vision model's image tokens.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg openssl ca-certificates curl unzip poppler-utils \
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

# ── Drop privileges, before the app arrives ──────────────────────────────────
#
# The process runs as `node`, a non-root user the base image already provides.
# /data/storage has to be owned by it — a Railway volume mounts as root, so the
# directory is created and handed over here and the app writes into it as
# `node`.
#
# This used to be a `chown -R node:node /app` at the very end. That walked every
# file in node_modules, and on an overlay filesystem changing a file's owner
# copies the whole file into a new layer: 2m43s per build, a second copy of
# node_modules in the image (721 MB pushed), and a slower export and push.
# Switching user first and copying with --chown gives the same ownership for
# free.
RUN mkdir -p /data/storage /app && chown node:node /data/storage /app
WORKDIR /app
USER node

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

# ── Dependencies, in their own layer ─────────────────────────────────────────
#
# This used to be `COPY . .` followed by `npm ci`, which put the entire source
# tree in the dependency layer's cache key: changing one line of TypeScript
# invalidated it and reinstalled ~900 packages. Manifests first means a normal
# code change now reuses the installed tree.
#
# packages/shared-types comes along because its `prepare` script compiles it
# during install, so its source has to be present for `npm ci` to succeed.
# It is ~600 lines and changes rarely, which is what makes that affordable.
COPY --chown=node:node package.json package-lock.json ./
COPY --chown=node:node packages/shared-types ./packages/shared-types
COPY --chown=node:node apps/api/package.json ./apps/api/package.json
COPY --chown=node:node apps/web/package.json ./apps/web/package.json
RUN npm ci

# ── Application ──────────────────────────────────────────────────────────────
COPY --chown=node:node . .

# Builds the API and apps/web/dist (shared-types is already built, above).
RUN npm run build --workspace=@darsly/api

ENV NODE_ENV=production
# HLS/attachments live here; mount a Railway volume at this path to persist them.
ENV STORAGE_LOCAL_PATH=/data/storage

# devDependencies are deliberately kept in the final image. `scripts/start.sh`
# runs `prisma migrate deploy` on every boot, and the optional
# RUN_SEED_ON_BOOT path runs the seed through ts-node — both devDependencies.
# Pruning them would shrink the image and break the migration step, and the
# migration step is the one that must never break: a failed `migrate deploy`
# is how this project has already had an outage (P3009).

# start = prisma migrate deploy && node dist/main.js (honors $PORT)
CMD ["npm", "run", "start", "--workspace=@darsly/api"]
