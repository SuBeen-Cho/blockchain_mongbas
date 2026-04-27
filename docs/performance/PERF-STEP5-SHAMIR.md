# STEP 5 성능 평가: Shamir's Secret Sharing (n-of-m 분산 집계)

> **평가 일시:** 2026-03-30
> **상태:** ✅ 완료 (50회 InitKeySharing + 50회 SubmitKeyShare + 30회 threshold 정확도)
> **우선순위:** Eviction(STEP 4) 완료 후, 프론트엔드(STEP 6) 전

---

## 왜 Shamir SSS가 필요한가

제안서(VII장) 명시 기능:

> "초기화 단계에서 마스터 키 생성 → Shamir의 비밀 분산 알고리즘으로 m개 조각 분할
> → 독립 검증 노드에 분산 저장. 투표 종료 시 n개 이상 수집 → 마스터 키 복원 → 복호화"

---

## 구현 설계 (A안: 간소화)

### 전체 흐름

```
[선거 종료(CLOSED) 후 — InitKeySharing]
1. masterKey = SHA256(txID + "::" + electionID)  ← 결정론적 생성
2. coeffSeed = SHA256("COEFF::" + txID + "::" + electionID)
3. Shamir SSS: masterKey(32 bytes) → 3개 share
   수식: f(x) = masterKey + coeff * x  mod p  (p = secp256k1 prime, 2^256 - 2^32 - 977)
   share_j = f(j) for j in 1..3  (각 32 byte Big-Endian, 256비트 정수 통째 연산)
4. share_1, share_2, share_3 → PDC(VotePrivateCollection) 저장
5. keyHash = SHA256(masterKey) → 공개 원장에 저장 (복원 검증용)

[집계 시 — SubmitKeyShare]
6. 조직이 share_index와 shareHex 제출
7. n=2 이상 수집 시 Lagrange 보간으로 masterKey 복원
   f(0) = y1 * (-x2)/(x1-x2) + y2 * (-x1)/(x2-x1)  mod p
8. SHA256(복원된 masterKey) == keyHash 검증 → isDecrypted=true
```

### 추가된 함수

| 함수 | 역할 |
|------|------|
| `InitKeySharing(electionID)` | 마스터키 생성 + Shamir 3분할 + PDC 저장 |
| `SubmitKeyShare(electionID, shareIndex, shareHex)` | share 제출 → n≥2 시 복원 검증 |
| `GetKeyDecryptionStatus(electionID)` | 현재 분산/복원 현황 조회 |
| `GetKeyShare(electionID, shareIndex)` | PDC에서 share 조회 (테스트/관리자용) |

### 수학적 근거

```
GF 소수: p = secp256k1 prime (2^256 - 2^32 - 977), 보안 공간 ≈ 2^256
  → 32바이트 masterKey 전체를 하나의 256비트 정수로 처리 (math/big.Int)
다항식:  f(x) = s + r*x  mod p  (threshold=2 → degree-1 다항식)
share_i: f(i) = (s + r*i) mod p  (i=1,2,3, 각 32바이트 big-endian)

복원 (Lagrange 보간, x=0):
  f(0) = y1 * L1(0) + y2 * L2(0)  mod p
  L1(0) = (-x2) / (x1 - x2)  mod p
  L2(0) = (-x1) / (x2 - x1)  mod p
  → f(0) = L1*y1 + L2*y2  mod p  (big.Int.ModInverse로 나눗셈)
```

### 추가된 REST API

```
POST /api/elections/:id/keysharing    선거 종료 후 마스터키 분산
POST /api/elections/:id/shares        share 제출 (n>=2 시 자동 복원)
GET  /api/elections/:id/decryption    복원 현황 조회
GET  /api/elections/:id/shares/:idx   PDC share 조회 (관리자용)
```

---

## 성능 평가 결과

### 테스트 5-A: InitKeySharing Latency — 50회

