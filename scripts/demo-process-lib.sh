#!/usr/bin/env bash

demo_runtime_init() {
  DEMO_REPO_DIR="$(pwd -P)"
  DEMO_RUNTIME_DIR="${MONGBAS_DEMO_RUNTIME_DIR:-${XDG_STATE_HOME:-${HOME}/.local/state}/mongbas/demo}"
  case "${DEMO_RUNTIME_DIR}" in ""|/|"${HOME}") echo '[ERROR] unsafe demo runtime directory' >&2; return 1 ;; esac
  umask 077
  install -d -m 0700 "${DEMO_RUNTIME_DIR}"
  BACKEND_PID_FILE="${DEMO_RUNTIME_DIR}/backend.pid"
  BACKEND_LOG_FILE="${DEMO_RUNTIME_DIR}/backend.log"
  TUNNEL_PID_FILE="${DEMO_RUNTIME_DIR}/tunnel.pid"
  TUNNEL_LOG_FILE="${DEMO_RUNTIME_DIR}/tunnel.log"
  TUNNEL_URL_FILE="${DEMO_RUNTIME_DIR}/tunnel-url.txt"
  export DEMO_REPO_DIR DEMO_RUNTIME_DIR BACKEND_PID_FILE BACKEND_LOG_FILE TUNNEL_PID_FILE TUNNEL_LOG_FILE TUNNEL_URL_FILE
}

demo_owned_pid() {
  local file="$1" marker="$2" expected_cwd="$3" pid command cwd
  [ -f "${file}" ] || return 1
  IFS= read -r pid < "${file}"
  [[ "${pid}" =~ ^[1-9][0-9]*$ ]] || return 1
  kill -0 "${pid}" 2>/dev/null || return 1
  command="$(ps -p "${pid}" -o command= 2>/dev/null || true)"
  [[ "${command}" == *"${marker}"* ]] || return 1
  if [ -e "/proc/${pid}/cwd" ]; then
    cwd="$(readlink "/proc/${pid}/cwd" 2>/dev/null || true)"
  elif command -v lsof >/dev/null 2>&1; then
    cwd="$(lsof -a -p "${pid}" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -n 1)"
  else
    return 1
  fi
  [ "${cwd}" = "${expected_cwd}" ] || return 1
  printf '%s\n' "${pid}"
}

demo_stop_owned() {
  local file="$1" marker="$2" expected_cwd="$3" label="$4" pid
  if pid="$(demo_owned_pid "${file}" "${marker}" "${expected_cwd}")"; then
    kill "${pid}"
    rm -f "${file}"
    echo "  ✓ ${label} 중지"
  elif [ -e "${file}" ]; then
    echo "  ! ${label} PID 소유권을 확인할 수 없어 중지하지 않음" >&2
    return 1
  else
    echo "  - ${label} 이미 꺼짐"
  fi
}
