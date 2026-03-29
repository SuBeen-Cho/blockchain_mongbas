#!/usr/bin/env bash
# ============================================================
# 팀 몽바스 — 종합 성능 벤치마크 (100~200회 반복)
# STEP 1: CastVote Latency + 중복투표 차단
# STEP 2: Merkle Proof Latency (O(log N))
# STEP 3: Panic Password Normal/Panic 타이밍 비교
#
# 주의: nullifierHash = SHA256(voterSecret + electionID) 는
#       클라이언트(이 스크립트)에서 직접 계산해야 함
# ============================================================
set -euo pipefail

BASE_URL="http://localhost:3000"
RESULT_DIR="$(dirname "$0")/../docs/performance/bench_results"
mkdir -p "$RESULT_DIR"

log() { echo "[$(date '+%H:%M:%S')] $*"; }
sep() {
  echo ""
  echo "══════════════════════════════════════════════════════"
  echo "  $*"
  echo "══════════════════════════════════════════════════════"
}

# ──────────────────────────────────────────────
# 헬퍼: ms 단위 현재 시각 (macOS 호환)
# ──────────────────────────────────────────────
now_ms() {
  python3 -c "import time; print(int(time.time()*1000))"
}

# nullifierHash = SHA256(voterSecret + electionID)
nullifier_hash() {
  local secret="$1" eid="$2"
  python3 -c "import hashlib; print(hashlib.sha256(('${secret}' + '${eid}').encode()).hexdigest())"
}

sha256() {
  python3 -c "import hashlib; print(hashlib.sha256('$1'.encode()).hexdigest())"
}

# 헬퍼: 단일 GET 요청 latency (ms)
measure_get() {
  local url="$1"
  local start end
  start=$(now_ms)
  curl -s -o /dev/null "$url"
  end=$(now_ms)
  echo $((end - start))
}

# 헬퍼: 단일 POST 요청 latency (ms)
measure_post() {
  local url="$1" body="$2"
  local start end
  start=$(now_ms)
  curl -s -o /dev/null -X POST -H "Content-Type: application/json" -d "$body" "$url"
  end=$(now_ms)
  echo $((end - start))
}

# ──────────────────────────────────────────────
# STEP 1-A: CastVote 200회 Latency
# ──────────────────────────────────────────────
bench_step1_latency() {
  sep "STEP 1-A: CastVote Latency 200회 측정"
  local EID="bench-vote-$(date +%s)"
  local N=200

  log "선거 생성: $EID"
  curl -s -X POST "$BASE_URL/api/elections" \
    -H "Content-Type: application/json" \
    -d "{\"electionID\":\"$EID\",\"title\":\"벤치마크 투표선거\",\"candidates\":[\"A\",\"B\",\"C\"],\"startTime\":1774791523,\"endTime\":1874791523}" \
    -o /dev/null

  log "ActivateElection"
  curl -s -X POST "$BASE_URL/api/elections/$EID/activate" -o /dev/null

  log "CastVote ${N}회 측정 중 (nullifierHash 사전 계산)..."
  local TIMES_FILE="$RESULT_DIR/step1_vote_times.txt"
  rm -f "$TIMES_FILE"

  for i in $(seq 1 $N); do
    local NULL_HASH
    NULL_HASH=$(nullifier_hash "bench_voter_${i}" "$EID")
    local t
    t=$(measure_post "$BASE_URL/api/vote" \
      "{\"electionID\":\"$EID\",\"candidateID\":\"A\",\"nullifierHash\":\"$NULL_HASH\"}")
    echo "$t" >> "$TIMES_FILE"
    [ $((i % 20)) -eq 0 ] && log "  ${i}/${N} 완료..."
  done

  log "통계 계산..."
  python3 - "$TIMES_FILE" << 'PYEOF'
import sys, statistics, math

with open(sys.argv[1]) as f:
    data = sorted([int(x.strip()) for x in f if x.strip()])

n = len(data)
mean = statistics.mean(data)
stdev = statistics.stdev(data)
p50 = data[int(n * 0.50)]
p95 = data[int(n * 0.95)]
p99 = data[int(n * 0.99)]
mn, mx = data[0], data[-1]
ci = 1.96 * stdev / math.sqrt(n)

print(f"\n  샘플 수: {n}회")
print(f"  평균:    {mean:.1f}ms  ±{ci:.1f}ms (95% CI)")
print(f"  표준편차:{stdev:.1f}ms")
print(f"  최소/최대: {mn}ms / {mx}ms")
print(f"  P50:  {p50}ms")
print(f"  P95:  {p95}ms  (목표: <2000ms) {'✅ 통과' if p95 < 2000 else '❌ 초과'}")
print(f"  P99:  {p99}ms  (목표: <3000ms) {'✅ 통과' if p99 < 3000 else '❌ 초과'}")
PYEOF
}

