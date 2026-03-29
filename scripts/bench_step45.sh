#!/usr/bin/env bash
# ============================================================
# 팀 몽바스 — STEP 4~5 성능 벤치마크
# STEP 4: Nullifier Eviction (재투표 Latency 100회 + 집계 정확도 20회)
# STEP 5: Shamir's Secret Sharing (InitKeySharing/SubmitKeyShare 50회 + 복원 정확도 30회)
#
# 실행 전제: 네트워크 기동 + 체인코드 배포 + API 서버(port 3000) 기동
# ============================================================

BASE_URL="http://localhost:3000"
RESULT_DIR="$(dirname "$0")/../docs/performance/bench_results"
mkdir -p "$RESULT_DIR"

log()  { echo "[$(date '+%H:%M:%S')] $*"; }
sep()  {
  echo ""
  echo "══════════════════════════════════════════════════════"
  echo "  $*"
  echo "══════════════════════════════════════════════════════"
}
ok()   { echo "  ✅ $*"; }
fail() { echo "  ❌ $*"; }

# ──────────────────────────────────────────────
# 헬퍼: ms 단위 현재 시각 (macOS date +%s%3N 미지원)
# ──────────────────────────────────────────────
now_ms() {
  python3 -c "import time; print(int(time.time()*1000))"
}

# nullifierHash = SHA256(voterSecret + electionID)
nullifier_hash() {
  local secret="$1" eid="$2"
  python3 -c "import hashlib; print(hashlib.sha256(('${secret}' + '${eid}').encode()).hexdigest())"
}

# ──────────────────────────────────────────────
# 헬퍼: latency 통계 계산
# ──────────────────────────────────────────────
calc_stats() {
  local data_file="$1" label="${2:-}"
  python3 - "$data_file" "$label" <<'PYEOF'
import sys, math, statistics

with open(sys.argv[1]) as f:
    vals = [float(x.strip()) for x in f if x.strip()]

label = sys.argv[2] if len(sys.argv) > 2 else ""
if label:
    print(f"  [{label}]")

if not vals:
    print("  데이터 없음")
    sys.exit(0)

n = len(vals)
vals_s = sorted(vals)
mean   = statistics.mean(vals)
stdev  = statistics.stdev(vals) if n > 1 else 0
se     = stdev / math.sqrt(n)
ci95   = 1.96 * se

def pct(p):
    return vals_s[min(int(n * p), n-1)]

print(f"  n={n} | 평균: {mean:.1f}ms ±{ci95:.1f}ms (95% CI) | 표준편차: {stdev:.1f}ms")
print(f"  P50: {pct(0.50):.0f}ms | P95: {pct(0.95):.0f}ms | P99: {pct(0.99):.0f}ms")
print(f"  최소: {vals_s[0]:.0f}ms | 최대: {vals_s[-1]:.0f}ms")
PYEOF
}

# ──────────────────────────────────────────────
# API 헬퍼
# ──────────────────────────────────────────────
create_election() {
  local eid="$1"
  local now end
  now=$(python3 -c "import time; print(int(time.time()))")
  end=$((now + 86400))
  curl -s -X POST "$BASE_URL/api/elections" \
    -H "Content-Type: application/json" \
    -d "{\"electionID\":\"$eid\",\"title\":\"Bench $eid\",\"description\":\"benchmark\",\"candidates\":[\"A\",\"B\",\"C\"],\"startTime\":$now,\"endTime\":$end}" \
    -o /dev/null -w "%{http_code}"
}

activate_election() {
  curl -s -X POST "$BASE_URL/api/elections/$1/activate" -o /dev/null -w "%{http_code}"
}

close_election() {
  curl -s -X POST "$BASE_URL/api/elections/$1/close" -o /dev/null -w "%{http_code}"
}

cast_vote() {
  # returns http status code
  curl -s -w "%{http_code}" -o /dev/null \
    -X POST "$BASE_URL/api/vote" \
    -H "Content-Type: application/json" \
    -d "{\"electionID\":\"$1\",\"nullifierHash\":\"$2\",\"candidateID\":\"$3\"}"
}

get_tally_json() {
  curl -s "$BASE_URL/api/elections/$1/tally"
}

init_keysharing() {
  curl -s -X POST "$BASE_URL/api/elections/$1/keysharing" -o /dev/null -w "%{http_code}"
}

