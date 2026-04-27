#!/usr/bin/env node
/**
 * scripts/generate-bt-report.js — BatchTimeout 측정 결과를 마크다운으로 생성
 * bt-results/*.json 파일들을 읽어서 BATCHTIMEOUT-RESULTS.md 생성
 */
'use strict';

const fs   = require('fs');
const path = require('path');

const BT_DIR    = path.join(__dirname, '../docs/security-eval/extended/bt-results');
const OUT_MD    = path.join(__dirname, '../docs/security-eval/extended/BATCHTIMEOUT-RESULTS.md');
const TIMEOUTS  = ['500ms', '1s', '2s', '5s'];
const TPS_LEVELS = [1, 3, 5, 10, 20];

function loadResult(bt) {
  const p = path.join(BT_DIR, `${bt}.json`);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function getRound(data, targetTps) {
  if (!data) return null;
  return data.rounds.find(r => r.targetTps === targetTps) || null;
}

function fmt(val, unit = '') {
  if (val === null || val === undefined) return 'N/A';
  return `${val}${unit}`;
}

function generateReport(allData) {
  const runDate = new Date().toLocaleString('ko-KR');

  let md = `# BatchTimeout별 TPS/Latency 측정 결과

> 생성일: ${runDate}
> 환경: Hyperledger Fabric 2.5 / etcdraft 4-node / Node.js REST API
> 목적: BatchTimeout(블록 컷 대기 시간) 변경이 투표 트랜잭션 처리 성능에 미치는 영향 분석

---

## 측정 개요

### 위협 시나리오 및 분석 목적

BatchTimeout은 Hyperledger Fabric 오더링 서비스가 블록을 생성할 때 트랜잭션이 충분히 모이지 않으면 얼마나 기다릴지를 결정하는 파라미터입니다.

- **낮은 TPS 환경 (BT 지배 구간)**: 트랜잭션이 드문드문 들어오면 BatchTimeout이 만료될 때마다 블록이 생성됩니다. BatchTimeout이 클수록 블록 생성 지연 → 레이턴시 증가.
- **높은 TPS 환경 (MaxMessageCount 지배 구간)**: 트랜잭션이 빠르게 들어오면 MaxMessageCount(=500)에 도달해 즉시 블록이 생성됩니다. BatchTimeout과 무관.

이 측정은 실제 선거 운영에서 최적의 BatchTimeout 설정을 찾고, BatchTimeout 변경이 보안/성능에 미치는 트레이드오프를 정량화합니다.

### 측정 조건

| 항목 | 값 |
|------|-----|
| BatchTimeout 종류 | 500ms / 1s / 2s(기본) / 5s |
| TPS 목표 | 1 / 3 / 5 / 10 / 20 |
| MaxMessageCount | 500 (고정) |
| Workers | 1 (직렬, REST API 기반) |
| 채널 변경 방법 | peer channel update (네트워크 재시작 없음) |

---

## 측정 결과

### 실제 달성 TPS 비교

| 목표 TPS | BT=500ms | BT=1s | BT=2s | BT=5s |
|---------|---------|-------|-------|-------|
${TPS_LEVELS.map(tps => {
  const cells = TIMEOUTS.map(bt => {
    const d = allData[bt];
    const r = getRound(d, tps);
    return r && !r.error ? `${r.actualTps}` : 'N/A';
  });
  return `| ${tps} TPS | ${cells.join(' | ')} |`;
}).join('\n')}

### 평균 레이턴시 (avg) 비교

| 목표 TPS | BT=500ms | BT=1s | BT=2s | BT=5s |
|---------|---------|-------|-------|-------|
${TPS_LEVELS.map(tps => {
  const cells = TIMEOUTS.map(bt => {
    const d = allData[bt];
    const r = getRound(d, tps);
    return r && !r.error ? `${r.latency.avg}ms` : 'N/A';
  });
  return `| ${tps} TPS | ${cells.join(' | ')} |`;
}).join('\n')}

### P95 레이턴시 비교

| 목표 TPS | BT=500ms | BT=1s | BT=2s | BT=5s |
|---------|---------|-------|-------|-------|
${TPS_LEVELS.map(tps => {
  const cells = TIMEOUTS.map(bt => {
    const d = allData[bt];
    const r = getRound(d, tps);
    return r && !r.error ? `${r.latency.p95}ms` : 'N/A';
  });
  return `| ${tps} TPS | ${cells.join(' | ')} |`;
}).join('\n')}

### P99 레이턴시 비교

| 목표 TPS | BT=500ms | BT=1s | BT=2s | BT=5s |
|---------|---------|-------|-------|-------|
${TPS_LEVELS.map(tps => {
  const cells = TIMEOUTS.map(bt => {
    const d = allData[bt];
    const r = getRound(d, tps);
    return r && !r.error ? `${r.latency.p99}ms` : 'N/A';
  });
  return `| ${tps} TPS | ${cells.join(' | ')} |`;
}).join('\n')}

### 실패율 비교

| 목표 TPS | BT=500ms | BT=1s | BT=2s | BT=5s |
|---------|---------|-------|-------|-------|
${TPS_LEVELS.map(tps => {
  const cells = TIMEOUTS.map(bt => {
    const d = allData[bt];
    const r = getRound(d, tps);
    return r && !r.error ? r.failRate : 'N/A';
  });
  return `| ${tps} TPS | ${cells.join(' | ')} |`;
}).join('\n')}

---

## BatchTimeout별 상세 결과

${TIMEOUTS.map(bt => {
  const d = allData[bt];
  if (!d) return `### BT=${bt}\n\n> ⚠ 측정 데이터 없음\n`;

  return `### BT=${bt} (측정일: ${d.runDate})

| 목표 TPS | 실제 TPS | 성공/전체 | 실패율 | avg | stddev | min | max | p50 | p95 | p99 |
|---------|---------|---------|------|-----|--------|-----|-----|-----|-----|-----|
${d.rounds.map(r => {
  if (r.error) return `| ${r.targetTps} | - | - | - | error: ${r.error} |||||`;
  return `| ${r.targetTps} | ${r.actualTps} | ${r.success}/${r.txCount} | ${r.failRate} | ${r.latency.avg}ms | ${r.latency.stddev}ms | ${r.latency.min}ms | ${r.latency.max}ms | ${r.latency.p50}ms | ${r.latency.p95}ms | ${r.latency.p99}ms |`;
}).join('\n')}
`;
}).join('\n')}

