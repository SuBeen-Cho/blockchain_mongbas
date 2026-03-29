# STEP 1 성능 평가: Node.js REST API

> **평가 시기:** STEP 1 (Node.js REST API) 구현 완료 직후
> **필수 측정:** 응답 시간(Latency) + 정확도 + TPS — 모든 테스트에 포함

---

## 평가 목적

Node.js Fabric Gateway SDK를 통한 REST API가 실제 투표 워크로드를 처리할 수 있는지
성능과 정확도를 정량적으로 측정합니다.

---

## 환경 설정

```bash
# 1. 네트워크 기동 확인
cd network && ./scripts/network.sh up && ./scripts/network.sh deploy

# 2. REST API 서버 기동
cd application && npm install && npm start
# 서버: http://localhost:3000

# 3. 테스트 도구 설치
npm install -g autocannon

# 4. 초기 데이터 준비 (선거 생성)
curl -s -X POST http://localhost:3000/api/election \
  -H "Content-Type: application/json" \
  -d '{"electionID":"perf-test-1","title":"성능테스트선거","candidates":["A","B","C"],"startTime":"2026-04-01T00:00:00Z","endTime":"2026-06-30T00:00:00Z"}'
```

---

## 테스트 1-A: 응답 시간 (Latency) 측정 — 필수

### 목적
단일 투표 트랜잭션의 P50/P95/P99 latency를 측정합니다.

### 절차

```bash
# 방법 1: autocannon — 연결 1개, 30초
autocannon \
  -c 1 -d 30 -m POST \
  -H "Content-Type: application/json" \
  -b '{"electionID":"perf-test-1","candidateID":"A","voterSecret":"secret_001"}' \
  http://localhost:3000/api/vote

# 방법 2: curl로 단일 요청 latency 측정
for i in {1..100}; do
  START=$(date +%s%3N)
  curl -s -X POST http://localhost:3000/api/vote \
    -H "Content-Type: application/json" \
    -d "{\"electionID\":\"perf-test-1\",\"candidateID\":\"A\",\"voterSecret\":\"secret_$i\"}" \
    > /dev/null
  END=$(date +%s%3N)
  echo "$((END-START))"
done | awk '{sum+=$1; count++; if(NR==1||$1>max)max=$1; if(NR==1||$1<min)min=$1} END {print "평균: "sum/count"ms | 최소: "min"ms | 최대: "max"ms"}'
```

### 목표값

| 지표 | 목표 | 비고 |
|------|------|------|
| P50 Latency | < 1,000ms | 정상 상황 응답 |
| P95 Latency | < 2,000ms | 95% 요청 기준 |
| P99 Latency | < 3,000ms | 99% 요청 기준 |

### 결과 기록 템플릿

```
테스트 일시: ________________
단일 연결, 30초 실행

P50 Latency: ______ms  (목표: <1000ms)  [통과/실패]
P95 Latency: ______ms  (목표: <2000ms)  [통과/실패]
P99 Latency: ______ms  (목표: <3000ms)  [통과/실패]
Min Latency: ______ms
Max Latency: ______ms
```

---

## 테스트 1-B: TPS (Transactions Per Second) — 필수

### 목적
동시 투표자 수에 따른 처리량 변화를 측정합니다.

### 절차

```bash
# 동시 연결 수를 바꾸며 3회 반복 측정

# 동시 10명
echo "=== 동시 10명 ===" && autocannon -c 10 -d 60 -m POST \
  -H "Content-Type: application/json" \
  -b '{"electionID":"perf-test-1","candidateID":"A","voterSecret":"__RAND__"}' \
  http://localhost:3000/api/vote 2>&1 | grep -E "Req/Sec|Latency"

# 동시 50명
echo "=== 동시 50명 ===" && autocannon -c 50 -d 60 -m POST \
  -H "Content-Type: application/json" \
  -b '{"electionID":"perf-test-1","candidateID":"A","voterSecret":"__RAND__"}' \
  http://localhost:3000/api/vote 2>&1 | grep -E "Req/Sec|Latency"

# 동시 100명
echo "=== 동시 100명 ===" && autocannon -c 100 -d 60 -m POST \
  -H "Content-Type: application/json" \
  -b '{"electionID":"perf-test-1","candidateID":"A","voterSecret":"__RAND__"}' \
  http://localhost:3000/api/vote 2>&1 | grep -E "Req/Sec|Latency"
```

> **주의:** voterSecret은 각 요청마다 유일해야 Nullifier 충돌 없이 정상 투표됩니다.
> 테스트 스크립트에서 UUID 또는 인덱스 기반 고유값 사용 권장.

### 목표값

| 동시 사용자 수 | 목표 TPS | 비고 |
|---------------|---------|------|
| 10명 | > 10 TPS | 기본 처리 능력 |
| 50명 | > 30 TPS | 중간 부하 |
| 100명 | > 50 TPS | 실용 목표 (선행 연구 기준) |

### 결과 기록 템플릿

```
테스트 일시: ________________

동시 10명:
  TPS: ______ req/sec  (목표: >10)  [통과/실패]
  P95 Latency: ______ms
  오류율: ______%

동시 50명:
  TPS: ______ req/sec  (목표: >30)  [통과/실패]
  P95 Latency: ______ms
  오류율: ______%

동시 100명:
  TPS: ______ req/sec  (목표: >50)  [통과/실패]
  P95 Latency: ______ms
  오류율: ______%
```

---

