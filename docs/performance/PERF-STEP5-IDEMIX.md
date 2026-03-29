# STEP 5 성능 평가: Idemix 익명 인증 (선택)

> **평가 시기:** STEP 5 (Idemix + ZKP) 구현 완료 직후
> **중요:** 이 단계는 일정에 따라 선택 사항. 구현 시 반드시 평가 수행.
> **필수 측정:** 응답 시간(Latency) + 정확도 + TPS — 모든 테스트에 포함

---

## 평가 목적

Idemix ZKP 인증이:
1. Idemix 없는 기존 시스템 대비 **성능 오버헤드**가 수용 가능한 수준인지
2. 동일 유권자의 여러 ZKP가 **연결 불가능(Unlinkability)**한지
3. ZKP 검증이 투표 TPS에 미치는 **영향**을 정량화

측정합니다.

---

## 환경 설정

```bash
# Fabric CA Idemix 설정 확인
cat network/configtx.yaml | grep -A 5 "IdemixMSP"

# Idemix credential 발급 테스트
fabric-ca-client enroll \
  -u http://admin:adminpw@localhost:7054 \
  --idemix \
  --mspdir ./idemix-msp

# Idemix 연동 체인코드 재배포
cd network && ./scripts/network.sh down && ./scripts/network.sh up && ./scripts/network.sh deploy
```

---

## 테스트 5-A: 응답 시간 (Latency) — 필수

### 목적
Idemix ZKP 포함 투표 vs 일반 투표의 응답 시간 차이를 측정합니다.

### 절차

```bash
#!/bin/bash
# 기존 투표 (Idemix 없음) vs Idemix 투표 응답 시간 비교

echo "=== 기존 투표 (Idemix 없음) — 100회 ===" > latency_comparison.txt
for i in {1..100}; do
  START=$(date +%s%3N)
  curl -s -X POST http://localhost:3000/api/vote \
    -H "Content-Type: application/json" \
    -d "{\"electionID\":\"baseline-test\",\"candidateID\":\"A\",\"voterSecret\":\"baseline_$i\"}" > /dev/null
  END=$(date +%s%3N)
  echo "baseline $((END-START))" >> latency_comparison.txt
done

echo "=== Idemix 투표 — 100회 ===" >> latency_comparison.txt
for i in {1..100}; do
  # ZKP credential 생성 시간 포함
  START=$(date +%s%3N)
  curl -s -X POST http://localhost:3000/api/vote/idemix \
    -H "Content-Type: application/json" \
    -d "{\"electionID\":\"idemix-test\",\"candidateID\":\"A\",\"idemixCredPath\":\"./creds/voter_$i\"}" > /dev/null
  END=$(date +%s%3N)
  echo "idemix $((END-START))" >> latency_comparison.txt
done

python3 << 'EOF'
baseline = [int(l.split()[1]) for l in open('latency_comparison.txt') if l.startswith('baseline')]
idemix = [int(l.split()[1]) for l in open('latency_comparison.txt') if l.startswith('idemix')]

import statistics
b_avg = statistics.mean(baseline)
i_avg = statistics.mean(idemix)
overhead = (i_avg - b_avg) / b_avg * 100

print(f"기존 투표 평균: {b_avg:.0f}ms")
print(f"Idemix 투표 평균: {i_avg:.0f}ms")
print(f"오버헤드: +{overhead:.1f}%")
print(f"목표 (30% 이하): {'✅ 통과' if overhead <= 30 else '❌ 실패'}")
EOF
```

### ZKP 생성 vs 검증 분리 측정

```bash
# ZKP 생성 시간 (클라이언트 측)
echo "ZKP 생성 시간 측정..."
for i in {1..50}; do
  START=$(date +%s%3N)
  # Idemix credential로 ZKP proof 생성
  node -e "
    const { IdemixProof } = require('./idemix-lib');
    const cred = require('./creds/voter_$i.json');
    const proof = IdemixProof.generate(cred, { isEligibleVoter: true });
  "
  END=$(date +%s%3N)
  echo $((END-START))
done | awk '{sum+=$1; count++} END {print "ZKP 생성 평균: "sum/count"ms"}'

# ZKP 검증 시간 (체인코드 측 — 로그로 측정)
grep "ZKP_VERIFY_TIME" /var/log/fabric/peer*.log | \
  awk '{print $NF}' | \
  awk '{sum+=$1; count++} END {print "ZKP 검증 평균: "sum/count"ms"}'
```

### 결과 기록 템플릿

