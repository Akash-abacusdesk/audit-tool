#!/bin/sh
# clamscan exits non-zero when it FINDS malware (1) or hits a scan error (2).
# Worker-runtime treats any non-zero container exit as a run failure and never
# hands the output to the adapter — but "found malware" is the important,
# expected case here, not a failure. Always exit 0; the FOUND/OK signal lives
# entirely in stdout text, which the adapter parses.
clamscan "$@"
exit 0
