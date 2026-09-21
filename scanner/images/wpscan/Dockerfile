FROM docker.io/library/ruby@sha256:0a6e39a193d07f987fe560e027eb214b87ec7e86bebeef44bd8665fbe7388f28

LABEL org.opencontainers.image.title="devsecops/scanner-wpscan" \
      org.opencontainers.image.version="3.8.28" \
      org.opencontainers.image.base="docker.io/library/ruby:3.1.4-slim-bullseye" \
      org.opencontainers.image.base.digest="sha256:0a6e39a193d07f987fe560e027eb214b87ec7e86bebeef44bd8665fbe7388f28"

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        build-essential \
        pkg-config \
        libxml2-dev \
        libxslt1-dev \
        libcurl4-openssl-dev \
    && gem install wpscan -v 3.8.28 --no-document \
    && apt-get purge -y \
        build-essential \
        pkg-config \
        libxml2-dev \
        libxslt1-dev \
        libcurl4-openssl-dev \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/* \
# runtime shared libs must survive the dev-purge above (ffi/typhoeus dlopen libcurl)
    && apt-get update \
    && apt-get install -y --no-install-recommends libcurl4 ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ENV HOME=/tmp

WORKDIR /tmp

USER 10001

ENTRYPOINT ["wpscan"]
CMD ["--version"]