```
테스트 일시: ________________

[기존 투표 vs Idemix 투표]
기존 투표 평균 latency: ______ms
Idemix 투표 평균 latency: ______ms
오버헤드: +______%  (목표: ≤30%)  [통과/실패]

[ZKP 처리 시간 분리]
ZKP 생성 (클라이언트): ______ms
ZKP 검증 (체인코드): ______ms
ZKP 전체 처리: ______ms (전체 latency 중 ______%)
```

---

## 테스트 5-B: TPS — 필수

### 목적
Idemix ZKP 포함 투표의 처리량이 실용적 수준인지 측정합니다.

### 절차

```bash
# 기존 투표 TPS
echo "=== 기존 투표 TPS (동시 50명) ==="
autocannon -c 50 -d 60 -m POST \
  -H "Content-Type: application/json" \
  -b '{"electionID":"baseline-tps","candidateID":"A","voterSecret":"__RAND__"}' \
  http://localhost:3000/api/vote

# Idemix 투표 TPS
echo "=== Idemix 투표 TPS (동시 50명) ==="
autocannon -c 50 -d 60 -m POST \
  -H "Content-Type: application/json" \
  -b '{"electionID":"idemix-tps","candidateID":"A","idemixCredPath":"./creds/test"}' \
  http://localhost:3000/api/vote/idemix
```

### 결과 기록 템플릿

```
기존 투표 TPS (동시 50명): ______ req/sec
Idemix 투표 TPS (동시 50명): ______ req/sec
TPS 감소율: ______%  (목표: ≤30%)  [통과/실패]
```

---

## 테스트 5-C: 정확도 — Unlinkability (비연결성) 검증 (필수)

### 목적
동일 유권자가 여러 번 ZKP를 생성해도 pseudonym이 매번 달라야 합니다.
(ZKP가 연결 가능하면 투표 행동 패턴 추적 가능 → 익명성 파괴)

### 절차

```bash
#!/bin/bash
# 동일 유권자의 ZKP를 10회 생성 → pseudonym 값 비교

echo "동일 유권자 ZKP 10회 생성..."
PSEUDONYMS=()

for i in {1..10}; do
  PSEUDONYM=$(node -e "
    const { IdemixProof } = require('./idemix-lib');
    const cred = require('./creds/test_voter.json');
    const proof = IdemixProof.generate(cred, { isEligibleVoter: true });
    console.log(proof.pseudonym);
  ")
  PSEUDONYMS+=("$PSEUDONYM")
  echo "시도 $i: $PSEUDONYM"
done

# 중복 확인
UNIQUE=$(printf '%s\n' "${PSEUDONYMS[@]}" | sort -u | wc -l)
TOTAL=${#PSEUDONYMS[@]}

if [ "$UNIQUE" -eq "$TOTAL" ]; then
  echo "✅ 비연결성 확인: 모든 pseudonym이 유일 ($UNIQUE/$TOTAL 고유값)"
else
  echo "❌ 비연결성 실패: 중복 pseudonym 감지 ($UNIQUE/$TOTAL 고유값)"
fi
```

### 로그 기반 ID 추론 가능성 검증

```bash
# 체인코드 실행 로그에서 유권자 ID 추론 가능한지 확인
echo "체인코드 로그에서 voterID 관련 정보 검색..."
docker logs peer0.electioncommission.example.com 2>&1 | \
  grep -i "voter\|identity\|certificate\|enrollment" | \
  head -20

# 기대: 로그에 실제 유권자 ID가 나타나지 않아야 함
```

### 결과 기록 템플릿

```
테스트 일시: ________________

[비연결성 검증]
동일 유권자 ZKP 10회 생성 → 고유 pseudonym: ______개/10
비연결성: [확인됨/실패]  (목표: 10개 모두 고유)

[익명성 보존]
체인코드 로그에서 실제 ID 추론 가능 여부: [가능/불가능]  (목표: 불가능)

[정확도 요약]
ZKP 검증 성공률 (유효한 credential): ______%  (목표: 100%)
ZKP 거부율 (무효한 credential): ______%  (목표: 100%)
```

---

## 종합 평가 결과 요약

```
STEP 5 성능 평가 종합 결과
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

[필수 지표]
✅/❌ Latency 오버헤드: +______%  (목표: ≤30%)
✅/❌ TPS 감소율: ______%  (목표: ≤30%)
✅/❌ ZKP 검증 정확도: ______%  (목표: 100%)
✅/❌ 비연결성 (Unlinkability): [확인됨/실패]
✅/❌ 로그 익명성: [보존됨/파괴됨]

[다음 단계]
→ STEP 6 Caliper 종합 성능 평가로 진행
```
