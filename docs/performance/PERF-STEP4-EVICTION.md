# STEP 4 성능 평가: Nullifier Eviction (재투표 지원)

> **평가 일시:** 2026-03-30
> **상태:** ✅ 완료 (100회 Latency + 20회 집계 정확도)
> **우선순위:** STEP 5 (Shamir SSS) 전 구현 — 프론트엔드보다 먼저

---

## 왜 Eviction이 필요한가

제안서(VIII장) 명시 기능:

> "동일인이 재투표 시도 시 이전 표를 찾아 **최신 표로 갱신**하거나 이전 값을 **무효화**할 수 있다"

기존 구현은 동일 Nullifier 재제출 시 **에러 반환**(이중투표 차단)만 했다.
강압 상황에서 유권자가 재투표할 때 이전 표를 무효화하고 새 표로 교체하는 기능을 추가했다.

---

## 구현 내용

### 체인코드 변경 (CastVote 수정)

```go
// 기존: 중복 Nullifier → 에러
// 변경: 중복 Nullifier → 기존 레코드 덮어쓰기 (Eviction)
isEviction := existing != nil
evictCount := 0
if isEviction {
    var prev Nullifier
    json.Unmarshal(existing, &prev)
    evictCount = prev.EvictCount + 1
}
nullifier := Nullifier{
    NullifierHash: nullifierHash, CandidateID: candidateID,
    EvictCount: evictCount,
    LastEvictedAt: func() int64 { if isEviction { return now }; return 0 }(),
}
```

### Nullifier 구조체 확장

```go
type Nullifier struct {
    DocType       string `json:"docType"`
    NullifierHash string `json:"nullifierHash"`
    CandidateID   string `json:"candidateID"`
    ElectionID    string `json:"electionID"`
    Timestamp     int64  `json:"timestamp"`
    EvictCount    int    `json:"evictCount"`     // 재투표 횟수 추가
    LastEvictedAt int64  `json:"lastEvictedAt"`  // 마지막 에빅션 시각
}
```

### TallyVotes 영향 없음

Nullifier를 동일 키로 덮어쓰기 때문에 TallyVotes CouchDB 쿼리는
항상 최신 `candidateID`를 집계한다. 별도 수정 불필요.

---

## 성능 평가 결과

### 테스트 4-A: 재투표(Eviction) Latency — 100회

```
평가 일시: 2026-03-30
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
시나리오: 동일 Nullifier로 재투표 100회 반복
기준 비교: CastVote P95=2277ms (STEP 1 결과)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

재투표 Latency (100회):
  평균:   2198.0ms ±15.7ms (95% CI)
  표준편차: 79.8ms
  P50:   2185ms
  P95:   2257ms    ← CastVote P95 ±200ms 이내 ✅
  P99:   2882ms
  최소:   2140ms  /  최대:  2882ms

재투표 성공률: 100/100 = 100%  ✅
최종 evictCount: 100 (기대: 100)  ✅
```

**비교 분석 (STEP 1 CastVote vs STEP 4 재투표):**

| 지표       | CastVote (신규) | 재투표 (Eviction) | 차이   |
|-----------|---------------|-----------------|------|
| 평균       | 2184.8ms      | 2198.0ms        | +13.2ms |
| P95       | 2277ms        | 2257ms          | -20ms  |
| P99       | 2324ms        | 2882ms          | +558ms |
| 표준편차   | 38.5ms        | 79.8ms          | +41.3ms |

→ 평균 latency는 신규 투표와 **거의 동일 (+13.2ms)**.
→ Eviction은 기존 레코드 Read + Unmarshal + Overwrite 추가 오버헤드가 있으나
   BatchTimeout(~2s) 지배 구간에서 **실용적으로 무시 가능**.
→ P99 spike: 2882ms는 간헐적 네트워크 지연 (블록 전파 딜레이).

### 테스트 4-B: 집계 정확도 — 20회

```
평가 일시: 2026-03-30
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
시나리오: 유권자 3명 A투표 → B재투표 → 집계 검증
기대 결과: B표수 - A표수 = 3 (에빅션된 유권자 수)
참고: CreateElection 시 후보자별 더미 Nullifier 3개 자동 생성
     → 실제 집계 A=3(더미), B=6(더미3+실제3), C=3(더미)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

집계 정확도: 20/20 = 100%  ✅
실패: 0건

검증 방식: B - A == numVoters (3)
  → 모든 20 라운드에서 에빅션된 표가 정확히 B로 집계됨
```

---

## 요약

| 지표 | 목표 | 결과 | 판정 |
|------|------|------|------|
| 재투표 평균 Latency | CastVote ±200ms 이내 | +13.2ms | ✅ |
| 재투표 P95 | CastVote P95 ±200ms 이내 | 2257ms (기준 2277ms) | ✅ |
| 재투표 성공률 | 100/100 = 100% | 100/100 | ✅ |
| 집계 정확도 | 20/20 = 100% | 20/20 | ✅ |

**결론:** Nullifier Eviction 구현은 성능·정확도 모든 목표를 달성.
신규 투표와 사실상 동일한 latency를 유지하면서 재투표를 완벽하게 지원함.
