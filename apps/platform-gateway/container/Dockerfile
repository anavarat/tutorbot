FROM node:22-alpine AS build

WORKDIR /app

RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json .npmrc ./
COPY apps/platform-gateway/container/package.json apps/platform-gateway/container/package.json
COPY packages/shared/package.json packages/shared/package.json

RUN pnpm install --frozen-lockfile

COPY apps/platform-gateway/container apps/platform-gateway/container
COPY packages/shared packages/shared

WORKDIR /app/packages/shared

RUN pnpm build

WORKDIR /app/apps/platform-gateway/container

RUN pnpm build

FROM node:22-alpine AS runtime

WORKDIR /app

RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/platform-gateway/container/package.json apps/platform-gateway/container/package.json
COPY packages/shared/package.json packages/shared/package.json

RUN pnpm install --frozen-lockfile --prod --filter @tutorbot/platform-gateway-container...

COPY --from=build /app/apps/platform-gateway/container/dist apps/platform-gateway/container/dist
COPY --from=build /app/packages/shared/dist packages/shared/dist

WORKDIR /app/apps/platform-gateway/container

ENV PORT=8080
EXPOSE 8080

# Cache-bust: changing this LABEL yields a new image digest, which forces a
# container rollout. Needed to restart running instances so they re-read Worker
# Secrets injected as env at container start (e.g. a rotated CNPG password).
# It is the LAST layer so the bump rebuilds ~nothing above it. Bump to redeploy.
LABEL dev.tutorbot.rev="2026-07-25-telegram-b1-reassign-disconnect"

CMD ["node", "dist/index.js"]
