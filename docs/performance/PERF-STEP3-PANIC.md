# STEP 3 성능 평가: Panic Password (Deniable Verification)

> **평가 시기:** STEP 3 (Panic Password 체인코드 + API) 구현 완료 직후
> **필수 측정:** 응답 시간(Latency) + 정확도 + TPS — 모든 테스트에 포함

---

## 평가 목적

Panic Password가 실제로:
1. Normal과 Panic 모드를 **응답 시간으로 구분할 수 없는지** (Timing Safety)
2. 가짜 Merkle 증명이 **실제 Root Hash 검증을 통과하는지** (Indistinguishability)
3. 강압자가 **Panic Mode 사용 여부를 감지할 수 없는지** (Coercion Resistance)

측정합니다.

---

## 환경 설정

```bash
# 체인코드 재배포 (Panic Password 로직 추가 후)
cd network && ./scripts/network.sh down && ./scripts/network.sh up && ./scripts/network.sh deploy

# 테스트 선거 생성 (더미 데이터 포함)
curl -s -X POST http://localhost:3000/api/election \
  -H "Content-Type: application/json" \
  -d '{
    "electionID": "panic-test",
    "title": "Panic Test 선거",
    "candidates": ["A","B"],
    "dummyVotes": 100
  }'

# 테스트 유권자 등록 (normalPW + panicPW)
curl -s -X POST http://localhost:3000/api/voter/register \
  -H "Content-Type: application/json" \
  -d '{
    "electionID": "panic-test",
    "voterSecret": "test_voter_1",
    "normalPassword": "my-real-password-2026",
    "panicPassword": "help-im-under-duress"
  }'

# 투표 제출
curl -s -X POST http://localhost:3000/api/vote \
  -H "Content-Type: application/json" \
  -d '{"electionID":"panic-test","candidateID":"A","voterSecret":"test_voter_1"}'

# Merkle Tree 빌드
curl -s -X POST http://localhost:3000/api/election/panic-test/close
curl -s -X POST http://localhost:3000/api/election/panic-test/merkle
```

---

## 테스트 3-A: 응답 시간 (Latency) 측정 — 필수

### 목적
Normal Mode와 Panic Mode의 응답 시간 분포를 측정합니다.

### 절차

```bash
#!/bin/bash
# Normal Mode와 Panic Mode 각각 1000회 응답 시간 측정

ELECTION_ID="panic-test"
NULLIFIER=$(echo -n "test_voter_1${ELECTION_ID}" | sha256sum | awk '{print $1}')
NORMAL_PW_HASH=$(echo -n "my-real-password-2026" | sha256sum | awk '{print $1}')
PANIC_PW_HASH=$(echo -n "help-im-under-duress" | sha256sum | awk '{print $1}')

echo "Normal Mode 1000회 측정..."
rm -f normal_times.txt panic_times.txt

for i in {1..1000}; do
  START=$(date +%s%3N)
  curl -s "http://localhost:3000/api/election/$ELECTION_ID/proof/$NULLIFIER?password=$NORMAL_PW_HASH" > /dev/null
  END=$(date +%s%3N)
  echo $((END-START)) >> normal_times.txt
done

echo "Panic Mode 1000회 측정..."
for i in {1..1000}; do
  START=$(date +%s%3N)
  curl -s "http://localhost:3000/api/election/$ELECTION_ID/proof/$NULLIFIER?password=$PANIC_PW_HASH" > /dev/null
  END=$(date +%s%3N)
  echo $((END-START)) >> panic_times.txt
done

echo "통계 계산..."
python3 << 'EOF'
import statistics, scipy.stats as st

with open('normal_times.txt') as f:
    normal = [int(x) for x in f.readlines()]
with open('panic_times.txt') as f:
    panic = [int(x) for x in f.readlines()]

print(f"\nNormal Mode: 평균={statistics.mean(normal):.1f}ms, 표준편차={statistics.stdev(normal):.1f}ms")
print(f"Panic Mode:  평균={statistics.mean(panic):.1f}ms, 표준편차={statistics.stdev(panic):.1f}ms")

# Welch's t-test
t_stat, p_value = st.ttest_ind(normal, panic, equal_var=False)
print(f"\nWelch's t-test: t={t_stat:.4f}, p-value={p_value:.6f}")
if p_value > 0.05:
    print("✅ PASS: p > 0.05 → 두 모드 응답 시간 통계적으로 구분 불가 (타이밍 안전)")
else:
    print("❌ FAIL: p ≤ 0.05 → 두 모드 응답 시간 차이가 감지됨 (타이밍 취약)")

# Percentile 비교
import numpy as np
for pct in [50, 95, 99]:
    n_val = np.percentile(normal, pct)
    p_val = np.percentile(panic, pct)
    print(f"P{pct}: Normal={n_val:.0f}ms, Panic={p_val:.0f}ms, 차이={abs(n_val-p_val):.0f}ms")
EOF
```

