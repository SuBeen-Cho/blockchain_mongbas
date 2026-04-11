# 팀 몽바스 — BFT 기반 익명 전자투표 블록체인 시스템

> **최종 업데이트: 2026-04-03** (전체 구현 완료 — 네트워크·체인코드·백엔드·프론트엔드·Caliper 성능평가)
> Hyperledger Fabric 기반 | 다중 기관 합의 | Nullifier 익명 투표 | Shamir SSS | Panic Password

---

## 1. 프로젝트 개요

### 문제 정의

기존 전자투표 시스템은 중앙 서버에 의존하여 **단일 기관에 의한 조작 가능성**과 **유권자 익명성 침해** 위험이 존재합니다.
또한 E2E 검증을 위한 증명 데이터가 강압 증거로 악용되는 **"검증의 역설"** 문제가 있습니다.

### 목표

Hyperledger Fabric 블록체인을 활용하여:
- **단일 기관 조작 불가** — 3개 독립 기관 중 2개 이상 동의해야 트랜잭션 유효
- **완전한 익명성** — 투표 사실은 증명 가능하되 누가 투표했는지는 알 수 없음
- **이중투표 원천 차단** — Nullifier 해시로 수학적으로 보장
- **강압 상황 대응** — Panic Password (부인 가능 인증): 강압자에게 가짜 Merkle 증명 제공
- **분산 집계** — Shamir SSS: 단일 관리자 없이 n-of-m 기관 합의로 결과 복원

---

## 2. 시스템 아키텍처

### 네트워크 구성

```
┌──────────────────────────────────────────────────────────┐
│                   Ordering Service                        │
│   orderer1:7050  orderer2:7150  orderer3:7250  orderer4:7350  │
│              etcdraft 합의 (4-node, CFT)                  │
└──────────────────────────────────────────────────────────┘
                          │
          ┌───────────────┼───────────────┐
          ▼               ▼               ▼
┌─────────────────┐ ┌──────────────┐ ┌──────────────┐
│ 선거관리위원회   │ │  참관 정당    │ │   시민단체    │
│ ElectionCommission│ │ PartyObserver│ │ CivilSociety │
│ peer0.ec :7051  │ │peer0.party   │ │peer0.civil   │
│ peer1.ec :7151  │ │      :8051   │ │      :9051   │
│ CouchDB0 :5984  │ │ CouchDB :6984│ │CouchDB :7984 │
│ CouchDB1 :5985  │ └──────────────┘ └──────────────┘
└─────────────────┘
```

### 핵심 보안 설계 — 2-of-3 승인 정책

```
트랜잭션 유효 조건:
  OutOf(2, '선거관리위원회.peer', '참관정당.peer', '시민단체.peer')

→ 선관위가 단독으로 결과를 조작할 수 없음
→ 어느 2개 기관이 서명해도 트랜잭션 성립
→ 3개 기관이 모두 담합하지 않는 한 무결성 보장
```

### 익명 투표 흐름 (Nullifier + PDC)

```
유권자 브라우저
  │
  ├─ voterSecret  (로컬 보관, 절대 서버 전송 안 함)
  │
  └─ nullifierHash = SHA256(voterSecret + electionID)
          │
          ▼ CastVote 호출
          │
          ├─→ [공개 원장]  Nullifier { nullifierHash, candidateID, evictCount }
          │      ↑ 누가 투표했는지 알 수 없음 (해시만 저장)
          │      ↑ 재투표 시 덮어쓰기 (Eviction) 지원
          │
          └─→ [PDC: VotePrivateCollection]  VotePrivate { voterID, ... }
                 ↑ 오더러에게 전달되지 않음
                 ↑ 피어의 비공개 사이드DB에만 저장
                 ↑ Shamir share도 여기에 저장
```

---

## 3. 구현 완료 현황

### 전체 진행률

