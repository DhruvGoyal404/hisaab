# Production images for the API, built from the repo root (one workspace, one lockfile):
#   docker build -f api/Dockerfile --target api     -t hisaab-api .
#   docker build -f api/Dockerfile --target migrate -t hisaab-migrate .
# Base: node 22.23.3 on Alpine 3.24 (pushed 2026-09-23), pinned by multi-arch index digest: the one
# Chitthi runs on the same VM, so the layers are shared there.
ARG NODE_IMAGE=node:22.23.3-alpine3.24@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402

FROM ${NODE_IMAGE} AS build
WORKDIR /src
COPY package.json package-lock.json .npmrc ./
COPY packages/money/package.json packages/money/
COPY api/package.json api/
COPY web/package.json web/
# The API and money workspaces plus the root (typescript, dbmate). No install scripts: dbmate
# ships prebuilt platform packages, picked by npm from the lockfile.
RUN npm ci --workspace @hisaab/api --workspace @hisaab/money --include-workspace-root --ignore-scripts
COPY packages/money/tsconfig.json packages/money/tsconfig.build.json packages/money/
COPY packages/money/src packages/money/src
COPY api/tsconfig.json api/tsconfig.build.json api/
COPY api/src api/src
# @hisaab/money is TypeScript source everywhere else; production node loads its compiled dist
# through the "hisaab-dist" export condition (the CMD below).
RUN npm run build --workspace @hisaab/money && npm run build --workspace @hisaab/api

FROM ${NODE_IMAGE} AS deps
WORKDIR /src
COPY package.json package-lock.json .npmrc ./
COPY packages/money/package.json packages/money/
COPY api/package.json api/
COPY web/package.json web/
# The money workspace too: its own pinned @noble/hashes lives in packages/money/node_modules.
RUN npm ci --workspace @hisaab/api --workspace @hisaab/money --omit=dev --ignore-scripts

FROM ${NODE_IMAGE} AS api
# npm and corepack are not needed at run time; removing them leaves less to patch and to abuse.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
ENV NODE_ENV=production
WORKDIR /app
# Code and dependencies belong to root and are read-only to the uid the API runs as (compose sets it).
COPY package.json ./
COPY api/package.json api/
COPY packages/money/package.json packages/money/
COPY --from=deps /src/node_modules node_modules
COPY --from=deps /src/packages/money/node_modules packages/money/node_modules
COPY --from=build /src/packages/money/dist packages/money/dist
COPY --from=build /src/api/dist api/dist
USER node
EXPOSE 8081
# busybox wget: no extra package, and no second node process every 30 s.
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8081/api/health || exit 1
CMD ["node", "--conditions=hisaab-dist", "api/dist/server.js"]

# One-off job before each deploy: migrations as the owner (MIGRATE_DATABASE_URL), then the
# hisaab_api login role from DATABASE_URL (api/src/setLoginRole.ts). Same layers plus dbmate and the SQL.
FROM api AS migrate
COPY --from=build /src/node_modules/@dbmate/linux-x64/bin/dbmate /usr/local/bin/dbmate
COPY db/migrations db/migrations
HEALTHCHECK NONE
CMD ["sh", "-c", "dbmate --env MIGRATE_DATABASE_URL --migrations-dir db/migrations --no-dump-schema --wait --wait-timeout 60s up && exec node --conditions=hisaab-dist api/dist/setLoginRole.js"]
