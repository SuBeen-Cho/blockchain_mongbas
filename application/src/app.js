/**
 * app.js — 다조직 합의 익명 전자투표 REST API 서버
 *
 * 실행: node src/app.js
 * 개발: nodemon src/app.js
 *
 * 환경변수 (선택):
 *   PORT           - 서버 포트 (기본: 3000)
 *   PANIC_PASSWORD - Panic Mode 활성화 비밀번호 (routes/vote.js 참조)
 *
 * ※ 네트워크가 기동된 상태에서 실행해야 합니다.
 *    network/scripts/network.sh up && network/scripts/network.sh deploy 후 실행.
 */

'use strict';

// .env 자동 로드 (이미 설정된 환경변수는 덮어쓰지 않음).
// ※ 미로딩 시 IDEMIX_ENABLED 등이 적용되지 않아 bypass 모드가 되고,
//   체인코드가 bypass 자격증명을 거부하여 투표가 실패함 — 반드시 로드.
require('dotenv').config();

const express        = require('express');
const path           = require('path');
const cors           = require('cors');
const rateLimit      = require('express-rate-limit');
const electionsRouter              = require('./routes/elections');
const voteRouter                   = require('./routes/vote');
const { router: credentialRouter } = require('./routes/credential');
const { requireVoterAuth, measureAuthLatency, idemixStatus } = require('./middleware/auth');
const { guardElectionAdminRoutes, validateAdminConfiguration } = require('./middleware/admin');

const app  = express();
const PORT = process.env.PORT || 3000;
const DISABLE_RATE_LIMITS = process.env.DISABLE_RATE_LIMITS === 'true';
const noRateLimit = (_req, _res, next) => next();
validateAdminConfiguration();

// ── 운영 환경 필수 환경변수 검증 ──────────────────────────────────
if (process.env.NODE_ENV === 'production') {
  const required = ['IDEMIX_ENABLED', 'CREDENTIAL_SECRET'];
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
  credentials: false,
}));

// ── 정적 프론트엔드 서빙 (부스 시연: 단일 오리진 + cloudflared 터널) ──
// 빌드된 SPA(frontend/dist)를 백엔드가 직접 서빙 → 폰/API 동일 출처라 CORS 무관, 터널 1개로 충분.
// 정적 파일이 없으면 next()로 통과 → 아래 API 라우터/핸들러가 처리.
const FRONTEND_DIST = path.join(__dirname, '../../frontend/dist');
app.use(express.static(FRONTEND_DIST));

// Rate Limiting — 전역 (15분당 300회)
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: '요청이 너무 많습니다. 잠시 후 다시 시도하세요.' },
});
if (!DISABLE_RATE_LIMITS) {
  app.use(globalLimiter);
}

// 보안 헤더
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; font-src 'self'");
  next();
});

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
app.use('/api/elections', guardElectionAdminRoutes, electionsRouter);
app.use('/api/nullifier',  voteRouter);
app.use('/api/credential', DISABLE_RATE_LIMITS ? noRateLimit : credentialLimiter, credentialRouter);    // Idemix 자격증명 발급
app.use('/api/vote',       DISABLE_RATE_LIMITS ? noRateLimit : voteLimiter, requireVoterAuth, voteRouter); // Idemix 인증 미들웨어 적용

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
    benchmark: { rateLimitsDisabled: DISABLE_RATE_LIMITS },
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
    },
    notes: [
      'nullifierHash는 서명된 자격증명 결합값과 선거별 블라인딩 팩터로 계산됩니다.',
      '체인코드가 credential–nullifier 일치를 독립 검증합니다.',
      'CastVote의 비공개 데이터는 Transient Map으로 PDC에만 저장됩니다.',
    ],
  });
});

// ── SPA 폴백 (부스 시연: /?app=kiosk|control 등 클라이언트 라우팅 / 딥링크) ──
// /api, /health, /(루트는 static이 index.html 제공)를 제외한 GET 경로는 SPA로.
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api') || req.path === '/health' || req.path === '/') return next();
  res.sendFile(path.join(FRONTEND_DIST, 'index.html'), (err) => { if (err) next(); });
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
