# STEP 6 성능 평가: Hyperledger Caliper 종합 평가

> **평가 시기:** 모든 기능 구현 완료 후 (5월 3~4주차)
> **목적:** 시스템 전체의 성능, 무결성, 확장성을 Caliper로 종합 정량화
> **필수 측정:** 응답 시간(Latency) + 정확도 + TPS — 모든 테스트에 포함

---

## 환경 설정

```bash
# 1. Caliper 설치
npm install -g @hyperledger/caliper-cli@0.6.0
caliper bind --caliper-bind-sut fabric:2.5

# 2. Caliper 디렉토리 구조 생성
mkdir -p caliper/{networks,benchmarks,workload,reports}

# 3. 네트워크 기동
cd network && ./scripts/network.sh up && ./scripts/network.sh deploy
```

### Caliper 네트워크 설정 파일

```yaml
# caliper/networks/fabric-voting.yaml
name: fabric-voting-network
version: "2.0.0"

caliper:
  blockchain: fabric

info:
  Version: 2.5.0
  Size: 4 Orderers + 4 Peers
  Orderer: etcdraft
  Distribution: Single Host

clients:
  client0.electioncommission:
    client:
      organization: ElectionCommissionMSP
      credentialStore:
        path: ./tmp/credstore
      clientPrivateKey:
        path: ./network/organizations/peerOrganizations/electioncommission.example.com/users/User1@electioncommission.example.com/msp/keystore/
      clientSignedCert:
        path: ./network/organizations/peerOrganizations/electioncommission.example.com/users/User1@electioncommission.example.com/msp/signcerts/

channels:
  votingchannel:
    created: true
    orderers:
      - orderer1.example.com
      - orderer2.example.com
      - orderer3.example.com
      - orderer4.example.com
    peers:
      peer0.electioncommission.example.com:
        endorsingPeer: true
        chaincodeQuery: true
      peer0.partyobserver.example.com:
        endorsingPeer: true
      peer0.civilsociety.example.com:
        endorsingPeer: true

chaincodes:
  - id: voting
    version: v1.0
    language: golang
    path: ./chaincode/voting
```

---

## 테스트 6-A: 기본 TPS/Latency 벤치마크 — 필수

### Caliper 워크로드 파일

```javascript
// caliper/workload/castVote.js
'use strict';

const { WorkloadModuleBase } = require('@hyperledger/caliper-core');
const crypto = require('crypto');

class CastVoteWorkload extends WorkloadModuleBase {
  constructor() {
    super();
    this.txIndex = 0;
  }

  async initializeWorkloadModule(workerIndex, totalWorkers, roundIndex, roundArguments, sutAdapter, sutContext) {
    await super.initializeWorkloadModule(workerIndex, totalWorkers, roundIndex, roundArguments, sutAdapter, sutContext);
    this.electionID = roundArguments.electionID || 'caliper-test';
    this.workerIndex = workerIndex;
  }

  async submitTransaction() {
    this.txIndex++;
    const voterSecret = `worker_${this.workerIndex}_tx_${this.txIndex}_${Date.now()}`;
    const candidateID = ['A','B','C'][this.txIndex % 3];
    const nullifierHash = crypto.createHash('sha256')
      .update(voterSecret + this.electionID)
      .digest('hex');

    const request = {
      contractId: 'voting',
      contractFunction: 'CastVote',
      contractArguments: [this.electionID, candidateID, nullifierHash],
      transientData: {
        voteData: Buffer.from(JSON.stringify({
          electionID: this.electionID,
          candidateID,
          nullifierHash
        }))
      },
      timeout: 60
    };

    return this.sutAdapter.sendRequests(request);
  }
}

module.exports.createWorkloadModule = () => new CastVoteWorkload();
```

### Caliper 벤치마크 설정

