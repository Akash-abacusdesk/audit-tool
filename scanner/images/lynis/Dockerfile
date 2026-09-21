FROM docker.io/library/debian@sha256:2ccc7e39b0a6f504d252f807da1fc4b5bcd838e83e4dec3e2f57b2a4a64e7214

LABEL org.opencontainers.image.title="devsecops/scanner-lynis" \
      org.opencontainers.image.version="3.1.1" \
      org.opencontainers.image.base="docker.io/library/debian:bookworm-20240812-slim" \
      org.opencontainers.image.base.digest="sha256:2ccc7e39b0a6f504d252f807da1fc4b5bcd838e83e4dec3e2f57b2a4a64e7214"

ARG LYNIS_VERSION=3.1.1
ARG LYNIS_TARBALL_SHA256=ca38a27c9c92e78877be4ecffce25f3345a1d24bbcd68be66a3a600e2ff748d1

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && curl -fsSL "https://github.com/CISOfy/lynis/archive/refs/tags/${LYNIS_VERSION}.tar.gz" -o /tmp/lynis.tgz \
    && echo "${LYNIS_TARBALL_SHA256}  /tmp/lynis.tgz" | sha256sum -c - \
    && mkdir -p /opt/lynis \
    && tar -xzf /tmp/lynis.tgz -C /opt/lynis --strip-components=1 \
    && rm -f /tmp/lynis.tgz \
    && chmod +x /opt/lynis/lynis \
    && apt-get purge -y curl \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

ENV PATH="/opt/lynis:${PATH}" \
    HOME=/tmp \
    LYNIS_PROFILE=/opt/lynis/default.prf

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# lynis resolves its include dir relative to CWD => must run from the install dir
WORKDIR /opt/lynis

USER 10001

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["audit", "system"]
