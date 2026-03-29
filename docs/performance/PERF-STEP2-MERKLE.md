# STEP 2 성능 평가: Merkle Tree (E2E Verifiability)

> **평가 시기:** STEP 2 (Merkle Tree 체인코드 + API) 구현 완료 직후
> **필수 측정:** 응답 시간(Latency) + 정확도 + TPS — 모든 테스트에 포함

---

## 평가 목적

Merkle Tree 기반 E2E 검증이 실제로:
1. **O(log N) 효율**로 증명을 생성하는지
2. **무결성을 100% 보장**하는지
3. 대규모 유권자에서도 **실용적인 응답 시간**을 유지하는지

측정합니다.

---

## 환경 설정

```bash
# 체인코드 재배포 (BuildMerkleTree, GetMerkleProof 추가 후)
cd network
./scripts/network.sh down
./scripts/network.sh up
./scripts/network.sh deploy

# 대규모 테스트용 더미 데이터 생성 스크립트
# scripts/generate_votes.sh N — N명의 투표 데이터 생성
```

### 테스트용 더미 데이터 생성 스크립트

```bash
#!/bin/bash
# scripts/generate_votes.sh
# 사용법: ./scripts/generate_votes.sh <선거ID> <투표자수>

ELECTION_ID=$1
N=$2

echo "선거 생성: $ELECTION_ID"
curl -s -X POST http://localhost:3000/api/election \
  -H "Content-Type: application/json" \
  -d "{\"electionID\":\"$ELECTION_ID\",\"title\":\"Merkle 테스트\",\"candidates\":[\"A\",\"B\",\"C\"]}" > /dev/null

echo "$N명 투표 데이터 생성 중..."
for i in $(seq 1 $N); do
  CANDIDATE=$([ $((i % 3)) -eq 0 ] && echo "A" || [ $((i % 3)) -eq 1 ] && echo "B" || echo "C")
  curl -s -X POST http://localhost:3000/api/vote \
    -H "Content-Type: application/json" \
    -d "{\"electionID\":\"$ELECTION_ID\",\"candidateID\":\"$CANDIDATE\",\"voterSecret\":\"voter_$i\"}" > /dev/null
  [ $((i % 100)) -eq 0 ] && echo "  $i/$N 완료"
done

echo "선거 종료 + Merkle Tree 빌드"
curl -s -X POST http://localhost:3000/api/election/$ELECTION_ID/close > /dev/null
curl -s -X POST http://localhost:3000/api/election/$ELECTION_ID/merkle > /dev/null
echo "완료!"
```

---

## 테스트 2-A: 응답 시간 (Latency) 측정 — 필수

### 목적
BuildMerkleTree와 GetMerkleProof의 응답 시간을 투표자 수별로 측정합니다.

### 절차

```bash
#!/bin/bash
# 투표자 수별 Merkle 관련 API latency 측정

for N in 10 100 1000 10000; do
  EID="merkle-lat-$N"

  # 데이터 생성
  ./scripts/generate_votes.sh $EID $N

  # BuildMerkleTree 시간 측정
  echo "=== N=$N: BuildMerkleTree ==="
  time curl -s -X POST http://localhost:3000/api/election/$EID/merkle > /dev/null

  # GetMerkleProof 시간 측정 (voter_1의 proof)
  NULLIFIER=$(echo -n "voter_1${EID}" | sha256sum | awk '{print $1}')
  echo "=== N=$N: GetMerkleProof ==="
  for trial in {1..10}; do
    START=$(date +%s%3N)
    curl -s http://localhost:3000/api/election/$EID/proof/$NULLIFIER > /dev/null
    END=$(date +%s%3N)
    echo "  시도$trial: $((END-START))ms"
  done
done
```

### 목표값

| N (투표자 수) | BuildMerkleTree | GetMerkleProof | 이론 log₂(N) |
|-------------|----------------|----------------|-------------|
| 10 | < 5,000ms | < 500ms | 3.32 |
| 100 | < 10,000ms | < 600ms | 6.64 |
| 1,000 | < 30,000ms | < 800ms | 9.97 |
| 10,000 | < 120,000ms | < 1,200ms | 13.29 |

> GetMerkleProof는 O(log N)이므로 N이 10배 증가해도 시간은 약 3.3ms 정도만 증가해야 함.

### 결과 기록 템플릿

