FROM ghcr.io/gitleaks/gitleaks@sha256:75bdb2b2f4db213cde0b8295f13a88d6b333091bbfbf3012a4e083d00d31caba

LABEL org.opencontainers.image.title="devsecops/scanner-gitleaks" \
      org.opencontainers.image.version="v8.18.4" \
      org.opencontainers.image.base="ghcr.io/gitleaks/gitleaks:v8.18.4" \
      org.opencontainers.image.base.digest="sha256:75bdb2b2f4db213cde0b8295f13a88d6b333091bbfbf3012a4e083d00d31caba"

ENV HOME=/tmp

WORKDIR /tmp

USER 10001

ENTRYPOINT ["gitleaks"]
CMD ["version"]