```yaml
# caliper/benchmarks/voting-tps.yaml
test:
  name: VotingSystemBenchmark
  description: HLF 기반 전자투표 시스템 종합 성능 테스트

  rounds:
    # 라운드 1: 10명 동시
    - label: CastVote-10workers
      description: 동시 투표자 10명
      txNumber: 500
      rateControl:
        type: fixed-load
        opts:
          transactionLoad: 10
      workload:
        module: workload/castVote.js
        arguments:
          electionID: caliper-round1

    # 라운드 2: 50명 동시
    - label: CastVote-50workers
      description: 동시 투표자 50명
      txNumber: 2000
      rateControl:
        type: fixed-load
        opts:
          transactionLoad: 50
      workload:
        module: workload/castVote.js
        arguments:
          electionID: caliper-round2

    # 라운드 3: 100명 동시
    - label: CastVote-100workers
      description: 동시 투표자 100명
      txNumber: 5000
      rateControl:
        type: fixed-load
        opts:
          transactionLoad: 100
      workload:
        module: workload/castVote.js
        arguments:
          electionID: caliper-round3

    # 라운드 4: 읽기 전용 (GetTally)
    - label: GetTally-concurrent
      description: 동시 집계 조회 100명
      txNumber: 1000
      rateControl:
        type: fixed-load
        opts:
          transactionLoad: 100
      workload:
        module: workload/getTally.js
        arguments:
          electionID: caliper-round1
```

### 실행

```bash
caliper launch manager \
  --caliper-workspace ./caliper \
  --caliper-networkconfig networks/fabric-voting.yaml \
  --caliper-benchconfig benchmarks/voting-tps.yaml \
  --caliper-report-path reports/tps-$(date +%Y%m%d).html

echo "리포트: caliper/reports/tps-$(date +%Y%m%d).html"
```

### 목표값

| 라운드 | 동시 사용자 | 목표 TPS | 목표 P95 Latency |
|--------|------------|---------|----------------|
| 1 | 10명 | > 10 TPS | < 2,000ms |
| 2 | 50명 | > 30 TPS | < 2,500ms |
| 3 | 100명 | > 50 TPS | < 3,000ms |
| 4 | 100명 (읽기) | > 200 TPS | < 500ms |

### 결과 기록 템플릿

```
Caliper 실행 일시: ________________
리포트 파일: caliper/reports/tps-________.html

[필수 지표 - TPS]
동시 10명  TPS: ______ (목표: >10)  [통과/실패]
동시 50명  TPS: ______ (목표: >30)  [통과/실패]
동시 100명 TPS: ______ (목표: >50)  [통과/실패]

[필수 지표 - Latency]
동시 10명  P95: ______ms (목표: <2000ms)  [통과/실패]
동시 50명  P95: ______ms (목표: <2500ms)  [통과/실패]
동시 100명 P95: ______ms (목표: <3000ms)  [통과/실패]
```

---

## 테스트 6-B: Byzantine Fault Injection — 정확도 필수 포함

### 목적
악의적 노드가 있어도 투표 무결성이 100% 유지되는지 측정합니다.

### 환경 구성

```bash
# 4개 오더러 환경에서 Fault Injection 시나리오
# 시나리오 1: 정상 (F=0)
# 시나리오 2: 오더러 1개 다운 (F=1, CFT 허용 범위)
# 시나리오 3: 오더러 1개 네트워크 격리 (F=1, 더 현실적)
# 시나리오 4: 오더러 2개 다운 (F=2, CFT 임계치 초과)
```

### Fault Injection 자동화 스크립트

