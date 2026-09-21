FROM ghcr.io/zaproxy/zaproxy@sha256:8dc78e39fafc3281ac2cf54eab05c3ea02721a1ea58f1c135f981a57f4e218b1

LABEL org.opencontainers.image.title="devsecops/scanner-zap" \
      org.opencontainers.image.version="2.15.0" \
      org.opencontainers.image.base="ghcr.io/zaproxy/zaproxy:2.15.0" \
      org.opencontainers.image.base.digest="sha256:8dc78e39fafc3281ac2cf54eab05c3ea02721a1ea58f1c135f981a57f4e218b1"

ENV HOME=/tmp

WORKDIR /zap

USER zap

COPY --chown=zap:zap docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["-version"]