get_share() {
  curl -s "$BASE_URL/api/elections/$1/shares/$2" \
    | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('shareHex',''))" 2>/dev/null
}

submit_share_timed() {
  # args: eid index hex  → prints latency in ms
  local eid="$1" idx="$2" hex="$3"
  local start end
  start=$(now_ms)
  curl -s -X POST "$BASE_URL/api/elections/$eid/shares" \
    -H "Content-Type: application/json" \
    -d "{\"shareIndex\":\"$idx\",\"shareHex\":\"$hex\"}" \
    -o /tmp/share_resp.json
  end=$(now_ms)
  echo $((end - start))
}

submit_share_status() {
  # returns isDecrypted value
  python3 -c "import json; d=json.load(open('/tmp/share_resp.json')); print(d.get('isDecrypted',False))" 2>/dev/null || echo "False"
}

echo ""
echo "╔══════════════════════════════════════════════════════╗"
echo "║  팀 몽바스 — STEP 4~5 성능 벤치마크                  ║"
echo "║  $(date '+%Y-%m-%d %H:%M:%S')                              ║"
echo "╚══════════════════════════════════════════════════════╝"
echo ""

# ============================================================
# STEP 4-A: Nullifier Eviction Latency — 100회
# 동일 nullifier로 재투표 100회 → latency 측정
# ============================================================
sep "STEP 4-A: Nullifier Eviction Latency (재투표) — 100회"

TS=$(python3 -c "import time; print(int(time.time()))")
EVICT_EID="EVICT_A_$TS"
log "선거 생성: $EVICT_EID"
create_election "$EVICT_EID" > /dev/null
sleep 1
activate_election "$EVICT_EID" > /dev/null
sleep 1

NULL_EVICT=$(nullifier_hash "evict_voter_bench" "$EVICT_EID")
log "초기 투표 제출 (A)..."
cast_vote "$EVICT_EID" "$NULL_EVICT" "A" > /dev/null
sleep 1

log "재투표(Eviction) 100회 측정 중..."
EVICT_LAT_FILE="$RESULT_DIR/step4a_eviction_latency.txt"
> "$EVICT_LAT_FILE"

EVICT_OK=0
EVICT_FAIL=0

for i in $(seq 1 100); do
  CAND="B"
  START=$(now_ms)
  STATUS=$(curl -s -w "%{http_code}" -o /tmp/evict_resp.json \
    -X POST "$BASE_URL/api/vote" \
    -H "Content-Type: application/json" \
    -d "{\"electionID\":\"$EVICT_EID\",\"nullifierHash\":\"$NULL_EVICT\",\"candidateID\":\"$CAND\"}")
  END=$(now_ms)
  LAT=$((END - START))
  echo "$LAT" >> "$EVICT_LAT_FILE"

  if [ "$STATUS" = "200" ]; then
    EVICT_OK=$((EVICT_OK + 1))
  else
    EVICT_FAIL=$((EVICT_FAIL + 1))
    [ $EVICT_FAIL -le 3 ] && log "  [i=$i] 재투표 실패 ($STATUS): $(cat /tmp/evict_resp.json 2>/dev/null)"
  fi

  if [ $((i % 25)) -eq 0 ]; then
    log "  진행: $i/100 (성공: $EVICT_OK, 실패: $EVICT_FAIL)"
  fi
done

# Eviction 후 nullifier evictCount 확인
EVICT_COUNT=$(curl -s "$BASE_URL/api/nullifier/$NULL_EVICT" \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('evictCount',0))" 2>/dev/null)

echo ""
echo "── STEP 4-A 결과 ──────────────────────────────────────"
echo "  재투표 성공률: $EVICT_OK/100 = $(python3 -c "print(f'{$EVICT_OK:.0f}%')")"
echo "  최종 evictCount: $EVICT_COUNT (기대: 100)"
calc_stats "$EVICT_LAT_FILE" "재투표 Latency"
if [ "$EVICT_OK" -ge 95 ]; then
  ok "재투표 성공률 ≥95% 달성"
else
  fail "재투표 성공률 미달 ($EVICT_OK/100)"
fi

# ============================================================
# STEP 4-B: 집계 정확도 — 20회
# (유권자 3명 A투표 → 3명 B재투표 → 집계 A=0, B=3 기대)
# ============================================================
sep "STEP 4-B: Eviction 집계 정확도 — 20회"
log "시나리오: 3명 A투표 → 3명 B재투표 → 집계 A=0 B=3 검증"

