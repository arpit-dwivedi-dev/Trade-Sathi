# Build context must be the repo root (pnpm workspace):
#   docker build -f apps/api/Dockerfile -t chartanalyzer-api .
FROM node:22-slim AS base
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY apps/api/package.json apps/api/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY packages/shared packages/shared
COPY apps/api apps/api
RUN pnpm --filter @chartanalyzer/shared build
RUN pnpm --filter @chartanalyzer/api build

FROM base AS runtime
ENV NODE_ENV=production
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY apps/api/package.json apps/api/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN pnpm install --frozen-lockfile --prod
COPY --from=build /app/packages/shared/dist /app/packages/shared/dist
COPY --from=build /app/apps/api/dist /app/apps/api/dist
RUN node -e "const p='packages/shared/package.json';const j=require('./'+p);j.main='dist/index.js';j.types='dist/index.d.ts';require('fs').writeFileSync(p,JSON.stringify(j,null,2))"
WORKDIR /app/apps/api
EXPOSE 3000
CMD ["node", "dist/index.js"]