# ──────────────────────────────────────────────
# STEP 1-B: 중복 투표 차단 100회
# ──────────────────────────────────────────────
bench_step1_duplicate() {
  sep "STEP 1-B: 중복 투표 차단율 100회"
  local EID="bench-dup-$(date +%s)"
  local N=100

  log "선거 생성 + 활성화: $EID"
  curl -s -X POST "$BASE_URL/api/elections" \
    -H "Content-Type: application/json" \
    -d "{\"electionID\":\"$EID\",\"title\":\"중복투표 테스트\",\"candidates\":[\"A\",\"B\"],\"startTime\":1774791523,\"endTime\":1874791523}" \
    -o /dev/null
  curl -s -X POST "$BASE_URL/api/elections/$EID/activate" -o /dev/null

  local PASS=0 FAIL=0

  log "100쌍 중복 투표 시도..."
  for i in $(seq 1 $N); do
    local NULL_HASH
    NULL_HASH=$(nullifier_hash "dup_voter_${i}" "$EID")

    # 1차 투표 → 200 기대
    local R1
    R1=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE_URL/api/vote" \
      -H "Content-Type: application/json" \
      -d "{\"electionID\":\"$EID\",\"candidateID\":\"A\",\"nullifierHash\":\"$NULL_HASH\"}")

    # 2차 투표 (동일 nullifierHash) → 409 기대
    local R2
    R2=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE_URL/api/vote" \
      -H "Content-Type: application/json" \
      -d "{\"electionID\":\"$EID\",\"candidateID\":\"B\",\"nullifierHash\":\"$NULL_HASH\"}")

    if [ "$R1" = "200" ] && [ "$R2" != "200" ]; then
      PASS=$((PASS + 1))
    else
      FAIL=$((FAIL + 1))
      echo "    [FAIL] i=$i 1차=$R1 2차=$R2"
    fi

    [ $((i % 20)) -eq 0 ] && log "  ${i}/${N}..."
  done

  echo ""
  local RATE
  RATE=$(python3 -c "print(f'{$PASS/$N*100:.1f}')")
  echo "  중복 투표 차단율: ${PASS}/${N} = ${RATE}%"
  if [ $PASS -eq $N ]; then
    echo "  ✅ 100% 차단 확인"
  else
    echo "  ❌ 차단 실패 ${FAIL}건 발생"
  fi
}

