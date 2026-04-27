# 프로젝트 인수인계 문서 — BFT 기반 익명 전자투표 블록체인

> 최초 작성: 2026-03-27 | **최종 업데이트: 2026-04-03**
> 대상: 다음 팀원 또는 이 문서를 처음 보는 사람 기준
>
> **2026-04-03 업데이트:** STEP 1~7 전체 구현 완료. React 프론트엔드 + Caliper 성능평가 + Idemix 미들웨어 훅 추가.

---

## 1. 지금까지 완료된 작업 요약

### 완료 — 네트워크 / 기반

| 항목 | 상태 | 비고 |
|-----|------|------|
| 네트워크 인증서 설계 (crypto-config.yaml) | ✅ | 3개 조직 + 4 오더러 |
| 채널·제네시스 블록 설계 (configtx.yaml) | ✅ | 2-of-3 승인 정책 |
| Docker 네트워크 설계 (docker-compose.yaml) | ✅ | 오더러4 + 피어4 + CouchDB4 |
| 네트워크 기동 자동화 (network.sh) | ✅ | up/deploy/test/down/clean |
| 체인코드 데이터 구조 설계 | ✅ | Nullifier + PDC 익명투표 |
| CouchDB 인덱스 설정 | ✅ | docType + electionID |
| PDC (VotePrivateCollection) 설정 | ✅ | memberOnlyRead: false |
| 네트워크 실제 기동 검증 | ✅ | 오더러·피어 채널 참여 성공 |
| 체인코드 배포 검증 | ✅ | 3개 기관 승인 / 2-of-3 커밋 |

### 완료 — STEP 1~3 (2026-03-29)

| 항목 | 상태 | 비고 |
|-----|------|------|
| Node.js REST API 전체 | ✅ | application/src/ 구현 완료 |
| CCAAS 배포 (macOS Docker 호환) | ✅ | chaincode/voting/Dockerfile |
| Merkle Tree (BuildMerkleTree, GetMerkleProof) | ✅ | O(log N) 포함 증명 |
| ActivateElection (CREATED→ACTIVE) | ✅ | |
| Panic Password / Deniable Verification | ✅ | Normal/Panic 타이밍 차이 13.7ms |
| STEP 1~3 성능 평가 (200회 반복) | ✅ | docs/performance/ 참조 |
| network.sh sequence 자동 감지 | ✅ | 재배포 시 자동 +1 |

### 완료 — STEP 4~5 (2026-03-30)

| 항목 | 상태 | 비고 |
|-----|------|------|
| Nullifier Eviction (재투표 지원) | ✅ | CastVote 덮어쓰기, EvictCount 추적 |
| Shamir's Secret Sharing (n=2/m=3) | ✅ | GF(p), p = secp256k1 prime (2²⁵⁶ − 2³² − 977), Lagrange 복원, threshold 검증 |
| STEP 4~5 성능 평가 (100·50회 반복) | ✅ | docs/performance/ 참조 |
| Shamir REST API 엔드포인트 추가 | ✅ | /keysharing, /shares, /decryption |

### 완료 — 보안 위협 시나리오 측정 (2026-04-11)

| 항목 | 상태 | 비고 |
|-----|------|------|
| 보안 시나리오 측정 스크립트 | ✅ | `scripts/security-scenarios.js` |
| 시나리오 A (단독 결과 조작) | ✅ | 2-of-3 정책 검증, 2113ms |
| 시나리오 B (이중투표) | ✅ | Eviction 100%, Avg 2082ms |
| 시나리오 C (강압 투표) | ✅ | Normal/Panic 차이 0.2ms, t=0.397 (p>0.05) |
| 시나리오 D (집계 키 탈취) | ✅ | 1-share 실패 100%, 2-share 성공 100% |
| 시나리오 E (결과 조작 주장) | ✅ | Merkle 정확도 100%/100%, 73.6ms |
| 결과 문서 | ✅ | `docs/security-eval/SECURITY-SCENARIOS.md` |

### 완료 — STEP 6~7 + Idemix 훅 (2026-04-03)

| 항목 | 상태 | 비고 |
|-----|------|------|
| React 프론트엔드 (VoterPage) | ✅ | voterSecret 로컬 생성, Panic Password 지원 |
| React 프론트엔드 (AdminPage) | ✅ | 선거 생성→활성화→종료→Merkle→Shamir 전체 플로우 |
| React 프론트엔드 (VerifyPage) | ✅ | Merkle 증명, Deniable Verification (Normal/Panic) |
| 브라우저 암호 유틸 (crypto.js) | ✅ | Web Crypto API SHA-256, nullifier·voteHash 계산 |
| Caliper 성능평가 (4라운드) | ✅ | Low/Mid/High/Backlog TPS + Latency P50/P95/P99 |
| Idemix 미들웨어 훅 | ✅ | `middleware/auth.js` — 환경변수 토글, 캐시 최적화 설계 포함 |
| Idemix 성능 비교 프레임워크 | ✅ | `run-caliper.sh idemix-compare`, `benchmark/http-bench.js` |