```bash
#!/bin/bash
# scripts/fault_injection_test.sh

run_fault_test() {
  local SCENARIO=$1
  local FAULT_NODE=$2
  local ELECTION_ID="fault-test-$SCENARIO"

  echo "=== 시나리오 $SCENARIO 시작 ==="

  # 선거 생성
  curl -s -X POST http://localhost:3000/api/election \
    -H "Content-Type: application/json" \
    -d "{\"electionID\":\"$ELECTION_ID\",\"title\":\"Fault Test\",\"candidates\":[\"A\",\"B\"]}" > /dev/null

  # Fault Injection
  if [ "$FAULT_NODE" != "none" ]; then
    echo "Fault 주입: $FAULT_NODE 격리"
    docker network disconnect fabric_test $FAULT_NODE 2>/dev/null || \
    docker exec $FAULT_NODE sh -c "iptables -A INPUT -j DROP" 2>/dev/null
  fi

  # 부하 테스트 실행 (Caliper)
  caliper launch manager \
    --caliper-workspace ./caliper \
    --caliper-networkconfig networks/fabric-voting.yaml \
    --caliper-benchconfig benchmarks/fault-injection.yaml \
    --caliper-benchconfig-override "test.rounds[0].workload.arguments.electionID=$ELECTION_ID" \
    --caliper-report-path reports/fault-$SCENARIO.html

  # Fault 복구
  if [ "$FAULT_NODE" != "none" ]; then
    docker network connect fabric_test $FAULT_NODE 2>/dev/null || \
    docker exec $FAULT_NODE sh -c "iptables -F" 2>/dev/null
    echo "Fault 복구 완료"
  fi

  # 집계 무결성 검증
  sleep 5
  curl -s -X POST http://localhost:3000/api/election/$ELECTION_ID/close > /dev/null
  TALLY=$(curl -s http://localhost:3000/api/election/$ELECTION_ID/tally)
  echo "집계 결과: $TALLY"
}

# 시나리오별 실행
run_fault_test "F0_baseline" "none"
run_fault_test "F1_orderer_down" "orderer2.example.com"
run_fault_test "F1_network_isolate" "orderer3.example.com"
```

### Fault Injection 결과 기록 템플릿

```
테스트 일시: ________________

[응답 시간 - 각 시나리오별]
F=0 (정상):        TPS=______, P95=______ms
F=1 (오더러 다운): TPS=______, P95=______ms
F=1 (네트워크 격리): TPS=______, P95=______ms

[정확도 - 무결성 유지율]
F=0 (정상):        무결성 유지 ______%  (목표: 100%)  [통과/실패]
F=1 (오더러 다운): 무결성 유지 ______%  (목표: 100%)  [통과/실패]
F=1 (네트워크 격리): 무결성 유지 ______%  (목표: 100%)  [통과/실패]
F=2 (초과):        네트워크 중단 여부 [예/아니오]

[위조 트랜잭션 차단]
주입된 위조 수: ______건
차단된 위조 수: ______건
차단율: ______%  (목표: 100%)  [통과/실패]
```

---

## 테스트 6-C: 오더러 수 변화에 따른 TPS/Latency — 필수

### 목적
오더러 노드 수가 4 → 7 → 10으로 증가할 때 TPS와 Latency 변화를 정량화합니다.

### 오더러 수별 docker-compose 파일 작성

```bash
# network/docker-compose-7orderers.yaml (7개 오더러)
# network/docker-compose-10orderers.yaml (10개 오더러)
# 각각 configtx.yaml도 수정 필요 (ConsenterCount 변경)
```

### 실행 스크립트

```bash
#!/bin/bash
# scripts/orderer_scaling_test.sh

for N_ORDERERS in 4 7 10; do
  echo "=== 오더러 $N_ORDERERS개 테스트 ==="

  # 네트워크 재기동 (오더러 수 변경)
  cd network
  ./scripts/network.sh down
  ORDERER_COUNT=$N_ORDERERS ./scripts/network.sh up
  ./scripts/network.sh deploy
  cd ..

  # Caliper 실행
  caliper launch manager \
    --caliper-workspace ./caliper \
    --caliper-networkconfig networks/fabric-voting-${N_ORDERERS}orderers.yaml \
    --caliper-benchconfig benchmarks/voting-tps.yaml \
    --caliper-report-path reports/orderers-${N_ORDERERS}.html

  echo "오더러 ${N_ORDERERS}개 리포트: caliper/reports/orderers-${N_ORDERERS}.html"
done
```

