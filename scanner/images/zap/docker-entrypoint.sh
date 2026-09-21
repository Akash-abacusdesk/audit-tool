#!/bin/sh
# RO-rootfs safe defaults: ZAP home lives on tmpfs scratch (/tmp), never /home/zap.
mkdir -p /tmp/zap-home 2>/dev/null || true
exec /zap/zap-x.sh -dir /tmp/zap-home "$@"
