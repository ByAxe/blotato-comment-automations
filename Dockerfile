FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/dist/src ./dist/src
COPY --from=build /app/dist/scripts/reconcile.js ./dist/scripts/reconcile.js
COPY --from=build /app/dist/examples/recording-provider.js ./dist/examples/recording-provider.js
COPY examples/try-pricing.mjs ./examples/try-pricing.mjs
COPY db ./db
USER node
CMD ["node", "dist/src/bin/server.js"]

FROM build AS verify
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*
USER node
CMD ["node", "test/disposable-db.mjs", "verify"]
