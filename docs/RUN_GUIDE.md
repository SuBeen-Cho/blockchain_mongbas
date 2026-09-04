# Mongbas 실행 가이드 (서버 시작 방법)

하이퍼레저 패브릭 기반 암호화·검증 가능 전자투표 프로토타입 — 데모/개발 실행 방법 정리. 현재 기본 Ed25519 credential은 완전 익명 credential이 아니다.

## 0. 최초 1회 설치 (Docker + Fabric 부트스트랩)

### 0-1. 필수 도구
| 도구 | 용도 | 확인 |
|---|---|---|
| **Docker Desktop** | 블록체인(피어·오더러·CouchDB)이 Docker로 동작 — **반드시 실행 중** | `docker ps` |
| **Node.js 22.12+** / npm | 백엔드·프론트엔드 (`puppeteer-core@25` 요구사항) | `node --version` |
| **Go 1.25.7+** | 현재 `chaincode/voting/go.mod` 기준 체인코드 빌드 | `go version` |
| **Tailscale** (원격 QR 선택) | tailnet 내부 HTTPS Serve | `tailscale status` |

### 0-2. 클론
```bash
git clone https://github.com/SuBeen-Cho/blockchain_mongbas.git
cd blockchain_mongbas/mongbas
```

### 0-3. 검증된 Linux 평가 환경 설치

Ubuntu 평가 서버에서는 저장소가 고정한 Fabric/Go 버전과 SHA-256을 검증하는 bootstrap을 사용합니다. 기존 runtime이나 ledger가 있는 서버에서는 먼저 `deploy/linux/README.md`의 보존·preflight 절차를 확인하고 fresh bootstrap/network-up을 반복하지 마세요.

```bash
./deploy/linux/bootstrap.sh
```

macOS/Docker 개발 환경에서 Fabric 도구를 별도로 설치할 경우에도 공식 release archive와 게시된 checksum을 검증하고, 원격 스크립트를 바로 shell로 파이프하지 않습니다.

Vite 개발 서버는 기본적으로 loopback만 수신합니다. 개발 서버를 별도 사설 hostname으로 열어야 할 때만 정확한 값을 지정하세요. 실제 tailnet QR 실증은 Vite dev server가 아니라 backend가 제공하는 production build와 Tailscale Serve를 사용합니다.

```bash
VITE_DEV_HOST=0.0.0.0 VITE_ALLOWED_HOSTS=exact-hostname npm --prefix frontend run dev
```

### 0-4. 의존성 설치 + 환경변수
```bash
cd application && cp .env.example .env && npm ci --omit=dev --omit=optional   # .env 값(SESSION_SECRET 등) 설정
cd ../frontend && npm ci
cd ..
```

> ⏱️ **첫 네트워크 기동 시 Docker 이미지 다운로드로 5~10분** 걸릴 수 있습니다(이후엔 빠름).
> 이후 `demo-start.sh`가 네트워크가 안 떠 있으면 자동으로 `up + deploy`까지 수행합니다.

Linux에서는 실제 secret과 실행 결과를 저장소 밖(예: `~/mongbas-runtime/`)에 두고 `application/.env`는 외부 secret 파일을 가리키는 심볼릭 링크로 구성하는 것을 권장한다.

---

## 1. 부스 데모 — 원클릭 (권장)

```bash
cd mongbas
./scripts/demo-start.sh     # ① 네트워크 확인(없으면 up+deploy) ② 빌드 ③ loopback 백엔드
./scripts/demo-status.sh    # 로컬 서비스 / 상태 확인 (언제든)
./scripts/demo-stop.sh      # 소유권이 확인된 백엔드 중지 (블록체인은 유지)
./scripts/demo-rebuild.sh   # 화면 코드만 바꿨을 때: build만 갱신
```

- `demo-start.sh`는 백엔드를 백그라운드로 기동하고, 실행 PID와 작업 경로를 저장해 소유권이 확인된 프로세스만 중지한다.
- 원격 휴대폰 실증은 QR 보안 프로필을 적용한 Linux loopback backend를 **tailnet-only Tailscale Serve HTTPS**로 전달한다.
- Tailscale Serve 계정 활성화와 휴대폰 tailnet 가입이 필요하다. Funnel·Quick Tunnel·일반 인터넷 공개는 별도 승인 없이 사용하지 않는다.

