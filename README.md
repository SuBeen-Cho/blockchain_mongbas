# 팀 몽바스 — BFT 기반 익명 전자투표 블록체인 시스템

> **중간 보고 기준일: 2026-03-27**
> Hyperledger Fabric 기반 | 다중 기관 합의 | Nullifier 익명 투표 | Private Data Collection

---

## 1. 프로젝트 개요

### 문제 정의
기존 전자투표 시스템은 중앙 서버에 의존하여 **단일 기관에 의한 조작 가능성**과 **유권자 익명성 침해** 위험이 존재합니다.

### 목표
Hyperledger Fabric 블록체인을 활용하여:
- **단일 기관 조작 불가** — 3개 독립 기관 중 2개 이상 동의해야 트랜잭션 유효
- **완전한 익명성** — 투표 사실은 증명 가능하되 누가 투표했는지는 알 수 없음
- **이중투표 원천 차단** — Nullifier 해시로 수학적으로 보장
- **강압 상황 대응** — Panic Mode (부인 가능 인증) 설계

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
          ├─→ [공개 원장]  Nullifier { nullifierHash, candidateID }
          │      ↑ 누가 투표했는지 알 수 없음 (해시만 저장)
          │      ↑ 이중투표 방지 (동일 해시 중복 제출 차단)
          │
          └─→ [PDC: VotePrivateCollection]  VotePrivate { voterID, ... }
                 ↑ 오더러에게 전달되지 않음
                 ↑ 피어의 비공개 사이드DB에만 저장
```

---

## 3. 구현 완료 현황 (중간 보고 기준)

### 전체 진행률

| 영역 | 항목 | 상태 |
|-----|-----|------|
| **네트워크** | crypto-config.yaml (3조직 + 4오더러 인증서 설계) | ✅ 완료 |
| **네트워크** | configtx.yaml (채널·제네시스 블록, 2-of-3 정책) | ✅ 완료 |
| **네트워크** | docker-compose.yaml (오더러4·피어4·CouchDB4) | ✅ 완료 |
| **네트워크** | network.sh (전체 기동 자동화 스크립트) | ✅ 완료 |
| **네트워크** | 실제 네트워크 기동 및 채널 참여 검증 | ✅ 완료 |
| **체인코드** | Election / Nullifier / VotePrivate / VoteTally 구조체 | ✅ 완료 |
| **체인코드** | InitLedger / CreateElection / CloseElection | ✅ 완료 |
| **체인코드** | CastVote (Nullifier + PDC Transient 처리) | ✅ 완료 |
| **체인코드** | TallyVotes (CouchDB Rich Query 집계) | ✅ 완료 |
| **체인코드** | CouchDB 인덱스 설정 | ✅ 완료 |
| **체인코드** | PDC (VotePrivateCollection) 설정 | ✅ 완료 |
| **체인코드** | 배포 검증 (3기관 승인 / 2-of-3 커밋) | ✅ 완료 |
| **체인코드** | 투표 시나리오 테스트 통과 | ✅ 완료 |
| **백엔드** | Node.js REST API | 🔲 미착수 |
| **보안** | Panic Mode (부인 가능 인증) | 🔲 미착수 |
| **보안** | Idemix ZKP 익명 자격증명 | 🔲 미착수 |
| **프론트엔드** | React 투표 UI | 🔲 미착수 |
| **검증** | 장애 내성 시뮬레이션 | 🔲 미착수 |
| **검증** | Caliper 성능 측정 (TPS / Latency) | 🔲 미착수 |

---

## 4. 핵심 구현 내용

### 4-1. 체인코드 함수

| 함수 | 접근 | 설명 |
|-----|------|------|
| `InitLedger` | 관리자 | 시연용 선거 데이터 초기화 |
| `CreateElection` | 관리자 | 새 선거 생성 (MSP ID 자동 기록) |
| `CastVote` | 유권자 | 익명 투표 — Nullifier 저장 + PDC 비공개 저장 |
| `GetElection` | 누구나 | 선거 정보 조회 |
| `GetNullifier` | 누구나 | 투표 여부 확인 (이중투표 방지 검증) |
| `CloseElection` | 관리자 | 선거 종료 + 자동 집계 |
| `TallyVotes` | 관리자 | CouchDB Rich Query 득표 집계 |
| `GetTally` | 누구나 | 개표 결과 조회 |

### 4-2. PDC (Private Data Collection) 구조

```
VotePrivateCollection
  ├─ policy: OR(선관위.peer, 참관정당.peer, 시민단체.peer)
  ├─ requiredPeerCount: 2   ← 최소 2개 피어에 복제
  ├─ maxPeerCount: 4
  ├─ blockToLive: 0         ← 영구 보존
  └─ memberOnlyRead: true   ← 구성원 외 읽기 불가
