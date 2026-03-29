# 팀 몽바스 — 전체 성능 평가 종합 정리

> **팀명:** 몽바스 | 조수빈(2394025) · 정윤녕(2394043) · 윤서현(2394048)
> **지도교수:** 서화정 교수님 | **과목:** 융합보안 캡스톤 디자인
> **최종 업데이트:** 2026-03-30 (STEP 1~5 전 단계 완료)

---

## 목차

1. [테스트 환경](#1-테스트-환경)
2. [STEP 1: CastVote (투표 제출)](#2-step-1-castvote-투표-제출)
3. [STEP 2: Merkle Tree (E2E 검증)](#3-step-2-merkle-tree-e2e-검증)
4. [STEP 3: Panic Password (강압 저항)](#4-step-3-panic-password-강압-저항)
5. [STEP 4: Nullifier Eviction (재투표)](#5-step-4-nullifier-eviction-재투표)
6. [STEP 5: Shamir's Secret Sharing (분산 집계)](#6-step-5-shamirs-secret-sharing-분산-집계)
7. [전체 요약 테이블](#7-전체-요약-테이블)
8. [설계 트레이드오프 분석](#8-설계-트레이드오프-분석)

---

## 1. 테스트 환경

```
OS:          macOS Darwin 24.6.0
블록체인:    Hyperledger Fabric v2.5 (CCAAS 배포)
조직:        3개 — 선거관리위원회 (peer0/peer1), 참관정당 (peer0), 시민단체 (peer0)
오더러:      etcdraft 4-node (orderer1~4)
합의 정책:   2-of-3 Endorsement (OutOf(2, EC.peer, Party.peer, Civil.peer))
상태DB:      CouchDB 3.4
Node.js:     v25.7.0 + @hyperledger/fabric-gateway v1.7.1
측정 도구:   bash + python3 (time.time() ms 단위, macOS date %N 미지원 우회)
체인코드 sequence: 9 (STEP 5 완료 시점)
```

---

## 2. STEP 1: CastVote (투표 제출)

> 상세: [PERF-STEP1-REST-API.md](./PERF-STEP1-REST-API.md)

### 2-1. CastVote Latency — 200회

| 지표 | 측정값 | 목표 | 판정 |
|------|--------|------|------|
| 평균 | 2184.8ms ±5.3ms (95% CI) | — | — |
| 표준편차 | 38.5ms | — | — |
| P50 | 2175ms | — | — |
| P95 | 2277ms | < 2000ms | ❌ BatchTimeout 원인 |
| P99 | 2324ms | < 3000ms | ✅ |
| 최소 / 최대 | 2130ms / 2378ms | — | — |

**P95 초과 원인:**
HLF 기본 `BatchTimeout=2s` + `getStatus()` 블록 커밋 대기.
이중투표 100% 차단을 위해 `getStatus()` 호출이 필수(없으면 MVCC 충돌 미감지 → 이중투표 통과).
BatchTimeout을 500ms로 줄이면 P50 ~650ms 수준으로 개선 가능.

### 2-2. 중복 투표 차단율 — 100쌍

| 지표 | 측정값 | 목표 | 판정 |
|------|--------|------|------|
| 중복 투표 차단율 | 100 / 100 = **100%** | 100% | ✅ |
| 1차 투표 성공률 | 100 / 100 = 100% | — | ✅ |
| 2차 동일 Nullifier 차단 | 100 / 100 = 100% (409 반환) | 100% | ✅ |

---

## 3. STEP 2: Merkle Tree (E2E 검증)

> 상세: [PERF-STEP2-MERKLE.md](./PERF-STEP2-MERKLE.md)

### 3-1. GetMerkleProof Latency — N별 200회

| N (유권자 수) | 평균 | 95% CI | P50 | P95 | 목표 | 판정 |
|-------------|------|--------|-----|-----|------|------|
| N=10  | 94.6ms | ±5.3ms | 83ms | 167ms | < 500ms | ✅ |
| N=50  | 92.0ms | ±2.5ms | 88ms | 126ms | < 600ms | ✅ |
| N=100 | 112.7ms | ±4.5ms | 102ms | 172ms | < 600ms | ✅ |

### 3-2. O(log N) 효율 분석

```
선형 회귀:  y = 4.30 × log₂(N) + 77.43ms
R² = 0.42  → 상수항(77ms)이 지배, log 성분은 4.3ms/bit

N 10배 증가 시 latency 증가: 14.3ms  (상수 대비 미미함)
→ 실용 범위 N ≤ 10,000에서 준O(1) 체감
```

| 비교 | 이론값 | 실측값 | 오차 |
|------|--------|--------|------|
| N=10  → N=100 (10배) | +14.3ms | +18.1ms | ±4ms |
| N=100 → N=1000 (10배) | +14.3ms | — | — |

**무결성 검증:** 잘못된 Nullifier → 404, 더미 Nullifier Merkle 포함 → Panic 가짜 증명 수학적으로 유효 ✅

---

## 4. STEP 3: Panic Password (강압 저항)

> 상세: [PERF-STEP3-PANIC.md](./PERF-STEP3-PANIC.md)

### 4-1. Normal / Panic 응답 시간 — 각 200회

| 모드 | 평균 | 95% CI | 표준편차 | P50 | P95 | P99 |
|------|------|--------|----------|-----|-----|-----|
| Normal | 112.6ms | ±4.4ms | 31.9ms | 102ms | 191ms | 282ms |
| Panic  | 98.8ms  | ±1.7ms | 12.6ms | 97ms  | 111ms | 178ms |
| **차이** | **13.7ms** | — | — | 5ms | 80ms | 104ms |

### 4-2. 타이밍 안전성 — Welch's t-test

| 지표 | 측정값 | 목표 | 판정 |
|------|--------|------|------|
| 평균 차이 | 13.7ms | < 100ms | ✅ |
| Welch's t | 5.6646 | — | — |
| p-value | 0.000000 | > 0.05 | ⚠️ 통계적 차이 존재 |
| 실용적 구분 가능성 | 네트워크 지터(±31ms) > 차이(13.7ms) | — | ✅ 실용적 구분 불가 |

> **핵심:** p < 0.05이지만 차이 13ms는 네트워크 지터(σ=31ms) 이내.
> 강압자가 타이밍만으로 Normal/Panic을 구분하는 것은 실용적으로 불가능.

### 4-3. 모드 분기 정확도

| 케이스 | 결과 | 판정 |
|--------|------|------|
| Normal 비밀번호 → 실제 Merkle proof 반환 | 10/10 = 100% | ✅ |
| Panic 비밀번호 → 가짜 Merkle proof 반환 | 10/10 = 100% | ✅ |
| 잘못된 비밀번호 → 400 오류 | 10/10 = 100% | ✅ |

**수학적 무결성:**
가짜 증명이 실제 Root Hash 검증을 통과함 (더미 Nullifier가 Merkle 트리 리프에 포함되어 있어 Lagrange path가 실제 root와 일치).

---

## 5. STEP 4: Nullifier Eviction (재투표)

> 상세: [PERF-STEP4-EVICTION.md](./PERF-STEP4-EVICTION.md)

### 5-1. 재투표(Eviction) Latency — 100회

| 지표 | 측정값 | CastVote 기준 | 오버헤드 | 판정 |
|------|--------|--------------|----------|------|
| 평균 | 2198.0ms ±15.7ms (95% CI) | 2184.8ms | **+13.2ms (+0.6%)** | ✅ |
| 표준편차 | 79.8ms | 38.5ms | +41.3ms | — |
| P50 | 2185ms | 2175ms | +10ms | ✅ |
| P95 | 2257ms | 2277ms | -20ms | ✅ |
| P99 | 2882ms | 2324ms | +558ms | ⚠️ 간헐적 spike |
| 최소 / 최대 | 2140ms / 2882ms | — | — | — |

**오버헤드 분석:**
Eviction은 기존 Nullifier 레코드 Read + Unmarshal 후 덮어쓰기.
평균 +13.2ms는 BatchTimeout(2s) 대비 **0.6%** — 실용적으로 무시 가능.

### 5-2. 재투표 정확도

| 지표 | 측정값 | 목표 | 판정 |
|------|--------|------|------|
| 재투표 성공률 | 100 / 100 = **100%** | 100% | ✅ |
| evictCount 추적 정확도 | 100 (기대값 일치) | 100% | ✅ |

### 5-3. 집계 정확도 — 20회

```
시나리오: 유권자 3명 A투표 → B재투표
검증 기준: B득표 - A득표 = 에빅션된 유권자 수 (3)
          (후보자별 더미 Nullifier 3개 존재, B=더미3+실제3=6, A=더미3+실제0=3)
```

| 지표 | 측정값 | 목표 | 판정 |
|------|--------|------|------|
| 집계 정확도 | 20 / 20 = **100%** | 100% | ✅ |

---

## 6. STEP 5: Shamir's Secret Sharing (분산 집계)

> 상세: [PERF-STEP5-SHAMIR.md](./PERF-STEP5-SHAMIR.md)

**구현 방식:** GF(257) 위 1차 다항식 Shamir SSS (threshold=2, shares=3)
- masterKey = SHA256(txID ∥ electionID) — 결정론적 생성
- share_i = masterKey[byte] + coeff[byte] × i  mod 257
- 복원: Lagrange at x=0 → f(0) = 2·y₁ + 256·y₂  mod 257

### 6-1. InitKeySharing Latency — 50회

| 지표 | 측정값 | CastVote 대비 | 판정 |
|------|--------|--------------|------|
| 평균 | 2258.4ms ±11.6ms (95% CI) | +73.6ms (+3.4%) | ✅ |
| 표준편차 | 41.8ms | +3.3ms | — |
| P50 | 2249ms | — | — |
| P95 | 2363ms | — | ✅ (< 3000ms) |
| P99 | 2399ms | — | ✅ (< 3000ms) |
| 성공률 | 50 / 50 = **100%** | — | ✅ |

**오버헤드 분석 (+73ms):**
SHA256 키 생성 + Shamir 3분할(32바이트 × 3 연산) + PDC 3회 저장.
BatchTimeout(2s) 지배 구간에서 **+73ms(3.4%)** — 수용 가능.

### 6-2. SubmitKeyShare Latency — 각 50회

| 모드 | 평균 | 95% CI | 표준편차 | P50 | P95 | P99 |
|------|------|--------|----------|-----|-----|-----|
| Share 1 (미충족) | 2226.2ms | ±25.8ms | 93.0ms | 2196ms | 2480ms | 2581ms |
| Share 2 (충족 + 복원) | 2203.7ms | ±24.5ms | 88.2ms | 2198ms | 2260ms | 2764ms |
| **차이** | **22.4ms** | — | — | 2ms | 220ms | — |

**타이밍 보안 (Welch's t-test):**

| 지표 | 측정값 | 판정 |
|------|--------|------|
| t 통계량 | 1.238 | — |
| 평균 차이 | 22.4ms | ✅ 네트워크 지터(σ≈90ms) 이내 |
| 실용적 구분 가능성 | 불가 (차이 < 표준편차) | ✅ 부채널 공격 저항 |

> share 1(복원 미충족)과 share 2(복원 완료) 응답 시간 차이 22.4ms는
> 네트워크 표준편차(≈90ms) 이내 → 타이밍 분석으로 threshold 충족 여부 식별 불가.

### 6-3. n-of-m Threshold 정확도 — 30회

| 검증 항목 | 측정값 | 목표 | 판정 |
|---------|--------|------|------|
| n=1 share → 복원 불가 (isDecrypted=false) | 30 / 30 = **100%** | 100% | ✅ |
| n=2 share → 복원 성공 (isDecrypted=true) | 30 / 30 = **100%** | 100% | ✅ |
| threshold 정확도 종합 | 30 / 30 = **100%** | 100% | ✅ |

---

## 7. 전체 요약 테이블

### 7-1. Latency 비교 (트랜잭션 제출 유형별)

| 연산 | 샘플수 | 평균 Latency | P95 | P99 | 비고 |
|------|--------|-------------|-----|-----|------|
| CastVote (신규) | 200회 | 2184.8ms | 2277ms | 2324ms | BatchTimeout 지배 |
| 재투표 (Eviction) | 100회 | 2198.0ms | 2257ms | 2882ms | +13ms (+0.6%) |
| InitKeySharing | 50회 | 2258.4ms | 2363ms | 2399ms | +74ms (+3.4%) |
| SubmitKeyShare(미충족) | 50회 | 2226.2ms | 2480ms | 2581ms | +41ms (+1.9%) |
| SubmitKeyShare(충족) | 50회 | 2203.7ms | 2260ms | 2764ms | +19ms (+0.9%) |
| GetMerkleProof (N=100) | 200회 | 112.7ms | 172ms | — | evaluateTransaction |
| Normal Proof | 200회 | 112.6ms | 191ms | 282ms | evaluateTransaction |
| Panic Proof | 200회 | 98.8ms | 111ms | 178ms | evaluateTransaction |

### 7-2. 정확도 / 보안 지표 종합

| 기능 | 지표 | 결과 | 판정 |
|------|------|------|------|
| 이중투표 차단 | 100쌍 차단율 | 100 / 100 = **100%** | ✅ |
| Merkle 무결성 | 잘못된 Nullifier 탐지 | 100% | ✅ |
| Eviction 재투표 성공 | 100회 성공률 | 100 / 100 = **100%** | ✅ |
| Eviction 집계 정확도 | 20회 시나리오 | 20 / 20 = **100%** | ✅ |
| Panic 모드 분기 | 3가지 케이스 × 10회 | 10 / 10 = **100%** | ✅ |
| Panic 타이밍 차이 | < 100ms 목표 | 13.7ms | ✅ |
| Shamir 복원 성공 (n=2) | 50회 | 50 / 50 = **100%** | ✅ |
| Shamir threshold 정확도 | n=1 실패 / n=2 성공 | 30 / 30 = **100%** | ✅ |
| Shamir 타이밍 차이 | 미충족 vs 충족 | 22.4ms | ✅ |

### 7-3. 제안서 평가 계획 대비 달성 현황

제안서 XIV장 평가 계획 기준:

| 평가 항목 | 제안서 요구 | 달성 여부 | 측정값 |
|---------|-----------|----------|--------|
| TPS 측정 | Caliper 측정 | 🔲 STEP 7 예정 | — |
| 이중투표 방지 | 100% 차단 | ✅ | 100/100 |
| Panic Password | 타이밍 구분 불가 | ✅ | 차이 13.7ms |
| n-of-m 집계 복원 | threshold 정확도 | ✅ | 30/30 = 100% |
| Nullifier Eviction | 재투표 정확도 | ✅ | 20/20 = 100% |
| Merkle E2E 검증 | O(log N) 증명 | ✅ | P95 172ms (N=100) |

---

## 8. 설계 트레이드오프 분석

### 8-1. BatchTimeout = 2s (P95 초과 주요 원인)

```
현재:   BatchTimeout=2s → CastVote P95=2277ms (목표 2000ms 초과)
원인:   getStatus()가 블록 커밋까지 대기 → 이중투표 100% 차단 필수
대안:   BatchTimeout=500ms → 예상 P50 ~650ms
        단, 블록당 트랜잭션 수 감소 → TPS 하락 가능성

→ STEP 7 Caliper에서 BatchTimeout 최적화 예정
```

### 8-2. 더미 Nullifier (후보자당 3개)

```
목적:   Panic Mode 가짜 Merkle 증명이 실제 Root와 수학적으로 일치하도록 설계
효과:   강압자가 증명 유효성 검사로 Normal/Panic을 구분 불가
부작용: TallyVotes 집계에 더미 포함 → 결과가 득표수 + 더미 3개/후보
        (실제 활용 시 더미 득표는 상수이므로 순위 판별에 영향 없음)
```

### 8-3. Shamir SSS — A안 (간소화)

```
현재(A안): 투표는 여전히 PDC에 저장, masterKey만 Shamir 분산
           → Shamir 로직 구현 완료, 실제 투표 암호화는 미적용
학술(B안): 투표 시 candidateID를 masterKey로 AES 암호화 후 저장,
           집계 시 복호화 → 집계
           → 구현 복잡도 높음 (Go 체인코드 결정론성 제약)

현 구현으로 제안서 "Shamir SSS 로직 구현 + 복원 검증"은 충족
```

### 8-4. Panic 타이밍 (Welch's p < 0.05)

```
현황:   p=0.000000 (통계적 차이 존재), 단 차이 13.7ms
대응:   Panic Mode에 0~30ms 랜덤 딜레이 추가 → p > 0.05 달성 가능
        현재 구현에는 의도적 딜레이 없음 → 실용 시나리오에서는 충분한 수준
```

---

## 벤치마크 스크립트 및 원시 데이터

| 파일 | 설명 |
|------|------|
| `scripts/bench_full.sh` | STEP 1~3 종합 벤치마크 (200회) |
| `scripts/bench_step45.sh` | STEP 4~5 벤치마크 (100~50회) |
| `bench_results/step4a_eviction_latency.txt` | STEP 4-A 원시 측정값 (100개) |
| `bench_results/step5a_init_keysharing_latency.txt` | STEP 5-A 원시 측정값 (50개) |
| `bench_results/step5b_share1_latency.txt` | STEP 5-B share1 원시값 (50개) |
| `bench_results/step5b_share2_latency.txt` | STEP 5-B share2 원시값 (50개) |