### 화면 진입 (URL)
| 경로 | 화면 |
|---|---|
| `/` 또는 `/?app=control` | **투표현황 대시보드** (발표자) |
| `/?app=kiosk&e=<선거ID>` | **폰 투표** (대시보드 [새 세션] QR이 자동 생성) |
| `/?app=track&e=<선거ID>` | 내 표 추적/검증 |
| `/showcase3.html` | 전시 쇼케이스 |
| `/?app=full` | 원래 탭 앱(투표/검증/관리자, 전체 파이프라인 심화) |

### 데모 흐름
1. 대시보드 **[＋ 새 세션]** → QR 표시 (+ 쇼케이스 QR 자동 동기화)
2. 폰으로 QR 스캔 → 투표 → 일반 추적번호 또는 deniable verification receipt
3. 사이드바 **커스텀 투표 주입**(후보별 드롭다운 + ＋)으로 분위기 채우기
4. **[개표]** → 종료 + 2-of-3 복호화 + 집계 과정(실제 계산값) + 셔플
5. **[검증]** → 추적번호로 Merkle 봉인 일치 확인

> normal/panic 흐름은 불투명 lookup capability와 고정 크기 API 응답을 시연합니다. 이는 PDC/backend 공모·재투표 패턴·forced abstention을 해결했다는 증거가 아니므로 전체 coercion resistance로 표현하지 않는다.

---

## 2. 개발 모드 (코드 수정하며)

```bash
# (최초) 블록체인 네트워크
cd mongbas/network && ./scripts/network.sh up && ./scripts/network.sh deploy

# 백엔드 (:3000, dist 정적 서빙 + /api)
cd mongbas/application && npm start          # 또는 npm run dev (nodemon)

# 프론트엔드 핫리로드 (:5173)
cd mongbas/frontend && npm run dev
```
- 프론트 수정 → `npm run build`로 `dist/` 갱신 → 백엔드가 서빙. (개발 중엔 `npm run dev`가 편함)

### 네트워크 관리
```bash
cd mongbas/network
./scripts/network.sh up | deploy | test
./scripts/network.sh down --confirm-destroy-ledger
./scripts/network.sh clean --confirm-destroy-ledger
```
- `down` 정지 / `clean` 암호화 자료까지 완전 초기화. 원장·볼륨·생성 키 삭제를 승인한 경우에만 `./scripts/demo-reset.sh --confirm-destroy-demo-ledger`를 사용한다.

---

## 3. 전시 쇼케이스 (Netlify)
- 배포 주소: `https://mongbas-blockchain.netlify.app/`
- 소스: `frontend/public/showcase3.html`
- 하단 QR은 **Firebase 릴레이**를 폴링해 현재 세션 키오스크 URL로 자동 갱신 → 서브 컴퓨터(다른 PC)에 띄워도 동작.
- 화면 갱신 시: 빌드 후 `dist/showcase3.html`(+ logo/icons/shots)을 Netlify에 재배포.

---

## 4. 데이터는 어디에?
- 표/선거/암호문/게시판은 **Hyperledger Fabric 원장**(피어별 **CouchDB** 월드스테이트 + 블록체인 블록)에 저장. 별도 DB 불필요.
- 백엔드 인메모리(`liveCount`/`demoLive`)는 화면용 보조 — 재시작 시 초기화되지만 실제 표는 원장에 영구 보존.

---

## 5. 트러블슈팅
| 증상 | 대응 |
|---|---|
| tailnet HTTPS 주소 안 열림 | `tailscale status`와 `tailscale serve status`를 확인하고, Serve 계정 활성화가 안 됐으면 사용자 조작 후 재확인 |
| 폰이 QR 못 엶 | 휴대폰이 같은 tailnet인지, 대시보드가 Serve HTTPS origin인지, QR admission이 만료되지 않았는지 확인 |
| 개표 시 MVCC 충돌 | 자동 재시도됨. 안 되면 [개표] 다시 |
| 전부 꼬임 | 복구 증거 보존 후 초기화를 승인했다면 `./scripts/demo-reset.sh --confirm-destroy-demo-ledger` → `./scripts/demo-start.sh` |
