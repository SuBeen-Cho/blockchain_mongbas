# 프로젝트 인수인계 문서 — BFT 기반 익명 전자투표 블록체인

> 최초 작성: 2026-03-27 | **최종 업데이트: 2026-03-30**
> 대상: 다음 팀원 또는 이 문서를 처음 보는 사람 기준
>
> **2026-03-30 업데이트:** STEP 1~5 전체 구현 완료. Nullifier Eviction + Shamir SSS 추가. 체인코드 sequence 9.

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
| Shamir's Secret Sharing (n=2/m=3) | ✅ | GF(257), Lagrange 복원, threshold 검증 |
| STEP 4~5 성능 평가 (100·50회 반복) | ✅ | docs/performance/ 참조 |
| Shamir REST API 엔드포인트 추가 | ✅ | /keysharing, /shares, /decryption |

### 남은 것

| 항목 | 우선순위 |
|-----|---------|
| STEP 6: React 프론트엔드 (투표 UI, Deniable UI, 관리자 화면) | 높음 |
| STEP 7: Hyperledger Caliper 종합 성능 평가 (TPS, BatchTimeout 최적화) | 높음 |
| Idemix ZKP 연동 | 낮음 (선택 사항) |

---

## 2. 프로젝트 구조

```
mongbas/
├── network/
│   ├── crypto-config.yaml        ← 인증서 생성 설정 (cryptogen)
│   ├── configtx.yaml             ← 채널·제네시스 블록 설정
│   ├── docker-compose.yaml       ← 컨테이너 정의
│   ├── channel-artifacts/
│   │   └── genesis.block
│   ├── crypto-config/            ← 생성된 인증서 (gitignore 권장)
│   └── scripts/
│       └── network.sh            ← 네트워크 전체 관리 스크립트
├── chaincode/
│   └── voting/
│       ├── voting.go             ← 체인코드 (STEP 1~5 전체, sequence 9)
│       ├── go.mod / go.sum
│       ├── collection_config.json  ← PDC 설정
│       └── META-INF/statedb/couchdb/indexes/
│           └── indexElection.json  ← CouchDB 인덱스
├── application/
│   └── src/
│       ├── app.js                ← Express 서버
│       ├── gateway.js            ← Fabric Gateway 연결
│       └── routes/
│           ├── elections.js      ← 선거 CRUD + Merkle + Proof + Shamir
│           └── vote.js           ← 투표 + Nullifier + Eviction + Panic
├── docs/
│   ├── PROGRESS.md
│   ├── HANDOFF.md                ← 현재 파일
│   └── performance/
│       ├── PERF-SUMMARY.md       ← 전체 성능 평가 종합
│       ├── PERF-STEP1~5.md       ← 단계별 상세 결과
│       └── bench_results/        ← 원시 측정값
├── scripts/
│   ├── bench_full.sh             ← STEP 1~3 벤치마크
│   └── bench_step45.sh           ← STEP 4~5 벤치마크
├── 20260330_진행사항보고.md
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

### STEP 6 — React 프론트엔드

**구현 화면 목록:**

| 화면 | 핵심 구현 포인트 |
|-----|--------------|
| 투표 화면 | `nullifierHash = SHA256(voterSecret + electionID)` 브라우저에서 계산. voterSecret은 로컬 저장, 서버 미전송 |
| E2E 검증 화면 | Deniable UI: Normal/Panic 입력창 완전 동일하게 구성 (강압자가 화면만으로 구분 불가) |
| 관리자 화면 | 선거 생성→활성화→종료 플로우, BuildMerkleTree, InitKeySharing, share 제출 UI |
| 결과 화면 | 득표 시각화, Shamir 복원 현황 (submittedCount/threshold 표시) |

**Deniable UI 구현 요령:**

```jsx
// 비밀번호 입력 하나로 Normal/Panic 분기 — UI는 완전히 동일해야 함
const handleVerify = async (password) => {
  const passwordHash = sha256(password);
  const response = await fetch(`/api/elections/${eid}/proof`, {
    method: 'POST',
    body: JSON.stringify({ nullifierHash, passwordHash }),
  });
  // 서버가 Normal/Panic 분기 → 프론트는 분기 여부를 알 수 없음
  const proof = await response.json();
  setProofResult(proof);  // 어떤 모드든 동일한 UI로 표시
};
```

**nullifierHash 클라이언트 계산:**

```javascript
import { createHash } from 'crypto';  // 또는 브라우저용 SubtleCrypto

const nullifierHash = createHash('sha256')
  .update(voterSecret + electionID)
  .digest('hex');
// voterSecret은 절대 API 요청에 포함하지 않음
```

---

### STEP 7 — Caliper 종합 성능 평가

**측정 목표:**

| 측정 항목 | 방법 | 목표 |
|---------|------|------|
| TPS (Throughput) | 동시 10명 병렬 투표 | ≥ 10 TPS |
| Latency (P50/P95/P99) | Caliper 공식 측정 | P95 < 3000ms |
| Fault Injection | orderer 1개 강제 종료 | 서비스 중단 없음 (CFT 검증) |
| BatchTimeout 최적화 | 2s → 500ms 변경 비교 | P50 < 1000ms 예상 |

**Fault Injection 방법:**

```bash
# orderer 1개 강제 종료
docker stop orderer1.orderer.voting.example.com

# 나머지 3개로 투표 정상 작동 확인
./scripts/network.sh test

# 복구
docker start orderer1.orderer.voting.example.com
```

> 보고서에 "BFT 검증"이 아닌 **"CFT 검증"** 으로 기술해야 합니다 (현재 etcdraft).

**Caliper 설치:**

```bash
npm install -g @hyperledger/caliper-cli
caliper bind --caliper-bind-sut fabric:2.4

caliper launch manager \
  --caliper-workspace ./caliper \
  --caliper-networkconfig network-config.yaml \
  --caliper-benchconfig benchmark.yaml
```

---

## 12. 트러블슈팅

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

## 13. 코드 검토 이력

| 파일 | 이슈 | 상태 |
|-----|-----|------|
| `network.sh` | step 번호 불일치 수정, sequence 자동 감지 추가 | ✅ |
| `configtx.yaml` | 헤더 주석 SmartBFT → etcdraft 수정 | ✅ |
| `collection_config.json` | `memberOnlyRead: false` — 클라이언트 evaluateTransaction 허용 의도적 설정 | ✅ |
| `voting.go` | getTxTime() 사용으로 다중 피어 RW-set 일치 보장, STEP 4~5 추가 | ✅ |
| `elections.js` | Shamir 엔드포인트 4개 추가 (`/keysharing`, `/shares`, `/decryption`, `/shares/:idx`) | ✅ |
| `vote.js` | Eviction 처리 — 409 에러 제거, 200 응답으로 통일 | ✅ |
