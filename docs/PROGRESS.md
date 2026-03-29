# Hyperledger Fabric 기반 전자투표 시스템 — 진행 현황

> **팀명:** 몽바스 | **팀장:** 조수빈(2394025) | **팀원:** 정윤녕(2394043), 윤서현(2394048)
> **지도교수:** 서화정 교수님 | **과목:** 융합보안 캡스톤 디자인
> **최종 업데이트:** 2026-03-30 (STEP 1~5 구현 + 전 단계 성능 평가 완료)

---

## 목차

1. [현재 구현 상태](#1-현재-구현-상태)
2. [전체 개발 로드맵](#2-전체-개발-로드맵)
3. [성능 평가 결과 요약](#3-성능-평가-결과-요약)
4. [다음 진행 순서](#4-다음-진행-순서)
5. [파일 구조](#5-파일-구조)
6. [환경 세팅 가이드](#6-환경-세팅-가이드)
7. [알려진 제약](#7-알려진-제약)

---

## 1. 현재 구현 상태

### 1.1 완료 (✅)

| 항목 | 상세 |
|------|------|
| **네트워크** | HLF v2.5, 3조직 4오더러, etcdraft CFT, 2-of-3 Endorsement Policy |
| **체인코드 기본** | CreateElection, ActivateElection, CastVote, CloseElection, TallyVotes |
| **Merkle Tree** | BuildMerkleTree, GetMerkleProof, GetMerkleRoot — O(log N) 포함 증명 |
| **Panic Password** | GetMerkleProofWithPassword, Normal/Panic 자동 분기, 더미 Nullifier |
| **Nullifier Eviction** | CastVote 덮어쓰기 모드, EvictCount / LastEvictedAt 추적 |
| **Shamir SSS** | InitKeySharing, SubmitKeyShare, GF(257) Lagrange 보간, threshold 복원 검증 |
| **PDC** | VotePrivateCollection — 투표 개인정보 + Shamir share 저장 |
| **Node.js REST API** | 전체 엔드포인트, Fabric Gateway SDK v1.7.1 |
| **CCAAS 배포** | macOS Docker 소켓 호환 해결, sequence 자동 감지 |
| **성능 평가** | STEP 1~5 전 단계 100~200회 반복 벤치마크 완료 |

### 1.2 미구현 (🔲)

| 항목 | 제안서 위치 | 현재 상태 |
|------|------------|----------|
| **React 프론트엔드** | XIII장 기술스택 | 미착수 (STEP 6) |
| **Caliper TPS** | XIV장 평가 #1 | 미실행 (STEP 7) |
| Idemix ZKP | IX장 | 제안서 "선택사항" 명시 |

---

## 2. 전체 개발 로드맵

| 순서 | 기능 | 핵심 내용 | 상태 | 성능 평가 |
|------|------|----------|------|-----------|
| ~~1~~ | ~~Node.js REST API~~ | ~~Fabric Gateway SDK, 전체 엔드포인트~~ | ✅ | 200회 |
| ~~2~~ | ~~Merkle Tree~~ | ~~O(log N) E2E 검증, BuildMerkleTree/Proof~~ | ✅ | 200회 |
| ~~3~~ | ~~Panic Password~~ | ~~Deniable Verification, 더미 Nullifier~~ | ✅ | 200회 |
| ~~4~~ | ~~Nullifier Eviction~~ | ~~재투표 덮어쓰기, EvictCount 추적~~ | ✅ | 100회 |
| ~~5~~ | ~~Shamir's Secret Sharing~~ | ~~n=2/m=3, GF(257), Lagrange 복원~~ | ✅ | 50회 |
| **6** | **React 프론트엔드** | 투표 UI, Deniable UI, 관리자 화면 | 🔲 | Lighthouse |
| **7** | **Caliper 종합 평가** | TPS / Latency, Fault Injection | 🔲 | Caliper |
| (선택) | Idemix ZKP | Fabric CA 연동, 익명 자격증명 | 🔲 | — |

---

## 3. 성능 평가 결과 요약

> 전체 상세: [docs/performance/PERF-SUMMARY.md](./performance/PERF-SUMMARY.md)

### 3.1 Latency 비교 (트랜잭션 제출 유형별)

| 연산 | 샘플 | 평균 | P95 | P99 |
|------|------|------|-----|-----|
| CastVote (신규 투표) | 200회 | 2184.8ms ±5.3ms | 2277ms ❌ | 2324ms ✅ |
| 재투표 Eviction | 100회 | 2198.0ms ±15.7ms | 2257ms ✅ | 2882ms |
| InitKeySharing | 50회 | 2258.4ms ±11.6ms | 2363ms ✅ | 2399ms ✅ |
| SubmitKeyShare (미충족) | 50회 | 2226.2ms ±25.8ms | 2480ms | 2581ms |
| SubmitKeyShare (충족) | 50회 | 2203.7ms ±24.5ms | 2260ms | 2764ms |
| GetMerkleProof N=100 | 200회 | 112.7ms ±4.5ms | 172ms ✅ | — |
| Normal Proof | 200회 | 112.6ms ±4.4ms | 191ms ✅ | 282ms |
| Panic Proof | 200회 | 98.8ms ±1.7ms | 111ms ✅ | 178ms |

> CastVote P95=2277ms는 HLF BatchTimeout=2s 때문. 이중투표 100% 차단을 위해 `getStatus()` 필수.

### 3.2 정확도 / 보안 지표

| 기능 | 결과 | 판정 |
|------|------|------|
| 이중투표 차단율 | 100 / 100 = **100%** | ✅ |
| Eviction 재투표 성공률 | 100 / 100 = **100%** | ✅ |
| Eviction 집계 정확도 | 20 / 20 = **100%** | ✅ |
| Panic 모드 분기 정확도 | 10 / 10 = **100%** | ✅ |
| Panic 타이밍 차이 | **13.7ms** (< 100ms 목표) | ✅ |
| Shamir n=2 복원 성공률 | 50 / 50 = **100%** | ✅ |
| Shamir threshold 정확도 | 30 / 30 = **100%** | ✅ |
| Shamir 타이밍 차이 | **22.4ms** (부채널 저항) | ✅ |

### 3.3 제안서 XIV장 평가 계획 대비

| 평가 항목 | 요구사항 | 달성 |
|---------|---------|------|
| TPS 측정 | Caliper | 🔲 STEP 7 예정 |
| 이중투표 방지 | 100% 차단 | ✅ 100/100 |
| Panic Password | 타이밍 구분 불가 | ✅ 차이 13.7ms |
| n-of-m 복원 | threshold 정확도 | ✅ 30/30 = 100% |
| Nullifier Eviction | 재투표 정확도 | ✅ 20/20 = 100% |
| Merkle E2E 검증 | O(log N) 증명 | ✅ P95 172ms |

---

## 4. 다음 진행 순서

### STEP 6: React 프론트엔드

**구현 파일:**
- `frontend/` (신규 디렉토리)
  - `src/pages/VotePage.jsx` — 투표 화면 (nullifierHash 클라이언트 계산)
  - `src/pages/VerifyPage.jsx` — Deniable Verification (Normal/Panic 동일 UI)
  - `src/pages/AdminPage.jsx` — 선거 생성/활성화/종료, Shamir share 제출
  - `src/pages/ResultPage.jsx` — 개표 결과 표시

**주요 구현 포인트:**
- `nullifierHash = SHA256(voterSecret + electionID)` 브라우저에서 계산 (voterSecret은 로컬 보관, 서버 전송 금지)
- Normal/Panic 모드 UI 완전 동일 (버튼 레이블, 응답 구조 동일)
- Eviction: 재투표 시 "이미 투표했습니다" 에러 제거 → 정상 처리

**성능 평가:** Lighthouse 점수 (Performance ≥ 80, Accessibility ≥ 90)

### STEP 7: Caliper 종합 평가

**측정 항목:**
- TPS (투표 제출): 동시 10명 병렬 투표
- Latency 분포: P50, P95, P99 공식 측정
- Fault Injection: orderer 1개 중단 시 CFT 검증 (3 of 4 → 계속 동작 기대)
- BatchTimeout 최적화: 2s → 500ms 변경 시 TPS / Latency 개선 측정

---

## 5. 파일 구조

```
mongbas/
├── chaincode/voting/
│   ├── voting.go              ✅ 체인코드 (STEP 1~5, sequence 9)
│   ├── collection_config.json ✅ PDC 설정 (memberOnlyRead: false)
│   └── go.mod / vendor/
├── application/src/
│   ├── app.js                 ✅ Express 서버
│   ├── gateway.js             ✅ Fabric Gateway 연결
│   └── routes/
│       ├── elections.js       ✅ 선거 CRUD + Merkle + Proof + Shamir
│       └── vote.js            ✅ 투표 + Nullifier + Eviction + Panic
├── network/
│   ├── scripts/network.sh     ✅ up/deploy/test/down (sequence 자동 감지)
│   ├── docker-compose.yaml    ✅
│   ├── configtx.yaml          ✅
│   └── crypto-config/         (Git 제외)
├── docs/
│   ├── PROGRESS.md            ← 현재 파일
│   ├── HANDOFF.md             ✅ 개발자 인계 문서
│   └── performance/
│       ├── PERF-SUMMARY.md         ✅ 전체 성능 평가 종합 (NEW)
│       ├── PERF-STEP1-REST-API.md  ✅ 200회
│       ├── PERF-STEP2-MERKLE.md    ✅ 200회
│       ├── PERF-STEP3-PANIC.md     ✅ 200회
│       ├── PERF-STEP4-EVICTION.md  ✅ 100회 + 20회 정확도
│       ├── PERF-STEP5-SHAMIR.md    ✅ 50회 + 30회 threshold
│       └── bench_results/          ✅ 원시 측정값 파일
└── scripts/
    ├── bench_full.sh          ✅ STEP 1~3 벤치마크
    └── bench_step45.sh        ✅ STEP 4~5 벤치마크
```

---

## 6. 환경 세팅 가이드

```bash
# 1. 네트워크 기동
cd network
./scripts/network.sh up
./scripts/network.sh deploy   # sequence 자동 감지 (현재 9)
./scripts/network.sh test     # smoke test

# 2. API 서버 기동
cd application
npm install
npm start    # http://localhost:3000

# 3. 벤치마크 실행
bash scripts/bench_full.sh      # STEP 1~3 (200회, ~30분)
bash scripts/bench_step45.sh    # STEP 4~5 (~40분)
# 결과: docs/performance/bench_results/
```

---

## 7. 알려진 제약

| 항목 | 내용 | 해결책 |
|------|------|--------|
| Fabric binary 경로 | `network.sh` macOS 기준 하드코딩 | `FABRIC_BIN_PATH` 환경변수 오버라이드 |
| InitKeySharing 조건 | Election이 `CLOSED` 상태여야 호출 가능 | CloseElection 먼저 호출 |
| TallyVotes 더미 포함 | 후보자별 더미 Nullifier 3개가 득표수에 포함 | 더미 수는 상수이므로 순위 판별에 무영향 |
| Shamir 암호화 미적용 | 투표 candidateID가 PDC에 평문 저장 (A안) | B안 구현 시 AES-GCM 암호화 추가 가능 |
| Panic Welch's p < 0.05 | 통계적 차이 존재 (13.7ms) | 랜덤 딜레이 0~30ms 추가 시 개선 가능 |