### 결과 기록 템플릿

```
[TPS vs 오더러 수]
오더러 4개 (기본):
  TPS (동시 50명): ______ req/sec
  P95 Latency: ______ms

오더러 7개 (F=2 허용):
  TPS (동시 50명): ______ req/sec
  P95 Latency: ______ms
  TPS 감소율 대비 4개: ______%

오더러 10개 (최대):
  TPS (동시 50명): ______ req/sec
  P95 Latency: ______ms
  TPS 감소율 대비 4개: ______%

최적 노드 수: ______ (성능 저하 수용 가능한 최대)
```

---

## 테스트 6-D: O(N²) 통신 지연 분석 — 응답 시간 필수

### 목적
BFT 합의의 O(N²) 통신 복잡도가 실제 latency에 미치는 영향을 정량화합니다.

### 네트워크 지연 주입 스크립트

```bash
#!/bin/bash
# scripts/network_delay_test.sh

DELAYS=(0 10 50 100)
ORDERER_COUNTS=(4 7 10)

echo "N,delay_ms,avg_latency_ms,TPS" > delay_results.csv

for N in "${ORDERER_COUNTS[@]}"; do
  for DELAY in "${DELAYS[@]}"; do
    echo "=== 오더러 $N개, 지연 ${DELAY}ms ==="

    # 오더러 컨테이너에 네트워크 지연 주입
    for i in $(seq 1 $N); do
      CONTAINER="orderer${i}.example.com"
      if docker ps -q -f name=$CONTAINER | grep -q .; then
        if [ $DELAY -gt 0 ]; then
          docker exec $CONTAINER sh -c \
            "tc qdisc add dev eth0 root netem delay ${DELAY}ms 2>/dev/null || \
             tc qdisc change dev eth0 root netem delay ${DELAY}ms"
        fi
      fi
    done

    # Caliper로 TPS/Latency 측정
    RESULT=$(caliper launch manager \
      --caliper-workspace ./caliper \
      --caliper-networkconfig networks/fabric-voting-${N}orderers.yaml \
      --caliper-benchconfig benchmarks/voting-tps.yaml \
      --caliper-report-path /dev/null 2>&1 | \
      grep -E "Avg latency|Throughput" | tail -2)

    AVG_LAT=$(echo "$RESULT" | grep "Avg latency" | awk '{print $NF}' | tr -d 'ms')
    TPS=$(echo "$RESULT" | grep "Throughput" | awk '{print $NF}' | tr -d 'TPS')

    echo "$N,$DELAY,$AVG_LAT,$TPS" >> delay_results.csv
    echo "  결과: Latency=${AVG_LAT}ms, TPS=${TPS}"

    # 지연 제거
    for i in $(seq 1 $N); do
      CONTAINER="orderer${i}.example.com"
      docker exec $CONTAINER sh -c "tc qdisc del dev eth0 root 2>/dev/null" || true
    done
  done
done

echo "결과: delay_results.csv"
```

### 그래프 생성

