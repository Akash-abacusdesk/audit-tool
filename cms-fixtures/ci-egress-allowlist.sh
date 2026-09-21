#!/usr/bin/env bash
# S6-D2 CI egress allowlist (mirrors SCANNING-CONVENTIONS sec5.2 default-deny floor).
# Applied on the CI runner host via iptables DOCKER-USER (runs before the default
# FORWARD chain, so it governs container egress). Effect: containers may only reach
# the local CI bridge + loopback + DNS; everything else NEW outbound is dropped.
#
# S6-D6 detection needs NO external egress (all local file/HTTP). The only sanctioned
# external destination is api.wpvulndb.com, enabled ONLY when WP vuln correlation is
# exercised (WPVULNDB_ENABLED=1). Leave deny otherwise.
set -euo pipefail

CI_NET="${CI_BRIDGE_CIDR:-172.18.0.0/16}"
CHAIN=DOCKER-USER

echo "S6 egress: installing default-deny floor on $CHAIN for $CI_NET"

# Flush any prior S6 rules in this chain (idempotent reload).
iptables -F "$CHAIN" 2>/dev/null || iptables -N "$CHAIN"

# Stateful return traffic + loopback + CI bridge (inter-service, e.g. fixtures <-> api).
iptables -A "$CHAIN" -m state --state RELATED,ESTABLISHED -j ACCEPT
iptables -A "$CHAIN" -i lo -j ACCEPT
iptables -A "$CHAIN" -d "$CI_NET" -j ACCEPT
# DNS resolution for containers that need it.
iptables -A "$CHAIN" -p udp --dport 53 -j ACCEPT
iptables -A "$CHAIN" -p tcp --dport 53 -j ACCEPT

# Sanctioned external: WP vuln correlation only when explicitly enabled.
if [ "${WPVULNDB_ENABLED:-0}" = "1" ]; then
  WP_IP="$(getent hosts api.wpvulndb.com | awk '{print $1; exit}')"
  if [ -n "$WP_IP" ]; then
    echo "S6 egress: allowing api.wpvulndb.com ($WP_IP)"
    iptables -A "$CHAIN" -d "$WP_IP" -j ACCEPT
  else
    echo "S6 egress: WARN api.wpvulndb.com unresolved; skipping" >&2
  fi
fi

# Default-deny NEW outbound (mirrors sec5.2 floor; abuse battery asserts this).
iptables -A "$CHAIN" -m state --state NEW -j DROP

echo "S6 egress: default-deny floor installed."