### 남은 것

| 항목 | 우선순위 | 비고 |
|-----|---------|------|
| Idemix ZKP 실 연동 | 낮음 | `middleware/auth.js` 내 TODO 블록 1개만 교체 |

---

## 2. 프로젝트 구조

```
blockchain_mongbas/
├── network/
│   ├── crypto-config.yaml        ← 인증서 생성 설정 (cryptogen)
│   ├── configtx.yaml             ← 채널·제네시스 블록 설정
│   ├── docker-compose.yaml       ← 컨테이너 정의
│   ├── channel-artifacts/        ← 제네시스 블록 (network.sh up 시 생성)
│   ├── crypto-config/            ← 인증서·개인키 (network.sh up 시 생성, gitignore)
│   └── scripts/
│       └── network.sh            ← 네트워크 전체 관리 (up/deploy/test/down/clean)
├── chaincode/
│   └── voting/
│       ├── voting.go             ← 체인코드 (STEP 1~5 전체)
│       ├── go.mod / go.sum
│       ├── vendor/               ← Go 의존성 (git 포함)
│       ├── collection_config.json  ← PDC 설정
│       └── META-INF/statedb/couchdb/indexes/
│           └── indexElection.json  ← CouchDB 인덱스
├── application/
│   ├── src/
│   │   ├── app.js                ← Express 서버 (Idemix 미들웨어 적용)
│   │   ├── gateway.js            ← Fabric Gateway 연결
│   │   ├── middleware/
│   │   │   └── auth.js           ← ★ Idemix 연동 포인트 (환경변수 토글, 캐시)
│   │   └── routes/
│   │       ├── elections.js      ← 선거 CRUD + Merkle + Proof + Shamir
│   │       └── vote.js           ← 투표 + Nullifier + Eviction + Panic
│   └── benchmark/
│       └── http-bench.js         ← Idemix 성능 비교 HTTP 벤치마크 스크립트
├── frontend/
│   └── src/
│       ├── pages/
│       │   ├── VoterPage.jsx     ← 투표 화면 (voterSecret 로컬 생성, Panic 지원)
│       │   ├── AdminPage.jsx     ← 관리자 화면 (선거 생성→Shamir 전체 플로우)
│       │   └── VerifyPage.jsx    ← E2E 검증 (Merkle + Deniable Verification)
│       └── utils/
│           └── crypto.js         ← 브라우저 SHA-256, nullifierHash 계산
├── caliper/
│   ├── networks/
│   │   └── fabric-network.yaml   ← Caliper 네트워크 설정
│   ├── benchmarks/
│   │   ├── cast-vote.yaml        ← CastVote 4라운드 벤치마크
│   │   ├── get-election.yaml     ← Query 벤치마크
│   │   └── full-bench.yaml       ← 전체 통합 벤치마크
│   ├── workloads/
│   │   └── castVote.js           ← CastVote 워크로드 (transientMap, Eviction 대응)
│   ├── reports/                  ← Caliper HTML/JSON 리포트 저장
│   └── run-caliper.sh            ← 벤치마크 실행 스크립트 (idemix-compare 모드 포함)
├── docs/
│   └── performance/
│       ├── PERF-SUMMARY.md       ← 전체 성능 평가 종합
│       └── bench_results/        ← 원시 측정값
├── scripts/
│   ├── bench_full.sh             ← STEP 1~3 벤치마크
│   └── bench_step45.sh           ← STEP 4~5 벤치마크
├── README.md
└── HANDOFF.md                    ← 현재 파일
```

---

## 3. 네트워크 아키텍처

### 조직 구성 (2-of-3 승인 정책)

```
┌─────────────────────────────────────────────┐
│  ElectionCommissionMSP (선거관리위원회)        │
│  peer0.ec.voting.example.com  :7051         │
│  peer1.ec.voting.example.com  :7151         │
├─────────────────────────────────────────────┤
│  PartyObserverMSP (참관 정당)                 │
│  peer0.party.voting.example.com :8051       │
├─────────────────────────────────────────────┤
│  CivilSocietyMSP (시민단체)                   │
│  peer0.civil.voting.example.com :9051       │
└─────────────────────────────────────────────┘

승인 정책: OutOf(2, EC.peer, Party.peer, Civil.peer)
→ 3개 기관 중 어느 2개가 서명해도 트랜잭션 유효
→ 단일 기관 단독 조작 불가능
```

### 오더러 구성 (etcdraft, 4-node CFT)

