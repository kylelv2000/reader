FROM node:22.22-bookworm-slim
WORKDIR /app
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
    && npx playwright-core install --with-deps --only-shell chromium \
    && rm -rf /var/lib/apt/lists/* /root/.cache /root/.npm
COPY --chown=node:node server.mjs ./
ENV NODE_ENV=production PORT=19090
EXPOSE 19090
USER node
CMD ["node", "server.mjs"]
