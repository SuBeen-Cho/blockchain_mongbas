# STEP 4 성능 평가: React 프론트엔드

> **평가 시기:** STEP 4 (React + Tailwind CSS) 구현 완료 직후
> **필수 측정:** 응답 시간(Latency) + 정확도 + TPS — 모든 테스트에 포함

---

## 평가 목적

React 프론트엔드가:
1. **빠른 응답 시간**으로 투표 UX를 제공하는지
2. **Panic Mode UI**가 Normal Mode와 외관상 동일한지 (정확도 검증)
3. 동시 사용자 부하 하에서도 **안정적인 TPS**를 유지하는지

측정합니다.

---

## 환경 설정

```bash
# React 앱 빌드 + 서빙
cd frontend
npm install
npm run build
npx serve -s build -l 3001

# API 서버 (백엔드)
cd application && npm start  # localhost:3000

# Lighthouse 설치
npm install -g lighthouse

# Playwright (E2E 자동화 테스트)
npm install -g playwright
npx playwright install
```

---

## 테스트 4-A: 응답 시간 (Latency) — 필수

### 목적
투표 완료까지의 End-to-End 응답 시간을 측정합니다.

### 4-A-1: API 응답 → UI 렌더링 E2E 시간

```javascript
// scripts/measure_e2e_time.js (Playwright 사용)
const { chromium } = require('playwright');

async function measureE2ETime(iterations = 50) {
  const browser = await chromium.launch();
  const times = [];

  for (let i = 0; i < iterations; i++) {
    const page = await browser.newPage();

    // 투표 페이지 로드 시간
    const t0 = Date.now();
    await page.goto('http://localhost:3001/elections/perf-test/vote');
    await page.waitForSelector('#candidate-list');
    const pageLoadTime = Date.now() - t0;

    // 투표 제출 → 완료 화면까지 시간
    const t1 = Date.now();
    await page.click('[data-candidate="A"]');
    await page.fill('#voter-secret', `e2e_voter_${i}`);
    await page.click('#submit-vote');
    await page.waitForSelector('#vote-success');
    const voteSubmitTime = Date.now() - t1;

    times.push({ pageLoadTime, voteSubmitTime });
    await page.close();

    if (i % 10 === 0) console.log(`진행: ${i}/${iterations}`);
  }

  await browser.close();

  const loadTimes = times.map(t => t.pageLoadTime);
  const submitTimes = times.map(t => t.voteSubmitTime);

  const avg = arr => arr.reduce((a, b) => a + b) / arr.length;
  const pct = (arr, p) => arr.sort((a,b)=>a-b)[Math.floor(arr.length * p / 100)];

  console.log('\n=== 결과 ===');
  console.log(`페이지 로드 - 평균: ${avg(loadTimes).toFixed(0)}ms, P95: ${pct(loadTimes, 95)}ms`);
  console.log(`투표 제출   - 평균: ${avg(submitTimes).toFixed(0)}ms, P95: ${pct(submitTimes, 95)}ms`);
}

measureE2ETime();
```

```bash
node scripts/measure_e2e_time.js
```

### 4-A-2: 검증 화면 응답 시간 (Normal vs Panic)

```javascript
// scripts/measure_verify_time.js
const { chromium } = require('playwright');
const crypto = require('crypto');

async function measureVerifyTime() {
  const browser = await chromium.launch();
  const normalTimes = [], panicTimes = [];

  for (let i = 0; i < 100; i++) {
    const page = await browser.newPage();

    // Normal Mode 검증
    const t1 = Date.now();
    await page.goto('http://localhost:3001/elections/panic-test/verify');
    await page.fill('#nullifier', `test_nullifier_${i}`);
    await page.fill('#password', 'my-real-password-2026');
    await page.click('#verify-btn');
    await page.waitForSelector('#merkle-proof-result');
    normalTimes.push(Date.now() - t1);

    // Panic Mode 검증 (새 탭)
    const page2 = await browser.newPage();
    const t2 = Date.now();
    await page2.goto('http://localhost:3001/elections/panic-test/verify');
    await page2.fill('#nullifier', `test_nullifier_${i}`);
    await page2.fill('#password', 'help-im-under-duress');
    await page2.click('#verify-btn');
    await page2.waitForSelector('#merkle-proof-result');
    panicTimes.push(Date.now() - t2);

    await page.close();
    await page2.close();
  }

  await browser.close();
  console.log('Normal 검증 평균:', normalTimes.reduce((a,b)=>a+b)/normalTimes.length, 'ms');
  console.log('Panic 검증 평균:', panicTimes.reduce((a,b)=>a+b)/panicTimes.length, 'ms');
}

measureVerifyTime();
```

### 목표값

| 지표 | 목표 | 비고 |
|------|------|------|
| 페이지 로드 시간 | < 3,000ms | First Contentful Paint |
| 투표 제출 E2E | < 5,000ms | 클릭 → 완료 화면 |
| 검증 화면 E2E | < 3,000ms | 비밀번호 입력 → 결과 |

### 결과 기록 템플릿

```
테스트 일시: ________________

[응답 시간]
페이지 로드 - 평균: ______ms, P95: ______ms  (목표: <3000ms)  [통과/실패]
투표 제출 E2E - 평균: ______ms, P95: ______ms  (목표: <5000ms)  [통과/실패]
Normal 검증 E2E - 평균: ______ms
Panic 검증 E2E  - 평균: ______ms
```

---

## 테스트 4-B: TPS — 필수

### 목적
동시 사용자가 투표할 때 시스템 전체 처리량을 측정합니다.

### 절차