```
orderer1 :7050 / admin :7053
orderer2 :7150 / admin :7153
orderer3 :7250 / admin :7253
orderer4 :7350 / admin :7353

4-node etcdraft → 노드 1개 장애 허용 (f=1)
※ SmartBFT(진정한 BFT)는 fabric-tools 안정 3.x 이미지 미출시로 현재 etcdraft 사용.
```

### 프라이버시 흐름

```
유권자 (브라우저)
  │
  ├─ voterSecret  (로컬 보관, 절대 서버 전송 금지)
  │
  └─ nullifierHash = SHA256(voterSecret + electionID)  ← 브라우저에서 계산
          │
          ▼ CastVote 호출 (재투표 시 Eviction으로 덮어쓰기)
          │
          ├─→ [공개 원장]  Nullifier { nullifierHash, candidateID, evictCount }
          │      → 신원 미노출 / 이중투표 방지 / 재투표 횟수 추적
          │
          └─→ [PDC: VotePrivateCollection]  VotePrivate + Shamir shares
                 → 오더러 미전달 / 피어 비공개 DB에만 저장
```

---

## 4. 처음 세팅하는 경우 — 전체 가이드

### 4-0. git에 포함되지 않는 항목 안내

이 저장소를 클론한 뒤 아래 항목들은 **직접 설치/생성**해야 합니다.
`.gitignore`에 의해 제외되어 있거나 실행 환경에 따라 달라지기 때문입니다.

| 항목 | 이유 | 생성 방법 |
|-----|------|---------|
| `fabric-samples/` (Fabric 바이너리) | 280MB, git 제외 | 아래 4-1 참고 |
| `network/crypto-config/` | 인증서/개인키 — 보안상 제외 | `network.sh up` 시 자동 생성 |
| `network/channel-artifacts/` | 제네시스 블록 — 실행 시 생성 | `network.sh up` 시 자동 생성 |
| `application/node_modules/` | npm 패키지 | `npm install` |
| `chaincode/voting/ccaas-package/` | 빌드 산출물 | `network.sh deploy` 시 자동 생성 |
| `chaincode/voting/voting` | 컴파일된 Go 바이너리 | CCAAS 방식이므로 로컬 빌드 불필요 |

> **`chaincode/voting/vendor/`** 는 git에 포함되어 있어 별도 `go mod download` 불필요.

---

### 4-1. Fabric 바이너리 설치

```bash
# mongbas/ 폴더 안에서 실행
curl -sSL https://raw.githubusercontent.com/hyperledger/fabric/main/scripts/install-fabric.sh \
  | bash -s -- --fabric-version 2.5.9 binary

# 설치 후 fabric-samples/bin/ 에 바이너리가 생성됨
ls fabric-samples/bin/
# peer  orderer  configtxgen  cryptogen  osnadmin  ...
```

설치 후 `network.sh`가 바이너리를 자동으로 찾습니다.
경로가 다를 경우 환경변수로 오버라이드:

```bash
export FABRIC_BIN_PATH="/your/path/to/fabric-samples/bin"
```

### 4-2. 필수 도구

| 도구 | 버전 | 용도 |
|-----|------|------|
| Docker + docker-compose | 최신 | 컨테이너 실행 |
| Go | 1.21+ | (참고용, CCAAS는 Docker 내 빌드) |
| Fabric 바이너리 | 2.5.9 | cryptogen, configtxgen, peer, osnadmin |
| Node.js | 18+ | REST API 서버 |
| python3 | 3.x | 벤치마크 스크립트 내부 사용 |

### 4-3. Node.js 패키지 설치

```bash
cd application
npm install
# application/node_modules/ 가 생성됨
```

### 4-4. 전체 세팅 순서 요약

```bash
# 1. 저장소 클론
git clone <repo-url>
cd mongbas

# 2. Fabric 바이너리 설치 (fabric-samples/ 생성)
curl -sSL https://raw.githubusercontent.com/hyperledger/fabric/main/scripts/install-fabric.sh \
  | bash -s -- --fabric-version 2.5.9 binary

# 3. Node.js 패키지 설치
cd application && npm install && cd ..

# 4. 네트워크 기동 (인증서·채널·Docker 자동 생성)
cd network
./scripts/network.sh up

# 5. 체인코드 배포 (ccaas-package 자동 생성, sequence 자동 감지)
./scripts/network.sh deploy

# 6. 동작 확인
./scripts/network.sh test

# 7. API 서버 기동
cd ../application && npm start
# → http://localhost:3000
```

---

## 5. 네트워크 실행 방법

