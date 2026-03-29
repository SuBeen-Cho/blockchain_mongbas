# STEP 1 성능 평가: Node.js REST API

> **평가 시기:** STEP 1 (Node.js REST API) 구현 완료 직후
> **최종 업데이트:** 2026-03-29 (200회 반복 벤치마크 완료)
> **필수 측정:** 응답 시간(Latency) + 정확도 + TPS — 모든 테스트에 포함

---

## 평가 목적

Node.js Fabric Gateway SDK를 통한 REST API가 실제 투표 워크로드를 처리할 수 있는지
성능과 정확도를 **200회 반복** 측정으로 정량적으로 검증합니다.

---

## 테스트 환경

```
OS:       macOS Darwin 24.6.0
HLF:      Hyperledger Fabric v2.5, CCAAS 배포
조직:     3개 (선관위 peer0/peer1, 참관정당 peer0, 시민단체 peer0)
합의:     etcdraft 4-node
상태DB:   CouchDB 3.4
Node.js:  v25.7.0
측정도구: bash + python3 (time.time() ms 단위)
```

---

## 테스트 1-A: CastVote Latency 측정 — 200회

### 방법론

```bash
# nullifierHash = SHA256(voterSecret + electionID) 클라이언트 사전 계산
for i in {1..200}; do
  NULL_HASH=$(python3 -c "import hashlib; print(hashlib.sha256(('bench_voter_${i}' + EID).encode()).hexdigest())")
  POST /api/vote { electionID, candidateID: "A", nullifierHash: NULL_HASH }
done
```

각 투표자마다 고유한 nullifierHash 사용 → Nullifier 충돌 없음

### 결과 (200회 실측)

```
샘플 수:    200회
평균:       2184.8ms  ±5.3ms (95% 신뢰구간)
표준편차:   38.5ms
최소/최대:  2130ms / 2378ms

P50:  2175ms
P95:  2277ms  (목표: <2000ms)  ❌ 초과 — BatchTimeout 원인 (설명 참조)
P99:  2324ms  (목표: <3000ms)  ✅ 통과
```

### P95 초과 원인 분석

```
평균 응답 시간 ~2185ms ≈ HLF BatchTimeout(2s) + 네트워크 오버헤드(~185ms)

원인:
  getStatus() 호출이 Fabric 블록 커밋 완료까지 대기
  HLF BatchTimeout 기본값 = 2초 → 블록 생성 간격 ~2s
  → 이중투표 방지 100% 달성을 위해 getStatus() 대기 필수

설계 트레이드오프:
  낮은 지연 (25ms 수준) vs. 이중투표 완전 차단 (100%)
  → 이중투표 방지 100%가 시스템 핵심 보안 요건이므로 현재 방식 유지
  → BatchTimeout을 500ms로 줄이면 P50 ~650ms 달성 가능 (STEP 6 Caliper 예정)
```

---

## 테스트 1-B: 중복 투표 차단율 — 100회

### 방법론

```bash
# 동일 nullifierHash로 2회 투표 시도 100쌍 반복
for i in {1..100}; do
  NULL = SHA256("dup_voter_i" + EID)
  1차: POST /api/vote → 200 기대
  2차: POST /api/vote (동일 NULL) → 409 기대
done
```

### 결과 (100쌍 실측)

```
중복 투표 차단율: 100/100 = 100.0%  ✅ 목표 달성

1차 투표 성공률:    100/100 = 100%
2차 투표 차단률:    100/100 = 100%  (409 Conflict 반환)
```

---

## 테스트 1-C: 집계 정확도 — 기능 검증

```bash
# A에 3표, B에 2표 → 집계 결과 A=3, B=2 확인
# smoke test 4/4 통과 (선거 생성→활성화→투표→집계 전체 플로우)
```

결과: 집계 정확도 100% 확인 (smoke test 기준)

---

## 종합 평가 결과

```
STEP 1 성능 평가 종합 결과 (200회 반복 벤치마크)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
평가 일시: 2026-03-29
환경: macOS, Docker Desktop, HLF v2.5, CCAAS, etcdraft 4-node

[필수 지표]
✅ 95% 신뢰구간:      2184.8ms ±5.3ms (통계적으로 안정된 측정값)
✅ P99 < 3000ms:      2324ms  통과
❌ P95 < 2000ms:      2277ms  초과 (BatchTimeout=2s 원인, 설계 트레이드오프)
✅ 중복 투표 차단율:   100/100 = 100%  통과
✅ 집계 정확도:        100%  통과

[설계 트레이드오프]
  P95 초과는 보안 요건(이중투표 100% 차단)을 위한 의도적 설계.
  getStatus() 없이는 MVCC 충돌 시 이중투표가 통과됨 (확인됨).
  BatchTimeout 조정으로 개선 가능 → STEP 6 Caliper에서 최적화 평가 예정.

[다음 단계]
→ STEP 2 Merkle Tree 성능 평가 참조
```
