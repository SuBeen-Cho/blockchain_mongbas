# 성능 평가 가이드라인 — 개요

> **팀 몽바스** | Hyperledger Fabric 기반 전자투표 시스템
> 각 구현 단계 완료 즉시 해당 성능 평가를 수행하고 결과를 기록합니다.

---

## 성능 평가 원칙

### 매 단계 필수 측정 지표 (3가지)

모든 성능 평가 파일에는 다음 3가지가 **반드시** 포함됩니다:

| # | 지표 | 설명 | 도구 |
|---|------|------|------|
| 1 | **응답 시간 (Latency)** | P50/P95/P99 latency (ms) | autocannon, curl 타이밍 |
| 2 | **정확도 (Accuracy)** | 기능별 정확도·무결성 성공률 (%) | 직접 스크립트 + 로그 분석 |
| 3 | **TPS** | 초당 트랜잭션 처리량 | autocannon, Caliper |

이 3가지는 단계별 특화 평가와 **별개로** 항상 측정합니다.

---

## 평가 파일 목록

| 파일 | 단계 | 주요 평가 내용 |
|------|------|--------------|
| `PERF-STEP1-REST-API.md` | STEP 1 | REST API latency, TPS 기본 측정, 중복투표 차단율 |
| `PERF-STEP2-MERKLE.md` | STEP 2 | Merkle Proof O(log N) 효율, Root Hash 무결성 |
| `PERF-STEP3-PANIC.md` | STEP 3 | Panic/Normal 모드 타이밍 t-test, 식별불가성 |
| `PERF-STEP4-FRONTEND.md` | STEP 4 | Lighthouse 점수, E2E 응답시간, UI TPS |
| `PERF-STEP5-IDEMIX.md` | STEP 5 | ZKP 오버헤드, 비연결성(Unlinkability) 검증 |
| `PERF-STEP6-CALIPER.md` | STEP 6 | Caliper 종합: Fault Injection, TPS vs N, O(N²) |

---

## 공통 환경 설정

### 필수 도구 설치

```bash
# autocannon — HTTP 부하 테스트
npm install -g autocannon

# Hyperledger Caliper — 블록체인 전용 벤치마크 (STEP 6)
npm install -g @hyperledger/caliper-cli
caliper bind --caliper-bind-sut fabric:2.5

# wrk — 추가 HTTP 부하 테스트 (선택)
brew install wrk   # macOS

# jq — JSON 파싱
brew install jq
```

### 기본 latency 측정 명령어 템플릿

```bash
# autocannon 기본 사용법
autocannon \
  -c <동시연결수> \
  -d <테스트기간(초)> \
  -m <HTTP메서드> \
  -H "Content-Type: application/json" \
  -b '<JSON body>' \
  http://localhost:3000/api/<endpoint>

# 예시: 투표 API 10명 동시 30초 부하 테스트
autocannon \
  -c 10 -d 30 -m POST \
  -H "Content-Type: application/json" \
  -b '{"electionID":"election1","candidateID":"A","voterSecret":"secret123"}' \
  http://localhost:3000/api/vote
```

### 결과 기록 템플릿

각 테스트 후 다음 형식으로 결과를 기록합니다:

```
테스트 일시: YYYY-MM-DD HH:MM
환경: OS, Node.js 버전, Fabric 버전, Docker 버전
동시 연결: N명
테스트 시간: Ns

결과:
- TPS: X req/sec
- Latency P50: Xms
- Latency P95: Xms
- Latency P99: Xms
- 정확도: X%
- 오류율: X%
```

---

## 성능 목표값 요약

| 지표 | 목표값 | 근거 |
|------|--------|------|
| TPS | > 50 TPS | 선행 연구(F=2, 7노드 환경 기준) |
| Latency P95 | < 3,000ms | 실용적 투표 시스템 UX 기준 |
| 중복투표 차단율 | 100% | 무관용 (보안 필수 요건) |
| Merkle 검증 정확도 | 100% | 무관용 (무결성 필수 요건) |
| Panic Mode 식별률 | 0% | 강압저항성 요건 |
| BFT 무결성 유지율 | 100% (F≤1) | 3주차 보고서 목표 |