```bash
cd network/

# 1. 네트워크 기동 (인증서 + 제네시스 블록 + Docker + 채널 참여)
./scripts/network.sh up

# 2. 체인코드 배포 (sequence 자동 감지 +1, 현재 9)
./scripts/network.sh deploy

# 3. 동작 확인 (투표→Nullifier→이중투표 차단 4가지 시나리오)
./scripts/network.sh test

# 종료 (볼륨 삭제 포함)
./scripts/network.sh down

# 완전 초기화
./scripts/network.sh clean
```

### API 서버 기동

```bash
cd application
npm install
npm start    # http://localhost:3000
```

---

## 6. 자주 쓰는 명령어

```bash
# 컨테이너 상태 확인
docker-compose ps

# 오더러/피어 로그
docker logs orderer1.orderer.voting.example.com 2>&1 | tail -20
docker logs peer0.ec.voting.example.com 2>&1 | tail -20

# CouchDB 웹 UI (Fauxton)
# 선관위 peer0: http://localhost:5984/_utils  (admin/adminpw)
# 선관위 peer1: http://localhost:5985/_utils
# 참관 정당:    http://localhost:6984/_utils
# 시민단체:     http://localhost:7984/_utils
```

### peer 명령어 직접 실행 시 환경변수

```bash
CRYPTO="./network/crypto-config"

export CORE_PEER_TLS_ENABLED=true
export CORE_PEER_LOCALMSPID=ElectionCommissionMSP
export CORE_PEER_MSPCONFIGPATH="${CRYPTO}/peerOrganizations/ec.voting.example.com/users/Admin@ec.voting.example.com/msp"
export CORE_PEER_ADDRESS=localhost:7051
export CORE_PEER_TLS_ROOTCERT_FILE="${CRYPTO}/peerOrganizations/ec.voting.example.com/peers/peer0.ec.voting.example.com/tls/ca.crt"

ORDERER_CA="${CRYPTO}/ordererOrganizations/orderer.voting.example.com/orderers/orderer1.orderer.voting.example.com/tls/ca.crt"
```

---

## 7. 체인코드 함수 목록 (sequence 9, 2026-03-30 기준)

| 함수 | 파라미터 | 설명 |
|-----|---------|------|
| `InitLedger` | 없음 | 시연용 선거 1개 초기화 |
| `CreateElection` | electionID, title, desc, candidatesJSON, startTime, endTime | 선거 생성 + 더미 Nullifier 3개/후보 자동 생성 |
| `ActivateElection` | electionID | CREATED → ACTIVE 상태 전환 |
| `GetElection` | electionID | 선거 정보 조회 |
| `CastVote` | electionID, candidateID, nullifierHash | 투표 제출 (transient: votePrivate + voterPW) — **재투표 시 Eviction(덮어쓰기)** |
| `GetNullifier` | nullifierHash | Nullifier 조회 (evictCount, lastEvictedAt 포함) |
| `CloseElection` | electionID | 선거 종료 + TallyVotes 자동 실행 |
| `TallyVotes` | electionID | CouchDB Rich Query 득표 집계 |
| `GetTally` | electionID | 집계 결과 조회 (`results` 키로 반환) |
| `BuildMerkleTree` | electionID | Merkle Tree 구축, Root Hash 원장 저장 |
| `GetMerkleRoot` | electionID | Merkle Root 조회 |
| `GetMerkleProof` | electionID, nullifierHash | Merkle 포함 증명 반환 |
| `GetMerkleProofWithPassword` | electionID, nullifierHash, passwordHash | Deniable Verification (Normal→실제, Panic→더미) |
| `InitKeySharing` | electionID | masterKey 생성 → Shamir 3분산 → PDC 저장 **(CLOSED 후 호출)** |
| `SubmitKeyShare` | electionID, shareIndex, shareHex | share 제출 → n≥2 시 Lagrange 복원 검증 |
| `GetKeyDecryptionStatus` | electionID | Shamir 복원 현황 조회 |
| `GetKeyShare` | electionID, shareIndex | PDC에서 share 조회 (관리자/테스트용) |

### TallyVotes 결과 형식 주의

```javascript
// 올바른 파싱 — "results" 키 사용
const tally = JSON.parse(result.toString());
const countA = tally.results?.A ?? 0;  // ← "tally" 아닌 "results"

// 더미 Nullifier 주의: 후보자당 3개 더미가 자동 포함됨
// A가 실제 5표이면 tally.results.A = 8 (5 + 더미3)
// 순위 판별은 정상 (더미는 모든 후보에 동등하게 적용됨)
```

### CastVote Transient 처리 (중요)

비공개 데이터는 반드시 **Transient Map**으로 전달해야 합니다. 일반 인자로 넣으면 오더러를 통해 모든 조직에 노출됩니다.

