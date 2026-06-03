'use strict';
/**
 * rehearsal-browser.js — 실제 브라우저(Chrome.app)로 UI 흐름 리허설 (P7)
 * 관제판: 새 세션 → 자동주입 → 종료 → 복호화 결과
 * 키오스크: 후보 선택 → 투표 → 영수증
 * 실행: node scripts/rehearsal-browser.js
 */
const puppeteer = require('puppeteer-core');
const crypto = require('crypto');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const BASE = 'http://localhost:3000';

async function clickText(page, sel, text) {
  const ok = await page.evaluate((s, t) => {
    const el = [...document.querySelectorAll(s)].find((e) => e.textContent.includes(t) && !e.disabled);
    if (el) { el.click(); return true; } return false;
  }, sel, text);
  if (!ok) throw new Error(`클릭 실패(없거나 비활성): "${text}"`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const A = (c, l) => { if (c) { pass++; console.log('  ✓ ' + l); } else { fail++; console.log('  ✗ FAIL: ' + l); } };

(async () => {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox', '--disable-gpu'] });
  try {
    // ───── 관제판 리허설 ─────
    console.log('[R1] 관제판 전체 흐름 (새 세션→주입→종료→복호화)');
    {
      const page = await browser.newPage();
      await page.setViewport({ width: 1200, height: 900 });
      page.on('dialog', (d) => d.accept());  // 종료 확인창 수락
      await page.goto(`${BASE}/?app=control`, { waitUntil: 'networkidle0' });
      const waitIdle = () => page.waitForFunction(() => !document.body.innerText.includes('⏳'), { timeout: 60000 });
      await clickText(page, 'button', '새 세션 시작');
      await page.waitForFunction(() => document.body.innerText.includes('ACTIVE'), { timeout: 20000 });
      await waitIdle();
      A(true, '새 세션 시작 → ACTIVE');
      await clickText(page, 'button', '투표 +5');
      await waitIdle();   // 작업 중엔 버튼 비활성 → 완료까지 대기
      await clickText(page, 'button', '투표 +10');
      await waitIdle();
      const live = await page.evaluate(() => document.body.innerText);
      A(/1[0-9]\s*표/.test(live) || live.includes('15'), '자동 주입(+5,+10) 후 라이브 카운터 증가');
      await clickText(page, 'button', '집계 종료');
      await page.waitForFunction(() => document.body.innerText.includes('복호화 완료'), { timeout: 90000 });
      A(true, '종료 → 2-of-3 복원 → 복호화 완료 로그 확인');
      // Merkle+게시판 공개는 복호화 직후 추가 수행(2~4초) → 로그가 나타날 때까지 대기
      await page.waitForFunction(() => document.body.innerText.includes('게시판 공개'), { timeout: 30000 });
      A(true, '검증 데이터(Merkle+게시판) 준비 로그 확인');
      await page.screenshot({ path: '/tmp/rehearsal-control.png' });
      await page.close();
    }

    // ───── 키오스크 리허설 ─────
    console.log('[R2] 키오스크 투표 흐름 (후보 선택→투표→영수증)');
    {
      const EID = 'REH_' + crypto.randomBytes(3).toString('hex'); const now = Math.floor(Date.now() / 1e3);
      const J = async (p, o = {}) => { const r = await fetch(BASE + p, { headers: { 'Content-Type': 'application/json' }, ...o }); return r.json(); };
      await J('/api/elections', { method: 'POST', body: JSON.stringify({ electionID: EID, title: '리허설 선거', candidates: ['김민주', '이정의', '박미래'], encryptionMode: 'elgamal', endTime: now + 86400 }) });
      await J(`/api/elections/${EID}/activate`, { method: 'POST' });

      const page = await browser.newPage();
      await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
      await page.goto(`${BASE}/?app=kiosk&e=${EID}`, { waitUntil: 'networkidle0' });
      await page.waitForFunction(() => document.body.innerText.includes('투표하기'), { timeout: 20000 });
      A(true, '키오스크 후보 화면 로드');
      await clickText(page, 'button', '이정의');
      await sleep(400);
      await clickText(page, 'button', '투표하기');
      await page.waitForFunction(() => document.body.innerText.includes('투표 완료'), { timeout: 30000 });
      const body = await page.evaluate(() => document.body.innerText);
      const m = body.match(/[0-9A-F]{4}-[0-9A-F]{2}/);
      A(!!m, `영수증 추적번호 표시됨 (${m ? m[0] : '없음'})`);
      await page.screenshot({ path: '/tmp/rehearsal-kiosk.png' });
      await page.close();
    }

    console.log(`\n=== 리허설 결과: ${pass} PASS, ${fail} FAIL ===`);
  } catch (e) {
    console.error('리허설 오류:', e.message); fail++;
  } finally {
    await browser.close();
    process.exit(fail ? 1 : 0);
  }
})();
