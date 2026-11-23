#!/usr/bin/env bash
# booth-up.sh — 부스 원클릭 기동 (Docker Fabric → 공개 터널 → 백엔드 → 관제판)
#   macOS · Linux · Windows(WSL2) 공통. 새 컴퓨터는 먼저 ./scripts/booth-setup.sh 한 번
#
#   ./scripts/booth-up.sh            기동 (터널 주소가 바뀌어도 QR 설정까지 자동 반영)
#   KEEP_TUNNEL=true ./scripts/booth-up.sh   터널(QR 주소)은 그대로 두고 백엔드만 재기동
#   ./scripts/booth-down.sh          백엔드·터널·잠자기 방지 종료 (원장은 그대로)
#
# 하는 일
#   1. Docker/Fabric 확인. 꺼져 있으면 원장을 지우지 않고 순서대로 docker start
#      (Docker 디스크가 SSD에서 끊겨 I/O 오류가 나면 Docker Desktop을 재시작)
#   2. Cloudflare Quick Tunnel을 PORT(3000)로 열고 https 주소 확보
#   3. 그 주소를 런타임 booth.env의 PUBLIC_VOTER_ORIGIN·CORS_ORIGIN에 반영 (저장소 밖)
#   4. 백엔드 재기동 → 로컬·공개 주소 헬스 확인
#   5. 백엔드가 떠 있는 동안 잠자기 방지 (macOS caffeinate · Linux systemd-inhibit)
#   6. 관리자 전용 관제판(127.0.0.1:ADMIN_LOCAL_PORT) 열기
#
# 공개 범위: 터널은 PORT만 노출한다. 관리 기능은 PORT에서 계속 토큰이 필요하고,
# 토큰 없는 관리자 입구(ADMIN_LOCAL_PORT)는 127.0.0.1에만 열린다.
set -Eeuo pipefail
cd "$(dirname "$0")/.."
source scripts/demo-process-lib.sh
demo_runtime_init

PORT="${PORT:-3000}"
BOOTH_ENV="${DEMO_RUNTIME_DIR}/booth.env"
ADMIN_TOKEN_FILE="${DEMO_RUNTIME_DIR}/admin-token"
CAFFEINATE_PID_FILE="${DEMO_RUNTIME_DIR}/caffeinate.pid"
OPEN_BROWSER="${OPEN_BROWSER:-true}"

say() { printf '%s\n' "$*"; }
fail() { printf '  ✗ %s\n' "$*" >&2; exit 1; }

OS="$(uname -s)"; WSL=false
grep -qi microsoft /proc/version 2>/dev/null && WSL=true
# booth-setup.sh가 저장소 밖에 설치한 도구 (Fabric CLI · cloudflared)
STATE_DIR="$(dirname "${DEMO_RUNTIME_DIR}")"
export PATH="${STATE_DIR}/tools/fabric-current/bin:${STATE_DIR}/tools/bin:${PATH}"

command -v docker >/dev/null || fail "docker가 없습니다. 먼저 ./scripts/booth-setup.sh"
command -v cloudflared >/dev/null || fail "cloudflared가 없습니다. 먼저 ./scripts/booth-setup.sh"
[ -e application/.env ] && [ -d application/node_modules ] && [ -f frontend/dist/index.html ] \
  || fail "처음 실행하는 컴퓨터입니다. 먼저 ./scripts/booth-setup.sh 를 실행하세요."
start_docker() {
  if [ "${OS}" = Darwin ]; then open -a Docker
  elif [ "${WSL}" = true ] && [ -x "/mnt/c/Program Files/Docker/Docker/Docker Desktop.exe" ]; then
    ("/mnt/c/Program Files/Docker/Docker/Docker Desktop.exe" >/dev/null 2>&1 &)
  else fail "Docker가 꺼져 있습니다. (Linux: sudo systemctl start docker)"
  fi
}
open_url() {
  if [ "${OS}" = Darwin ]; then open "$1"
  elif [ "${WSL}" = true ]; then explorer.exe "$1" >/dev/null 2>&1 || true
  elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$1" >/dev/null 2>&1 &
  fi
}