### 목표값

| 지표 | 목표 | 비고 |
|------|------|------|
| Welch's t-test p-value | > 0.05 | 통계적으로 구분 불가 |
| Normal vs Panic 평균 차이 | < 100ms | 체감 불가 수준 |
| Normal P95 Latency | < 2,000ms | - |
| Panic P95 Latency | < 2,000ms | Normal과 동일 수준 |

### 결과 기록 템플릿

```
테스트 일시: ________________

Normal Mode (1000회):
  평균: ______ms, 표준편차: ______ms
  P50: ______ms, P95: ______ms, P99: ______ms

Panic Mode (1000회):
  평균: ______ms, 표준편차: ______ms
  P50: ______ms, P95: ______ms, P99: ______ms

Welch's t-test: t=______, p=______
타이밍 안전성: [통과/실패]  (p > 0.05이면 통과)
```

---

## 테스트 3-B: TPS — 필수

### 목적
Normal/Panic 모드 각각의 처리량을 측정합니다.

### 절차

```bash
ELECTION_ID="panic-tps-test"
NULLIFIER=$(echo -n "test_voter_1${ELECTION_ID}" | sha256sum | awk '{print $1}')
NORMAL_PW_HASH=$(echo -n "real-password" | sha256sum | awk '{print $1}')
PANIC_PW_HASH=$(echo -n "panic-password" | sha256sum | awk '{print $1}')

# Normal Mode TPS
echo "=== Normal Mode TPS ==="
autocannon -c 50 -d 30 \
  "http://localhost:3000/api/election/$ELECTION_ID/proof/$NULLIFIER?password=$NORMAL_PW_HASH"

# Panic Mode TPS
echo "=== Panic Mode TPS ==="
autocannon -c 50 -d 30 \
  "http://localhost:3000/api/election/$ELECTION_ID/proof/$NULLIFIER?password=$PANIC_PW_HASH"
```

### 결과 기록 템플릿

```
Normal Mode TPS: ______ req/sec
Panic Mode TPS:  ______ req/sec
TPS 차이: ______%  (목표: < 10%)  [통과/실패]
```

---

## 테스트 3-C: 정확도 — 식별 불가능성 검증 (필수)

### 목적
외부 검증자가 Normal과 Panic 증명을 구분할 수 없는지 확인합니다.

### C-1: Root Hash 검증 통과율