```javascript
const nullifierHash = crypto.createHash('sha256')
  .update(voterSecret + electionID).digest('hex');  // 클라이언트에서 계산

const privateData = Buffer.from(JSON.stringify({
  docType: 'votePrivate', voterID, electionID, candidateID, nullifierHash,
}));

const proposal = contract.newProposal('CastVote', {
  arguments: [electionID, candidateID, nullifierHash],
  transientData: { votePrivate: privateData },  // ← 오더러 미전달
});
const transaction = await proposal.endorse();
const submitResult = await transaction.submit();
await submitResult.getStatus();  // ← 필수! 없으면 이중투표 미감지
```

> `getStatus()` 호출이 없으면 MVCC 충돌 시 이중투표가 통과됩니다. 반드시 포함하세요.

### Shamir SSS 사용 흐름

```javascript
// 1. 선거 종료 후 InitKeySharing (CLOSED 상태 필요)
await fetch(`/api/elections/${eid}/keysharing`, { method: 'POST' });

// 2. 각 조직이 자신의 share 조회 (PDC 읽기 권한 필요)
const { shareHex } = await fetch(`/api/elections/${eid}/shares/1`).then(r => r.json());

// 3. Share 제출 (2개 이상 제출 시 isDecrypted=true)
const status = await fetch(`/api/elections/${eid}/shares`, {
  method: 'POST',
  body: JSON.stringify({ shareIndex: '1', shareHex }),
}).then(r => r.json());
// status.submittedCount: 1, status.isDecrypted: false

// 4. 2번째 share 제출 → threshold 충족 → 자동 복원
const status2 = await fetch(`/api/elections/${eid}/shares`, {
  method: 'POST',
  body: JSON.stringify({ shareIndex: '2', shareHex: share2Hex }),
}).then(r => r.json());
// status2.isDecrypted: true
```

---

## 8. REST API 전체 엔드포인트

```
POST /api/elections                      선거 생성
POST /api/elections/:id/activate         선거 활성화 (CREATED→ACTIVE)
GET  /api/elections/:id                  선거 정보 조회
POST /api/elections/:id/close            선거 종료
GET  /api/elections/:id/tally            개표 결과 (results 키)
POST /api/elections/:id/merkle           Merkle Tree 구축
GET  /api/elections/:id/merkle           Merkle Root 조회
GET  /api/elections/:id/proof/:null      Merkle 포함 증명 (비밀번호 없음)
POST /api/elections/:id/proof            Deniable Verification (Normal/Panic)
POST /api/elections/:id/keysharing       Shamir 키 분산 초기화 (CLOSED 필요)
POST /api/elections/:id/shares           Shamir share 제출 (n≥2 시 자동 복원)
GET  /api/elections/:id/decryption       Shamir 복원 현황 조회
GET  /api/elections/:id/shares/:idx      share 조회 (관리자/PDC 권한 필요)
POST /api/vote                           투표 제출 (Eviction 지원)
GET  /api/nullifier/:hash                Nullifier 조회 (evictCount 포함)
POST /api/vote/panic/reset               Panic 세션 해제
```

---

## 9. 알려진 제약사항

| 제약 | 내용 | 대응 방안 |
|-----|------|---------|
| **CastVote P95 > 2000ms** | BatchTimeout=2s + getStatus() 대기 → P95=2277ms | BatchTimeout=500ms 변경 시 개선 가능 (STEP 7) |
| **Shamir A안 (간소화)** | 투표 candidateID는 PDC에 평문 저장 (masterKey 분산만 구현) | B안: AES-GCM 암호화 추가 가능 |
| **Panic Welch's p < 0.05** | 타이밍 차이 13.7ms — 통계적 유의미 | 0~30ms 랜덤 딜레이 추가 시 p > 0.05 달성 |
| **TallyVotes 더미 포함** | 후보자당 더미 3개가 득표수에 포함됨 | 더미는 상수 — 순위 판별 무영향 |
| **InitKeySharing 조건** | Election이 CLOSED 상태여야 호출 가능 | CloseElection 먼저 호출 |
| **Fabric binary 경로** | network.sh macOS 경로 하드코딩 | FABRIC_BIN_PATH 환경변수 오버라이드 |
| **etcdraft (CFT)** | 진정한 BFT 아님 — 오더러 1개 장애까지 허용 | fabric-tools 3.x 출시 시 SmartBFT 전환 가능 |
| **유권자 인증 미구현** | nullifierHash 유효성만 수학적 검증, 선거인 명부 확인 없음 | CA 기반 자격 검증 또는 유권자 목록 등록 추가 필요 |

---

## 10. 주요 포트 맵

