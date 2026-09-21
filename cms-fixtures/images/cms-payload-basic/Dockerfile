ARG NODE_DIGEST=
FROM docker.io/library/node:20-slim${NODE_DIGEST}

LABEL org.opencontainers.image.title="devsecops/cms-payload-basic" \
      org.opencontainers.image.version="fixture" \
      org.opencontainers.image.base="docker.io/library/node:20-slim"

ENV HOME=/tmp \
    NODE_ENV=production \
    PORT=3000 \
    PAYLOAD_CONFIG_PATH=/app/payload.config.ts

WORKDIR /app

COPY package*.json ./
RUN npm install --no-audit --no-fund || npm install --no-audit --no-fund

COPY . .

RUN chown -R 10001:10001 /app
USER 10001

EXPOSE 3000

# Payload needs DATABASE_URI at runtime (CI postgres sidecar supplies it).
# Fixture is marker-only; serves admin API when DB is reachable.
CMD ["npx", "payload", "run"]