TALLY_OK=0
TALLY_FAIL=0
TALLY_DETAIL=""

for round in $(seq 1 20); do
  TS=$(python3 -c "import time; print(int(time.time()))")
  ROUND_EID="EVICT_T${round}_$TS"
  create_election "$ROUND_EID" > /dev/null
  sleep 0.5
  activate_election "$ROUND_EID" > /dev/null

  # 3명 A 투표
  for v in 1 2 3; do
    NH=$(nullifier_hash "tallv_${round}_${v}" "$ROUND_EID")
    cast_vote "$ROUND_EID" "$NH" "A" > /dev/null
  done

  # 3명 B 재투표 (Eviction)
  for v in 1 2 3; do
    NH=$(nullifier_hash "tallv_${round}_${v}" "$ROUND_EID")
    cast_vote "$ROUND_EID" "$NH" "B" > /dev/null
  done

  # 선거 종료 + 집계
  close_election "$ROUND_EID" > /dev/null
  sleep 1

  TALLY_JSON=$(get_tally_json "$ROUND_EID")
  # 집계 결과는 "results" 키, 더미 Nullifier 포함
  # CreateElection 시 후보자별 3개 더미 Nullifier 자동 생성
  # → A_real=0(에빅션됨), B_real=3 → A=3dummy, B=3dummy+3real=6, C=3dummy
  # 검증: B - A == 3 (에빅션된 투표수 = numVoters)
  COUNT_A=$(echo "$TALLY_JSON" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('results',{}).get('A','-'))" 2>/dev/null)
  COUNT_B=$(echo "$TALLY_JSON" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('results',{}).get('B','-'))" 2>/dev/null)

  # Eviction 정확도: B가 A보다 3표(에빅션된 유권자 수) 더 많아야 함
  DIFF=$(python3 -c "print($COUNT_B - $COUNT_A)" 2>/dev/null || echo "-1")
  if [ "$DIFF" = "3" ]; then
    TALLY_OK=$((TALLY_OK + 1))
  else
    TALLY_FAIL=$((TALLY_FAIL + 1))
    TALLY_DETAIL="$TALLY_DETAIL\n  [round=$round] A=$COUNT_A, B=$COUNT_B, diff=$DIFF (기대 diff=3)"
    log "  [round=$round] 집계 이상 — A=$COUNT_A, B=$COUNT_B, diff=$DIFF"
  fi

  if [ $((round % 5)) -eq 0 ]; then
    log "  진행: $round/20 (정확: $TALLY_OK, 실패: $TALLY_FAIL)"
  fi
done

echo ""
echo "── STEP 4-B 결과 ──────────────────────────────────────"
PCT4B=$(python3 -c "print(f'{$TALLY_OK/20*100:.1f}')")
echo "  집계 정확도: $TALLY_OK/20 = $PCT4B% (목표: 100%)"
echo "  (검증 기준: B - A = 3 = 에빅션된 유권자 수)"
[ -n "$TALLY_DETAIL" ] && printf "  실패 상세:%b\n" "$TALLY_DETAIL"
if [ "$TALLY_OK" -eq 20 ]; then
  ok "집계 정확도 100% 달성"
else
  fail "집계 정확도 미달 ($TALLY_OK/20)"
fi

# ============================================================
# STEP 5-A: InitKeySharing Latency — 50회
# 선거 생성→활성화→종료→InitKeySharing latency 측정
# ============================================================
sep "STEP 5-A: InitKeySharing Latency — 50회"
log "선거 종료 후 마스터키 생성 + 3 share Shamir 분산 latency"

INIT_LAT_FILE="$RESULT_DIR/step5a_init_keysharing_latency.txt"
> "$INIT_LAT_FILE"
INIT_OK=0

for i in $(seq 1 50); do
  TS=$(python3 -c "import time; print(int(time.time()))")
  INIT_EID="SHAMIR_I${i}_$TS"
  create_election "$INIT_EID" > /dev/null
  sleep 0.3
  activate_election "$INIT_EID" > /dev/null
  sleep 0.3
  close_election "$INIT_EID" > /dev/null
  sleep 1

  START=$(now_ms)
  STATUS=$(curl -s -w "%{http_code}" -o /tmp/init_resp.json \
    -X POST "$BASE_URL/api/elections/$INIT_EID/keysharing")
  END=$(now_ms)
  echo $((END - START)) >> "$INIT_LAT_FILE"

  if [ "$STATUS" = "200" ]; then
    INIT_OK=$((INIT_OK + 1))
  else
    [ $((50 - INIT_OK)) -le 5 ] && log "  [i=$i] InitKeySharing 실패 ($STATUS): $(cat /tmp/init_resp.json)"
  fi

  if [ $((i % 10)) -eq 0 ]; then
    log "  진행: $i/50 (성공: $INIT_OK)"
  fi
