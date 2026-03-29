# Hyperledger Fabric 기반 전자투표 시스템 — 진행 현황 및 구현 계획

> **팀명:** 몽바스 | **팀장:** 조수빈(2394025) | **팀원:** 정윤녕(2394043), 윤서현(2394048)
> **지도교수:** 서화정 교수님 | **과목:** 융합보안 캡스톤 디자인
> **GitHub:** https://github.com/SuBeen-Cho/blockchain_mongbas
> **최종 업데이트:** 2026-03-29

---

## 목차

1. [프로젝트 개요](#1-프로젝트-개요)
2. [현재 구현 상태](#2-현재-구현-상태)
3. [전체 개발 일정](#3-전체-개발-일정)
4. [기술 스택 및 아키텍처](#4-기술-스택-및-아키텍처)
5. [프로젝트 파일 구조](#5-프로젝트-파일-구조)
6. [기능별 구현 계획](#6-기능별-구현-계획)
7. [성능 평가 계획 (단계별)](#7-성능-평가-계획-단계별)
8. [Git 워크플로우](#8-git-워크플로우)

---

## 1. 프로젝트 개요

### 1.1 핵심 목표

기존 전자투표 시스템의 **3가지 치명적 문제**를 해결하는 차세대 투표 인프라:

| 문제 | 기존 한계 | 본 시스템의 해결책 |
|------|-----------|-----------------|
| 디지털 기표소 부재 | 물리적 보호막 없이 강압에 노출 | Panic Password로 강압자를 수학적으로 기만 |
| 검증의 역설 | 검증 데이터가 강압 증거로 악용 | Deniable Verification (부인 가능 검증) |
| 사후 협박 | 투표 후 증명 요구 시나리오 | 가짜 Merkle 증명 동적 생성으로 대응 |

### 1.2 달성해야 할 3가지 속성

```
1. 투표 비밀성 (Ballot Secrecy)
   → PDC + Idemix + Nullifier로 완전 익명성 보장

2. E2E 검증 가능성 (End-to-End Verifiability)
   → Merkle Commitment로 O(log N) 효율 개별 검증 지원

3. 강압 저항성 (Coercion Resistance)
   → Panic Password + Deniable UI로 협박자 기만
```

---

## 2. 현재 구현 상태

### 2.1 완료된 항목 (✅)

```
✅ Hyperledger Fabric v2.5 네트워크 구성
   - 3개 조직: ElectionCommission, PartyObserver, CivilSociety
   - 4개 오더러 (etcdraft, CFT F=1 허용)
   - 2-of-3 Endorsement Policy

✅ CouchDB 연동 (피어별 각 1개, 총 4개)

✅ PDC (Private Data Collection) 설정
   - collection_config.json 구성 완료

✅ Go 체인코드 (chaincode/voting/voting.go)
   - CreateElection: 선거 생성
   - CastVote: Nullifier 기반 투표 (중복 방지)
   - CloseElection: 선거 종료
   - TallyVotes: 집계
   - GetElection / GetTally / GetNullifier
   - InitLedger: 초기 데이터

✅ 네트워크 자동화 스크립트
   - network/scripts/network.sh (up/deploy/test/down/clean)

✅ 기본 기능 테스트 통과
   - 선거 생성, 투표, 중복 투표 차단, 집계 smoke test
```

### 2.2 미구현 항목 (❌)

```
❌ Node.js REST API (application/src/ 비어있음)
❌ Merkle Tree 구현 (체인코드 + API)
❌ Panic Password 로직
❌ React 프론트엔드
❌ Idemix 연동 (선택 사항)
❌ Hyperledger Caliper 성능 평가
```

### 2.3 알려진 이슈

> `network/scripts/network.sh`의 Fabric binary 경로가 `/home/hihi/fabric-capstone/fabric-samples/bin`으로 하드코딩되어 있음.
> 새 환경에서 클론 시 반드시 경로를 수정해야 함 → `FABRIC_BIN_PATH` 환경변수로 변경 권장.

---

## 3. 전체 개발 일정

| 주차 | 원래 일정 | 실제 상태 | 작업 내용 |
|------|-----------|-----------|-----------|
| 3월 3주차 | 기획 최종 설계 | ✅ 완료 | 제안서 작성 |
| 3월 4주차 | 기술 스택 구축 | ✅ 완료 | 네트워크 + 체인코드 완성 |
| **4월 1주차** | 네트워크 구조 설계 | → **앞당김** | **STEP 1: Node.js REST API** |
| **4월 2주차** | 채널 생성, PDC 설계 | → **앞당김** | **STEP 2: Merkle Tree** |
| **4월 3주차** | 핵심 체인코드 개발 | → **앞당김** | **STEP 2 마무리 + 성능 평가 1~2** |
| 4월 4주차 | **중간발표** | — | 중간발표 준비 |
| **4월 5주차** | 부인 가능 검증 로직 | — | **STEP 3: Panic Password** |
| **5월 1주차** | 프론트엔드(UI) 결합 | — | **STEP 4: React + Tailwind** |
| **5월 2주차** | Idemix 익명 인증 연동 | — | **STEP 5: Idemix (선택)** |
| **5월 3주차** | 성능 평가 | — | **STEP 6: Caliper 종합 평가** |
| **5월 4주차** | 보고서 및 오류 수정 | — | 최종 성능 보고서 작성 |
| 6월 1주차 | 최종 제출 (6/2) | — | 최종 구현물 + 보고서 제출 |
| 6월 2~4주차 | 시연 | — | 발표 + 시연 |

> **현재(3월 4주차)**: 일정이 약 2~3주 앞당겨진 상태. 중간발표 전에 REST API와 Merkle Tree까지 구현 가능.

---

## 4. 기술 스택 및 아키텍처

### 4.1 기술 스택

| 레이어 | 기술 | 선정 이유 |
|--------|------|-----------|
| Blockchain | Hyperledger Fabric v2.5 (LTS) | PDC + Idemix 지원 가장 안정적 버전 |
| Smart Contract | Go (Chaincode) | Idemix·Merkle Tree 라이브러리 활용도 높음 |
| Identity | Fabric CA + Idemix | ZKP 기반 신원 비공개 자격 증명 |
| Database | CouchDB | JSON Query + PDC 내 복합 쿼리 지원 |
| Backend SDK | Node.js (Fabric Gateway SDK) | 비동기 통신 최적화, 클라이언트 측 보증 서명 취합 |
| Security Logic | Shamir's Secret Sharing | n-of-m 분산 집계, 단일 관리자 조작 불가 |
| Frontend | React.js + Tailwind CSS | Deniable UI (Panic Mode) 구현에 최적화 |

### 4.2 시스템 아키텍처

```
┌─────────────────────────────────────────────────────┐
│                    USER INTERFACE                    │
│   관리자 Web                        유권자 UI        │
└──────────────────┬───────────────────────────────────┘
                   │
┌──────────────────▼───────────────────────────────────┐
│              애플리케이션 & API 계층                   │
│         투표 시스템 서버 (Node.js)                    │
│         REST API │ Fabric Gateway SDK                │
└──────────────────┬───────────────────────────────────┘
                   │
┌──────────────────▼───────────────────────────────────┐
│           Hyperledger Fabric 네트워크 모듈             │
│                                                      │
│  신원 인증        스마트 컨트랙트    합의 & 블록 생성  │
│  ┌──────────┐   ┌─────────────┐   ┌──────────────┐  │
│  │ Fabric CA│   │   Go        │   │ Endorsing    │  │
│  │ Idemix   │   │ Chaincode   │   │ Peer         │  │
│  │ Nullifier│   │ (투표 로직) │   │ N-of-M Policy│  │
│  └──────────┘   └─────────────┘   └──────────────┘  │
│                                                      │
│  분산 원장           검증 모듈                        │
│  ┌──────────┐   ┌─────────────┐                     │
│  │ CouchDB  │   │ E2E Verif.  │                     │
│  │ Blockchain│  │ Merkle Tree │                     │
│  │ PDC      │   │ Panic PW    │                     │
│  └──────────┘   └─────────────┘                     │
└──────────────────────────────────────────────────────┘
```

### 4.3 투표 데이터 흐름

```
유권자
  │
  ├─ [1] Idemix Credential 발급 (ZKP로 자격 증명)
  │
  ├─ [2] Nullifier 생성: SHA256(voterSecret || electionID)
  │
  ├─ [3] CastVote 호출 (Transient Map으로 투표 내용 전달)
  │         ↓
  │    보증 피어들 (2-of-3 서명 필요)
  │         ↓
  │    PDC: 투표 원본 저장 (orderer 비공개)
  │    공용 원장: Nullifier Hash + Candidate ID만 기록
  │
  ├─ [4] 투표 종료 후: Merkle Tree 구축
  │         ↓
  │    모든 투표 해시 → Merkle Tree
  │    Root Hash만 원장에 커밋
  │
  └─ [5] 검증: GetMerkleProof(nullifierHash, password)
            │
            ├─ 정상 비밀번호 → 실제 Merkle Path (Normal Mode)
            └─ 패닉 비밀번호 → 가짜 Merkle Path (Panic Mode)
```

---

## 5. 프로젝트 파일 구조

```
blockchain_mongbas/
├── chaincode/
│   └── voting/
│       ├── voting.go              # 메인 체인코드 (구현 완료)
│       ├── collection_config.json # PDC 설정
│       ├── go.mod
│       └── META-INF/
│           └── statedb/
│               └── couchdb/
│                   └── indexes/   # CouchDB 인덱스
├── application/
│   ├── package.json               # Node.js 의존성
│   └── src/                       # ⬅ 여기서부터 구현 시작
│       ├── app.js                 # Express 서버 진입점 (생성 예정)
│       ├── fabric/
│       │   └── connection.js      # Fabric Gateway 연결 (생성 예정)
│       └── routes/
│           ├── election.js        # 선거 CRUD API (생성 예정)
│           ├── vote.js            # 투표 API (Transient Map) (생성 예정)
│           └── verify.js          # Merkle 검증 + Panic PW (생성 예정)
├── network/
│   ├── scripts/
│   │   └── network.sh             # 네트워크 자동화 스크립트
│   ├── configtx.yaml              # 채널 + Endorsement Policy 설정
│   ├── crypto-config.yaml         # 인증서 생성 설정
│   └── docker-compose.yaml        # Docker 서비스 정의
├── docs/
│   ├── PROGRESS.md                # ← 현재 파일 (진행 현황)
│   └── performance/               # 단계별 성능 평가 가이드라인
│       ├── README.md
│       ├── PERF-STEP1-REST-API.md
│       ├── PERF-STEP2-MERKLE.md
│       ├── PERF-STEP3-PANIC.md
│       ├── PERF-STEP4-FRONTEND.md
│       ├── PERF-STEP5-IDEMIX.md
│       └── PERF-STEP6-CALIPER.md
├── scripts/
│   └── git-sync.sh                # Git 자동화 스크립트
├── HANDOFF.md                     # 이전 작업 인계 문서
└── README.md                      # 프로젝트 소개
```

---

## 6. 기능별 구현 계획

### STEP 0: 레포 클론 및 환경 세팅

```bash
# 1. 레포 클론
git clone https://github.com/SuBeen-Cho/blockchain_mongbas.git
cd blockchain_mongbas

# 2. Fabric binary 경로 수정 (필수!)
# network/scripts/network.sh 내 하드코딩된 경로 변경:
# /home/hihi/fabric-capstone/fabric-samples/bin → 실제 경로

# 3. 환경 검증
cd network
./scripts/network.sh up
./scripts/network.sh deploy
./scripts/network.sh test   # smoke test 통과 확인
```

---

### STEP 1: Node.js REST API 구축

**구현 위치:** `application/src/`

**엔드포인트 목록:**

| Method | Path | 설명 | 체인코드 함수 |
|--------|------|------|--------------|
| POST | `/api/election` | 선거 생성 | `CreateElection` |
| GET | `/api/election/:id` | 선거 조회 | `GetElection` |
| POST | `/api/vote` | 투표 제출 (Transient Map) | `CastVote` |
| POST | `/api/election/:id/close` | 선거 종료 | `CloseElection` |
| GET | `/api/election/:id/tally` | 집계 조회 | `GetTally` |
| GET | `/api/nullifier/:hash` | Nullifier 확인 | `GetNullifier` |

**핵심 - Transient Map 구현:**
```javascript
// application/src/routes/vote.js 예시
const proposal = await contract.newProposal('CastVote', {
  arguments: [electionID, candidateID],
  transientData: {
    // 투표 내용은 Transient Map으로 → PDC에 격리 저장
    voteData: Buffer.from(JSON.stringify({
      electionID,
      candidateID,
      nullifierHash,
      timestamp: Date.now()
    }))
  }
});
```

**참고 파일:**
- `fabric-samples/asset-transfer-private-data/application-gateway-javascript/` — Transient Map 패턴

---

### STEP 2: Merkle Tree 구현 (E2E Verifiability)

**체인코드 추가 함수 (`chaincode/voting/voting.go`):**

```go
// 선거 종료 후 Merkle Tree 구축 → Root Hash 원장 커밋
func (s *SmartContract) BuildMerkleTree(
    ctx contractapi.TransactionContextInterface,
    electionID string,
) error

// 특정 Nullifier의 Merkle Path 반환
func (s *SmartContract) GetMerkleProof(
    ctx contractapi.TransactionContextInterface,
    electionID string,
    nullifierHash string,
) ([]MerkleNode, error)
```

**데이터 구조:**
```go
type MerkleNode struct {
    Hash     string `json:"hash"`
    Position string `json:"position"` // "left" | "right"
}
// 원장 키: "MERKLE_ROOT_{electionID}" → Root Hash 저장
```

**REST API 추가:**

| Method | Path | 설명 |
|--------|------|------|
| POST | `/api/election/:id/merkle` | Merkle Tree 빌드 |
| GET | `/api/election/:id/proof/:nullifier` | Merkle Path 조회 |

---

### STEP 3: Panic Password (Deniable Verification)

**체인코드 수정 (`voting.go`):**

```go
// GetMerkleProof에 passwordHash 파라미터 추가
func (s *SmartContract) GetMerkleProof(
    ctx contractapi.TransactionContextInterface,
    electionID string,
    nullifierHash string,
    passwordHash string, // SHA256(사용자 입력 비밀번호)
) ([]MerkleNode, error) {

    // PDC에서 유권자 비밀번호 해시 조회
    voterPW, _ := ctx.GetStub().GetPrivateData("_implicit_org_ElectionCommissionMSP", "PW_"+nullifierHash)

    if passwordHash == string(voterPW.NormalPWHash) {
        // Normal Mode: 실제 Merkle Path 반환
        return buildRealMerklePath(ctx, electionID, nullifierHash)
    } else if passwordHash == string(voterPW.PanicPWHash) {
        // Panic Mode: 더미 데이터로 가짜 Merkle Path 생성
        return buildFakeMerklePath(ctx, electionID)
    }
    return nil, fmt.Errorf("invalid password")
}
```

**더미 데이터 전략:**
- `CreateElection` 시 더미 투표 레코드 N개를 원장에 미리 저장
- Panic Mode에서 더미 레코드를 leaf로 사용해 Root Hash와 일치하는 가짜 Path 구성
- 가짜 Path도 실제 Root Hash로 검증 통과 → 협박자가 구분 불가

---

### STEP 4: React 프론트엔드

**주요 페이지:**

| 페이지 | 경로 | 설명 |
|--------|------|------|
| 로그인 | `/login` | 유권자 자격 확인 (Idemix 연동 시 ZKP) |
| 선거 목록 | `/elections` | 진행 중인 선거 조회 |
| 투표 | `/elections/:id/vote` | 후보 선택 + 투표 제출 |
| 검증 | `/elections/:id/verify` | Merkle Path 조회 (Normal/Panic 동일 UI) |
| 관리자 | `/admin` | 선거 생성 + 집계 + Merkle 빌드 |

**Panic Mode UI 핵심 원칙:**
- Normal Mode와 Panic Mode 화면이 **완전히 동일**해야 함
- 비밀번호 입력 필드만 다르고, 결과 화면 구조 동일
- 협박자가 화면만 봐서는 모드를 구분할 수 없어야 함

---

### STEP 5: Idemix 연동 (선택, 5월 2주차)

**구현 흐름:**
```
1. Fabric CA에서 Idemix credential 발급
   $ fabric-ca-client enroll --idemix ...

2. 유권자: ZKP 생성
   속성: isEligibleVoter = true (신원 비공개)

3. CastVote 호출 시 ZKP 포함
   → 체인코드에서 Idemix 서명 검증

4. Nullifier 생성에 Idemix pseudonym 사용
   → 실제 ID와 완전히 분리
```

---

### STEP 6: Hyperledger Caliper 종합 성능 평가 (5월 3~4주차)

```bash
# 설치
npm install -g @hyperledger/caliper-cli
caliper bind --caliper-bind-sut fabric:2.5

# 실행 예시
caliper launch manager \
  --caliper-workspace ./caliper \
  --caliper-networkconfig networks/fabric-voting.yaml \
  --caliper-benchconfig benchmarks/voting-tps.yaml \
  --caliper-report-path reports/report.html
```

**평가 항목:**
1. Byzantine Fault Injection (무결성 검증)
2. TPS/Latency vs 오더러 수 (성능 트레이드오프)
3. O(N²) 통신 지연 분석 (확장성)
4. Merkle Proof 생성 시간 O(log N) 검증
5. Panic Password 타이밍 t-test

---

## 7. 성능 평가 계획 (단계별)

각 구현 단계가 완료되면 즉시 해당 성능 평가를 수행합니다.
상세 가이드라인은 `docs/performance/` 폴더의 개별 파일을 참조하세요.

| 단계 | 기능 | 성능 평가 파일 | 핵심 지표 |
|------|------|--------------|----------|
| STEP 1 | REST API | `PERF-STEP1-REST-API.md` | latency P95, TPS, 중복방지율 |
| STEP 2 | Merkle Tree | `PERF-STEP2-MERKLE.md` | O(log N) 효율, 무결성 100% |
| STEP 3 | Panic Password | `PERF-STEP3-PANIC.md` | t-test p>0.05, 식별불가 |
| STEP 4 | Frontend | `PERF-STEP4-FRONTEND.md` | Lighthouse 점수, E2E 시간 |
| STEP 5 | Idemix | `PERF-STEP5-IDEMIX.md` | ZKP 오버헤드, 비연결성 |
| STEP 6 | Caliper | `PERF-STEP6-CALIPER.md` | Fault Injection, TPS vs N |

---

## 8. crypto-config.zip 설정 가이드

GitHub 레포에는 보안상 인증서(crypto-config)를 직접 올리지 않고
`crypto-config.zip`으로 압축하여 업로드했습니다.
새 환경에서 레포를 클론할 때 반드시 아래 절차를 따르세요.

### 8.1 crypto-config.zip 받기 및 압축 해제

```bash
# 1. 레포 클론
git clone https://github.com/SuBeen-Cho/blockchain_mongbas.git
cd blockchain_mongbas

# 2. crypto-config.zip 확인
ls network/crypto-config.zip   # 또는 루트에 있을 수 있음
ls crypto-config.zip

# 3. 압축 해제
# 방법 A: network/ 폴더 아래에 압축 해제 (일반적인 위치)
cd network
unzip crypto-config.zip
# → network/crypto-config/ 폴더 생성됨

# 방법 B: 루트에서 압축 해제
cd blockchain_mongbas
unzip crypto-config.zip -d network/
# → network/crypto-config/ 폴더 생성됨
```

### 8.2 압축 해제 후 폴더 구조 확인

```bash
ls network/crypto-config/
# 기대 출력:
# ordererOrganizations/
# peerOrganizations/

ls network/crypto-config/peerOrganizations/
# 기대 출력:
# electioncommission.example.com/
# partyobserver.example.com/
# civilsociety.example.com/
```

### 8.3 경로 수정 (필수)

`network/scripts/network.sh` 내 Fabric binary 경로가 하드코딩되어 있습니다:

```bash
# 현재 하드코딩된 경로 (다른 환경에서 동작 안 함)
FABRIC_BIN=/home/hihi/fabric-capstone/fabric-samples/bin

# 수정 방법 1: 환경변수로 오버라이드
export FABRIC_BIN_PATH=/Users/subeen/Desktop/project_mongbas/mongbas/fabric-samples/bin
./scripts/network.sh up

# 수정 방법 2: network.sh 파일 직접 수정
sed -i '' 's|/home/hihi/fabric-capstone/fabric-samples/bin|/Users/subeen/Desktop/project_mongbas/mongbas/fabric-samples/bin|g' network/scripts/network.sh
```

### 8.4 환경 검증

```bash
cd network

# Fabric binary 접근 확인
ls $FABRIC_BIN_PATH/peer   # 또는 수정한 경로

# 네트워크 기동 테스트
./scripts/network.sh up
./scripts/network.sh deploy
./scripts/network.sh test   # smoke test 통과 확인

# 성공 시 출력:
# ✓ CastVote succeeded
# ✓ TallyVotes succeeded
# ✓ Duplicate vote blocked
```

### 8.5 crypto-config 재생성이 필요한 경우

기존 인증서가 만료되거나 새로운 네트워크 구성이 필요할 때:

```bash
cd network

# cryptogen으로 인증서 재생성
$FABRIC_BIN_PATH/cryptogen generate \
  --config=./crypto-config.yaml \
  --output=./crypto-config

# 재생성 후 zip으로 업데이트 (GitHub 업로드용)
zip -r crypto-config.zip crypto-config/
# → GitHub에 새 zip 업로드 (git add crypto-config.zip && git commit)
```

> **주의:** `crypto-config/` 폴더 자체는 `.gitignore`에 포함됩니다.
> 인증서 파일(`.pem`, `.key`)은 절대 직접 커밋하지 마세요.

---

## 10. Git 워크플로우

### 자동화 스크립트 사용법

```bash
# 커밋 + 푸시 자동화
./scripts/git-sync.sh "feat: Merkle Tree 체인코드 구현"

# 수동으로 할 경우
git pull origin main --rebase
git add -A
git commit -m "feat: ..."
git push origin main
```

### 커밋 메시지 컨벤션

```
feat:     새로운 기능 추가
fix:      버그 수정
test:     테스트 추가/수정
docs:     문서 수정
refactor: 리팩토링
perf:     성능 개선
```

### 브랜치 전략

```
main          : 항상 동작하는 상태 유지
feature/step1 : REST API 개발
feature/step2 : Merkle Tree 개발
feature/step3 : Panic Password 개발
feature/step4 : Frontend 개발
```
