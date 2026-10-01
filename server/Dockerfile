# syntax=docker/dockerfile:1
# thuammai server image (spec §9.1): the esbuild bundles, migrations, provinces and infra/ (the VPS
# updater extracts infra/ from every image — F2-3). Built only by release/workflows/server-image.yml.

FROM node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
COPY server ./server
COPY static/provinces.json ./static/provinces.json
RUN node server/build.mjs

FROM node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force

FROM node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6
ARG VERSION=dev
ARG REVISION=unknown
ARG CI_BREAK=0
LABEL org.opencontainers.image.source="https://github.com/thaiglider/thuammai" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}" \
      org.opencontainers.image.description="thuammai flood alerts server (api, alerts, migrate)"
ENV NODE_ENV=production CI_BREAK=${CI_BREAK}
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY --from=build /src/server/dist ./dist
COPY server/migrations ./server/migrations
COPY server/fonts ./server/fonts
COPY static/provinces.json ./static/provinces.json
COPY infra ./infra
USER node
CMD ["node", "dist/api.mjs"]