```python
# scripts/plot_network_delay.py
import csv
import matplotlib.pyplot as plt
import numpy as np
from collections import defaultdict

data = defaultdict(list)
with open('caliper/delay_results.csv') as f:
    reader = csv.DictReader(f)
    for row in reader:
        n, d = int(row['N']), int(row['delay_ms'])
        data[d].append((n, float(row['avg_latency_ms'])))

fig, axes = plt.subplots(1, 2, figsize=(14, 6))

# 그래프 1: 지연별 latency vs N
for delay, points in sorted(data.items()):
    ns = [p[0] for p in sorted(points)]
    lats = [p[1] for p in sorted(points)]
    axes[0].plot(ns, lats, 'o-', label=f'{delay}ms 지연')
    # O(N²) 이론선
    if delay > 0:
        theory = [delay * n**2 / 1000 for n in ns]
        axes[0].plot(ns, theory, '--', alpha=0.4, label=f'O(N²)×{delay}ms (이론)')

axes[0].set_xlabel('오더러 수 N')
axes[0].set_ylabel('평균 합의 Latency (ms)')
axes[0].set_title('네트워크 지연 vs 합의 Latency')
axes[0].legend()
axes[0].grid(True, alpha=0.3)

# 그래프 2: TPS 변화
for delay, points in sorted(data.items()):
    ns = [p[0] for p in sorted(points)]
    tps = [float(list(data.values())[0][i][1]) for i in range(len(ns))]  # placeholder
    axes[1].plot(ns, tps, 'o-', label=f'{delay}ms 지연')

axes[1].set_xlabel('오더러 수 N')
axes[1].set_ylabel('TPS')
axes[1].set_title('네트워크 지연 vs TPS')
axes[1].legend()
axes[1].grid(True, alpha=0.3)

plt.tight_layout()
plt.savefig('caliper/reports/network_delay_analysis.png', dpi=150)
print("그래프 저장: caliper/reports/network_delay_analysis.png")
```

---

## 테스트 6-E: Panic Password 타이밍 안전성 — 응답 시간 + 정확도 필수

```bash
#!/bin/bash
# Caliper 기반 Panic/Normal 대규모 타이밍 분석 (각 1000회)

# caliper/workload/merkleProof_normal.js
# caliper/workload/merkleProof_panic.js
# 위 워크로드 파일 준비 후:

caliper launch manager \
  --caliper-workspace ./caliper \
  --caliper-networkconfig networks/fabric-voting.yaml \
  --caliper-benchconfig benchmarks/panic-timing.yaml \
  --caliper-report-path reports/panic-timing.html
```

```python
# scripts/timing_ttest.py
import scipy.stats as st
import json

# Caliper 리포트에서 latency 데이터 추출
# (또는 별도 수집한 데이터 사용)
with open('normal_times.json') as f:
    normal = json.load(f)
with open('panic_times.json') as f:
    panic = json.load(f)

t_stat, p_value = st.ttest_ind(normal, panic, equal_var=False)
print(f"Welch's t-test: t={t_stat:.4f}, p={p_value:.6f}")
print(f"결론: {'✅ 타이밍 안전 (p>0.05)' if p_value > 0.05 else '❌ 타이밍 취약 (p≤0.05)'}")
```

---

## 최종 종합 결과 요약 테이블

```
STEP 6 Caliper 종합 성능 평가 결과
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

[필수 지표 요약]

TPS (동시 사용자별):
  10명:  ______ TPS  (목표: >10)   [통과/실패]
  50명:  ______ TPS  (목표: >30)   [통과/실패]
  100명: ______ TPS  (목표: >50)   [통과/실패]

Latency P95 (동시 사용자별):
  10명:  ______ms  (목표: <2000ms) [통과/실패]
  50명:  ______ms  (목표: <2500ms) [통과/실패]
  100명: ______ms  (목표: <3000ms) [통과/실패]

정확도:
  Fault Injection 무결성 (F=1): ______%  (목표: 100%)  [통과/실패]
  위조 트랜잭션 차단율: ______%  (목표: 100%)  [통과/실패]
  Panic 타이밍 t-test p-value: ______  (목표: >0.05)  [통과/실패]

확장성:
  TPS 감소율 (4→10 오더러): ______%
  최적 오더러 수: ______개
  O(N²) 이론 vs 실측 일치 여부: [일치/불일치]

[리포트 파일]
- caliper/reports/tps-________.html
- caliper/reports/fault-*.html
- caliper/reports/orderers-*.html
- caliper/reports/network_delay_analysis.png
```
