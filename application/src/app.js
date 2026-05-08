/**
 * app.js — 다조직 합의 익명 전자투표 REST API 서버
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
const cors           = require('cors');
const rateLimit      = require('express-rate-limit');
const electionsRouter              = require('./routes/elections');
const voteRouter                   = require('./routes/vote');
const { router: credentialRouter } = require('./routes/credential');
const { requireVoterAuth, measureAuthLatency, idemixStatus } = require('./middleware/auth');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── 운영 환경 필수 환경변수 검증 ──────────────────────────────────
if (process.env.NODE_ENV === 'production') {
  const required = ['IDEMIX_ENABLED', 'SESSION_SECRET', 'CREDENTIAL_SECRET'];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    throw new Error(`운영 환경 필수 환경변수 누락: ${missing.join(', ')}`);
  }
  if (process.env.IDEMIX_ENABLED !== 'true') {
    throw new Error('운영 환경에서는 IDEMIX_ENABLED=true 가 필요합니다. bypass 인증은 개발/벤치마크 전용입니다.');
  }
}

// ── 미들웨어 ────────────────────────────────────────────────────
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// CORS — 허용 origin 제한 (CORS_ORIGIN 환경변수 또는 개발용 localhost)
const allowedOrigins = (process.env.CORS_ORIGIN || 'http://localhost:5173,http://localhost:3000')
  .split(',').map(o => o.trim());
app.use(cors({
  origin: allowedOrigins,
  credentials: true,
}));

// Rate Limiting — 전역 (15분당 300회)
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: '요청이 너무 많습니다. 잠시 후 다시 시도하세요.' },
});
app.use(globalLimiter);

// 보안 헤더
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; font-src 'self'");
  next();
});

// 세션 (Panic Mode 상태 관리에 사용)
app.use(session({
  secret: process.env.SESSION_SECRET || (() => {
    console.warn('[WARN] SESSION_SECRET 환경변수 미설정 — 개발용 랜덤 시크릿 사용 중.');
    return require('crypto').randomBytes(32).toString('hex');
  })(),
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    sameSite: 'strict',
    maxAge: 60 * 60 * 1000,  // 1시간
  },
}));

// ── 민감 엔드포인트 Rate Limiting ─────────────────────────────────
const voteLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: '투표 요청이 너무 많습니다. 잠시 후 다시 시도하세요.' },
});
const credentialLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 50,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Credential 발급 요청이 너무 많습니다.' },
});

// ── 라우터 ──────────────────────────────────────────────────────
app.use('/api/elections',  electionsRouter);
app.use('/api/nullifier',  voteRouter);
app.use('/api/credential', credentialLimiter, credentialRouter);    // Idemix 자격증명 발급
app.use('/api/vote',       voteLimiter, requireVoterAuth, voteRouter); // Idemix 인증 미들웨어 적용

// ── 벤치마크 전용 엔드포인트 ────────────────────────────────────
// 인증 레이턴시만 측정하기 위한 엔드포인트 (체인코드 호출 없음)
// IDEMIX_ENABLED=false/true 전환 후 http-bench.js 로 성능 비교
app.get('/api/bench/auth', async (req, res) => {
  const result = await measureAuthLatency(req);
  res.json(result);
});

// ── 헬스 체크 ───────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  const mem = process.memoryUsage();
  res.json({
    status:    'ok',
    timestamp: new Date().toISOString(),
    idemix:    idemixStatus(),
    memory: {
      heapUsed:  mem.heapUsed,
      heapTotal: mem.heapTotal,
      rss:       mem.rss,
      external:  mem.external,
    },
  });
});

// ── API 목록 (개발 편의) ────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    name: '팀 몽바스 — 다조직 합의 익명 전자투표 API',
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
║  팀 몽바스 — 다조직 합의 익명 전자투표 API 서버 기동  ║
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
