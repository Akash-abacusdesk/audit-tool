ARG NODE_DIGEST=
FROM docker.io/library/node:20-slim${NODE_DIGEST}

LABEL org.opencontainers.image.title="devsecops/cms-headless-next-wordpress" \
      org.opencontainers.image.version="fixture" \
      org.opencontainers.image.base="docker.io/library/node:20-slim"

ENV HOME=/tmp \
    NODE_ENV=development \
    PORT=3200 \
    HOSTNAME=0.0.0.0 \
    NEXT_PUBLIC_WP_URL=http://cms-wordpress:8080

WORKDIR /app

COPY package*.json ./
RUN npm install --no-audit --no-fund || npm install --no-audit --no-fund

COPY . .

RUN chown -R 10001:10001 /app
USER 10001

EXPOSE 3200

CMD ["npx", "next", "dev", "-p", "3200", "-H", "0.0.0.0"]
