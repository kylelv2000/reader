# syntax=docker/dockerfile:1.7
FROM node:22.22-alpine AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --prefer-offline --no-audit --no-fund --fetch-timeout=60000 --fetch-retries=2
COPY . .
RUN npm run build

FROM node:22.22-alpine AS runtime

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8080
WORKDIR /app

COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/node_modules/react ./node_modules/react
COPY --from=build --chown=node:node /app/node_modules/react-dom ./node_modules/react-dom
COPY --from=build --chown=node:node /app/node_modules/scheduler ./node_modules/scheduler
COPY --chown=node:node services/web-runtime ./services/web-runtime
COPY --chown=node:node services/security-gateway ./services/security-gateway

EXPOSE 8080
USER node
CMD ["node", "services/security-gateway/server.mjs"]