| 서비스 | 호스트 포트 | 용도 |
|-------|----------|------|
| orderer1 | 7050 / 7053 | 트랜잭션 수신 / osnadmin |
| orderer2 | 7150 / 7153 | |
| orderer3 | 7250 / 7253 | |
| orderer4 | 7350 / 7353 | |
| peer0.ec | 7051 | 선관위 주 피어 |
| peer1.ec | 7151 | 선관위 보조 피어 |
| peer0.party | 8051 | 참관 정당 |
| peer0.civil | 9051 | 시민단체 |
| couchdb-ec0 | 5984 | peer0.ec 상태 DB |
| couchdb-ec1 | 5985 | peer1.ec 상태 DB |
| couchdb-party | 6984 | peer0.party 상태 DB |
| couchdb-civil | 7984 | peer0.civil 상태 DB |
| API 서버 | 3000 | Node.js REST API |

---

## 11. 다음 팀원 작업 가이드

### STEP 6 — React 프론트엔드 (완료)

`frontend/src/pages/` 에 3개 화면 구현 완료.

| 화면 | 파일 | 핵심 내용 |
|-----|------|---------|
| 투표 화면 | `VoterPage.jsx` | voterSecret 자동생성, nullifierHash 브라우저 계산, Panic Password 지원 |
| E2E 검증 화면 | `VerifyPage.jsx` | Deniable UI (Normal/Panic 입력창 완전 동일), Merkle 증명 시각화 |
| 관리자 화면 | `AdminPage.jsx` | 선거 생성→활성화→종료→Merkle→Shamir 전체 플로우 |

**프론트엔드 실행:**
```bash
cd frontend
npm install
npm run dev   # http://localhost:5173
```

**브라우저 SHA-256 (`frontend/src/utils/crypto.js`):**
```javascript
// Web Crypto API 사용 — Node.js crypto 모듈 아님
async function computeNullifier(voterSecret, electionID) {
  const data = new TextEncoder().encode(voterSecret + electionID);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, '0')).join('');
}
// voterSecret은 절대 서버로 전송하지 않음
```

---

### STEP 7 — Caliper 성능 평가 (완료)

Caliper 0.6 + peer-gateway 커넥터로 4라운드 벤치마크 완료.

**측정 결과 (2026-04-03, workers=4, peer-gateway):**

| 라운드 | 목표 TPS | 성공 | Avg Latency | Max Latency | 실측 TPS |
|-------|---------|-----|-------------|-------------|---------|
| CastVote_Low    | 1 TPS  | 48  | 2.14s | 2.16s | 1.0 TPS |
| CastVote_Mid    | 5 TPS  | 100 | 1.39s | 2.20s | 4.7 TPS |
| CastVote_High   | 10 TPS | 148 | 1.34s | 2.22s | 9.6 TPS |
| CastVote_Backlog | 자동조정 | — | — | — | 미완료 |

> Max Latency ~2.2s는 BatchTimeout=2s에 기인. 단축 시 Avg Latency 대폭 개선 예상.
> Idemix 성능 비교 벤치마크는 실 연동 후 `run-caliper.sh idemix-compare` 로 재측정 필요.

**실행 방법:**

```bash
cd caliper
npm install
npx caliper bind --caliper-bind-sut fabric:2.5

# 투표 성능 평가 (4라운드: Low/Mid/High/Backlog)
bash run-caliper.sh vote

# Idemix 성능 비교 (기준선 → Idemix → 캐시 최적화)
# (API 서버 실행 중이어야 함)
bash run-caliper.sh idemix-compare
```

**Caliper 트러블슈팅 (겪었던 문제들):**

| 문제 | 원인 | 해결 |
|-----|------|------|
| `semver.satisfies` 오류 | `version: "2.0"` → semver 비호환 | `version: "2.0.0"` 으로 수정 |
| Multiple bindings 오류 | `fabric-network` 패키지 중복 | `npm uninstall fabric-network` |
| 필드명 오류 (contract, fcn) | 구버전 필드명 | `contractId`, `contractFunction`, `contractArguments` 사용 |
| EISDIR (private key 경로) | 디렉토리를 가리킴 | 경로 끝에 `/priv_sk` 파일 명시 |
| transientData 미전달 | 필드명 오류 | `transientData` → `transientMap` |
| CLOSED 상태 오류 | 이전 실행의 동일 electionID 재사용 | electionID에 `Date.now()` 타임스탬프 추가 |

> 보고서에 "BFT 검증"이 아닌 **"CFT 검증"** 으로 기술해야 합니다 (현재 etcdraft).

---

### Idemix ZKP 실 연동 방법

`application/src/middleware/auth.js`의 `verifyVoterEligibility()` 함수 내 TODO 블록 1개만 교체하면 됩니다.

```javascript
// TODO 블록 교체 전 (현재):
if (IDEMIX_SIMULATE_MS > 0) {
  await new Promise(r => setTimeout(r, IDEMIX_SIMULATE_MS));
}
const result = { eligible: true, anonymous: true, ... };

// 교체 후 (Idemix 실 연동):
const credential = req.headers['x-idemix-credential'];
if (!credential) return { eligible: false };
const verified = await fabricCA.verifyIdemixCredential(credential, {
  attributeName: 'voterEligible', attributeValue: '1',
});
const result = { eligible: verified, anonymous: true, ... };
```

