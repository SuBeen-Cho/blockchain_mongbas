#!/usr/bin/env bash
set -Eeuo pipefail

[ "${EUID}" -eq 0 ] || { echo "run with sudo: $0" >&2; exit 1; }
repo="$(cd "$(dirname "$0")/../.." && pwd)"
group="mongbas-trustees"
users=(mongbas-ec mongbas-party mongbas-civil)
root="/var/lib/mongbas-trustees"
commit="$(git -C "${repo}" rev-parse HEAD)"
install_root="/opt/mongbas-trustee/${commit}"

getent group "${group}" >/dev/null || groupadd --system "${group}"
for user in "${users[@]}"; do
  if ! getent passwd "${user}" >/dev/null; then
    useradd --system --gid "${group}" --home-dir /nonexistent --shell /usr/sbin/nologin "${user}"
  fi
  [ "$(id -gn "${user}")" = "${group}" ] || { echo "unexpected primary group for ${user}" >&2; exit 1; }
done

install -d -o root -g "${group}" -m 0750 "${root}" "${root}/runs"
for user in "${users[@]}"; do
  install -d -o "${user}" -g "${group}" -m 0700 "${root}/${user}"
done

if [ ! -d "${install_root}" ]; then
  install -d -o root -g root -m 0755 "${install_root}/bin" "${install_root}/src"
  install -o root -g root -m 0755 "${repo}/trustee/bin/mongbas-trustee.js" "${install_root}/bin/"
  install -o root -g root -m 0644 "${repo}/trustee/src/dkg.js" "${repo}/trustee/package.json" "${install_root}/"
  mv "${install_root}/dkg.js" "${install_root}/src/dkg.js"
fi
ln -sfn "${install_root}" /opt/mongbas-trustee/current
printf 'trustee custody users ready; code=%s\n' "${commit}"