# ── 런타임 설정 (처음 한 번만 생성, 비밀값은 저장소 밖) ─────────────────
if [ ! -f "${ADMIN_TOKEN_FILE}" ]; then
  openssl rand -base64 48 | tr -d '\n=' | tr '+/' '-_' > "${ADMIN_TOKEN_FILE}"
  chmod 600 "${ADMIN_TOKEN_FILE}"
fi
if [ ! -f "${BOOTH_ENV}" ]; then
  cat > "${BOOTH_ENV}" <<EOF
NODE_ENV=development
ENABLE_DEMO_ENDPOINTS=true
REQUIRE_DEMO_ADMISSION=true
DISABLE_RATE_LIMITS=false
LISTEN_HOST=127.0.0.1
CORS_ORIGIN=http://localhost:${PORT},http://127.0.0.1:${PORT}
DEMO_ADMISSION_FILE=${DEMO_RUNTIME_DIR}/admission-state.json
GLOBAL_RATE_LIMIT_MAX=20000
VOTE_RATE_LIMIT_MAX=9000
CREDENTIAL_RATE_LIMIT_MAX=3500
ADMIN_LOCAL_PORT=3001
EOF
  chmod 600 "${BOOTH_ENV}"
fi
set_env() { # key value — 원자적으로 교체
  python3 - "${BOOTH_ENV}" "$1" "$2" <<'PY'
import os, sys, tempfile
path, key, value = sys.argv[1:]
lines = open(path, encoding='utf-8').read().splitlines()
out, done = [], False
for line in lines:
    if line.split('=', 1)[0].strip() == key:
        if not done: out.append(f'{key}={value}'); done = True
        continue
    out.append(line)
if not done: out.append(f'{key}={value}')
fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path))
with os.fdopen(fd, 'w', encoding='utf-8') as f: f.write('\n'.join(out) + '\n')
os.chmod(tmp, 0o600); os.replace(tmp, path)
PY
}
ADMIN_LOCAL_PORT="$(sed -n 's/^ADMIN_LOCAL_PORT=//p' "${BOOTH_ENV}" | tail -1)"
ADMIN_LOCAL_PORT="${ADMIN_LOCAL_PORT:-3001}"

# ── 1. Docker / Fabric ────────────────────────────────────────────
say "[1/6] Docker · Fabric 확인"
restart_docker_desktop() {
  [ "${OS}" = Darwin ] || fail "컨테이너 I/O 오류: Docker Desktop을 직접 재시작한 뒤 다시 실행하세요."
  say "      Docker Desktop 재시작 진행"
  osascript -e 'quit app "Docker Desktop"' >/dev/null 2>&1 || osascript -e 'quit app "Docker"' >/dev/null 2>&1 || true
  for _ in $(seq 1 40); do docker info >/dev/null 2>&1 || break; sleep 3; done
  sleep 3; open -a Docker
  for _ in $(seq 1 80); do docker info >/dev/null 2>&1 && return 0; sleep 3; done
  fail "Docker Desktop이 켜지지 않습니다."
}
if ! docker info >/dev/null 2>&1; then
  say "      Docker 켜는 중"
  start_docker
  for _ in $(seq 1 80); do docker info >/dev/null 2>&1 && break; sleep 3; done
  docker info >/dev/null 2>&1 || fail "Docker가 켜지지 않습니다."
fi
# 밤새 SSD 연결이 끊긴 뒤에는 컨테이너가 Up이어도 exec가 I/O 오류를 낸다
if docker ps --format '{{.Names}}' | grep -qx cli && ! docker exec cli true >/dev/null 2>&1; then
  say "      컨테이너 디스크 I/O 오류 확인 (SSD 연결이 끊겼던 흔적)"
  restart_docker_desktop