| 영역 | 항목 | 상태 |
|-----|-----|------|
| **네트워크** | crypto-config.yaml (3조직 + 4오더러 인증서) | ✅ |
| **네트워크** | configtx.yaml (채널·제네시스 블록, 2-of-3 정책) | ✅ |
| **네트워크** | docker-compose.yaml + network.sh 자동화 | ✅ |
| **체인코드** | CreateElection / ActivateElection / CastVote | ✅ |
| **체인코드** | CloseElection / TallyVotes / GetTally | ✅ |
| **체인코드** | BuildMerkleTree / GetMerkleProof / GetMerkleRoot | ✅ |
| **체인코드** | GetMerkleProofWithPassword (Normal/Panic) | ✅ |
| **체인코드** | CastVote Eviction 모드 (EvictCount 추적) | ✅ |
| **체인코드** | InitKeySharing / SubmitKeyShare (Shamir SSS) | ✅ |
| **백엔드** | Node.js REST API (전체 엔드포인트) | ✅ 완료 (200회 벤치마크) |
| **보안** | Panic Password / Deniable Verification | ✅ 완료 (200회 벤치마크) |
| **보안** | Nullifier Eviction (재투표 지원) | ✅ 완료 (100회 벤치마크) |
| **보안** | Shamir SSS n=2/m=3 분산 집계 | ✅ 완료 (50회 벤치마크) |
| **보안** | Idemix ZKP 미들웨어 훅 (`middleware/auth.js`) | ✅ 훅 구현 완료 (실 연동 예정) |
| **프론트엔드** | React 투표 UI (Voter / Admin / Verify) | ✅ 완료 |
| **검증** | Caliper 성능 측정 (TPS / Latency / Backlog) | ✅ 4라운드 완료 |

---

## 4. 핵심 구현 내용

### 4-1. 체인코드 함수

| 함수 | 접근 | 설명 |
|-----|------|------|
| `InitLedger` | 관리자 | 시연용 선거 데이터 초기화 |
| `CreateElection` | 관리자 | 선거 생성 + 더미 Nullifier 3개/후보 자동 생성 |
| `ActivateElection` | 관리자 | CREATED → ACTIVE 상태 전환 |
| `CastVote` | 유권자 | 익명 투표 — Nullifier(덮어쓰기 지원) + PDC + 비밀번호 저장 |
| `CloseElection` | 관리자 | 선거 종료 + 자동 집계 |
| `TallyVotes` | 관리자 | CouchDB Rich Query 득표 집계 |
| `GetTally` | 누구나 | 개표 결과 조회 |
| `BuildMerkleTree` | 관리자 | Merkle Tree 구축, Root Hash 원장 저장 |
| `GetMerkleProof` | 누구나 | Merkle 포함 증명 (E2E 검증) |
| `GetMerkleProofWithPassword` | 유권자 | Deniable Verification (Normal/Panic 분기) |
| `InitKeySharing` | 관리자 | masterKey 생성 → Shamir 3분할 → PDC 저장 |
| `SubmitKeyShare` | 기관 | share 제출 → n≥2 시 Lagrange 복원 검증 |
| `GetKeyDecryptionStatus` | 누구나 | Shamir 복원 현황 조회 |

### 4-2. REST API 엔드포인트

```
POST /api/elections                    선거 생성
POST /api/elections/:id/activate       선거 활성화 (CREATED→ACTIVE)
GET  /api/elections/:id                선거 정보 조회
POST /api/elections/:id/close          선거 종료
GET  /api/elections/:id/tally          개표 결과
POST /api/elections/:id/merkle         Merkle Tree 구축
GET  /api/elections/:id/merkle         Merkle Root 조회
GET  /api/elections/:id/proof/:null    Merkle 포함 증명
POST /api/elections/:id/proof          Deniable Verification (Normal/Panic)
POST /api/elections/:id/keysharing     Shamir 키 분산 초기화 (CLOSED 후)
POST /api/elections/:id/shares         Shamir share 제출 (n≥2 시 자동 복원)
GET  /api/elections/:id/decryption     복원 현황 조회
POST /api/vote                         투표 제출 (Idemix 인증 미들웨어 + PDC + Eviction)
GET  /api/nullifier/:hash              Nullifier 확인 (evictCount 포함)
GET  /api/bench/auth                   Idemix 인증 레이턴시 측정 (벤치마크 전용)
GET  /health                           서버 상태 + Idemix 설정 확인
```

### 4-3. Shamir SSS 수학적 근거

