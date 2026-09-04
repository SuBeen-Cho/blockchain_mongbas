/**
 * app.js — 다조직 합의 암호화·검증 가능 전자투표 REST API 서버
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
const { fabricConcurrencyGate } = require('./lib/fabricConcurrencyGate');
const { demoEndpointsEnabled } = require('./lib/demoFeatures');
const { validateRuntimeSecurity, apiRequestShapeGuard } = require('./lib/runtimeSecurity');

const app  = express();
app.disable('x-powered-by');
const PORT = process.env.PORT || 3000;
const DISABLE_RATE_LIMITS = process.env.DISABLE_RATE_LIMITS === 'true';
const noRateLimit = (_req, _res, next) => next();
const HTTP_LISTEN_BACKLOG = Number(process.env.HTTP_LISTEN_BACKLOG || 2048);
if (!Number.isSafeInteger(HTTP_LISTEN_BACKLOG) || HTTP_LISTEN_BACKLOG < 128 || HTTP_LISTEN_BACKLOG > 65535) {
  throw new Error('HTTP_LISTEN_BACKLOG는 128~65535 범위의 정수여야 합니다.');
}
validateAdminConfiguration();
const runtimeSecurity = validateRuntimeSecurity();
if (runtimeSecurity.trustProxyHops > 0) app.set('trust proxy', runtimeSecurity.trustProxyHops);

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
// These policies must run before body parsing as parser failures terminate the
// normal middleware chain. Otherwise malformed/oversized requests lose the
// response protections applied to successful API and static responses.
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; font-src 'self'");
  if (runtimeSecurity.hsts) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  if (/^\/api\/(?:credential|vote|elections)(?:\/|$)/.test(req.path)) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
  }
  next();
});

// CORS — 허용 origin 제한 (CORS_ORIGIN 환경변수 또는 개발용 localhost)
app.use(cors({
  origin: runtimeSecurity.allowedOrigins,
  credentials: false,
}));
app.use('/api', apiRequestShapeGuard(runtimeSecurity.allowedOrigins));
app.use(express.json({ limit: '1mb' }));

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
// Credential 모드별 성능 비교는 readiness를 검증하는 benchmark/run-comparison.sh 사용
if (runtimeSecurity.benchEndpoints) {
  app.get('/api/bench/auth', async (req, res) => {
    const result = await measureAuthLatency(req);
    res.json(result);
  });
}

// ── 헬스 체크 ───────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  const mem = process.memoryUsage();
  res.json({
    status:    'ok',
    timestamp: new Date().toISOString(),
    idemix:    idemixStatus(),
    benchmark: {
      authEndpointEnabled: runtimeSecurity.benchEndpoints,
      rateLimitsDisabled: DISABLE_RATE_LIMITS,
      demoCredentialsEnabled: process.env.ENABLE_DEMO_CREDENTIALS === 'true',
    },
    demo: {
      endpointsEnabled: demoEndpointsEnabled(),
      admissionRequired: runtimeSecurity.demoAdmissionRequired,
    },
    fabricConcurrency: fabricConcurrencyGate.status(),
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
    name: '팀 몽바스 — 다조직 합의 암호화·검증 가능 전자투표 API',
    version: '1.0.0',
    endpoints: {
      'GET  /health'                         : '서버 상태 확인',
      'GET  /api/elections/:id'              : '선거 정보 조회',
      'POST /api/elections'                  : '선거 생성 (관리자)',
      'POST /api/elections/:id/activate'     : '선거 활성화 CREATED→ACTIVE (관리자)',
      'POST /api/elections/:id/close'        : '선거 종료 (관리자)',
      'POST /api/elections/:id/revoke-credential': '선거별 credential 폐기 (관리자)',
      'GET  /api/elections/:id/tally'        : '개표 결과 조회',
      'POST /api/elections/:id/merkle'       : 'Merkle Tree 구축 (선거 종료 후, 관리자)',
      'GET  /api/elections/:id/merkle'       : 'Merkle Root 조회',
      'GET  /api/elections/:id/proof/:null'  : 'Merkle 포함 증명 조회 (E2E 검증)',
      'POST /api/elections/:id/proof'        : 'Deniable Verification (Normal/Panic 모드)',
      'POST /api/vote'                       : 'AES/legacy ElGamal 투표 제출 (vector-v3 직접 제출 거부)',
      'POST /api/vote/prepare-vector'        : 'vector-v3 ciphertext/proof 준비 커밋',
      'POST /api/vote/audit-vector'          : '준비된 vector-v3 투표 공개 검증 및 폐기',
      'POST /api/vote/cast-vector'           : '준비된 vector-v3 투표 원자적 제출',
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
  if (err?.type === 'entity.too.large') {
    console.warn('[WARN] request body rejected: entity too large');
    return res.status(413).json({ error: '요청 본문이 허용 크기를 초과했습니다.' });
  }
  if (err instanceof SyntaxError && err?.status === 400 && Object.hasOwn(err, 'body')) {
    console.warn('[WARN] request body rejected: malformed JSON');
    return res.status(400).json({ error: '잘못된 JSON 요청입니다.' });
  }
  console.error('[ERROR]', err?.stack || err);
  res.status(500).json({ error: '서버 내부 오류가 발생했습니다.' });
});

// ── 서버 기동 ───────────────────────────────────────────────────
app.listen(PORT, runtimeSecurity.listenHost, HTTP_LISTEN_BACKLOG, () => {
  console.log(`
╔══════════════════════════════════════════════════════╗
║  팀 몽바스 — 다조직 합의 암호화·검증 가능 투표 API 서버 기동  ║
║  http://localhost:${PORT}                              ║
╚══════════════════════════════════════════════════════╝

[INFO] 엔드포인트 목록: http://localhost:${PORT}/
[INFO] 헬스 체크: http://localhost:${PORT}/health
[INFO] HTTP listen backlog: ${HTTP_LISTEN_BACKLOG}
[INFO] HTTP listen host: ${runtimeSecurity.listenHost}

[WARNING] 네트워크가 기동된 상태에서만 정상 동작합니다.
  → cd ../network && ./scripts/network.sh up
  → ./scripts/network.sh deploy
`);
});

module.exports = app;