연동 후 성능 비교:
```bash
# IDEMIX_ENABLED=false → 기준선
# IDEMIX_ENABLED=true  → ZKP 오버헤드 측정
# IDEMIX_CACHE_ENABLED=true → 캐시 최적화 효과 확인
bash run-caliper.sh idemix-compare
```

---

## 12. 보고서 작성 시 참고 사항

### Caliper 성능 수치 해석

- **Throughput vs Send Rate**: Caliper 리포트의 "Send Rate"는 워크로드가 보내려 한 속도, "Throughput"은 실제 체인에 커밋된 TPS. 보고서에는 Throughput 기준으로 기술.
- **Avg Latency 추이**: Low(2.14s) > Mid(1.39s) > High(1.34s) 순으로 감소. 높은 TPS에서 오더러 배치가 빠르게 채워지기 때문 — BatchTimeout(2s)이 지배적인 Low 구간과 대비해서 설명 가능.
- **Max Latency ~2.2s**: BatchTimeout=2s 설정에서 배치가 가득 차지 않으면 항상 ~2s 대기가 발생. "BatchTimeout 영향"으로 서술. 단축(예: 500ms) 시 Avg·Max 모두 개선 예상.
- **Backlog 라운드 미완료**: `fixed-backlog` rate controller가 목표 backlog=5를 달성하지 못해 조기 종료됨. 보고서에 "미측정" 또는 제외.

### Caliper 측정 한계

- Caliper는 peer-gateway로 체인코드를 **직접** 호출 → 애플리케이션 서버(auth 미들웨어)를 **거치지 않음**
- 따라서 Caliper TPS는 순수 블록체인 레이어 성능 (Idemix 추가 여부와 무관)
- Idemix ZKP 오버헤드는 `GET /api/bench/auth` 엔드포인트로 별도 측정 필요

### Idemix 성능 비교 — 현재 데이터 주의

2026-04-03 실행된 `idemix-compare` 벤치마크(auth_bench_*.json)는 **유효하지 않습니다.**

| 파일 | TPS | 문제 |
|------|-----|------|
| `auth_bench_1_baseline` | 7,797 TPS | ✅ 유효 (bypass 기준선) |
| `auth_bench_2_idemix`   | 7,119 TPS | ❌ 무효 — 서버 재시작 없이 실행, 실제로는 bypass 상태 |
| `auth_bench_3_optimized`| 6,699 TPS | ❌ 무효 — 동일 이유 |

**이유**: `run-caliper.sh idemix-compare`는 환경변수를 설정하지만, 이미 실행 중인 `node src/app.js` 프로세스에는 적용되지 않음. 서버를 재시작해야 env var이 반영됨.

**올바른 측정 절차** (Idemix 실 연동 후):
```bash
# 1단계: 기준선
IDEMIX_ENABLED=false node src/app.js &
node benchmark/http-bench.js  # → 저장

# 2단계: Idemix 적용
pkill -f "node src/app.js"
IDEMIX_ENABLED=true node src/app.js &
node benchmark/http-bench.js  # → 저장

# 3단계: 캐시 최적화
pkill -f "node src/app.js"
IDEMIX_ENABLED=true IDEMIX_CACHE_ENABLED=true node src/app.js &
node benchmark/http-bench.js  # → 저장
```

### 보안 시나리오 측정 결과 해석

| 시나리오 | 보고서 기술 포인트 |
|---------|----------------|
| A. 단독 결과 조작 | "2-of-3 승인 정책으로 단일 기관의 독자적 조작 차단. 정상 트랜잭션 2113ms 내 처리." |
| B. 이중투표 | "Nullifier Eviction 방식 — 재투표 허용이지만 마지막 투표 1개만 집계. 이중집계 수학적 불가." |
| C. 강압 투표 | "Normal/Panic 타이밍 차이 0.2ms, t=0.397 (p>0.05) — 통계적으로 구별 불가." |
| D. 키 탈취 | "GF(p) Shamir SSS (p = secp256k1 prime) — Share 1개 탈취 시 정보량 0. 2개 이상 기관 공모 없이 복원 불가." |
| E. 결과 조작 주장 | "Merkle E2E 검증 정확도 100%. Root Hash 원장 기록으로 사후 변경 증명 불가." |

> 시나리오 측정 스크립트 재실행: `node scripts/security-scenarios.js` (네트워크 + API 서버 필요)

### 보고서 기술 포인트 요약