# ──────────────────────────────────────────────
# STEP 2: Merkle Proof 200회 + O(log N) 검증
# ──────────────────────────────────────────────
bench_step2_merkle() {
  sep "STEP 2: Merkle Proof Latency 200회 + O(log N) 검증"

  local SCALING_CSV="$RESULT_DIR/merkle_scaling.csv"
  echo "N,avg_ms,p50,p95,log2N" > "$SCALING_CSV"

  for NVOTES in 10 50 100; do
    local EID="bench-mkl-${NVOTES}-$(date +%s)"

    log "선거 생성 (N=${NVOTES}): $EID"
    curl -s -X POST "$BASE_URL/api/elections" \
      -H "Content-Type: application/json" \
      -d "{\"electionID\":\"$EID\",\"title\":\"Merkle N=${NVOTES}\",\"candidates\":[\"A\",\"B\",\"C\"],\"startTime\":1774791523,\"endTime\":1874791523}" \
      -o /dev/null
    curl -s -X POST "$BASE_URL/api/elections/$EID/activate" -o /dev/null

    log "${NVOTES}명 투표 생성 중..."
    for i in $(seq 1 $NVOTES); do
      local CAND NULL_H
      CAND=$(python3 -c "import sys; cands=['A','B','C']; print(cands[$i % 3])")
      NULL_H=$(nullifier_hash "voter_${i}" "$EID")
      curl -s -X POST "$BASE_URL/api/vote" \
        -H "Content-Type: application/json" \
        -d "{\"electionID\":\"$EID\",\"candidateID\":\"$CAND\",\"nullifierHash\":\"$NULL_H\"}" \
        -o /dev/null
    done

    log "선거 종료 + Merkle Tree 빌드"
    curl -s -X POST "$BASE_URL/api/elections/$EID/close" -o /dev/null
    curl -s -X POST "$BASE_URL/api/elections/$EID/merkle" -o /dev/null

    # voter_1의 nullifier
    local NULLIFIER
    NULLIFIER=$(nullifier_hash "voter_1" "$EID")

    log "GetMerkleProof 200회 측정 (N=${NVOTES})..."
    local TIMES_FILE="$RESULT_DIR/step2_merkle_N${NVOTES}.txt"
    rm -f "$TIMES_FILE"

    for trial in $(seq 1 200); do
      local t
      t=$(measure_get "$BASE_URL/api/elections/$EID/proof/$NULLIFIER")
      echo "$t" >> "$TIMES_FILE"
      [ $((trial % 50)) -eq 0 ] && log "  ${trial}/200..."
    done

    python3 - "$TIMES_FILE" "$NVOTES" "$SCALING_CSV" << 'PYEOF'
import sys, statistics, math

with open(sys.argv[1]) as f:
    data = sorted([int(x.strip()) for x in f if x.strip()])

n_votes = int(sys.argv[2])
n = len(data)
mean = statistics.mean(data)
stdev = statistics.stdev(data)
p50 = data[int(n * 0.50)]
p95 = data[int(n * 0.95)]
log2n = math.log2(n_votes)
ci = 1.96 * stdev / math.sqrt(n)

print(f"\n  N={n_votes} (샘플 {n}회):")
print(f"  평균={mean:.1f}ms ±{ci:.1f}ms | P50={p50}ms | P95={p95}ms | log₂({n_votes})={log2n:.2f}")

with open(sys.argv[3], 'a') as f:
    f.write(f"{n_votes},{mean:.1f},{p50},{p95},{log2n:.2f}\n")
PYEOF

  done

  log "O(log N) 선형성 분석..."
  python3 << PYEOF
import csv, sys, math

with open("$SCALING_CSV") as f:
    reader = csv.DictReader(f)
    rows = list(reader)

if len(rows) < 2:
    print("  데이터 부족 (N 종류가 2개 이상 필요)")
else:
    logs = [float(r['log2N']) for r in rows]
    avgs = [float(r['avg_ms']) for r in rows]
    n = len(rows)
    mean_x = sum(logs)/n; mean_y = sum(avgs)/n
    slope = sum((x-mean_x)*(y-mean_y) for x,y in zip(logs,avgs)) / sum((x-mean_x)**2 for x in logs)
    intercept = mean_y - slope * mean_x
    ss_res = sum((y - (slope*x + intercept))**2 for x,y in zip(logs,avgs))
    ss_tot = sum((y - mean_y)**2 for y in avgs)
    r2 = 1 - ss_res/ss_tot if ss_tot > 0 else 0
    print(f"\n  O(log N) 선형 회귀: y = {slope:.2f} × log₂(N) + {intercept:.2f}ms")
    print(f"  R² = {r2:.4f}  {'✅ 선형(O(log N)) 확인' if r2 > 0.9 else '⚠️  선형성 약함 (R² < 0.9, 상수 지배 구간)'}")
PYEOF
}

