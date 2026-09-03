#!/usr/bin/env bash
set -Eeuo pipefail

[ "$(id -u)" -eq 0 ] || { printf 'ERROR: root is required\n' >&2; exit 2; }
command -v iptables >/dev/null
interfaces="${MONGBAS_INGRESS_INTERFACES:-tailscale0 wlo1}"

apply_family() {
  local command_name="$1" interface_name
  command -v "${command_name}" >/dev/null 2>&1 || return 0
  for interface_name in ${interfaces}; do
    [ -e "/sys/class/net/${interface_name}" ] || continue
    if ! "${command_name}" -C FORWARD -i "${interface_name}" -m conntrack --ctstate NEW \
        -m comment --comment mongbas-deny-external-container-ingress -j DROP 2>/dev/null; then
      "${command_name}" -I FORWARD 1 -i "${interface_name}" -m conntrack --ctstate NEW \
        -m comment --comment mongbas-deny-external-container-ingress -j DROP
    fi
  done
}

apply_family iptables
apply_family ip6tables
printf 'Mongbas external container ingress is denied on: %s\n' "${interfaces}"