fi
CHAINCODE_CONTAINER="$(docker ps -a --format '{{.Names}}' | grep -E '^voting-chaincode-seq-[0-9]+$' | sort -t- -k4 -n | tail -1 || true)"
CHAINCODE_CONTAINER="${CHAINCODE_CONTAINER:-voting-chaincode}"
start_group() { # 이미 켜진 것은 건드리지 않음
  local names=() n
  for n in "$@"; do docker ps --format '{{.Names}}' | grep -qx "$n" || names+=("$n"); done
  [ "${#names[@]}" -eq 0 ] || docker start "${names[@]}" >/dev/null
}
start_group couchdb-ec0 couchdb-ec1 couchdb-party couchdb-civil; sleep 3
start_group orderer1.orderer.voting.example.com orderer2.orderer.voting.example.com orderer3.orderer.voting.example.com orderer4.orderer.voting.example.com; sleep 3
start_group peer0.ec.voting.example.com peer1.ec.voting.example.com peer0.party.voting.example.com peer0.civil.voting.example.com; sleep 3
start_group "${CHAINCODE_CONTAINER}" cli
for _ in $(seq 1 20); do
  docker exec cli peer channel getinfo -c voting-channel >/dev/null 2>&1 && break; sleep 3
done
docker exec cli peer channel getinfo -c voting-channel >/dev/null 2>&1 || fail "Fabric 채널 응답 없음 (docker ps로 확인)"
say "      ✓ Fabric 정상 · 체인코드 컨테이너 ${CHAINCODE_CONTAINER}"

