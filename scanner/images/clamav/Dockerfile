FROM docker.io/clamav/clamav:stable@sha256:0e31ce089574268aefa0b543767d66b70240ab51ed49eec53e07f18d5629d817

LABEL org.opencontainers.image.title="devsecops/scanner-clamav" \
      org.opencontainers.image.version="stable" \
      org.opencontainers.image.base="docker.io/clamav/clamav:stable" \
      org.opencontainers.image.base.digest="sha256:0e31ce089574268aefa0b543767d66b70240ab51ed49eec53e07f18d5629d817"

# Signature databases (main.cvd, daily.cvd) are baked into this base image —
# no freshclam network pull needed at scan time (offline egress works).
ENV HOME=/tmp

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

WORKDIR /tmp

USER clamav

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["--version"]