## 테스트 1-C: 정확도 검증 — 필수

### 목적
모든 API가 기능적으로 정확히 동작하는지 검증합니다.

### C-1: 중복 투표 방지 정확도

**목표: 중복 투표 차단율 100%**

```bash
#!/bin/bash
# 동일 voterSecret으로 2회 투표 시도 100번 반복

PASS=0
FAIL=0

for i in {1..100}; do
  VOTER_SECRET="duplicate_test_$i"

  # 1번째 투표 → 성공해야 함
  RESP1=$(curl -s -o /dev/null -w "%{http_code}" -X POST http://localhost:3000/api/vote \
    -H "Content-Type: application/json" \
    -d "{\"electionID\":\"perf-test-1\",\"candidateID\":\"A\",\"voterSecret\":\"$VOTER_SECRET\"}")

  # 2번째 투표 (동일 secret) → 실패해야 함 (409 or 400)
  RESP2=$(curl -s -o /dev/null -w "%{http_code}" -X POST http://localhost:3000/api/vote \
    -H "Content-Type: application/json" \
    -d "{\"electionID\":\"perf-test-1\",\"candidateID\":\"B\",\"voterSecret\":\"$VOTER_SECRET\"}")

  if [ "$RESP1" = "200" ] && [ "$RESP2" != "200" ]; then
    PASS=$((PASS+1))
  else
    FAIL=$((FAIL+1))
    echo "실패 케이스 $i: 1차=$RESP1, 2차=$RESP2"
  fi
done

echo "중복 투표 차단율: $PASS/100 = $(echo "scale=1; $PASS" | bc)%"
```

### C-2: 선거 생성 + 투표 + 집계 플로우 정확도

```bash
#!/bin/bash
# 전체 플로우 10회 반복 테스트

PASS=0
for i in {1..10}; do
  EID="flow-test-$i"

  # 선거 생성
  curl -s -X POST http://localhost:3000/api/election \
    -H "Content-Type: application/json" \
    -d "{\"electionID\":\"$EID\",\"title\":\"테스트$i\",\"candidates\":[\"A\",\"B\"]}" > /dev/null

  # A에 3표, B에 2표
  for j in {1..3}; do
    curl -s -X POST http://localhost:3000/api/vote \
      -H "Content-Type: application/json" \
      -d "{\"electionID\":\"$EID\",\"candidateID\":\"A\",\"voterSecret\":\"voter_A_${i}_${j}\"}" > /dev/null
  done
  for j in {1..2}; do
    curl -s -X POST http://localhost:3000/api/vote \
      -H "Content-Type: application/json" \
      -d "{\"electionID\":\"$EID\",\"candidateID\":\"B\",\"voterSecret\":\"voter_B_${i}_${j}\"}" > /dev/null
  done

  # 선거 종료 + 집계
  curl -s -X POST http://localhost:3000/api/election/$EID/close > /dev/null
  TALLY=$(curl -s http://localhost:3000/api/election/$EID/tally)

  A_COUNT=$(echo $TALLY | jq '.A')
  B_COUNT=$(echo $TALLY | jq '.B')

  if [ "$A_COUNT" = "3" ] && [ "$B_COUNT" = "2" ]; then
    PASS=$((PASS+1))
  else
    echo "FAIL $i: A=$A_COUNT (기대:3), B=$B_COUNT (기대:2)"
  fi
done

echo "집계 정확도: $PASS/10 = $(echo "scale=0; $PASS * 10" | bc)%"
```

### 결과 기록 템플릿

```
테스트 일시: ________________

중복 투표 차단율: ______/100 = ______%  (목표: 100%)  [통과/실패]
집계 정확도: ______/10 = ______%  (목표: 100%)  [통과/실패]
선거 생성 성공률: ______%
API 오류 응답 정확도 (잘못된 입력에 4xx 반환): ______%
```

---

## 테스트 1-D: API별 개별 Latency 비교

### 목적
각 엔드포인트의 상대적 성능을 비교합니다.

```bash
# CreateElection latency
time curl -s -X POST http://localhost:3000/api/election \
  -H "Content-Type: application/json" \
  -d '{"electionID":"lat-test","title":"test","candidates":["A","B"]}'

# CastVote latency (가장 복잡한 트랜잭션)
time curl -s -X POST http://localhost:3000/api/vote \
  -H "Content-Type: application/json" \
  -d '{"electionID":"lat-test","candidateID":"A","voterSecret":"test_latency"}'

# GetTally latency (읽기 전용)
time curl -s http://localhost:3000/api/election/lat-test/tally
```

### 결과 기록 템플릿

```
엔드포인트별 평균 응답 시간 (100회 측정 평균):

POST /api/election        : ______ms
POST /api/vote            : ______ms  ← 가장 중요
POST /api/election/:id/close: ______ms
GET  /api/election/:id/tally: ______ms
GET  /api/nullifier/:hash : ______ms
```

---

## 종합 평가 결과 요약

```
STEP 1 성능 평가 종합 결과
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

[필수 지표]
✅/❌ 응답 시간 P95 < 2000ms:    ______ms
✅/❌ TPS (100명 동시): ______ req/sec (목표: >50)
✅/❌ 중복 투표 차단율:  ______%  (목표: 100%)
✅/❌ 집계 정확도:       ______%  (목표: 100%)

[특이 사항]
(성능 병목 지점, 오류 원인 등 기록)

[다음 단계]
→ STEP 2 Merkle Tree 구현으로 진행
```