```

### 4-3. 실제 테스트 결과

```
[STEP] [테스트 1/4] 선거 정보 조회
→ {"electionID":"ELECTION_2026_PRESIDENT","status":"ACTIVE","candidates":["CANDIDATE_A","CANDIDATE_B","CANDIDATE_C"]}

[STEP] [테스트 2/4] 투표 제출 (선관위 + 참관 정당 서명으로 2-of-3 충족)
→ Chaincode invoke successful. result: status:200

[STEP] [테스트 3/4] Nullifier 확인 (이중투표 방지)
→ {"nullifierHash":"3a8fc9c0...","candidateID":"CANDIDATE_A"}

[STEP] [테스트 4/4] 이중투표 시도 (에러 발생 시 정상)
→ [INFO] 이중투표 정상 차단 확인

[INFO] 모든 테스트 통과!
```

---

## 5. 향후 계획

### 남은 작업 및 일정

| 순서 | 항목 | 핵심 내용 | 난이도 |
|-----|-----|---------|------|
| 1 | **Node.js 백엔드 API** | Fabric Gateway SDK 연동, REST API 구현 (투표·조회·집계) | ★★☆ |
| 2 | **React 프론트엔드** | 투표 화면, 결과 조회, 관리자 화면 | ★★☆ |
| 3 | **Panic Mode** | 패닉 비밀번호 감지 시 가짜 투표 기록 반환 (Deniable UI) | ★★★ |
| 4 | **장애 내성 검증** | 오더러 노드 강제 종료 후 정상 작동 확인 | ★☆☆ |
| 5 | **Caliper 성능 측정** | TPS / Latency 측정, 오더러 수·블록 크기 변수 실험 | ★★☆ |
| 6 | **Idemix ZKP** | Fabric CA 연동, 익명 자격증명 발급 (시간 여유 시) | ★★★★ |

### 기술적 고려사항

**합의 알고리즘:**
현재 **etcdraft (4-node)** 사용 중입니다. 진정한 BFT(SmartBFT)는 `fabric-tools:3.x` 안정 이미지가 Docker Hub에 출시되면 전환 가능합니다. 현 구성은 **오더러 1개 장애까지 허용**하는 CFT 구성입니다.

**Idemix 현실:**
Idemix는 Fabric CA에 구현되어 있으나 Node.js SDK 연동이 불완전합니다. 구현 난이도가 높으므로 설계 문서 + 부분 구현으로 접근할 계획입니다.

---

## 6. 실행 방법

```bash
cd network/

# 1. 네트워크 기동 (인증서 생성 → 제네시스 블록 → Docker → 채널 참여)
./scripts/network.sh up

# 2. 체인코드 배포 (3기관 승인 → 2-of-3 커밋 → InitLedger)
./scripts/network.sh deploy

# 3. 동작 확인 (투표 → Nullifier → 이중투표 차단 테스트)
./scripts/network.sh test

# 종료
./scripts/network.sh down
```

---

## 7. 기술 스택

| 레이어 | 기술 |
|-------|------|
| 블록체인 네트워크 | Hyperledger Fabric 2.5 |
| 합의 알고리즘 | etcdraft (4-node) |
| 상태 DB | CouchDB 3.4 |
| 체인코드 언어 | Go 1.21 + fabric-contract-api-go |
| 컨테이너 | Docker / docker-compose |
| 백엔드 (예정) | Node.js + @hyperledger/fabric-gateway |
| 프론트엔드 (예정) | React.js |

---

> 상세 개발자 인계 문서: [HANDOFF.md](./HANDOFF.md)
