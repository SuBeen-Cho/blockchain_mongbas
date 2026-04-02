# Hyperledger Fabric 기반
# 전자투표 시스템 제안서
# **4주차 진행 보고서**

블록체인(하이퍼레저 패브릭)기반 전자투표 구현 및 검증가능성 구현
(유권자 프라이버시(비밀투표)와 강한 검증가능성(E2E verifiability) 측면에서)

---

| 제출일 | 2026.03.28 (토) | 팀장 | 2394025 조수빈 |
|--------|-----------------|------|----------------|
| 과목 | 융합보안 캡스톤 디자인 | 팀원 | 2394043 정윤녕 |
| 지도교수 | 서화정 교수님 | 팀원 | 2394048 윤서현 |

---

## [ 목차 ]

1. 이번 주 진행 요약
2. 구현 완료 현황
3. 주요 구현 내용
   - I. 블록체인 네트워크 구축
   - II. 체인코드 (스마트 컨트랙트)
   - III. 보안 메커니즘
   - IV. 백엔드 API 서버
4. 성능 측정 결과
5. 원래 일정 대비 진행률
6. 향후 계획 수정안

---

## 1. 이번 주 진행 요약

3주차 보고서에서 **3월 4주차 목표**는 "기술 스택 구축 및 피드백 반영"이었습니다.

이번 주에는 목표를 크게 초과하여, 당초 **4월 3주차까지 계획**했던 네트워크 구축, 체인코드 개발, 백엔드 API 서버, 그리고 핵심 보안 기능(Panic Password, Shamir SSS, Merkle Tree)까지 **전부 구현하고 실제 동작 검증**을 완료했습니다.

**이번 주 완료 항목:**

| # | 항목 | 결과 |
|---|------|------|
| 1 | Hyperledger Fabric 네트워크 완전 구축 및 실행 | ✅ 완료 |
| 2 | 체인코드 전 함수 구현 + 배포 + 테스트 | ✅ 완료 |
| 3 | Nullifier + PDC 익명 투표 로직 | ✅ 완료 |
| 4 | Merkle Tree + E2E 검증 | ✅ 완료 |
| 5 | Panic Password (Deniable Verification) | ✅ 완료 |
| 6 | Shamir's Secret Sharing 분산 집계 | ✅ 완료 |
| 7 | Node.js REST API 서버 (14개 엔드포인트) | ✅ 완료 |
| 8 | 전 기능 성능 벤치마크 (총 750회 샘플) | ✅ 완료 |

---

## 2. 구현 완료 현황

| 영역 | 항목 | 상태 |
|------|------|------|
| **네트워크** | crypto-config.yaml (3조직 + 4오더러 인증서 구조) | ✅ |
| **네트워크** | configtx.yaml (채널·제네시스 블록, 2-of-3 승인 정책) | ✅ |
| **네트워크** | docker-compose.yaml + network.sh 자동화 스크립트 | ✅ |
| **체인코드** | CreateElection / ActivateElection / CastVote | ✅ |
| **체인코드** | CloseElection / TallyVotes / GetTally | ✅ |
| **체인코드** | BuildMerkleTree / GetMerkleProof / GetMerkleRoot | ✅ |
| **체인코드** | GetMerkleProofWithPassword (Normal/Panic 분기) | ✅ |
| **체인코드** | CastVote Eviction 모드 (재투표 + EvictCount 추적) | ✅ |
| **체인코드** | InitKeySharing / SubmitKeyShare (Shamir SSS) | ✅ |
| **백엔드** | Node.js REST API 서버 (전체 엔드포인트) | ✅ |
| **보안** | Panic Password / Deniable Verification | ✅ |
| **보안** | Nullifier Eviction (재투표 지원) | ✅ |
| **보안** | Shamir SSS n=2/m=3 분산 집계 | ✅ |
| **보안** | Idemix ZKP 익명 자격증명 | 🔲 선택 사항 |
| **프론트엔드** | React 투표 UI | 🔲 미착수 |
| **검증** | Caliper 공식 성능 측정 (TPS / Latency) | 🔲 미착수 |

---

## 3. 주요 구현 내용

### I. 블록체인 네트워크 구축

3주차 보고서에서 제안한 아키텍처를 그대로 구현했습니다.

**네트워크 구성:**

```
┌─────────────────────────────────────────────────────┐
│                   Ordering Service                   │
│  orderer1:7050  orderer2:7150  orderer3:7250  orderer4:7350 │
│             etcdraft 합의 (4-node, CFT)              │
└─────────────────────────────────────────────────────┘
                         │
         ┌───────────────┼───────────────┐
         ▼               ▼               ▼
  선거관리위원회      참관 정당        시민단체
  (peer0, peer1)    (peer0)          (peer0)
  CouchDB x2        CouchDB          CouchDB
```

- **합의 알고리즘**: etcdraft (4-node CFT)
  - SmartBFT는 현재 Fabric 2.5에서 안정 이미지 미제공으로 etcdraft 채택
  - 4개 오더러 중 2개 이상 정상이면 합의 유지 (CFT 보장)
