ARG NODE_DIGEST=
FROM docker.io/library/node:20-slim${NODE_DIGEST}

LABEL org.opencontainers.image.title="devsecops/cms-directus-basic" \
      org.opencontainers.image.version="fixture" \
      org.opencontainers.image.base="docker.io/library/node:20-slim"

ENV HOME=/tmp \
    NODE_ENV=production \
    PORT=8055

WORKDIR /app

COPY package*.json ./
RUN npm install --no-audit --no-fund || npm install --no-audit --no-fund

COPY . .

RUN chown -R 10001:10001 /app
USER 10001

EXPOSE 8055

# Directus uses SQLITE for the fixture (CI sets DATABASE_URL=sqlite).
CMD ["npx", "directus", "start"]
