# syntax=docker/dockerfile:1

# ---- deps: full install (needed to compile) ----
# Node 22: tedious@20 (pulled in by mssql) declares engines.node >=22.
FROM node:22-alpine AS deps

# bcrypt falls back to node-gyp when no prebuilt musl binary is available.
RUN apk add --no-cache python3 make g++

WORKDIR /app

# "prepare": "husky install" must not run inside the image.
ENV HUSKY=0

COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile --network-timeout 600000

# ---- build: compile TypeScript to dist/ ----
FROM node:22-alpine AS build

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

RUN yarn build:prod

# ---- prod-deps: prune devDependencies (keeps tslib, source-map-support) ----
FROM deps AS prod-deps

RUN yarn install --frozen-lockfile --production --network-timeout 600000 \
    && yarn cache clean

# ---- runner ----
FROM node:22-alpine AS runner

RUN apk add --no-cache tzdata

ENV NODE_ENV=production \
    PORT=3000 \
    TZ=Asia/Ho_Chi_Minh

WORKDIR /app

COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/package.json ./package.json

# Static uploads (OS disk) and backup root placeholder; the backup root is
# replaced by the host bind mount at runtime.
RUN mkdir -p /app/public/uploads /app/backup-storage \
    && chown -R node:node /app/public /app/backup-storage

USER node

EXPOSE 3000

# Liveness only: GET / is always 200. GET /health returns 503 when backup
# freshness is stale, so it must not drive container restarts.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
    CMD wget -qO- http://127.0.0.1:3000/ >/dev/null || exit 1

CMD ["node", "dist/main.js"]