```
소수체: GF(257)  (p=257 > 255, 모든 바이트값 수용)
다항식: f(x) = masterKey[i] + coeff[i]·x  mod 257  (degree-1, threshold=2)

share 생성:  share_j[i] = f(j)  for j=1,2,3
복원 (x=0):  f(0) = 2·y₁ + 256·y₂  mod 257  (Lagrange 보간)
검증:        SHA256(복원된 masterKey) == 원장의 keyHash
```

---

## 5. 성능 평가 결과

> 전체 상세: [docs/performance/PERF-SUMMARY.md](./docs/performance/PERF-SUMMARY.md)

### 5-1. Hyperledger Caliper — CastVote TPS 벤치마크

> 측정 환경: Caliper 0.6 / peer-gateway 커넥터 / workers 4 / 2026-04-03

| 라운드 | 목표 TPS | 성공 건수 | 실패 | Avg Latency | Max Latency | 실측 TPS |
|-------|---------|---------|-----|-------------|-------------|---------|
| CastVote_Low    | 1 TPS  | 48  | 0 | 2.14s | 2.16s | **1.0 TPS** |
| CastVote_Mid    | 5 TPS  | 100 | 0 | 1.39s | 2.20s | **4.7 TPS** |
| CastVote_High   | 10 TPS | 148 | 0 | 1.34s | 2.22s | **9.6 TPS** |

**분석:**
- 목표 TPS 달성률: Low 91%, Mid 94%, High 96% — 부하 증가 시 달성률 개선
- Avg Latency가 Mid·High에서 낮아지는 이유: 높은 TPS에서 배치가 빨리 채워져 BatchTimeout 대기 감소
- Max Latency ~2.2s는 BatchTimeout=2s 설정에 기인 → BatchTimeout 단축 시 개선 가능

### 5-2. 체인코드 함수 Latency (scripts/bench_full.sh, bench_step45.sh)

| 연산 | 샘플 | 평균 | P95 | 판정 |
|------|------|------|-----|------|
| CastVote (신규) | 200회 | 2184.8ms | 2277ms | ❌ BatchTimeout (P95 목표 초과) |
| 재투표 Eviction | 100회 | 2198.0ms | 2257ms | ✅ CastVote 대비 +13ms |
| InitKeySharing | 50회 | 2258.4ms | 2363ms | ✅ CastVote 대비 +74ms |
| GetMerkleProof (N=100) | 200회 | 112.7ms | 172ms | ✅ |
| Normal/Panic Proof | 200회 | 112.6 / 98.8ms | 191 / 111ms | ✅ |

### 5-3. 보안 위협 시나리오 측정 (2026-04-11)

> 전체 상세: [docs/security-eval/SECURITY-SCENARIOS.md](./docs/security-eval/SECURITY-SCENARIOS.md)

| 시나리오 | 핵심 수치 | 판정 |
|---------|---------|------|
| A. 선관위 단독 결과 조작 | 2-of-3 정책, 정상 트랜잭션 2113ms | ✅ |
| B. 이중투표 시도 | 1차 100% 성공, Eviction 100% 처리, Avg 2082ms | ✅ |
| C. 강압 투표 (Panic) | Normal/Panic 차이 **0.2ms**, t=0.397 (p>0.05) | ✅ |
| D. 집계 키 단독 탈취 | 1-share 복원 실패 **100%**, 2-share 성공 **100%** | ✅ |
| E. "결과 조작" 외부 주장 | Merkle 포함/배제 정확도 **100%/100%**, 평균 73.6ms | ✅ |

### 5-4. 정확도 / 보안 (스크립트 벤치마크)

| 지표 | 결과 |
|------|------|
| 이중투표 차단 | 100/100 = **100%** ✅ |
| Eviction 집계 정확도 | 20/20 = **100%** ✅ |
| Panic 타이밍 차이 | **13.7ms** (< 100ms) ✅ |
| Shamir threshold 정확도 | 30/30 = **100%** ✅ |
| Shamir 타이밍 차이 | **22.4ms** (부채널 저항) ✅ |

---

## 6. 향후 계획