```bash
# API 서버 TPS (백엔드 기준, REST API 직접 측정)
autocannon -c 50 -d 60 -m POST \
  -H "Content-Type: application/json" \
  -b '{"electionID":"frontend-tps-test","candidateID":"A","voterSecret":"__RAND__"}' \
  http://localhost:3000/api/vote

# Playwright 기반 브라우저 TPS 측정 (실제 사용자 시뮬레이션)
# scripts/browser_tps.js — 10개 브라우저 탭 병렬 실행
```

```javascript
// scripts/browser_tps.js
const { chromium } = require('playwright');

async function browserTPS(concurrency = 10, duration = 60000) {
  const browser = await chromium.launch();
  let completed = 0;
  const startTime = Date.now();

  const workers = Array(concurrency).fill(0).map(async (_, idx) => {
    while (Date.now() - startTime < duration) {
      const page = await browser.newPage();
      try {
        await page.goto('http://localhost:3001/elections/tps-test/vote');
        await page.fill('#voter-secret', `browser_voter_${Date.now()}_${idx}`);
        await page.click('[data-candidate="A"]');
        await page.click('#submit-vote');
        await page.waitForSelector('#vote-success', { timeout: 10000 });
        completed++;
      } catch (e) {} finally {
        await page.close();
      }
    }
  });

  await Promise.all(workers);
  await browser.close();

  const totalSec = (Date.now() - startTime) / 1000;
  console.log(`Browser TPS: ${(completed / totalSec).toFixed(2)} votes/sec`);
  console.log(`총 완료: ${completed}건 / ${totalSec.toFixed(0)}초`);
}

browserTPS(10, 60000);
```

### 결과 기록 템플릿

```
API 직접 TPS (동시 50명): ______ req/sec
브라우저 TPS (동시 10탭): ______ votes/sec
```

---

## 테스트 4-C: 정확도 — Lighthouse + UI 정확성 (필수)

### 4-C-1: Lighthouse 성능 점수

```bash
# Production 빌드 기준으로 측정
lighthouse http://localhost:3001/elections \
  --output=json \
  --output-path=lighthouse_report.json \
  --chrome-flags="--headless"

# 결과 요약 추출
node -e "
const report = require('./lighthouse_report.json');
const cats = report.lhr.categories;
console.log('Performance:', cats.performance.score * 100);
console.log('Accessibility:', cats.accessibility.score * 100);
console.log('Best Practices:', cats['best-practices'].score * 100);
console.log('SEO:', cats.seo.score * 100);
"
```

### 4-C-2: Panic Mode UI 동일성 검증

```javascript
// scripts/panic_ui_check.js
// Normal과 Panic 화면의 DOM 구조가 동일한지 확인

const { chromium } = require('playwright');

async function checkPanicUiIdentity() {
  const browser = await chromium.launch();

  const page1 = await browser.newPage();
  await page1.goto('http://localhost:3001/elections/panic-test/verify');
  await page1.fill('#password', 'my-real-password-2026');
  await page1.click('#verify-btn');
  await page1.waitForSelector('#merkle-proof-result');
  const normalScreenshot = await page1.screenshot();
  const normalHTML = await page1.$eval('#merkle-proof-result', el => el.innerHTML);

  const page2 = await browser.newPage();
  await page2.goto('http://localhost:3001/elections/panic-test/verify');
  await page2.fill('#password', 'help-im-under-duress');
  await page2.click('#verify-btn');
  await page2.waitForSelector('#merkle-proof-result');
  const panicHTML = await page2.$eval('#merkle-proof-result', el => el.innerHTML);

  // DOM 구조 비교 (class, 태그 구조만 — 실제 값은 달라도 됨)
  const normalStructure = normalHTML.replace(/[0-9a-f]{64}/g, 'HASH');
  const panicStructure = panicHTML.replace(/[0-9a-f]{64}/g, 'HASH');

  console.log('DOM 구조 동일 여부:', normalStructure === panicStructure ? '✅ 동일' : '❌ 다름');

  // 스크린샷 저장
  require('fs').writeFileSync('normal_screen.png', normalScreenshot);
  const panicScreenshot = await page2.screenshot();
  require('fs').writeFileSync('panic_screen.png', panicScreenshot);
  console.log('스크린샷 저장: normal_screen.png, panic_screen.png');

  await browser.close();
}

checkPanicUiCheck();
```

### 목표값

| 지표 | 목표 | 비고 |
|------|------|------|
| Lighthouse Performance | ≥ 80 | 실용적 투표 앱 기준 |
| Lighthouse Accessibility | ≥ 90 | 접근성 확보 |
| Panic Mode UI 동일성 | 100% | DOM 구조 동일 필수 |

### 결과 기록 템플릿

```
테스트 일시: ________________

[Lighthouse 점수]
Performance:    ______  (목표: ≥80)  [통과/실패]
Accessibility:  ______  (목표: ≥90)  [통과/실패]
Best Practices: ______
SEO:            ______

[UI 정확성]
Panic Mode DOM 구조 동일성: ______%  (목표: 100%)  [통과/실패]
Normal/Panic 스크린샷 저장: [예/아니오]

[TPS 요약]
API TPS (동시 50명): ______ req/sec
브라우저 TPS:        ______ votes/sec
```

---

## 종합 평가 결과 요약

```
STEP 4 성능 평가 종합 결과
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

[필수 지표]
✅/❌ 투표 E2E 응답 P95: ______ms  (목표: <5000ms)
✅/❌ TPS (동시 50명): ______ req/sec
✅/❌ Lighthouse Performance: ______  (목표: ≥80)
✅/❌ Panic UI 동일성: ______%  (목표: 100%)

[다음 단계]
→ STEP 5 Idemix 연동 구현으로 진행 (또는 STEP 6 성능 평가)
```
