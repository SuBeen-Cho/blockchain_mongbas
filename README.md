# 팀 몽바스 — BFT 기반 익명 전자투표 블록체인 시스템

> **최종 업데이트: 2026-03-30** (STEP 1~5 완료, 전 단계 성능 평가 완료)
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
| **보안** | Idemix ZKP 익명 자격증명 | 🔲 선택 사항 |
| **프론트엔드** | React 투표 UI | 🔲 미착수 (STEP 6) |
| **검증** | Caliper 성능 측정 (TPS / Latency) | 🔲 미착수 (STEP 7) |

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
POST /api/vote                         투표 제출 (PDC + Transient + Eviction)
GET  /api/nullifier/:hash              Nullifier 확인 (evictCount 포함)
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

### Latency 요약

| 연산 | 샘플 | 평균 | P95 | 판정 |
|------|------|------|-----|------|
| CastVote (신규) | 200회 | 2184.8ms | 2277ms | ❌ BatchTimeout(P95 목표 초과) |
| 재투표 Eviction | 100회 | 2198.0ms | 2257ms | ✅ CastVote 대비 +13ms |
| InitKeySharing | 50회 | 2258.4ms | 2363ms | ✅ CastVote 대비 +74ms |
| GetMerkleProof (N=100) | 200회 | 112.7ms | 172ms | ✅ |
| Normal/Panic Proof | 200회 | 112.6 / 98.8ms | 191 / 111ms | ✅ |

### 정확도 / 보안

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
| **6** | **React 프론트엔드** | 투표 UI, Deniable UI, 관리자 화면 | 🔲 미착수 |
| **7** | **Caliper 성능 측정** | TPS / Latency, BatchTimeout 최적화 | 🔲 미착수 |
| (선택) | Idemix ZKP | Fabric CA 연동, 익명 자격증명 | 🔲 선택 |

---

## 7. 실행 방법

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
cd application && npm install && npm start   # http://localhost:3000

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
| 컨테이너 | Docker / docker-compose |
| 백엔드 | Node.js + @hyperledger/fabric-gateway v1.7.1 |
| 프론트엔드 (예정) | React.js |
| 암호학 | SHA-256, GF(257) Shamir SSS, Merkle Tree |

---

> 진행 현황 상세: [docs/PROGRESS.md](./docs/PROGRESS.md)
> 성능 평가 종합: [docs/performance/PERF-SUMMARY.md](./docs/performance/PERF-SUMMARY.md)
> 개발자 인계 문서: [HANDOFF.md](./HANDOFF.md)
