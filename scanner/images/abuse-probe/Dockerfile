# S4-C abuse-battery probe image.
# Tiny non-root shell environment used ONLY by tool/scanner/tests/abuse/run.mjs
# to execute hostile payloads inside an isolated worker so the battery can
# assert runtime DENIAL behavior. Never scheduled by the platform.
FROM docker.io/library/busybox@sha256:7a3ebe5bfd1a4a19797d20b0c0bb39d44393e9a03fd852c0865b0f540d868df0

LABEL org.opencontainers.image.title="devsecops/scanner-abuse-probe" \
      org.opencontainers.image.description="S4-C isolation battery payload runner (non-root busybox shell)" \
      org.opencontainers.image.created="2026-08-26" \
      org.opencontainers.image.source="https://github.com/anomalyco/opencode"

USER 10001:10001
WORKDIR /tmp
ENTRYPOINT ["/bin/sh", "-c"]