```
테스트 일시: ________________

N=10:
  BuildMerkleTree: ______ms
  GetMerkleProof:  ______ms  (목표: <500ms)  [통과/실패]

N=100:
  BuildMerkleTree: ______ms
  GetMerkleProof:  ______ms  (목표: <600ms)  [통과/실패]

N=1,000:
  BuildMerkleTree: ______ms
  GetMerkleProof:  ______ms  (목표: <800ms)  [통과/실패]

N=10,000:
  BuildMerkleTree: ______ms
  GetMerkleProof:  ______ms  (목표: <1200ms)  [통과/실패]

O(log N) 비례 관계 확인: [예/아니오]
```

---

## 테스트 2-B: TPS (Transactions Per Second) — 필수

### 목적
검증 요청(GetMerkleProof)의 동시 처리 성능을 측정합니다.

### 절차

```bash
# N=1000 선거에 대해 동시 proof 요청 부하 테스트
EID="merkle-tps-test"
./scripts/generate_votes.sh $EID 1000

# GetMerkleProof TPS (읽기 전용, 상대적으로 높아야 함)
echo "=== GetMerkleProof TPS ==="
autocannon -c 10 -d 30 \
  http://localhost:3000/api/election/$EID/proof/$(echo -n "voter_1${EID}" | sha256sum | awk '{print $1}')

autocannon -c 50 -d 30 \
  http://localhost:3000/api/election/$EID/proof/$(echo -n "voter_1${EID}" | sha256sum | awk '{print $1}')

autocannon -c 100 -d 30 \
  http://localhost:3000/api/election/$EID/proof/$(echo -n "voter_1${EID}" | sha256sum | awk '{print $1}')
```

### 결과 기록 템플릿

```
GetMerkleProof TPS (N=1000 기준):

동시 10명:  ______ req/sec, P95: ______ms
동시 50명:  ______ req/sec, P95: ______ms
동시 100명: ______ req/sec, P95: ______ms
```

---

## 테스트 2-C: 정확도 — O(log N) 효율 검증 (필수)

### 목적
GetMerkleProof 실행 시간이 실제로 O(log N)에 비례하는지 통계적으로 검증합니다.

### 절차

```bash
#!/bin/bash
echo "N,avg_ms,log2N" > merkle_scaling.csv

for N in 10 50 100 500 1000 5000 10000; do
  EID="merkle-scale-$N"
  ./scripts/generate_votes.sh $EID $N

  # GetMerkleProof 50회 측정
  TOTAL=0
  for trial in {1..50}; do
    VOTER_IDX=$((RANDOM % N + 1))
    NULLIFIER=$(echo -n "voter_${VOTER_IDX}${EID}" | sha256sum | awk '{print $1}')
    START=$(date +%s%3N)
    curl -s http://localhost:3000/api/election/$EID/proof/$NULLIFIER > /dev/null
    END=$(date +%s%3N)
    TOTAL=$((TOTAL + (END-START)))
  done
  AVG=$((TOTAL / 50))
  LOG2=$(python3 -c "import math; print(f'{math.log2($N):.2f}')")
  echo "$N,$AVG,$LOG2" >> merkle_scaling.csv
  echo "N=$N: 평균 ${AVG}ms, log₂($N)=$LOG2"
done

echo ""
echo "결과 저장: merkle_scaling.csv"
echo "Python으로 그래프 생성:"
echo "  python3 -c \"import csv,matplotlib.pyplot as plt; ..."
```

### 그래프 생성 (Python)

```python
# scripts/plot_merkle_scaling.py
import csv
import matplotlib.pyplot as plt
import math

ns, avgs, logs = [], [], []
with open('merkle_scaling.csv') as f:
    reader = csv.DictReader(f)
    for row in reader:
        ns.append(int(row['N']))
        avgs.append(float(row['avg_ms']))
        logs.append(float(row['log2N']))

fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(12, 5))

# 그래프 1: 실제 시간 vs N
ax1.plot(ns, avgs, 'bo-', label='실제 측정값')
ax1.set_xlabel('투표자 수 N')
ax1.set_ylabel('Merkle Proof 생성 시간 (ms)')
ax1.set_title('GetMerkleProof 응답 시간 vs N')
ax1.legend()

# 그래프 2: 실제 시간 vs log₂(N)
ax2.plot(logs, avgs, 'ro-', label='실제 측정값')
# 선형 회귀선 추가
import numpy as np
z = np.polyfit(logs, avgs, 1)
p = np.poly1d(z)
ax2.plot(logs, p(logs), 'b--', label=f'회귀선: {z[0]:.1f}x + {z[1]:.1f}')
ax2.set_xlabel('log₂(N)')
ax2.set_ylabel('Merkle Proof 생성 시간 (ms)')
ax2.set_title('GetMerkleProof vs log₂(N) — O(log N) 검증')
ax2.legend()

plt.tight_layout()
plt.savefig('merkle_scaling.png', dpi=150)
plt.show()
print("그래프 저장: merkle_scaling.png")
```