```bash
#!/bin/bash
# Normal Proof와 Panic Proof 각 100개 생성 → Root Hash 검증 통과율 확인

PASS_NORMAL=0
PASS_PANIC=0

for i in {1..100}; do
  # 투표자 등록 + 투표
  curl -s -X POST http://localhost:3000/api/voter/register \
    -H "Content-Type: application/json" \
    -d "{\"electionID\":\"panic-test\",\"voterSecret\":\"indist_voter_$i\",\"normalPassword\":\"real_pw_$i\",\"panicPassword\":\"panic_pw_$i\"}" > /dev/null
  curl -s -X POST http://localhost:3000/api/vote \
    -H "Content-Type: application/json" \
    -d "{\"electionID\":\"panic-test\",\"candidateID\":\"A\",\"voterSecret\":\"indist_voter_$i\"}" > /dev/null

  NULLIFIER=$(echo -n "indist_voter_${i}panic-test" | sha256sum | awk '{print $1}')
  NORMAL_HASH=$(echo -n "real_pw_$i" | sha256sum | awk '{print $1}')
  PANIC_HASH=$(echo -n "panic_pw_$i" | sha256sum | awk '{print $1}')

  # Normal Proof → Root Hash와 일치해야 함
  NORMAL_PROOF=$(curl -s "http://localhost:3000/api/election/panic-test/proof/$NULLIFIER?password=$NORMAL_HASH")
  ROOT=$(curl -s http://localhost:3000/api/election/panic-test | jq -r '.merkleRoot')

  # 클라이언트에서 Root Hash 재계산 검증
  VERIFIED=$(python3 -c "
import json, hashlib
proof = json.loads('$NORMAL_PROOF')
# Merkle Path 따라 Root 재계산
current = proof['leafHash']
for node in proof['path']:
    if node['position'] == 'left':
        current = hashlib.sha256((node['hash'] + current).encode()).hexdigest()
    else:
        current = hashlib.sha256((current + node['hash']).encode()).hexdigest()
print('1' if current == '$ROOT' else '0')
" 2>/dev/null || echo "0")

  [ "$VERIFIED" = "1" ] && PASS_NORMAL=$((PASS_NORMAL+1))

  # Panic Proof → Normal Root Hash와 일치해야 함 (핵심!)
  PANIC_PROOF=$(curl -s "http://localhost:3000/api/election/panic-test/proof/$NULLIFIER?password=$PANIC_HASH")
  PANIC_VERIFIED=$(python3 -c "
import json, hashlib
proof = json.loads('$PANIC_PROOF')
current = proof['leafHash']
for node in proof['path']:
    if node['position'] == 'left':
        current = hashlib.sha256((node['hash'] + current).encode()).hexdigest()
    else:
        current = hashlib.sha256((current + node['hash']).encode()).hexdigest()
print('1' if current == '$ROOT' else '0')
" 2>/dev/null || echo "0")

  [ "$PANIC_VERIFIED" = "1" ] && PASS_PANIC=$((PASS_PANIC+1))
done

echo "Normal Proof Root Hash 검증 통과율: $PASS_NORMAL/100 = ${PASS_NORMAL}%"
echo "Panic Proof Root Hash 검증 통과율:  $PASS_PANIC/100 = ${PASS_PANIC}%"
```

### C-2: 강압자 감지 가능성 시뮬레이션

```bash
#!/bin/bash
# 강압자가 Normal vs Panic을 분류 시도하는 시뮬레이션
# 강압자가 알 수 있는 정보: Root Hash, 제출된 Proof
# 강압자가 모르는 정보: voterSecret, normalPWHash, panicPWHash

DETECTED=0
TOTAL=100

for i in {1..100}; do
  # 랜덤하게 Normal 또는 Panic Proof를 생성
  MODE=$((RANDOM % 2))  # 0=Normal, 1=Panic

  if [ $MODE -eq 0 ]; then
    PROOF=$(curl -s "http://localhost:3000/api/election/panic-test/proof/$NULLIFIER?password=$NORMAL_HASH")
  else
    PROOF=$(curl -s "http://localhost:3000/api/election/panic-test/proof/$NULLIFIER?password=$PANIC_HASH")
  fi

  # 강압자의 감지 시도: Proof의 leafHash가 실제 nullifier와 일치하는지 확인
  # (강압자는 nullifier를 모르므로 실제로는 이 검증도 불가)
  LEAF_HASH=$(echo $PROOF | jq -r '.leafHash')
  ACTUAL_NULLIFIER=$(echo -n "indist_voter_${i}panic-test" | sha256sum | awk '{print $1}')

  # 만약 leafHash == hash(nullifier)라면 Normal이라고 추측
  GUESSED_LEAF=$(echo -n "$ACTUAL_NULLIFIER" | sha256sum | awk '{print $1}')

  if [ "$LEAF_HASH" = "$GUESSED_LEAF" ] && [ $MODE -eq 0 ]; then
    DETECTED=$((DETECTED+1))
  elif [ "$LEAF_HASH" != "$GUESSED_LEAF" ] && [ $MODE -eq 1 ]; then
    DETECTED=$((DETECTED+1))
  fi
done

echo "강압자 감지 성공률: $DETECTED/$TOTAL = $((DETECTED))%"
echo "기대값: 50% (무작위 추측 수준 = 감지 불가)"
```

