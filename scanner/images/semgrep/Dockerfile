FROM docker.io/returntocorp/semgrep@sha256:05d24d34abcb88b18610bf9a9731458a4ebadc336383805a63cdf811adfd1bc8

LABEL org.opencontainers.image.title="devsecops/scanner-semgrep" \
      org.opencontainers.image.version="1.86.0" \
      org.opencontainers.image.base="docker.io/returntocorp/semgrep:1.86.0-nonroot" \
      org.opencontainers.image.base.digest="sha256:05d24d34abcb88b18610bf9a9731458a4ebadc336383805a63cdf811adfd1bc8"

ENV HOME=/tmp \
    SEMGREP_SEND_METRICS=off

WORKDIR /tmp

USER 10001

ENTRYPOINT ["semgrep"]
CMD ["--version"]