done

echo ""
echo "── STEP 5-A 결과 ──────────────────────────────────────"
echo "  InitKeySharing 성공: $INIT_OK/50"
calc_stats "$INIT_LAT_FILE" "InitKeySharing Latency"
if [ "$INIT_OK" -ge 48 ]; then
  ok "InitKeySharing 성공률 ≥96% 달성"
else
  fail "InitKeySharing 성공률 미달 ($INIT_OK/50)"
fi

# ============================================================
# STEP 5-B: SubmitKeyShare Latency — 각 50회
# share 1(미충족) 제출 vs share 2(threshold 충족) 제출 latency 비교
# ============================================================
sep "STEP 5-B: SubmitKeyShare Latency — 각 50회"
log "share 1 제출(미충족) vs share 2 제출(threshold 충족, 복원 포함) 비교"

SHARE1_LAT_FILE="$RESULT_DIR/step5b_share1_latency.txt"
SHARE2_LAT_FILE="$RESULT_DIR/step5b_share2_latency.txt"
> "$SHARE1_LAT_FILE"
> "$SHARE2_LAT_FILE"

SB_OK=0
SB_FAIL=0

for i in $(seq 1 50); do
  TS=$(python3 -c "import time; print(int(time.time()))")
  S_EID="SHAMIR_S${i}_$TS"
  create_election "$S_EID" > /dev/null
  sleep 0.3
  activate_election "$S_EID" > /dev/null
  sleep 0.3
  close_election "$S_EID" > /dev/null
  sleep 1
  init_keysharing "$S_EID" > /dev/null
  sleep 1

  SH1=$(get_share "$S_EID" "1")
  SH2=$(get_share "$S_EID" "2")

  # Share 1 제출 (미충족)
  LAT1=$(submit_share_timed "$S_EID" "1" "$SH1")
  echo "$LAT1" >> "$SHARE1_LAT_FILE"

  # Share 2 제출 (threshold 충족 → 복원)
  LAT2=$(submit_share_timed "$S_EID" "2" "$SH2")
  echo "$LAT2" >> "$SHARE2_LAT_FILE"

  DEC=$(submit_share_status)
  if [ "$DEC" = "True" ]; then
    SB_OK=$((SB_OK + 1))
  else
    SB_FAIL=$((SB_FAIL + 1))
    [ $SB_FAIL -le 3 ] && log "  [i=$i] 복원 실패: $DEC"
  fi

  if [ $((i % 10)) -eq 0 ]; then
    log "  진행: $i/50 (복원 성공: $SB_OK, 실패: $SB_FAIL)"
  fi
done

echo ""
echo "── STEP 5-B 결과 ──────────────────────────────────────"
calc_stats "$SHARE1_LAT_FILE" "Share 1 제출 (미충족)"
echo ""
calc_stats "$SHARE2_LAT_FILE" "Share 2 제출 (threshold 충족)"
echo ""
PCT5B=$(python3 -c "print(f'{$SB_OK/50*100:.1f}')")
echo "  n=2 threshold 복원 성공: $SB_OK/50 = $PCT5B% (목표: 100%)"

# Welch's t-test: share1 vs share2 latency
python3 - "$SHARE1_LAT_FILE" "$SHARE2_LAT_FILE" <<'PYEOF'
import sys, math, statistics

def load(f):
    with open(f) as fp:
        return [float(x.strip()) for x in fp if x.strip()]

a = load(sys.argv[1])  # share1
b = load(sys.argv[2])  # share2

if len(a) < 2 or len(b) < 2:
    print("  t-test: 데이터 부족")
    sys.exit(0)

ma, mb = statistics.mean(a), statistics.mean(b)
sa, sb = statistics.stdev(a), statistics.stdev(b)
na, nb = len(a), len(b)

t_num = ma - mb
t_den = math.sqrt(sa**2/na + sb**2/nb)
t = t_num / t_den if t_den != 0 else 0
diff = ma - mb