---

## 분석 및 시사점

### 1. BatchTimeout과 레이턴시의 관계 (저TPS 구간)

저TPS(1~3 TPS) 환경에서는 블록이 BatchTimeout 만료 시 생성됩니다.
따라서 트랜잭션 레이턴시는 **BatchTimeout에 근접하게** 나타납니다.

| BatchTimeout | 이론적 최소 레이턴시 | 측정된 avg (TPS=1) |
|-------------|-------------------|-----------------|
| 500ms | ~500ms | ${(() => { const d = allData['500ms']; const r = getRound(d, 1); return r && !r.error ? r.latency.avg + 'ms' : 'N/A'; })()} |
| 1s | ~1000ms | ${(() => { const d = allData['1s']; const r = getRound(d, 1); return r && !r.error ? r.latency.avg + 'ms' : 'N/A'; })()} |
| 2s | ~2000ms | ${(() => { const d = allData['2s']; const r = getRound(d, 1); return r && !r.error ? r.latency.avg + 'ms' : 'N/A'; })()} |
| 5s | ~5000ms | ${(() => { const d = allData['5s']; const r = getRound(d, 1); return r && !r.error ? r.latency.avg + 'ms' : 'N/A'; })()} |

### 2. 고TPS 구간에서의 BatchTimeout 영향

고TPS(10~20 TPS) 환경에서는 MaxMessageCount(500)에 도달하기 전에 BatchTimeout이 만료되지 않으므로 BatchTimeout 값에 무관하게 유사한 레이턴시를 보여야 합니다.

| BatchTimeout | avg (TPS=10) | avg (TPS=20) |
|-------------|-------------|-------------|
| 500ms | ${(() => { const d = allData['500ms']; const r = getRound(d, 10); return r && !r.error ? r.latency.avg + 'ms' : 'N/A'; })()} | ${(() => { const d = allData['500ms']; const r = getRound(d, 20); return r && !r.error ? r.latency.avg + 'ms' : 'N/A'; })()} |
| 1s | ${(() => { const d = allData['1s']; const r = getRound(d, 10); return r && !r.error ? r.latency.avg + 'ms' : 'N/A'; })()} | ${(() => { const d = allData['1s']; const r = getRound(d, 20); return r && !r.error ? r.latency.avg + 'ms' : 'N/A'; })()} |
| 2s | ${(() => { const d = allData['2s']; const r = getRound(d, 10); return r && !r.error ? r.latency.avg + 'ms' : 'N/A'; })()} | ${(() => { const d = allData['2s']; const r = getRound(d, 20); return r && !r.error ? r.latency.avg + 'ms' : 'N/A'; })()} |
| 5s | ${(() => { const d = allData['5s']; const r = getRound(d, 10); return r && !r.error ? r.latency.avg + 'ms' : 'N/A'; })()} | ${(() => { const d = allData['5s']; const r = getRound(d, 20); return r && !r.error ? r.latency.avg + 'ms' : 'N/A'; })()} |

### 3. 선거 시스템 운영 관점 권장 설정

| 상황 | 권장 BatchTimeout | 근거 |
|------|-----------------|------|
| 투표 집중 시간대 (높은 TPS) | 1s ~ 2s | 어차피 MaxMessageCount 지배, BT 영향 없음 |
| 투표 한산 시간대 (낮은 TPS) | 500ms ~ 1s | 레이턴시를 낮춰 유권자 응답성 확보 |
| 개표/결과 조회 위주 | 2s | 기본값 유지, 쓰기 트랜잭션 적음 |

### 4. 보안 관점 시사점

- BatchTimeout 변경은 **채널 config 업데이트 트랜잭션**으로만 가능 — 3개 기관 서명 필요
- 단일 기관이 BatchTimeout을 임의로 변경하여 선거를 방해하는 것은 2-of-3 정책에 의해 차단됨
- BatchTimeout을 매우 낮게(예: 100ms) 설정하면 블록 생성 빈도가 높아져 **오더러 부하 증가** 가능
- BatchTimeout을 매우 높게(예: 30s) 설정하면 **유권자 체감 레이턴시 급증** → 선거 혼란 유발 가능

---

> 측정 환경: localhost, Fabric 2.5, etcdraft 4-node, Node.js REST API
> BatchTimeout 변경: peer channel update (네트워크 재시작 없이 온라인 변경)
`;

  return md;
}

// ── 메인 ─────────────────────────────────────────────────────────
const allData = {};
for (const bt of TIMEOUTS) {
  allData[bt] = loadResult(bt);
  if (allData[bt]) {
    console.log(`  ✅ ${bt} 결과 로드: ${allData[bt].rounds.length}라운드`);
  } else {
    console.log(`  ⚠ ${bt} 결과 없음`);
  }
}

const md = generateReport(allData);
fs.writeFileSync(OUT_MD, md, 'utf8');
console.log(`\n✅ 마크다운 생성: ${OUT_MD}`);
