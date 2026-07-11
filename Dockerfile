# Darsly single-service image: API (NestJS) that also serves the built web app.
# Includes ffmpeg/ffprobe for the Phase-3 encrypted-HLS pipeline and openssl for
# Prisma. The API build also builds apps/web/dist, which ServeStatic serves.
FROM node:20-slim

# System deps: ffmpeg for transcoding, openssl+ca-certificates for Prisma/TLS.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

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