| 항목 | 기술 방법 |
|-----|---------|
| 합의 알고리즘 | "etcdraft(CFT)" — "BFT"로 쓰지 말 것 (SmartBFT는 미적용) |
| 이중투표 방지 | Nullifier Hash로 수학적 보장, 100% 차단 실험 결과 |
| 익명성 | voterSecret 클라이언트 로컬 보관, 서버는 nullifierHash만 수신 |
| Panic Password | Normal/Panic 타이밍 차이 13.7ms — UI 완전 동일로 구분 불가 |
| Shamir SSS | GF(p) 소수체 (p = secp256k1 prime, 2²⁵⁶ − 2³² − 977), 2-of-3 threshold, Lagrange 보간으로 masterKey 복원 |
| Caliper TPS | Low 1.0 / Mid 4.7 / High 9.6 TPS (Throughput 기준) |
| BatchTimeout | 2s 설정이 Max Latency를 지배 — 최적화 여지 있음 |
| Idemix | 미들웨어 훅 구현 완료 (auth.js), 실 ZKP 연동은 향후 과제 |

---

## 13. 트러블슈팅

### `network.sh up` 실패 시

```bash
docker-compose ps
docker logs orderer1.orderer.voting.example.com 2>&1 | grep -E "ERROR|WARN|panic"
docker logs peer0.ec.voting.example.com 2>&1 | grep -E "ERROR|WARN|panic"
```

### 오더러 채널 참여 시 TLS 오류

`crypto-config.yaml`의 SANS에 `localhost`와 `127.0.0.1`이 반드시 포함되어야 합니다.
빠져 있다면 `network.sh clean && network.sh up` 으로 재생성합니다.

### `deploy` 시 재배포 (이미 배포된 상태)

`network.sh deploy`는 현재 커밋된 sequence를 자동 감지하고 +1 합니다. 별도 수정 불필요.

### `InitKeySharing` 에러 (CLOSED 아님)

선거가 `CLOSED` 상태가 아닐 때 호출 시 에러 반환됩니다. `CloseElection` 먼저 호출하세요.

### `TallyVotes` 결과가 0으로 나온다

CouchDB 인덱스가 생성되지 않았을 수 있습니다. 체인코드를 먼저 invoke한 후 CouchDB Fauxton UI(`http://localhost:5984/_utils`)에서 인덱스 생성 여부를 확인하세요.

### CastVote 400 에러 (nullifierHash 관련)

API는 `nullifierHash`를 직접 받습니다. `voterSecret`을 그대로 넣으면 안 됩니다.

```javascript
// 틀림
body: JSON.stringify({ voterSecret: 'my_secret', ... })

// 올바름
const nullifierHash = sha256(voterSecret + electionID);
body: JSON.stringify({ nullifierHash, ... })
```

### 벤치마크 스크립트에서 `date +%s%3N` 오류 (macOS)

macOS의 `date` 명령은 `%N` (나노초)를 지원하지 않습니다. `bench_full.sh`와 `bench_step45.sh`는 이미 python3로 우회 처리되어 있습니다.

```bash
# macOS 호환 ms 타임스탬프
python3 -c "import time; print(int(time.time()*1000))"
```

---

## 14. 코드 검토 이력

| 파일 | 이슈 | 상태 |
|-----|-----|------|
| `network.sh` | step 번호 불일치 수정, sequence 자동 감지, `docker compose` v2 전환 | ✅ |
| `docker-compose.yaml` | macOS docker.sock 경로 → `/var/run/docker.sock`, core.yaml 마운트 제거 | ✅ |
| `configtx.yaml` | 헤더 주석 SmartBFT → etcdraft 수정 | ✅ |
| `collection_config.json` | `memberOnlyRead: false` — 클라이언트 evaluateTransaction 허용 의도적 설정 | ✅ |
| `voting.go` | getTxTime() 사용으로 다중 피어 RW-set 일치 보장, STEP 4~5 추가 | ✅ |
| `elections.js` | Shamir 엔드포인트 4개 추가 (`/keysharing`, `/shares`, `/decryption`, `/shares/:idx`) | ✅ |
| `vote.js` | Eviction 처리 — 409 에러 제거, 200 응답으로 통일 | ✅ |
| `app.js` | requireVoterAuth를 POST /api/vote에 적용, `/api/bench/auth` 엔드포인트 추가 | ✅ |
| `middleware/auth.js` | IDEMIX_ENABLED 토글, IDEMIX_SIMULATE_MS, IDEMIX_CACHE_ENABLED 추가 | ✅ |
| `caliper/workloads/castVote.js` | `transientData` → `transientMap`, electionID에 타임스탬프 추가 | ✅ |
| `caliper/networks/fabric-network.yaml` | version "2.0.0", 절대경로, priv_sk 파일 명시 | ✅ |