- **2-of-3 승인 정책**: `OutOf(2, EC.peer, Party.peer, Civil.peer)`
  - 선관위 단독으로 결과 조작 불가
  - 어느 2개 기관이 서명해도 트랜잭션 유효
- **Channel Participation API**: 제네시스 블록 없이 `osnadmin channel join`으로 오더러 참여
- **CouchDB + Rich Query**: 득표 집계 시 `selector` 기반 복합 쿼리 + 인덱스 적용

---

### II. 체인코드 (스마트 컨트랙트)

총 **13개 함수** 구현, Go 언어로 작성:

| 함수 | 접근 | 설명 |
|------|------|------|
| `InitLedger` | 관리자 | 시연용 선거 데이터 초기화 |
| `CreateElection` | 관리자 | 선거 생성 + 더미 Nullifier 자동 생성 (익명성 강화) |
| `ActivateElection` | 관리자 | CREATED → ACTIVE 상태 전환 |
| `CastVote` | 유권자 | 익명 투표 (Nullifier + PDC + Eviction) |
| `CloseElection` | 관리자 | 선거 종료 + 자동 집계 |
| `TallyVotes` | 관리자 | CouchDB Rich Query 득표 집계 |
| `GetTally` | 누구나 | 개표 결과 조회 |
| `BuildMerkleTree` | 관리자 | Merkle Tree 구축, Root Hash 원장 저장 |
| `GetMerkleProof` | 누구나 | Merkle 포함 증명 (E2E 검증) |
| `GetMerkleProofWithPassword` | 유권자 | **Deniable Verification** (Normal/Panic 분기) |
| `InitKeySharing` | 관리자 | masterKey 생성 → Shamir 3분할 → PDC 저장 |
| `SubmitKeyShare` | 기관 | share 제출 → n≥2 시 Lagrange 복원 검증 |
| `GetKeyDecryptionStatus` | 누구나 | Shamir 복원 현황 조회 |

**핵심 설계 원칙**: `getTxTimestamp()` 사용 → 여러 보증 피어가 동일한 RW-set 생성 보장
(time.Now() 사용 시 피어마다 시간 달라져 트랜잭션 무효화 문제 회피)

---

### III. 보안 메커니즘

#### 3-1. Nullifier 기반 익명 투표

```
nullifierHash = SHA256(voterSecret + electionID)

[공개 원장] Nullifier { nullifierHash, candidateID, evictCount }
           ↑ 누가 투표했는지 알 수 없음 (해시만 저장)

[PDC: VotePrivateCollection] VotePrivate { voterID, panicPassword, ... }
           ↑ 오더러에 전달되지 않음 (Transient Data)
           ↑ 피어의 비공개 사이드DB에만 저장
```

- 이중투표 차단: nullifierHash 존재 여부로 검증 (100% 정확도 확인)
- Eviction 지원: 재투표 시 기존 Nullifier 덮어쓰기 + evictCount 증가

#### 3-2. Panic Password (Deniable Verification)

강압 상황에서 유권자 보호:

```
유권자 설정:
  normalPassword → 실제 투표 Merkle 증명 반환
  panicPassword  → 조작된 가짜 Merkle 증명 반환 (다른 후보 지지한 것처럼)

강압자가 panicPassword로 검증 → "A에 투표했다"는 가짜 증명 확인
실제 투표는 B였지만, 시스템은 강압자의 검증을 조용히 기각
```

- Normal/Panic 분기 타이밍 차이: **13.7ms** (100ms 기준 이하, 타이밍 공격 방어)

#### 3-3. Shamir's Secret Sharing (분산 집계)

단일 관리자 없이 n-of-m 기관 합의로 개표 마스터키 복원:

```
소수체:  GF(257)  (p=257 > 255, 모든 바이트값 수용)
다항식:  f(x) = masterKey[i] + coeff[i]·x  mod 257  (threshold=2)

share 생성: share_j[i] = f(j)  for j = 1, 2, 3
복원 (x=0): f(0) = 2·y₁ + 256·y₂  mod 257  (Lagrange 보간법)
검증:       SHA256(복원된 masterKey) == 원장의 keyHash
```

- 임계값 정확도: 30/30 = **100%**
- 타이밍 일관성: 정상 복원 vs 실패 차이 **22.4ms** (부채널 공격 방어)

#### 3-4. Merkle Tree (E2E 검증)

```
투표 완료 후:
  1. BuildMerkleTree  → 모든 Nullifier 해시로 Merkle Tree 구성
  2. Root Hash        → 공개 원장에 기록 (불변)
  3. GetMerkleProof   → 유권자가 자신의 Nullifier 포함 여부 독립 검증 가능
```

---

### IV. 백엔드 API 서버

Node.js + @hyperledger/fabric-gateway SDK 기반, 14개 REST API 엔드포인트:

```
POST /api/elections                   선거 생성
POST /api/elections/:id/activate      선거 활성화
GET  /api/elections/:id               선거 정보 조회
POST /api/elections/:id/close         선거 종료
GET  /api/elections/:id/tally         개표 결과
POST /api/elections/:id/merkle        Merkle Tree 구축
GET  /api/elections/:id/merkle        Merkle Root 조회
GET  /api/elections/:id/proof/:null   Merkle 포함 증명
POST /api/elections/:id/proof         Deniable Verification
POST /api/elections/:id/keysharing    Shamir 키 분산 초기화
POST /api/elections/:id/shares        Shamir share 제출
GET  /api/elections/:id/decryption    복원 현황 조회
POST /api/vote                        투표 제출
GET  /api/nullifier/:hash             Nullifier 확인
```

---

## 4. 성능 측정 결과

네트워크를 실제 구동하여 총 **750회** 이상의 반복 테스트를 진행했습니다.

### 4-1. Latency 요약

| 연산 | 샘플 수 | 평균 | P95 | 비고 |
|------|---------|------|-----|------|
| CastVote (신규 투표) | 200회 | 2184.8ms | 2277ms | BatchTimeout(2s) 구간 |
| 재투표 Eviction | 100회 | 2198.0ms | 2257ms | 신규 대비 +13ms |
| InitKeySharing (Shamir) | 50회 | 2258.4ms | 2363ms | 신규 대비 +74ms |
| GetMerkleProof (N=100) | 200회 | 112.7ms | 172ms | 읽기 쿼리, 빠름 |
| Deniable Verification | 200회 | Normal 112.6ms / Panic 98.8ms | 191 / 111ms | 타이밍 유사 |

> CastVote 평균 2.18초는 Fabric의 BatchTimeout(2초) 특성에 기인합니다.
> 블록 배치 주기를 조정하거나 트랜잭션을 묶어 제출하면 TPS 개선 가능 — Caliper로 추후 최적화 예정.

### 4-2. 정확도 / 보안 지표

| 지표 | 결과 |
|------|------|
| 이중투표 차단률 | 100 / 100 = **100%** ✅ |
| Eviction 집계 정확도 | 20 / 20 = **100%** ✅ |
| Panic 타이밍 차이 | **13.7ms** (목표: < 100ms) ✅ |
| Shamir 임계값 정확도 | 30 / 30 = **100%** ✅ |
| Shamir 타이밍 차이 | **22.4ms** ✅ |

---

## 5. 원래 일정 대비 진행률

3주차 보고서 일정 대비 현재 상태:

| 원래 일정 | 계획 내용 | 실제 상태 |
|-----------|-----------|-----------|
| 3월 4주차 | 기술 스택 구축 및 피드백 반영 | ✅ 완료 + 초과 달성 |
| 4월 1주차 | 네트워크 구조 설계 | ✅ **이미 완료** |
| 4월 2주차 | 채널 생성, 데이터 구조 및 PDC 설계 | ✅ **이미 완료** |
| 4월 3주차 | 핵심 체인코드 개발 + 중간 발표 준비 | ✅ **이미 완료** |
| 4월 4주차 | 중간고사 (중간발표) | — |
| 4월 5주차 | 부인 가능 검증로직 (패닉 로직) | ✅ **이미 완료** |
| 5월 1주차 | 프론트엔드(UI) 결합 | 🔲 미착수 |
| 5월 2주차 | Idemix 익명 인증 연동 (선택) | 🔲 선택 사항 |
| 5월 3주차 | 성능 평가 (TPS / Latency 수치 검증) | 🔲 Caliper 미착수 |

> **현재 약 4~5주 일정 선행 중** — 중간발표 전 핵심 구현이 모두 완료된 상태입니다.

---

## 6. 향후 계획 수정안

현재 진행 상황을 반영하여 남은 일정을 아래와 같이 수정합니다.

| 순서 | 항목 | 핵심 내용 | 목표 시기 |
|------|------|-----------|-----------|
| **6** | **React 프론트엔드** | 유권자 투표 UI, 관리자 화면, Deniable UI (강압 상황 전환) | 5월 1주차 |
| **7** | **Caliper 성능 측정** | TPS / Latency 공식 측정, BatchTimeout 최적화 포인트 탐색 | 5월 3주차 |
| **(선택)** | **Idemix ZKP** | Fabric CA 연동, 속성 기반 익명 자격증명 | 5월 2주차 (일정 여유 시) |

---

## 참고문헌

- C. Cachin, "Architecture of the Hyperledger blockchain fabric," *IBM Research*, Jul. 2016.
- J. Sousa, A. Bessani, and M. Vukolić, "A Byzantine fault-tolerant ordering service for the Hyperledger Fabric blockchain platform," in *Proc. IEEE/IFIP Int. Conf. Dependable Syst. Netw. (DSN)*, 2018, pp. 51–58.
- A. Barger, Y. Manevich, H. Meir, and Y. Tock, "A Byzantine fault-tolerant consensus library for Hyperledger Fabric," *IBM Research*, Haifa, Israel, 2017.
- A. Shamir, "How to Share a Secret," *Communications of the ACM*, vol. 22, no. 11, pp. 612–613, 1979.
