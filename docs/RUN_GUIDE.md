# Mongbas 실행 가이드 (서버 시작 방법)

하이퍼레저 패브릭 기반 익명 전자투표 — 데모/개발 실행 방법 정리.

## 0. 사전 준비 (최초 1회)
- **Docker Desktop** 실행 중일 것 (블록체인 네트워크가 Docker로 동작).
- Node.js 18+ / npm.
- `cloudflared` (공개 터널용): `brew install cloudflared`.
- 의존성 설치:
  ```bash
  cd mongbas/application && npm install
  cd ../frontend && npm install
  ```
- 백엔드 환경변수: `application/.env` (없으면 `.env.example` 복사 후 값 설정).

---

## 1. 부스 데모 — 원클릭 (권장)

```bash
cd mongbas
./scripts/demo-up.sh        # ① 네트워크 확인(없으면 up+deploy) ② 빌드 ③ 백엔드 ④ 공개터널
./scripts/demo-status.sh    # 현재 공개 주소 / 상태 확인 (언제든)
./scripts/demo-stop.sh      # 백엔드·터널 중지 (블록체인은 유지)
./scripts/demo-rebuild.sh   # 화면 코드만 바꿨을 때: 빌드만 (터널 주소 유지)
```

- `demo-up.sh` 실행 후 **터미널을 닫아도 계속 동작**(nohup). 노트북만 켜져 있으면 됨.
- 출력된 `https://*.trycloudflare.com/` 주소 = **투표현황 대시보드**.
- 터널은 `--protocol http2`(TCP)로 동작 → QUIC/UDP 막는 와이파이에서도 OK.

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
2. 폰으로 QR 스캔 → 정상/패닉 선택 → 투표 → 추적번호
3. 사이드바 **커스텀 투표 주입**(후보별 드롭다운 + ＋)으로 분위기 채우기
4. **[개표]** → 종료 + 2-of-3 복호화 + 집계 과정(실제 계산값) + 셔플
5. **[검증]** → 추적번호로 Merkle 봉인 일치 확인

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
./scripts/network.sh up | deploy | test | down | clean
```
- `down` 정지 / `clean` 암호화 자료까지 완전 초기화. 꼬이면 `./scripts/demo-reset.sh`.

---

## 3. 전시 쇼케이스 (Netlify)
- 배포 주소: `https://mongbas-blockchain.netlify.app/`
- 소스: `frontend/public/showcase3.html`
- 하단 QR은 **Firebase 릴레이**를 폴링해 현재 세션 키오스크 URL로 자동 갱신 → 서브 컴퓨터(다른 PC)에 띄워도 동작.
- 화면 갱신 시: 빌드 후 `dist/showcase3.html`(+ logo/icons/shapes/shots)을 Netlify에 재배포.

---

## 4. 데이터는 어디에?
- 표/선거/암호문/게시판은 **Hyperledger Fabric 원장**(피어별 **CouchDB** 월드스테이트 + 블록체인 블록)에 저장. 별도 DB 불필요.
- 백엔드 인메모리(`liveCount`/`demoLive`)는 화면용 보조 — 재시작 시 초기화되지만 실제 표는 원장에 영구 보존.

---

## 5. 트러블슈팅
| 증상 | 대응 |
|---|---|
| 공개 주소 안 열림 | 와이파이가 바뀌면 터널이 끊김 → `./scripts/demo-up.sh` 재실행(http2). `demo-status.sh`로 새 주소 확인 |
| 폰이 QR 못 엶 | 대시보드를 **터널 주소로** 열었는지 확인(로컬호스트면 폰이 접근 불가) |
| 개표 시 MVCC 충돌 | 자동 재시도됨. 안 되면 [개표] 다시 |
| 전부 꼬임 | `./scripts/demo-reset.sh` → `./scripts/demo-up.sh` |
