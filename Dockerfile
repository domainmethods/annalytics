FROM node:20-slim AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ src/
RUN npx tsc
RUN npm prune --production

FROM gcr.io/distroless/nodejs20-debian12
WORKDIR /app
COPY --from=builder /app/dist/ dist/
COPY --from=builder /app/node_modules/ node_modules/
COPY --from=builder /app/package.json ./
# dbt artifacts (manifest.json, catalog.json) must exist at build time.
# Generate with `dbt compile && dbt docs generate` and provide them in dbt/.
COPY dbt/ dbt/
CMD ["dist/app.js"]
