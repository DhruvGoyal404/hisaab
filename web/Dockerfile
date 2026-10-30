# Production image for the web app, built from the repo root (one workspace, one lockfile):
#   docker build -f web/Dockerfile -t hisaab-web .
# The Vite build is served by Caddy as a non-root user on :5174; the edge Caddy proxies to it.
# Base images pinned by multi-arch index digest, the same ones Chitthi uses on the VM: node 22.23.3 /
# Alpine 3.24 (pushed 2026-09-23), caddy 2.11.6 (pushed 2026-10-04; only its binary is used) and
# Alpine 3.24.2 (pushed 2026-09-18).
ARG NODE_IMAGE=node:22.23.3-alpine3.24@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402
ARG CADDY_IMAGE=caddy:2.11.6-alpine@sha256:d44355d3c2149dc580ce2cac735955d1c08d3d00882c30489c241aa51a5c10d9
ARG ALPINE_IMAGE=alpine:3.24.2@sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6

FROM ${NODE_IMAGE} AS build
WORKDIR /src
COPY package.json package-lock.json .npmrc ./
COPY packages/money/package.json packages/money/
COPY api/package.json api/
COPY web/package.json web/
# No install scripts: Vite's and Tailwind's native parts are prebuilt platform packages.
RUN npm ci --workspace @hisaab/web --include-workspace-root --ignore-scripts
COPY packages/money/src packages/money/src
COPY web/tsconfig.json web/index.html web/vite.config.ts web/
COPY web/src web/src
COPY web/public web/public
# Typechecking is CI's job; the image only needs the bundle.
RUN cd web && ../node_modules/.bin/vite build \
 && find dist -type f \( -name '*.js' -o -name '*.css' -o -name '*.html' -o -name '*.svg' \) -exec gzip -9 -k {} +

# The stock binary carries a cap_net_bind_service file capability, and with it exec fails outright
# under cap_drop: ALL. A plain copy has none; on bare Alpine the image holds the binary once.
FROM ${CADDY_IMAGE} AS caddy
RUN cat /usr/bin/caddy > /caddy && chmod 0755 /caddy

FROM ${ALPINE_IMAGE} AS web
# 10022: Hisaab's own uid range (10020-10029), never shared with another app on the host.
RUN addgroup -S -g 10022 web && adduser -S -D -H -u 10022 -G web web
COPY --from=caddy /caddy /usr/bin/caddy
# With admin and persistence off Caddy writes nothing; /tmp is the read-only container's tmpfs.
ENV XDG_CONFIG_HOME=/tmp/caddy XDG_DATA_HOME=/tmp/caddy
COPY web/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /src/web/dist /srv
USER web
EXPOSE 5174
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:5174/ || exit 1
CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
