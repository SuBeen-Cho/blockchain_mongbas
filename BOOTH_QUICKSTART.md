# 부스 시연 빠른 시작 (macOS · Windows · Linux)

연구실 서버 없이 **노트북 한 대**에서 Fabric 원장·백엔드·관제판을 모두 띄우고, 방문자는 휴대폰으로 QR을 찍어 투표한다.

```
노트북 (Docker)                                   휴대폰
 ├─ Fabric 원장: 3개 기관 · 오더러 4 · 피어 4       │
 ├─ 백엔드 :3000 ── Cloudflare 임시 터널(https) ──┘  QR → 투표 화면
 └─ 관제판 127.0.0.1:3001  (이 노트북에서만 열림, 관리자 토큰 불필요)
```

## 1. 준비물

| | macOS | Windows | Linux (Ubuntu) |
|---|---|---|---|
| Docker | Docker Desktop | Docker Desktop (WSL2 기반) | Docker Engine + Compose v2 |
| 터미널 | 기본 터미널 | **WSL2 Ubuntu** 터미널 | 기본 터미널 |
| Node.js | 22.12 이상 | 22.12 이상 (WSL 안에 설치) | 22.12 이상 |
| 기타 | git · python3 · openssl | WSL 안에 git · python3 · openssl | git · python3 · openssl · curl |

- Docker에 메모리 **4GB 이상**을 할당한다. 디스크는 이미지 포함 약 5GB가 필요하다.
- Fabric 도구(peer·cryptogen 등 2.5.16)와 cloudflared는 설치 스크립트가 체크섬을 확인하고 자동으로 받는다.

### Windows 추가 준비 (처음 한 번)
1. PowerShell(관리자)에서 `wsl --install -d Ubuntu-24.04`를 실행하고 재부팅한다.
2. Docker Desktop을 설치한다. **Settings › Resources › WSL integration**에서 Ubuntu-24.04를 켠다.
3. 시작 메뉴에서 **Ubuntu**를 열고 아래 명령으로 필요한 프로그램을 설치한다.
   ```bash
   sudo apt-get update && sudo apt-get install -y git curl openssl python3
   curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash && source ~/.bashrc && nvm install 22
   ```
4. **저장소는 반드시 WSL 홈(`~/`)에 clone한다.** `/mnt/c/...`(C 드라이브)에 두면 Fabric이 매우 느리고 권한 오류가 난다. 이 경우 설치 스크립트가 실행을 거부한다.

## 2. 설치 (컴퓨터마다 처음 한 번)

```bash
git clone -b booth/aisw-festival-2026 https://github.com/SuBeen-Cho/blockchain_mongbas.git mongbas
cd mongbas
./scripts/booth-setup.sh
```

설치 스크립트는 아래 순서로 진행한다.
1. 필수 프로그램 확인
2. Fabric·cloudflared 설치
3. 서버 비밀값 생성
4. npm 패키지 설치·화면 빌드
5. 원장 생성·체인코드 배포

처음에는 이미지를 받느라 5~15분 걸린다. 다시 실행해도 기존 원장과 비밀값은 지우지 않는다.

비밀값, 도구, 로그는 저장소 밖 `~/.local/state/mongbas`에 저장되고 Git에 올라가지 않는다.

## 3. 부스 기동 (매번)

```bash
./scripts/booth-up.sh
```

스크립트가 하는 일:
1. Docker·Fabric 확인
2. 공개 터널 열기
3. 휴대폰 QR 주소 반영
4. 백엔드 기동
5. 관제판 열기

관제판이 열리면 **[＋ 새 세션 시작]**을 누른다. 세션마다 새 QR이 표시되고, 만료 30초 전에 자동으로 갱신된다.

- 관제판 주소: `http://localhost:3001/?app=control` (Windows에서도 브라우저로 이 주소를 연다)
- 백엔드만 다시 켜고 QR 주소는 유지: `KEEP_TUNNEL=true ./scripts/booth-up.sh`
- 종료: `./scripts/booth-down.sh` (원장은 그대로 남는다)
- 노트북을 재부팅했으면 Docker를 켠 뒤 `./scripts/booth-up.sh`만 다시 실행한다.

## 4. 문제 해결

| 증상 | 확인 |
|---|---|
| `처음 실행하는 컴퓨터입니다` | `./scripts/booth-setup.sh`를 먼저 실행 |
| 터널 주소를 못 받음 | 인터넷 연결 확인 후 재실행. 학교망이 막히면 휴대폰 핫스팟 사용 |
| QR이 안 뜸 | 관제판을 반드시 `localhost:3001`로 열었는지 확인 (`:3000`은 관리자 토큰 필요) |
| `컨테이너는 없는데 network/crypto-config가 남아 있습니다` | 예전 원장 흔적. 필요 없으면 `network/scripts/network.sh clean --confirm-destroy-ledger` |
| 백엔드 응답 없음 | `~/.local/state/mongbas/demo/backend.log` 확인 |
| Windows에서 잠자기 | 설정 › 전원 › 화면·절전을 '안 함'으로 설정 (macOS·Linux는 자동) |

자세한 운영 절차와 보안 범위는 [`docs/DEMO_RUNBOOK.md`](docs/DEMO_RUNBOOK.md)에 있다. 발표·전시 자료는 [`SW경진대회/`](SW경진대회/)에 있다.