```
평가 일시: 2026-03-30
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
시나리오: 선거 종료 후 InitKeySharing 호출 — 50회 반복
연산: SHA256 마스터키 생성 + Shamir 3분할 + PDC 3회 저장
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

InitKeySharing Latency (50회):
  평균:   2258.4ms ±11.6ms (95% CI)
  표준편차: 41.8ms
  P50:   2249ms
  P95:   2363ms
  P99:   2399ms
  최소:   2192ms  /  최대:  2399ms

성공률: 50/50 = 100%  ✅
```

**CastVote 대비 분석:**

| 지표 | CastVote | InitKeySharing | 차이 |
|------|---------|----------------|------|
| 평균 | 2184.8ms | 2258.4ms | +73.6ms |
| P95  | 2277ms   | 2363ms   | +86ms  |
| 표준편차 | 38.5ms | 41.8ms | +3.3ms |

→ InitKeySharing이 CastVote보다 **~73ms 느림** (Shamir 3분할 + PDC 3회 저장 오버헤드).
→ BatchTimeout(~2s) 지배 구간에서 **실용적으로 허용 가능 수준**.

### 테스트 5-B: SubmitKeyShare Latency — 각 50회

```
평가 일시: 2026-03-30
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
시나리오: share 1 제출(미충족) vs share 2 제출(threshold 충족, 복원 포함)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Share 1 제출 (미충족, n=1):
  평균:   2226.2ms ±25.8ms (95% CI)
  표준편차: 93.0ms
  P50:   2196ms
  P95:   2480ms
  P99:   2581ms
  최소:   2142ms  /  최대:  2581ms

Share 2 제출 (threshold 충족, n=2, 복원 포함):
  평균:   2203.7ms ±24.5ms (95% CI)
  표준편차: 88.2ms
  P50:   2198ms
  P95:   2260ms
  P99:   2764ms
  최소:   2130ms  /  최대:  2764ms

두 모드 비교:
  Welch's t-test: t=1.238
  share1 평균 2226.2ms vs share2 평균 2203.7ms → 차이 22.4ms
  → 실용적 구분 불가 (차이 <200ms) ✅

n=2 threshold 복원 성공: 50/50 = 100%  ✅
```

**모드 구분 불가 보안 의미:**
share 1 제출(미충족)과 share 2 제출(복원 포함)의 응답 시간 차이가 22.4ms로,
네트워크 지터(±88ms stdev) 이내에 있다.
→ 외부에서 응답 시간만으로 threshold 충족 여부를 구별할 수 없음 (부채널 공격 저항).

### 테스트 5-C: n-of-m Threshold 정확도 — 30회

```
평가 일시: 2026-03-30
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
검증 1: n=1 share만 제출 시 복원 불가 (isDecrypted=false)
검증 2: n=2 share 제출 시 복원 가능 (isDecrypted=true)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

threshold 정확도: 30/30 = 100%  ✅
  n=1 → isDecrypted=false: 30/30 = 100%  ✅
  n=2 → isDecrypted=true:  30/30 = 100%  ✅

실패: 0건
```

---

## 전체 요약

| 지표 | 목표 | 결과 | 판정 |
|------|------|------|------|
| InitKeySharing 평균 Latency | CastVote 수준 | +73.6ms (+3.4%) | ✅ |
| InitKeySharing P95 | < 3000ms | 2363ms | ✅ |
| InitKeySharing 성공률 | 100% | 50/50 | ✅ |
| SubmitKeyShare Latency 차이 | < 200ms | 22.4ms | ✅ |
| n=2/m=3 복원 성공 | 100% | 50/50 | ✅ |
| n=1만으로 복원 불가 | 100% | 30/30 | ✅ |
| threshold 정확도 | 100% | 30/30 | ✅ |

**결론:** Shamir SSS (n=2, m=3) 구현은 성능·정확도·보안(부채널) 모든 목표를 달성.
share 1과 share 2 응답 시간 차이가 22.4ms로 실용적 부채널 공격이 불가능함.
n=1 threshold 미달 시 항상 복원 실패, n=2 달성 시 항상 복원 성공을 보장함.