| 순서 | 항목 | 핵심 내용 | 상태 |
|-----|-----|---------|------|
| ~~1~~ | ~~Node.js 백엔드 API~~ | — | ✅ 200회 벤치마크 |
| ~~2~~ | ~~Merkle Tree~~ | — | ✅ 200회 벤치마크 |
| ~~3~~ | ~~Panic Password~~ | — | ✅ 200회 벤치마크 |
| ~~4~~ | ~~Nullifier Eviction~~ | — | ✅ 100회 벤치마크 |
| ~~5~~ | ~~Shamir's Secret Sharing~~ | — | ✅ 50회 벤치마크 |
| ~~6~~ | ~~React 프론트엔드~~ | 투표 UI, Deniable UI, 관리자 화면 | ✅ 완료 |
| ~~7~~ | ~~Caliper 성능 측정~~ | TPS / Latency, 4라운드 벤치마크 | ✅ 완료 |
| (선택) | Idemix ZKP 실 연동 | `middleware/auth.js` 훅 교체만 필요 | 🔲 예정 |

---

## 7. 실행 방법

### 7-0. 처음 받는 경우 — 전체 세팅 순서

> git에 포함되지 않는 항목들은 아래 단계에서 자동 생성됩니다.

| 항목 | git 포함 여부 | 생성 방법 |
|------|-------------|----------|
| `fabric-samples/` (Fabric 바이너리) | ❌ | 아래 1단계 |
| `network/crypto-config/` (인증서·개인키) | ❌ | `network.sh up` 자동 생성 |
| `network/channel-artifacts/` (제네시스 블록) | ❌ | `network.sh up` 자동 생성 |
| `application/node_modules/` | ❌ | `npm install` |
| `chaincode/voting/vendor/` (Go 의존성) | ✅ | 별도 설치 불필요 |

```bash
# 1. 저장소 클론
git clone https://github.com/SuBeen-Cho/blockchain_mongbas.git
cd blockchain_mongbas

# 2. Fabric 바이너리 설치 (cryptogen, peer, orderer 등 포함, ~280MB)
curl -sSL https://bit.ly/2ysbOFE | bash -s -- 2.5.0 1.5.7
# → fabric-samples/ 디렉토리 생성됨

# 3. 네트워크 기동 (crypto-config, channel-artifacts 자동 생성)
cd network
./scripts/network.sh up
# → network/crypto-config/ 자동 생성 (cryptogen)
# → network/channel-artifacts/ 자동 생성 (configtxgen)

# 4. 체인코드 배포
./scripts/network.sh deploy

# 5. Node.js 의존성 설치
cd ../application && npm install

# 6. API 서버 기동
npm start   # http://localhost:3000
```

> **crypto-config.zip은 필요 없습니다.** 인증서는 `network.sh up`으로 각자 환경에서 새로 생성합니다.

---

### 7-1. 이미 세팅된 경우 — 일반 실행

```bash
cd network/

# 1. 네트워크 기동
./scripts/network.sh up

# 2. 체인코드 배포 (sequence 자동 감지, 현재 9)
./scripts/network.sh deploy

# 3. 동작 확인
./scripts/network.sh test

# 종료
./scripts/network.sh down
```

```bash
# API 서버
cd application && npm start   # http://localhost:3000

# 벤치마크
bash scripts/bench_full.sh      # STEP 1~3
bash scripts/bench_step45.sh    # STEP 4~5
```

---

## 8. 기술 스택

| 레이어 | 기술 |
|-------|------|
| 블록체인 네트워크 | Hyperledger Fabric 2.5 |
| 합의 알고리즘 | etcdraft (4-node, CFT) |
| 상태 DB | CouchDB 3.4 |
| 체인코드 | Go 1.21 + fabric-contract-api-go |
| 컨테이너 | Docker + docker compose v2 |
| 백엔드 | Node.js + @hyperledger/fabric-gateway v1.7.1 |
| 프론트엔드 | React + Vite + Tailwind CSS |
| 성능 측정 | Hyperledger Caliper 0.6 (peer-gateway 커넥터) |
| 암호학 | SHA-256, GF(257) Shamir SSS, Merkle Tree |
| 인증 (예정) | Idemix ZKP — 훅 구현 완료, 실 연동 예정 |

---

> 진행 현황 상세: [docs/PROGRESS.md](./docs/PROGRESS.md)
> 성능 평가 종합: [docs/performance/PERF-SUMMARY.md](./docs/performance/PERF-SUMMARY.md)
> 개발자 인계 문서: [HANDOFF.md](./HANDOFF.md)