# ── 2. 공개 터널 ─────────────────────────────────────────────────
say "[2/6] 공개 터널 (Cloudflare Quick Tunnel → :${PORT})"
URL=""
# KEEP_TUNNEL=true: 살아 있는 터널을 그대로 써서 QR 주소를 바꾸지 않음 (백엔드만 재기동할 때)
if [ "${KEEP_TUNNEL:-false}" = true ] && demo_owned_pid "${TUNNEL_PID_FILE}" "cloudflared tunnel" "${DEMO_REPO_DIR}" >/dev/null; then
  URL="$(cat "${TUNNEL_URL_FILE}" 2>/dev/null || true)"
  [[ "${URL}" =~ ^https://[a-z0-9-]+\.trycloudflare\.com$ ]] && say "      기존 터널 유지" || URL=""
fi
[ -n "${URL}" ] || demo_stop_owned "${TUNNEL_PID_FILE}" "cloudflared tunnel" "${DEMO_REPO_DIR}" "이전 터널" >/dev/null 2>&1 || true
for try in 1 2 3 4; do
  [ -n "${URL}" ] && break
  # 새 파일로 시작 (이전 프로세스가 잡고 있던 파일을 비우면 NUL이 섞임)
  rm -f "${TUNNEL_LOG_FILE}"
  nohup cloudflared tunnel --no-autoupdate --protocol http2 --url "http://127.0.0.1:${PORT}" > "${TUNNEL_LOG_FILE}" 2>&1 &
  printf '%s\n' "$!" > "${TUNNEL_PID_FILE}"
  for _ in $(seq 1 20); do
    sleep 1.5
    URL="$(grep -aoE 'https://[a-z0-9-]+\.trycloudflare\.com' "${TUNNEL_LOG_FILE}" 2>/dev/null | head -1 || true)"
    [ -n "${URL}" ] && break
  done
  [ -n "${URL}" ] && break
  say "      터널 시도 ${try} 실패 → 다시 시도"
  demo_stop_owned "${TUNNEL_PID_FILE}" "cloudflared tunnel" "${DEMO_REPO_DIR}" "터널" >/dev/null 2>&1 || true
done
[ -n "${URL}" ] || fail "터널 주소를 받지 못했습니다. 인터넷 연결 확인 (${TUNNEL_LOG_FILE})"
[[ "${URL}" =~ ^https://[a-z0-9-]+\.trycloudflare\.com$ ]] || fail "터널 주소 형식이 이상합니다: ${URL}"
printf '%s\n' "${URL}" > "${TUNNEL_URL_FILE}"
say "      ✓ ${URL}"

# ── 3. QR 주소 설정 반영 ─────────────────────────────────────────
say "[3/6] 휴대폰 QR 주소 설정 반영"
set_env PUBLIC_VOTER_ORIGIN "${URL}"
set_env CORS_ORIGIN "http://localhost:${PORT},http://127.0.0.1:${PORT},${URL}"
say "      ✓ PUBLIC_VOTER_ORIGIN · CORS_ORIGIN 갱신 (${BOOTH_ENV})"

# ── 4. 백엔드 재기동 ─────────────────────────────────────────────
say "[4/6] 백엔드 재기동"
demo_stop_owned "${BACKEND_PID_FILE}" "node src/app.js" "${DEMO_REPO_DIR}/application" "이전 백엔드" >/dev/null 2>&1 || true
for _ in $(seq 1 10); do curl -fsS --max-time 1 "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1 || break; sleep 1; done
if curl -fsS --max-time 1 "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
  fail ":${PORT}를 다른 프로세스가 쓰고 있습니다. (lsof -nP -iTCP:${PORT} -sTCP:LISTEN)"
fi
(
  set -a; . "${BOOTH_ENV}"; ADMIN_API_TOKEN="$(cat "${ADMIN_TOKEN_FILE}")"; set +a
  cd application
  nohup node src/app.js > "${BACKEND_LOG_FILE}" 2>&1 &
  printf '%s\n' "$!" > "${BACKEND_PID_FILE}"
)
for _ in $(seq 1 30); do curl -fsS --max-time 2 "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1 && break; sleep 1; done
curl -fsS --max-time 2 "http://127.0.0.1:${PORT}/health" >/dev/null || fail "백엔드 응답 없음 (${BACKEND_LOG_FILE})"
curl -fsS --max-time 2 "http://127.0.0.1:${ADMIN_LOCAL_PORT}/health" | grep -q '"localAdmin":true' || fail "관리자 전용 입구 응답 없음"
say "      ✓ 공개 :${PORT} · 관리자 전용 127.0.0.1:${ADMIN_LOCAL_PORT}"

# ── 5. 공개 주소 확인 + 잠자기 방지 ──────────────────────────────
say "[5/6] 휴대폰에서 열 공개 주소 확인"
OK=""
for _ in $(seq 1 30); do
  if curl -fsS --max-time 5 "${URL}/health" 2>/dev/null | grep -q '"status":"ok"'; then OK=1; break; fi
  sleep 2
done
[ -n "${OK}" ] && say "      ✓ ${URL} 접속 확인" || say "      ! 공개 주소 응답이 아직 없음 (DNS 반영 지연일 수 있음, 1분 뒤 다시 확인)"
if [ -f "${CAFFEINATE_PID_FILE}" ]; then kill "$(cat "${CAFFEINATE_PID_FILE}")" 2>/dev/null || true; rm -f "${CAFFEINATE_PID_FILE}"; fi
BACKEND_PID="$(cat "${BACKEND_PID_FILE}")"
if [ "${OS}" = Darwin ]; then
  nohup caffeinate -dimsu -w "${BACKEND_PID}" >/dev/null 2>&1 &
  printf '%s\n' "$!" > "${CAFFEINATE_PID_FILE}"
  say "      ✓ 백엔드가 켜져 있는 동안 잠자기 방지"
elif [ "${WSL}" = false ] && command -v systemd-inhibit >/dev/null 2>&1 && systemd-inhibit --list >/dev/null 2>&1; then
  nohup systemd-inhibit --what=idle:sleep --who=mongbas --why=booth tail --pid="${BACKEND_PID}" -f /dev/null >/dev/null 2>&1 &
  printf '%s\n' "$!" > "${CAFFEINATE_PID_FILE}"
  say "      ✓ 백엔드가 켜져 있는 동안 잠자기 방지"
else
  say "      ! 잠자기 방지는 직접 설정 (Windows: 설정 › 전원 › 화면·절전 '안 함')"
fi

# ── 6. 관제판 ───────────────────────────────────────────────────
DASHBOARD="http://localhost:${ADMIN_LOCAL_PORT}/?app=control"
say "[6/6] 관제판 열기"
[ "${OPEN_BROWSER}" = true ] && open_url "${DASHBOARD}" || true
cat <<EOF

  ✅ 부스 준비 완료
  ───────────────────────────────────────────────────────
  관제판 (이 컴퓨터 전용, 토큰 없음) : ${DASHBOARD}
  휴대폰 공개 주소              : ${URL}
  → 관제판에서 [＋ 새 세션 시작]을 누르면 세션마다 새 QR 표시
  ───────────────────────────────────────────────────────
  종료  : ./scripts/booth-down.sh   (원장은 그대로)
  ※ 터널을 다시 켜면 주소가 바뀌므로 이 스크립트를 다시 실행
EOF