### 결과 기록 템플릿

```
테스트 일시: ________________

[필수 지표]
Normal Proof Root 검증 통과율: ______%  (목표: 100%)  [통과/실패]
Panic Proof Root 검증 통과율:  ______%  (목표: 100%)  [통과/실패]
Welch's t-test p-value: ______  (목표: > 0.05)  [통과/실패]

[타이밍 안전성]
Normal 평균 응답: ______ms
Panic 평균 응답:  ______ms
평균 차이: ______ms  (목표: < 100ms)  [통과/실패]

[강압자 감지율]
강압자 감지 성공률: ______%  (목표: ≈50%, 즉 무작위 추측 수준)  [통과/실패]
```

---

## 테스트 3-D: 정확도 — 모드 분기 정확도 (필수)

```bash
#!/bin/bash
# Normal 비밀번호 → 실제 투표 후보 반환
# Panic 비밀번호 → 조작된 후보 반환 (실제 투표와 다른 후보)
# 잘못된 비밀번호 → 오류 반환

PASS=0

for i in {1..50}; do
  # A에 투표한 유권자
  curl -s -X POST http://localhost:3000/api/vote \
    -H "Content-Type: application/json" \
    -d "{\"electionID\":\"panic-test\",\"candidateID\":\"A\",\"voterSecret\":\"mode_test_$i\"}" > /dev/null

  NULLIFIER=$(echo -n "mode_test_${i}panic-test" | sha256sum | awk '{print $1}')
  NORMAL_HASH=$(echo -n "real_$i" | sha256sum | awk '{print $1}')
  PANIC_HASH=$(echo -n "panic_$i" | sha256sum | awk '{print $1}')
  WRONG_HASH=$(echo -n "wrong_$i" | sha256sum | awk '{print $1}')

  # Normal Mode → 실제 Proof (leafHash가 실제 nullifier 기반)
  NORMAL_RESP=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:3000/api/election/panic-test/proof/$NULLIFIER?password=$NORMAL_HASH")

  # Panic Mode → 가짜 Proof (200 OK이지만 다른 leafHash)
  PANIC_RESP=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:3000/api/election/panic-test/proof/$NULLIFIER?password=$PANIC_HASH")

  # 잘못된 비밀번호 → 오류 (4xx)
  WRONG_RESP=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:3000/api/election/panic-test/proof/$NULLIFIER?password=$WRONG_HASH")

  if [ "$NORMAL_RESP" = "200" ] && [ "$PANIC_RESP" = "200" ] && [ "$WRONG_RESP" != "200" ]; then
    PASS=$((PASS+1))
  fi
done

echo "모드 분기 정확도: $PASS/50 = $((PASS*2))%"
```

---

## 종합 평가 결과 요약

```
STEP 3 성능 평가 종합 결과
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

[필수 지표]
✅/❌ Normal P95 Latency: ______ms  (목표: <2000ms)
✅/❌ Panic P95 Latency:  ______ms  (목표: <2000ms)
✅/❌ TPS (Normal): ______ req/sec
✅/❌ TPS (Panic):  ______ req/sec  (Normal의 90% 이상이면 통과)
✅/❌ Normal Proof Root 검증: ______%  (목표: 100%)
✅/❌ Panic Proof Root 검증:  ______%  (목표: 100%)

[타이밍 안전성]
✅/❌ Welch's t-test p-value: ______  (목표: >0.05)

[강압 저항성]
✅/❌ 강압자 감지율: ______%  (목표: ≈50%)

[다음 단계]
→ STEP 4 React 프론트엔드 구현으로 진행
```