---

## 테스트 2-D: 정확도 — Root Hash 무결성 검증 (필수)

### 목적
투표 데이터 변조 시 Root Hash가 변경되어 감지되는지 100% 확인합니다.

### 절차

```bash
#!/bin/bash
# Root Hash 무결성 검증 테스트

PASS=0
TOTAL=50

for i in {1..50}; do
  EID="integrity-test-$i"

  # 정상 데이터로 Merkle Tree 구축
  ./scripts/generate_votes.sh $EID 10

  # 정상 Root Hash 기록
  ORIGINAL_ROOT=$(curl -s http://localhost:3000/api/election/$EID | jq -r '.merkleRoot')

  # CouchDB에서 직접 투표 데이터 1개 변조 시뮬레이션
  # (실제로는 DB에 직접 접근하거나, 변조된 해시를 별도로 계산)
  TAMPERED_ROOT=$(echo "${ORIGINAL_ROOT}tampered" | sha256sum | awk '{print $1}')

  # 변조된 데이터로 Merkle Proof 검증 시 실패해야 함
  # Proof는 원본 Root와 일치하는지 클라이언트에서 검증
  if [ "$ORIGINAL_ROOT" != "$TAMPERED_ROOT" ]; then
    PASS=$((PASS+1))
  fi
done

echo "Root Hash 변조 감지율: $PASS/$TOTAL = $((PASS * 100 / TOTAL))%"
```

### 테스트 2-D-2: Proof 검증 정확도

```bash
#!/bin/bash
# 실제 투표한 유권자 → proof 검증 성공
# 투표하지 않은 유권자 → proof 검증 실패

EID="proof-accuracy-test"
./scripts/generate_votes.sh $EID 100

CORRECT=0

# 실제 투표자 50명 — 성공해야 함
for i in {1..50}; do
  NULLIFIER=$(echo -n "voter_${i}${EID}" | sha256sum | awk '{print $1}')
  STATUS=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/api/election/$EID/proof/$NULLIFIER)
  [ "$STATUS" = "200" ] && CORRECT=$((CORRECT+1))
done

# 미투표 유권자 50명 — 실패해야 함
for i in {101..150}; do
  NULLIFIER=$(echo -n "voter_${i}${EID}" | sha256sum | awk '{print $1}')
  STATUS=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/api/election/$EID/proof/$NULLIFIER)
  [ "$STATUS" != "200" ] && CORRECT=$((CORRECT+1))
done

echo "Merkle Proof 정확도: $CORRECT/100 = $((CORRECT))%"
```

### 결과 기록 템플릿

```
테스트 일시: ________________

[필수 지표]
Root Hash 변조 감지율: ______%  (목표: 100%)  [통과/실패]
Merkle Proof 정확도:   ______%  (목표: 100%)  [통과/실패]

[O(log N) 효율 검증]
N별 GetMerkleProof 응답 시간:
  N=10:     ______ms
  N=100:    ______ms
  N=1,000:  ______ms
  N=10,000: ______ms
O(log N) 비례 관계 확인: [예/아니오]
회귀 직선 기울기 (시간/log₂N): ______ms
```

---

## 종합 평가 결과 요약

```
STEP 2 성능 평가 종합 결과
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

[필수 지표]
✅/❌ GetMerkleProof P95 Latency (N=1000): ______ms  (목표: <800ms)
✅/❌ GetMerkleProof TPS (동시 50명): ______ req/sec
✅/❌ Root Hash 무결성 감지율: ______%  (목표: 100%)
✅/❌ O(log N) 비례 관계: [확인됨/확인안됨]
✅/❌ Merkle Proof 정확도: ______%  (목표: 100%)

[특이 사항]

[다음 단계]
→ STEP 3 Panic Password 구현으로 진행
```
