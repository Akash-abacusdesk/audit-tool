#!/bin/sh
# RO-rootfs safe defaults: lynis log/report go to tmpfs scratch (/tmp), never /var/log.
exec /opt/lynis/lynis --logfile /tmp/lynis.log --report-file /tmp/lynis-report.dat "$@"
