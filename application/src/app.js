/**
 * app.js — BFT 익명 전자투표 REST API 서버
 *
 * 실행: node src/app.js
 * 개발: nodemon src/app.js
 *
 * 환경변수 (선택):
 *   PORT           - 서버 포트 (기본: 3000)
 *   SESSION_SECRET - 세션 서명 키 (기본: 개발용 임시값, 운영 시 반드시 변경)
 *   PANIC_PASSWORD - Panic Mode 활성화 비밀번호 (routes/vote.js 참조)
 *
 * ※ 네트워크가 기동된 상태에서 실행해야 합니다.
 *    network/scripts/network.sh up && network/scripts/network.sh deploy 후 실행.
 */

'use strict';

const express        = require('express');
const session        = require('express-session');
const electionsRouter = require('./routes/elections');
const voteRouter     = require('./routes/vote');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── 미들웨어 ────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 세션 (Panic Mode 상태 관리에 사용)
app.use(session({
  secret: process.env.SESSION_SECRET || 'mongbas-dev-secret-change-in-prod',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: false,   // HTTPS 사용 시 true로 변경
    maxAge: 60 * 60 * 1000,  // 1시간
  },
}));

// ── 라우터 ──────────────────────────────────────────────────────
app.use('/api/elections', electionsRouter);
app.use('/api/nullifier', voteRouter);
app.use('/api/vote',      voteRouter);

// ── 헬스 체크 ───────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ── API 목록 (개발 편의) ────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    name: '팀 몽바스 — BFT 익명 전자투표 API',
    version: '1.0.0',
    endpoints: {
      'GET  /health'                         : '서버 상태 확인',
      'GET  /api/elections/:id'              : '선거 정보 조회',
      'POST /api/elections'                  : '선거 생성 (관리자)',
      'POST /api/elections/:id/activate'     : '선거 활성화 CREATED→ACTIVE (관리자)',
      'POST /api/elections/:id/close'        : '선거 종료 (관리자)',
      'GET  /api/elections/:id/tally'        : '개표 결과 조회',
      'POST /api/elections/:id/merkle'       : 'Merkle Tree 구축 (선거 종료 후, 관리자)',
      'GET  /api/elections/:id/merkle'       : 'Merkle Root 조회',
      'GET  /api/elections/:id/proof/:null'  : 'Merkle 포함 증명 조회 (E2E 검증)',
      'POST /api/elections/:id/proof'        : 'Deniable Verification (Normal/Panic 모드)',
      'POST /api/vote'                       : '투표 제출',
      'GET  /api/nullifier/:hash'            : '투표 여부 확인',
      'POST /api/vote/panic/reset'           : 'Panic Mode 해제',
    },
    notes: [
      'nullifierHash는 클라이언트(브라우저)에서 계산: SHA256(voterSecret + electionID)',
      'voterSecret은 절대 서버로 전송되지 않습니다.',
      'CastVote의 비공개 데이터는 Transient Map으로 PDC에만 저장됩니다.',
    ],
  });
});

// ── 에러 핸들러 ─────────────────────────────────────────────────
app.use((err, req, res, _next) => {
  console.error('[ERROR]', err);
  res.status(500).json({ error: '서버 내부 오류가 발생했습니다.' });
});

// ── 서버 기동 ───────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════════╗
║  팀 몽바스 — BFT 익명 전자투표 API 서버 기동         ║
║  http://localhost:${PORT}                              ║
╚══════════════════════════════════════════════════════╝

[INFO] 엔드포인트 목록: http://localhost:${PORT}/
[INFO] 헬스 체크: http://localhost:${PORT}/health
[INFO] Panic Mode 비밀번호: 환경변수 PANIC_PASSWORD 참조

[WARNING] 네트워크가 기동된 상태에서만 정상 동작합니다.
  → cd ../network && ./scripts/network.sh up
  → ./scripts/network.sh deploy
`);
});

module.exports = app;