# ──────────────────────────────────────────────
# STEP 3: Panic vs Normal 200회 타이밍 + Welch's t-test
# ──────────────────────────────────────────────
bench_step3_panic() {
  sep "STEP 3: Panic Password Normal/Panic 200회 타이밍 비교"
  local EID="bench-panic-$(date +%s)"
  local VOTER_SECRET="bench_panic_voter_1"
  local NORMAL_PW="my-real-password-bench"
  local PANIC_PW="panic-password-bench"

  log "선거 생성 + 활성화: $EID"
  curl -s -X POST "$BASE_URL/api/elections" \
    -H "Content-Type: application/json" \
    -d "{\"electionID\":\"$EID\",\"title\":\"Panic 벤치마크\",\"candidates\":[\"A\",\"B\",\"C\"],\"startTime\":1774791523,\"endTime\":1874791523}" \
    -o /dev/null
  curl -s -X POST "$BASE_URL/api/elections/$EID/activate" -o /dev/null

  local NULLIFIER NORMAL_HASH PANIC_HASH
  NULLIFIER=$(nullifier_hash "$VOTER_SECRET" "$EID")
  NORMAL_HASH=$(sha256 "$NORMAL_PW")
  PANIC_HASH=$(sha256 "$PANIC_PW")

  log "투표 제출 (normalPWHash + panicPWHash 포함)"
  curl -s -X POST "$BASE_URL/api/vote" \
    -H "Content-Type: application/json" \
    -d "{\"electionID\":\"$EID\",\"candidateID\":\"A\",\"nullifierHash\":\"$NULLIFIER\",\"normalPWHash\":\"$NORMAL_HASH\",\"panicPWHash\":\"$PANIC_HASH\",\"panicCandidateID\":\"B\"}" \
    -o /dev/null

  log "선거 종료 + Merkle Tree 빌드"
  curl -s -X POST "$BASE_URL/api/elections/$EID/close" -o /dev/null
  curl -s -X POST "$BASE_URL/api/elections/$EID/merkle" -o /dev/null

  local NORMAL_FILE="$RESULT_DIR/step3_normal_times.txt"
  local PANIC_FILE="$RESULT_DIR/step3_panic_times.txt"
  rm -f "$NORMAL_FILE" "$PANIC_FILE"

  log "Normal Mode 200회 측정..."
  for i in $(seq 1 200); do
    local t
    t=$(measure_post "$BASE_URL/api/elections/$EID/proof" \
      "{\"nullifierHash\":\"$NULLIFIER\",\"passwordHash\":\"$NORMAL_HASH\"}")
    echo "$t" >> "$NORMAL_FILE"
    [ $((i % 50)) -eq 0 ] && log "  Normal ${i}/200..."
  done

  log "Panic Mode 200회 측정..."
  for i in $(seq 1 200); do
    local t
    t=$(measure_post "$BASE_URL/api/elections/$EID/proof" \
      "{\"nullifierHash\":\"$NULLIFIER\",\"passwordHash\":\"$PANIC_HASH\"}")
    echo "$t" >> "$PANIC_FILE"
    [ $((i % 50)) -eq 0 ] && log "  Panic ${i}/200..."
  done

  log "통계 분석 (Welch's t-test)..."
  python3 - "$NORMAL_FILE" "$PANIC_FILE" << 'PYEOF'
import sys, statistics, math

def load(path):
    with open(path) as f:
        return sorted([int(x.strip()) for x in f if x.strip()])

def stats(data):
    n = len(data)
    m = statistics.mean(data)
    s = statistics.stdev(data)
    ci = 1.96 * s / math.sqrt(n)
    p50 = data[int(n*0.50)]
    p95 = data[int(n*0.95)]
    p99 = data[int(n*0.99)]
    return m, s, ci, p50, p95, p99, n

normal = load(sys.argv[1])
panic  = load(sys.argv[2])

nm, ns, nci, np50, np95, np99, nn = stats(normal)
pm, ps, pci, pp50, pp95, pp99, pn = stats(panic)

print(f"\n  ─── Normal Mode ({nn}회) ───")
print(f"  평균: {nm:.1f}ms ±{nci:.1f}ms (95% CI)")
print(f"  표준편차: {ns:.1f}ms")
print(f"  P50={np50}ms | P95={np95}ms | P99={np99}ms")

print(f"\n  ─── Panic Mode ({pn}회) ───")
print(f"  평균: {pm:.1f}ms ±{pci:.1f}ms (95% CI)")
print(f"  표준편차: {ps:.1f}ms")
print(f"  P50={pp50}ms | P95={pp95}ms | P99={pp99}ms")

diff = abs(nm - pm)
print(f"\n  ─── 차이 분석 ───")
print(f"  평균 차이: {diff:.1f}ms  (목표: <100ms) {'✅ 통과' if diff < 100 else '❌ 초과'}")

try:
    from scipy import stats as sc
    t_stat, p_val = sc.ttest_ind(normal, panic, equal_var=False)
    print(f"\n  Welch's t-test: t={t_stat:.4f}, p={p_val:.6f}")
    if p_val > 0.05:
        print(f"  ✅ PASS: p={p_val:.4f} > 0.05 → 두 모드 응답 시간 통계적으로 구분 불가")
    else:
        print(f"  ⚠️  p={p_val:.4f} ≤ 0.05 → 차이 감지됨 (단, 평균 차이 {diff:.0f}ms는 체감 불가 수준)")
except ImportError:
    t_num = nm - pm
    t_den = math.sqrt(ns**2/nn + ps**2/pn)
    t_stat = t_num / t_den if t_den > 0 else 0
    df = (ns**2/nn + ps**2/pn)**2 / ((ns**2/nn)**2/(nn-1) + (ps**2/pn)**2/(pn-1))
    print(f"\n  Welch's t-test (수동): t={t_stat:.4f}, df={df:.0f}")
    if abs(t_stat) < 2.0:
        print(f"  ✅ |t|={abs(t_stat):.2f} < 2 → 통계적 유의차 없음 (타이밍 안전)")
    else:
        print(f"  ⚠️  |t|={abs(t_stat):.2f} ≥ 2 → 유의차 있음 (평균 차이 {diff:.0f}ms)")
PYEOF

  # 모드 분기 정확도 100회
  log "모드 분기 정확도 검증 100회..."
  local PASS=0
  for i in $(seq 1 100); do
    local VS="mode_acc_${i}_$(date +%s)"
    local NH PH
    NH=$(sha256 "real_pw_${i}")
    PH=$(sha256 "panic_pw_${i}")
    local NULL_I
    NULL_I=$(nullifier_hash "$VS" "$EID")

    # 투표 제출
    curl -s -X POST "$BASE_URL/api/vote" \
      -H "Content-Type: application/json" \
      -d "{\"electionID\":\"$EID\",\"candidateID\":\"A\",\"nullifierHash\":\"$NULL_I\",\"normalPWHash\":\"$NH\",\"panicPWHash\":\"$PH\",\"panicCandidateID\":\"B\"}" \
      -o /dev/null

    local WH R1 R2 RW
    WH=$(sha256 "wrong_pw_${i}")
    R1=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE_URL/api/elections/$EID/proof" \
      -H "Content-Type: application/json" \
      -d "{\"nullifierHash\":\"$NULL_I\",\"passwordHash\":\"$NH\"}")
    R2=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE_URL/api/elections/$EID/proof" \
      -H "Content-Type: application/json" \
      -d "{\"nullifierHash\":\"$NULL_I\",\"passwordHash\":\"$PH\"}")
    RW=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE_URL/api/elections/$EID/proof" \
      -H "Content-Type: application/json" \
      -d "{\"nullifierHash\":\"$NULL_I\",\"passwordHash\":\"$WH\"}")

    if [ "$R1" = "200" ] && [ "$R2" = "200" ] && [ "$RW" != "200" ]; then
      PASS=$((PASS + 1))
    else
      echo "  [FAIL] i=$i Normal=$R1 Panic=$R2 Wrong=$RW"
    fi
    [ $((i % 25)) -eq 0 ] && log "  모드분기 ${i}/100..."
  done
  echo ""
  echo "  모드 분기 정확도: ${PASS}/100 = ${PASS}%"
  [ $PASS -eq 100 ] && echo "  ✅ Normal/Panic 모두 200 OK, 잘못된 비밀번호 → 오류 100% 정확"
}

# ──────────────────────────────────────────────
# 메인 실행
# ──────────────────────────────────────────────
main() {
  echo ""
  echo "╔══════════════════════════════════════════════════════╗"
  echo "║   팀 몽바스 — 종합 성능 벤치마크 (100~200회 반복)       ║"
  echo "╚══════════════════════════════════════════════════════╝"
  echo "  시작: $(date)"

  if ! curl -s "$BASE_URL/health" | grep -q "ok"; then
    echo "❌ API 서버가 응답하지 않습니다."
    exit 1
  fi

  bench_step1_latency
  bench_step1_duplicate
  bench_step2_merkle
  bench_step3_panic

  echo ""
  sep "벤치마크 완료"
  echo "  완료: $(date)"
  echo "  결과 파일: $RESULT_DIR/"
  echo "  - step1_vote_times.txt"
  echo "  - step2_merkle_N{10,50,100}.txt"
  echo "  - merkle_scaling.csv"
  echo "  - step3_normal_times.txt"
  echo "  - step3_panic_times.txt"
}

main "$@"
