FROM ghcr.io/aquasecurity/trivy@sha256:35e972d4c97895711cb2de6594cc1774b61e6b9dc7661ef73a76dd649f006c8d

LABEL org.opencontainers.image.title="devsecops/scanner-trivy" \
      org.opencontainers.image.version="0.55.0" \
      org.opencontainers.image.base="ghcr.io/aquasecurity/trivy:0.55.0" \
      org.opencontainers.image.base.digest="sha256:35e972d4c97895711cb2de6594cc1774b61e6b9dc7661ef73a76dd649f006c8d"

ENV HOME=/tmp \
    TRIVY_CACHE_DIR=/tmp/trivy-cache

WORKDIR /tmp

# named volumes mount empty + root-owned; pre-create so the volume inherits
# this ownership on first mount (container runs as non-root 10001).
RUN mkdir -p /tmp/trivy-cache && chown -R 10001:10001 /tmp/trivy-cache

USER 10001

ENTRYPOINT ["trivy"]
CMD ["--version"]
