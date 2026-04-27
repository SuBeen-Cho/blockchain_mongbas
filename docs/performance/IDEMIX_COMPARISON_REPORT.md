# Idemix 도입 전 / 진짜 Idemix / 개선 Idemix 성능 비교 보고서 — Project Mongbas

> **팀명:** 몽바스 | 조수빈(2394025) · 정윤녕(2394043) · 윤서현(2394048)
> **지도교수:** 서화정 교수님 | **과목:** 융합보안 캡스톤 디자인
> **최초 작성:** 2026-04-17 | **최종 업데이트:** 2026-04-17 (진짜 Idemix 반영)

---

## 목차

1. [비교 구조 및 측정 환경](#1-비교-구조-및-측정-환경)
2. [A단계: Idemix 도입 전 (기준선)](#2-a단계-idemix-도입-전-기준선)
3. [B단계: PS-BN254 (진짜 Hyperledger Fabric Idemix CL)](#3-b단계-ps-bn254-진짜-hyperledger-fabric-idemix-cl)
4. [C단계: BBS+-BLS12381 (개선된 Idemix, IRTF 표준)](#4-c단계-bbs-bls12381-개선된-idemix-irtf-표준)
5. [3단계 종합 비교](#5-3단계-종합-비교)
6. [결론 및 시사점](#6-결론-및-시사점)

---

## 1. 비교 구조 및 측정 환경

### 1-1. 3단계 비교 구조

```
[A단계] Idemix 도입 전 (기준선)
  환경:    IDEMIX_ENABLED=false
  암호:    없음
  특징:    인증 우회, 자격증명 없음, 익명성 없음

        ↓ 진짜 Idemix 도입 (Hyperledger Fabric과 동일 수학)

[B단계] PS-BN254 — 진짜 Hyperledger Fabric Idemix
  환경:    IDEMIX_ENABLED=true  IDEMIX_IMPL=ps
  암호:    Pointcheval-Sanders 서명 on BN254 (BN256) 곡선
  특징:    Fabric Idemix와 수학적으로 동등한 CL 서명,
           2 pairing 연산 per 검증
  파일:    src/lib/ps-idemix.js

        ↓ BBS+ 도입 (논문 기반 개선: 선택적 공개 + 완전 비연결성)

[C단계] BBS+-BLS12381 — 개선된 Idemix (IRTF CFRG 표준)
  환경:    IDEMIX_ENABLED=true  IDEMIX_IMPL=bbs
  암호:    BBS+ on BLS12-381 (IRTF draft-irtf-cfrg-bbs-signatures)
  특징:    선택적 공개 (voterEligible만 공개),
           매 요청 fresh nonce ZKP proof (완전 비연결성),
           Rust WASM 구현
  파일:    src/lib/bbs-idemix.js
```

### 1-2. B단계가 "진짜 Fabric Idemix"인 근거

Hyperledger Fabric Idemix 내부 구현:
- **곡선**: BN256 = **BN254** (동일 곡선, 명칭만 다름)
- **서명 방정식** (Pointcheval-Sanders):
  ```
  e(h, X · Y₁^m₁ · Y₂^m₂ · Y₃^m₃) == e(σ, g₂)
  ```
- **라이브러리**: Go `amcl` (Apache Milagro Crypto Library)

B단계 구현 (`src/lib/ps-idemix.js`):
- **동일 곡선**: BN254 (`@noble/curves`)
- **동일 서명 방정식**: 위와 완전히 동일
- **차이점**: Go amcl 대신 Node.js — 수학은 동등, 속도만 다름

### 1-3. C단계가 "개선"인 근거

| 항목 | B (PS-BN254) | C (BBS+-BLS12381) |
|------|-------------|------------------|
| 선택적 공개 | ❌ 모든 속성 노출 | ✅ voterEligible만 공개 |
| 비연결성 | △ h점 재사용 시 연결 가능 | ✅ 매 요청 fresh ZKP proof |
| 검증 복잡도 | O(k) — 속성 수 비례 | O(1) — 속성 수 무관 |
| 표준화 | Fabric 내부 | IRTF CFRG 국제 표준 |
| 구현 | Pure JS | Rust WASM (4-8x 빠름) |

### 1-4. 측정 환경

```
OS:         macOS Darwin 24.6.0 (Apple Silicon)
Node.js:    v25.7.0 + Express
인증:       src/middleware/auth.js
자격증명:   src/routes/credential.js + src/lib/ps-idemix.js + src/lib/bbs-idemix.js
측정 도구:  benchmark/real-idemix-bench.js
측정 일자:  2026-04-17
```

---

## 2. A단계: Idemix 도입 전 (기준선)

> 환경: `IDEMIX_ENABLED=false`

### 2-1. 인증 방식

```
bypass 모드: 인증 없이 통과
자격증명 없음, voterID 직접 노출, 익명성 없음
```

### 2-2. 인증 엔드포인트 TPS (동시성별)

| Workers | TPS | avg | P95 | P99 |
|---------|-----|-----|-----|-----|
| 1 | **12,395** | 0.08ms | — | 0.13ms |
| 5 | **28,960** | 0.17ms | — | 0.35ms |
| 10 | **28,752** | 0.34ms | — | 0.77ms |
| **20** | **29,118** | 0.68ms | — | 1.64ms |

### 2-3. 스트레스 테스트 (20 workers × 15초)

| TPS | avg | P99 | 에러율 |
|-----|-----|-----|--------|
| **29,441** | 0.68ms | 1.45ms | **0%** |

### 2-4. 인증 레이턴시 분포 (50회 단일 스레드)

| avg | P50 | P95 | P99 |
|-----|-----|-----|-----|
| **0.29ms** | 0.25ms | 0.51ms | 0.87ms |

### 2-5. Credential 발급 / 크기

```
발급: 없음 (bypass)
크기: 0 bytes
익명성: 없음
```

### 2-6. 보안 특성

| 항목 | 상태 |
|------|------|
| voterID 익명성 | ❌ 없음 |
| 쌍선형 서명 (ZKP) | ❌ 없음 |
| 비연결성 | ❌ 없음 |
| 선택적 공개 | ❌ 없음 |

---

## 3. B단계: PS-BN254 (진짜 Hyperledger Fabric Idemix CL)

> 환경: `IDEMIX_ENABLED=true IDEMIX_IMPL=ps IDEMIX_CACHE_ENABLED=false`

### 3-1. 인증 방식

```
Pointcheval-Sanders 서명 on BN254
  발급: h = g₁^u,  σ = h^(x + Σ yᵢ·H(mᵢ))
  검증: e(h, X·Y₁^m₁·Y₂^m₂·Y₃^m₃) == e(σ, g₂)
        ↑ Hyperledger Fabric Idemix와 완전히 동일한 방정식

속성: [voterEligible="1", electionID, exp]  — 3개 속성
```

### 3-2. Credential 발급 성능 (50회)

| 지표 | 측정값 | 비고 |
|------|--------|------|
| avg | **7.82ms** | 키 생성 후 hot path |
| P95 | 5.31ms | — |
| min | 3.43ms | — |
| max | **197.36ms** | 첫 호출 시 BN254 키 쌍 생성 포함 |
| **Credential 크기** | **359 bytes** | h(64B) + σ(64B) + attrs + expMs |
| 타입 | PS-BN254 | 쌍선형 서명 |
| 속성 수 | 3개 | voterEligible, electionID, exp |

### 3-3. 인증 레이턴시 분포 (50회 단일 스레드)

| avg | P50 | P95 | P99 | stddev |
|-----|-----|-----|-----|--------|
| **56.69ms** | 56.41ms | 59.77ms | 61.24ms | — |

> **원인**: BN254 pairing × 2 + G2 scalar mult × 3 (per 검증)

### 3-4. 인증 엔드포인트 TPS (동시성별)

| Workers | TPS | avg | P99 |
|---------|-----|-----|-----|
| 1 | **17.5** | 57.25ms | 78.2ms |
| 5 | **17.5** | 282.07ms | 527.35ms |
| 10 | **17.9** | 542.10ms | 1774.77ms |
| **20** | **18.2** | 1034.91ms | 7472.52ms |

> **관찰**: worker 수 증가 시 TPS 변화 없음 → Node.js 단일 스레드에서 crypto가 병목
> 실제 배포 시 cluster/worker_threads로 선형 확장 가능

### 3-5. 스트레스 테스트 (20 workers × 15초)

| TPS | avg | P99 | 에러율 |
|-----|-----|-----|--------|
| **18.2** | 1063.71ms | 2107.92ms | **0%** |

### 3-6. 보안 특성

| 항목 | 상태 |
|------|------|
| voterID 익명성 | ✅ credential에 voterID 미포함 |
| 쌍선형 서명 | ✅ 진짜 pairing-based 서명 |
| 공개키 검증 | ✅ 발급자 공개키로 누구나 검증 가능 |
| 비연결성 | △ credential 재사용 시 h 동일 → 연결 가능 |
| 선택적 공개 | ❌ 전체 속성 노출 |
| IRTF 표준화 | ❌ Fabric 내부 방식 |

---

## 4. C단계: BBS+-BLS12381 (개선된 Idemix, IRTF 표준)

> 환경: `IDEMIX_ENABLED=true IDEMIX_IMPL=bbs IDEMIX_CACHE_ENABLED=false`

### 4-1. 개선 내용

| 개선 항목 | B단계 (PS-BN254) | C단계 (BBS+) | 근거 |
|---------|-----------------|------------|------|
| **선택적 공개** | 전체 속성 노출 | voterEligible만 공개 | BBS IRTF Draft, ACL CCS 2013 |
| **비연결성** | h 재사용 시 연결 가능 | 매 요청 fresh nonce ZKP | Protego INDOCRYPT 2022 |
| **검증 복잡도** | O(k) — 속성 수 비례 | O(1) — 항상 2 pairing | BBS IRTF Draft |
| **구현 속도** | Pure JS (~57ms) | Rust WASM (~48ms) | @mattrglobal/bbs-signatures |
| **표준화** | Fabric 내부 | IRTF CFRG 국제 표준 | RFC 진행 중 |

### 4-2. Credential 발급 성능 (50회)

| 지표 | B단계 (PS) | C단계 (BBS+) | 변화 |
|------|-----------|------------|------|
| avg | 7.82ms | **8.07ms** | +0.25ms (+3.2%) |
| P95 | 5.31ms | **8.31ms** | — |
| min | 3.43ms | **6.90ms** | — |
| max | 197.36ms | **45.39ms** | -152ms (키 생성 빠름) |
| **크기** | 359 bytes | **326 bytes** | **-33 bytes (-9%)** |
| 타입 | PS-BN254 | BBS+-BLS12381 | — |

### 4-3. 인증 레이턴시 분포 (50회 단일 스레드)

| avg | P50 | P95 | P99 |
|-----|-----|-----|-----|
| **47.93ms** | 47.34ms | 48.50ms | 71.71ms |

> **구성**: `BBS.createProof()` ~29ms + `BBS.verifyProof()` ~22ms
> 매 요청마다 fresh nonce로 새로운 proof 생성 → 완전 비연결성

### 4-4. 인증 엔드포인트 TPS (동시성별)

| Workers | TPS | avg | P99 |
|---------|-----|-----|-----|
| 1 | **21** | 47.50ms | 48.9ms |
| 5 | **21.2** | 233.44ms | 423.64ms |
| 10 | **21.1** | 461.35ms | 1464.87ms |
| **20** | **21** | 902.98ms | 6487.57ms |

### 4-5. 스트레스 테스트 (20 workers × 15초)

| TPS | avg | P99 | 에러율 |
|-----|-----|-----|--------|
| **20.4** | 950.57ms | 1832.55ms | **0%** |

### 4-6. 보안 특성

| 항목 | A단계 | B단계 (PS-BN254) | **C단계 (BBS+)** |
|------|------|-----------------|----------------|
| voterID 익명성 | ❌ | ✅ | ✅ |
| 쌍선형 서명 | ❌ | ✅ BN254 | ✅ BLS12-381 |
| 선택적 공개 | ❌ | ❌ | **✅ voterEligible만** |
| 비연결성 | ❌ | △ | **✅ 완전 (fresh nonce)** |
| ZKP proof | ❌ | 서명만 | **✅ 진짜 ZKP proof** |
| IRTF 표준 | ❌ | ❌ | **✅** |

---

## 5. 3단계 종합 비교

### 5-1. 인증 레이턴시 핵심 비교

| 단계 | 방식 | avg | P50 | P95 | P99 | A대비 오버헤드 |
|------|------|-----|-----|-----|-----|--------------|
| **A (bypass)** | 없음 | **0.29ms** | 0.25ms | 0.51ms | 0.87ms | 기준 |
| **B (PS-BN254)** | CL 서명 검증 | **56.69ms** | 56.41ms | 59.77ms | 61.24ms | +56.4ms (×195) |
| **C (BBS+)** | ZKP createProof+verify | **47.93ms** | 47.34ms | 48.50ms | 71.71ms | +47.6ms (×165) |

```
인증 레이턴시 시각화:
A ░ 0.3ms
B ███████████████████████████��████████████ 56.7ms
C █████████████████████████████████░░░░░░░ 47.9ms
```

### 5-2. TPS 비교 (20 workers)

| 단계 | TPS | A대비 | 비고 |
|------|-----|-------|------|
| A (bypass) | **29,118** | 기준 | crypto 없음 |
| B (PS-BN254) | **18.2** | −99.9% | pairing 병목 |
| C (BBS+) | **21.0** | −99.9% | WASM, 소폭 개선 |

> **중요**: B/C 둘 다 TPS 급감. Node.js 단일 스레드에서 ~50ms 암호 연산이 병목.
> `1000ms / 57ms ≈ 17.5 TPS` (B), `1000ms / 48ms ≈ 21 TPS` (C) — 계산과 일치.

### 5-3. 스트레스 TPS (20 workers × 15초)

| 단계 | TPS | avg | P99 | 에러율 |
|------|-----|-----|-----|--------|
| A (bypass) | **29,441** | 0.68ms | 1.45ms | 0% |
| B (PS-BN254) | **18.2** | 1063ms | 2108ms | 0% |
| C (BBS+) | **20.4** | 951ms | 1833ms | 0% |

### 5-4. Credential 성능 비교

| 항목 | B (PS-BN254) | C (BBS+) | 변화 |
|------|------------|---------|------|
| 발급 avg | 7.82ms | 8.07ms | +0.25ms |
| 첫 발급 max | 197ms | 45ms | −152ms |
| **크기** | **359 bytes** | **326 bytes** | **-9%** |
| 속성 수 | 3개 (전체 노출) | 3개 (1개만 공개) | — |
| 검증 가능 주체 | 공개키 보유자 | 공개키 보유자 | 동일 |
| 비연결성 | △ | ✅ | 개선 |

### 5-5. 속성 수에 따른 성능 스케일링

| 속성 수 | B PS verify | C BBS+ total | B/C 비율 |
|---------|------------|------------|---------|
| 3 | 57ms | 48ms | 1.19x |
| 10 | **128ms** | **69ms** | **1.86x** |
| 20 | ~260ms (추정) | ~90ms (추정) | ~2.9x |

> **핵심**: 속성이 많아질수록 BBS+의 이점이 증가.
> B (PS): G2 scalar mult가 k에 선형 O(k) / C (BBS+): pairing 2회 고정 O(1)

### 5-6. 전체 CastVote TPS 영향

```
CastVote TPS 결정 요인:
  Fabric BatchTimeout(2s) >> Endorsement(~200ms) >> Auth(57ms)

실측 (네트워크 가동 기준):
  A단계 CastVote TPS: ~4.7
  B단계 CastVote TPS: ~4.7  (동일)
  C단계 CastVote TPS: ~4.7  (동일)
```

인증 방식과 무관하게 CastVote TPS는 BatchTimeout이 지배적 병목.

### 5-7. 보안-성능 트레이드오프 요약

```
[보안 낮음 / 성능 높음]           [보안 높음 / 성능 낮음]

 A단계              B단계                 C단계
 bypass             PS-BN254              BBS+-BLS12381
 29,441 TPS         18.2 TPS              20.4 TPS
 인증 없음           진짜 Idemix CL         개선 ZKP (선택적 공개)
 익명성 없음         서명 검증              완전 비연결성
```

---

## 6. 결론 및 시사점

### 6-1. 성능 측면

**① Idemix 도입 비용**
- A→B: 0.29ms → 56.7ms (+56ms, ×195) — 쌍선형 pairing 2회의 본질적 비용
- B→C: 56.7ms → 47.9ms (−8.8ms, −15.4%) — WASM 최적화 효과

**② 전체 CastVote에 미치는 영향 — 없음**
- 인증 오버헤드 최대 57ms vs BatchTimeout 2,000ms → 오버헤드 비율 2.8%
- 실제 투표 엔드포인트 TPS(~4.7)는 세 단계 모두 동일
- TU Delft DAPPS 2024 논문의 "API 레이어 Idemix는 블록체인 TPS에 영향 없음" 결론과 일치

**③ 단일 프로세스 한계**
- B/C 모두 ~18-21 TPS (Node.js 단일 스레드 한계)
- `1000ms / latency_ms` = 이론적 최대 TPS와 정확히 일치
- 운영 시 Node.js cluster 또는 로드밸런서로 선형 확장 가능

### 6-2. 보안 측면

**① B단계 (PS-BN254) — 진짜 Idemix의 의미**
- Fabric Idemix와 동일한 BN254 곡선, 동일한 서명 방정식
- 공개키만 있으면 누구나 검증 가능 (서버 신뢰 불필요)
- 한계: 속성 전체 노출, credential 재사용 시 연결 가능

**② C단계 (BBS+) — 핵심 개선점**

| 개선 | 내용 |
|------|------|
| 선택적 공개 | "나는 투표 자격이 있다"만 증명, electionID는 숨김 |
| 완전 비연결성 | 동일 credential로 생성한 proof들끼리 연결 불가 |
| O(1) 검증 | 속성 10개 → PS 128ms vs BBS+ 69ms (1.86x 차이) |
| 표준화 | IRTF CFRG 국제 표준 → 장기 지속성 |

### 6-3. 한계 및 향후 개선 방향

| 한계 | 현재 상태 | 개선 방향 |
|------|----------|---------|
| Node.js 단일 스레드 | ~18-21 TPS | cluster 모드 → 코어 수 × TPS |
| Fabric CA 미연동 | 수학 등가 구현 | fabric-ca-client 실제 연동 |
| 양자 내성 없음 | BN254/BLS12-381 모두 양자 취약 | Post-Quantum (Falcon, Dilithium) |
| ZK-Rollup 미적용 | CastVote ~4.7 TPS | arXiv 2602.08870 Layer-2 |

### 6-4. 핵심 시사점 (3줄 요약)

1. **B단계(PS-BN254)는 Hyperledger Fabric Idemix의 수학적 등가 구현이다** — 동일한 BN254 곡선과 Pointcheval-Sanders 서명 방정식을 사용하며, 인증 레이턴시 ~57ms는 pairing 연산의 본질적 비용이다.

2. **C단계(BBS+)는 선택적 공개와 완전 비연결성을 추가한 진짜 ZKP이다** — IRTF CFRG 표준, Rust WASM 구현으로 15% 빠르며, 속성이 많을수록 이점이 커진다(O(k) → O(1)).

3. **CastVote TPS는 세 단계 모두 ~4.7로 동일하다** — 인증 방식과 무관하게 Fabric BatchTimeout(2s)이 지배적 병목이며, API 레이어 Idemix는 실제 투표 처리량에 영향을 주지 않는다.

---

## 부록: 측정 재현 방법

```bash
cd mongbas/application
npm install   # @noble/curves, @mattrglobal/bbs-signatures 포함

# 3단계 자동 측정
bash benchmark/run-real-idemix.sh

# 단계별 개별 측정
# A단계
IDEMIX_ENABLED=false node src/app.js &
node benchmark/real-idemix-bench.js --out benchmark-reports/real-A.json

# B단계 (진짜 Idemix CL)
IDEMIX_ENABLED=true IDEMIX_IMPL=ps node src/app.js &
node benchmark/real-idemix-bench.js --out benchmark-reports/real-B.json

# C단계 (BBS+ 개선)
IDEMIX_ENABLED=true IDEMIX_IMPL=bbs node src/app.js &
node benchmark/real-idemix-bench.js --out benchmark-reports/real-C.json
```

| 파일 | 설명 |
|------|------|
| `src/lib/ps-idemix.js` | PS-BN254 서명 구현 (B단계) |
| `src/lib/bbs-idemix.js` | BBS+-BLS12381 ZKP (C단계) |
| `benchmark/real-idemix-bench.js` | 측정 스크립트 |
| `benchmark/run-real-idemix.sh` | 3단계 자동 오케스트레이션 |
| `benchmark-reports/real-*.json` | 원시 JSON 측정 데이터 |
| `docs/performance/REAL_IDEMIX_COMPARISON_REPORT.md` | 상세 분석 보고서 |

> 이전 HMAC-SHA256 vs Ed25519 비교 결과는 git 히스토리에서 확인 가능.

---

*최종 업데이트: 2026-04-17 | 팀 몽바스*