print(f"  Welch's t-test: t={t:.3f}")
print(f"  share1 평균 {ma:.1f}ms vs share2 평균 {mb:.1f}ms → 차이 {diff:.1f}ms")
if abs(diff) < 200:
    print("  → 두 모드 실용적 구분 불가 (차이 <200ms) ✅")
else:
    print(f"  → 주의: share2가 {diff:.1f}ms 더 {'느림' if diff > 0 else '빠름'} (복원 연산 포함)")
PYEOF

if [ "$SB_OK" -ge 48 ]; then
  ok "threshold 복원 성공률 ≥96% 달성"
else
  fail "threshold 복원 성공률 미달 ($SB_OK/50)"
fi

# ============================================================
# STEP 5-C: n-of-m Threshold 정확도 — 30회
# n=1 share → isDecrypted=false 검증
# n=2 share → isDecrypted=true 검증
# ============================================================
sep "STEP 5-C: n-of-m Threshold 정확도 — 30회"
log "n=1 share 시 복원 불가(false), n=2 share 시 복원 가능(true) 검증"

THRESH_OK=0
THRESH_FAIL=0

for i in $(seq 1 30); do
  TS=$(python3 -c "import time; print(int(time.time()))")
  T_EID="SHAMIR_T${i}_$TS"
  create_election "$T_EID" > /dev/null
  sleep 0.3
  activate_election "$T_EID" > /dev/null
  sleep 0.3
  close_election "$T_EID" > /dev/null
  sleep 1
  init_keysharing "$T_EID" > /dev/null
  sleep 1

  SH1=$(get_share "$T_EID" "1")
  SH2=$(get_share "$T_EID" "2")

  # share 1만 제출 → isDecrypted 반드시 false
  RESP1=$(curl -s -X POST "$BASE_URL/api/elections/$T_EID/shares" \
    -H "Content-Type: application/json" \
    -d "{\"shareIndex\":\"1\",\"shareHex\":\"$SH1\"}")
  DEC1=$(echo "$RESP1" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('isDecrypted',True))" 2>/dev/null)

  # share 2 추가 → isDecrypted 반드시 true
  RESP2=$(curl -s -X POST "$BASE_URL/api/elections/$T_EID/shares" \
    -H "Content-Type: application/json" \
    -d "{\"shareIndex\":\"2\",\"shareHex\":\"$SH2\"}")
  DEC2=$(echo "$RESP2" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('isDecrypted',False))" 2>/dev/null)

  if [ "$DEC1" = "False" ] && [ "$DEC2" = "True" ]; then
    THRESH_OK=$((THRESH_OK + 1))
  else
    THRESH_FAIL=$((THRESH_FAIL + 1))
    log "  [i=$i] 실패 — n=1: $DEC1 (기대:False), n=2: $DEC2 (기대:True)"
  fi

  if [ $((i % 10)) -eq 0 ]; then
    log "  진행: $i/30 (정확: $THRESH_OK, 실패: $THRESH_FAIL)"
  fi
done

echo ""
echo "── STEP 5-C 결과 ──────────────────────────────────────"
PCT5C=$(python3 -c "print(f'{$THRESH_OK/30*100:.1f}')")
echo "  threshold 정확도: $THRESH_OK/30 = $PCT5C% (목표: 100%)"
if [ "$THRESH_OK" -eq 30 ]; then
  ok "threshold 정확도 100% 달성"
else
  fail "threshold 정확도 미달 ($THRESH_OK/30)"
fi

# ============================================================
# 최종 요약
# ============================================================
sep "전체 STEP 4~5 벤치마크 완료 — 최종 요약"
echo ""
echo "  STEP 4-A  재투표(Eviction) Latency:  $EVICT_OK/100 성공 (결과: $RESULT_DIR/step4a_eviction_latency.txt)"
echo "  STEP 4-B  집계 정확도:               $TALLY_OK/20"
echo "  STEP 5-A  InitKeySharing Latency:    $INIT_OK/50 성공 (결과: $RESULT_DIR/step5a_init_keysharing_latency.txt)"
echo "  STEP 5-B  SubmitKeyShare Latency:    $SB_OK/50 복원 성공"
echo "  STEP 5-C  n-of-m 정확도:             $THRESH_OK/30"
echo ""
log "벤치마크 완료."
