'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '../..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

function filesBelow(relativeDirectory) {
  const absoluteDirectory = path.join(root, relativeDirectory);
  return fs.readdirSync(absoluteDirectory, { withFileTypes: true }).flatMap(entry => {
    const relative = path.join(relativeDirectory, entry.name);
    return entry.isDirectory() ? filesBelow(relative) : [relative];
  });
}

test('runtime metadata and UI do not self-certify coercion resistance', () => {
  const chaincode = read('chaincode/voting/voting.go');
  const verifyPage = read('frontend/src/pages/VerifyPage.jsx');
  const voterPage = read('frontend/src/pages/VoterPage.jsx');
  const controlPage = read('frontend/src/pages/ControlPage.jsx');
  const kioskPage = read('frontend/src/pages/KioskPage.jsx');
  const trackPage = read('frontend/src/pages/TrackPage.jsx');
  const receiptFree = read('frontend/src/components/verify-animations/ReceiptFreeDiagram.jsx');
  const diagram = read('frontend/src/components/verify-animations/DeniableDiagram.jsx');
  const e2e = read('application/scripts/full-election-e2e.js');
  const electionRoutes = read('application/src/routes/elections.js');
  const app = read('application/src/app.js');
  const readme = read('README.md');
  const runGuide = read('docs/RUN_GUIDE.md');
  const runbook = read('docs/DEMO_RUNBOOK.md');

  assert.doesNotMatch(chaincode, /Status:\s+"achieved"/);
  assert.doesNotMatch(chaincode, /Cleansing-Hiding coercion resistance/);
  assert.match(chaincode, /Property:\s+"Coercion Resistance"[\s\S]{0,120}Status:\s+"unverified"/);
  assert.doesNotMatch(verifyPage, /강압자가 어느 것이 진짜인지 구분할 수 없/);
  assert.doesNotMatch(verifyPage, /공개된 암호화 키로 모든 투표를 복호화|receipt 생성이 원천 불가/);
  assert.doesNotMatch(voterPage, /Idemix 익명 자격 증명을 발급|100% 동일/);
  assert.doesNotMatch(controlPage, /100% 동일|강압자 구별 불가/);
  assert.doesNotMatch(trackPage, /시스템이 절대 복호화하지 않/);
  assert.doesNotMatch(trackPage, /아무도 못 건드림|변조 없이 집계에 들어갔/);
  assert.doesNotMatch(trackPage, /집계에 포함되었습니다|운영자도 못 본다/);
  assert.doesNotMatch(kioskPage, /변조 없이 집계에 들어갔/);
  assert.doesNotMatch(controlPage, /변조 없이 집계에 포함됨/);
  assert.doesNotMatch(receiptFree, /receipt 생성이 원천 불가|강압자에게 누구를 찍었는지 증명할 수 없/);
  assert.doesNotMatch(diagram, /Coercion Resistance —/);
  assert.doesNotMatch(diagram, /강압자가 구분 불가/);
  assert.doesNotMatch(e2e, /Coercion Resistance E2E Test/);
  assert.doesNotMatch(e2e, /Receipt-?Free|receiptFree/);
  assert.doesNotMatch(electionRoutes, /Receipt-?free/i);
  assert.doesNotMatch(chaincode, /Receipt-?Free/i);
  for (const [label, source] of [['app', app], ['README', readme], ['run guide', runGuide], ['runbook', runbook]]) {
    assert.doesNotMatch(source, /다조직 합의 익명 전자투표|운영자도 못 봄|누구에게 찍었는지 우리도 몰라/, label);
  }
  assert.doesNotMatch(kioskPage, /<Badge>익명<\/Badge>/);
  assert.doesNotMatch(readme, /curl[^\n]*\|\s*(?:bash|sh)/);
  assert.doesNotMatch(readme, /공개터널 자동/);
  assert.doesNotMatch(readme, /Anonymous E-Voting|Node\.js 18|Go 1\.21/);
});

test('public operating guides do not disclose the evaluated host account path', () => {
  for (const relative of ['deploy/linux/README.md', 'docs/RUN_GUIDE.md', 'docs/DEMO_RUNBOOK.md']) {
    assert.doesNotMatch(read(relative), /\/home\/user1(?:\/|\b)/, relative);
  }
});

test('public showcase and credential labels do not claim unverified equivalence', () => {
  const showcase = read('frontend/public/showcase3.html');
  const auth = read('application/src/middleware/auth.js');
  const psPrototype = read('application/src/lib/ps-idemix.js');
  const bbsPrototype = read('application/src/lib/bbs-idemix.js');
  const packageManifest = read('application/package.json');
  const environmentExample = read('application/.env.example');
  const caliperManifest = read('caliper/package.json');
  const fullBenchmark = read('caliper/benchmarks/full-bench.yaml');
  const chaincode = read('chaincode/voting/voting.go');
  const voterPage = read('frontend/src/pages/VoterPage.jsx');
  const boothDesign = read('docs/DEMO_BOOTH_DESIGN.md');
  const frontendIndex = read('frontend/index.html');
  const viteConfig = read('frontend/vite.config.js');
  const setupGuide = read('docs/RUN_GUIDE.md');
  const caliperBenchmarks = [
    read('caliper/benchmarks/cast-vote.yaml'),
    read('caliper/benchmarks/get-election.yaml'),
    read('caliper/benchmarks/worker-scale.yaml'),
  ];

  assert.doesNotMatch(showcase, /7\/7 보안 속성/);
  assert.doesNotMatch(showcase, /7<b>\/7<\/b>|7\/7[^\n]{0,80}전부 충족|학술 보안속성 전부 충족/);
  assert.doesNotMatch(showcase, /하나도 빠짐없이 달성한 첫 사례/);
  assert.doesNotMatch(showcase, /완벽한 비밀|모두 충족|100% 전부 달성|강압자가 눈치챌 수 없|프라이버시는 거의 공짜/);
  assert.doesNotMatch(showcase, /누구도 못 보|신원은 노출 안 됨|신원 관련 데이터는 비공개 영역\(PDC\)에만/);
  assert.doesNotMatch(showcase, /기존 투표가 못 하던 것을, 전부|누구나 비밀키 없이 전체 개표 검증/);
  assert.match(showcase, /현재 7\/7 완전 검증을 주장하지 않습니다/);
  assert.match(showcase, /강압저항성은 현재 unverified/);
  assert.doesNotMatch(auth, /진짜 Idemix|Fabric Idemix와 동일/);
  assert.doesNotMatch(auth, /완전 비연결성|익명 credential\s*[—(]/);
  assert.doesNotMatch(auth, /anonymous:\s+true/);
  assert.match(auth, /PS-BN254 credential prototype/);
  assert.match(psPrototype, /Fabric Idemix와의 wire-format/);
  assert.match(bbsPrototype, /nullifierMaterial/);
  assert.doesNotMatch(bbsPrototype, /비연결성 보장|선택적 공개: voterEligible만 공개/);
  assert.doesNotMatch(packageManifest, /익명 전자투표/);
  assert.doesNotMatch(environmentExample, /익명 전자투표/);
  assert.doesNotMatch(caliperManifest, /익명 전자투표/);
  assert.doesNotMatch(fullBenchmark, /익명 전자투표/);
  assert.doesNotMatch(chaincode, /익명 전자투표|익명 투표 증명|익명으로 투표|Nullifier 저장 \(익명\)|Nullifier\s+\(익명 공개\)/);
  assert.doesNotMatch(chaincode, /평문 후보자를 절대 보지 않|강압자가 구분 불가능|서버는 어느 모드인지 알 수 없음/);
  assert.doesNotMatch(voterPage, /label:\s*['"]익명 투표['"]/);
  assert.doesNotMatch(boothDesign, /운영자도 못 본다|익명성 \/ \*\*Ballot Secrecy\*\*|Ballot Secrecy \/ 익명성|변조 불가능하게 기록|조작이 불가능|100% 사실이 되고 위험 0|아무도 못 건드/);
  assert.doesNotMatch(boothDesign, /cloudflared tunnel|trycloudflare|ngrok (?:터널|http)|LAN IP 추가|앞 6자리|6 hex면 충분|Receipt-free\(included만 반환\) \| ✅ 사실/);
  assert.doesNotMatch(frontendIndex, /Anonymous E-Voting/);
  assert.doesNotMatch(setupGuide, /curl[\s\S]{0,200}\|\s*(?:bash|sh)/);
  assert.doesNotMatch(viteConfig, /allowedHosts:\s*true|host:\s*true/);
  for (const benchmark of caliperBenchmarks) assert.doesNotMatch(benchmark, /익명 전자투표/);
  for (const benchmark of caliperBenchmarks) assert.doesNotMatch(benchmark, /익명 투표 트랜잭션/);
});

test('legacy security scenario does not mislabel missing-election rejection as endorsement evidence', () => {
  const scenarios = read('scripts/security-scenarios-extended.js');

  assert.doesNotMatch(scenarios, /단일 서명 거부율/);
  assert.doesNotMatch(scenarios, /정책 위반 거부 횟수/);
  assert.doesNotMatch(scenarios, /코드 레벨 추가 검증 없이도 정책이 보장/);
  assert.match(scenarios, /cannot measure or prove an endorsement-policy rejection/);
  assert.match(scenarios, /2-of-3 endorsement 차단 증거가 아닙니다/);
});

test('legacy extended security runner is quarantined before state mutation', () => {
  const run = spawnSync(process.execPath, [path.join(root, 'scripts/security-scenarios-extended.js')], {
    encoding: 'utf8',
    timeout: 5000,
  });

  assert.equal(run.status, 2);
  assert.equal(run.stdout, '');
  assert.match(run.stderr, /UNSUPPORTED/);
  assert.doesNotMatch(run.stderr, /측정 완료/);
});

test('legacy security scenario runner is quarantined before network access', () => {
  const run = spawnSync(process.execPath, [path.join(root, 'scripts/security-scenarios.js')], {
    encoding: 'utf8',
    timeout: 5000,
  });

  assert.equal(run.status, 2);
  assert.equal(run.stdout, '');
  assert.match(run.stderr, /UNSUPPORTED/);
  assert.doesNotMatch(run.stderr, /측정 완료/);
});

test('legacy full and step 4-5 benchmarks are quarantined before network access', () => {
  for (const relative of ['scripts/bench_full.sh', 'scripts/bench_step45.sh']) {
    const run = spawnSync('bash', [path.join(root, relative)], {
      encoding: 'utf8',
      timeout: 5000,
    });

    assert.equal(run.status, 2, relative);
    assert.equal(run.stdout, '', relative);
    assert.match(run.stderr, /UNSUPPORTED/, relative);
    assert.doesNotMatch(run.stderr, /벤치마크 완료/, relative);
  }
});

test('legacy BatchTimeout runners are quarantined before output or channel mutation', () => {
  const javascriptRun = spawnSync(process.execPath, [path.join(root, 'scripts/batchtimeout-bench.js')], {
    encoding: 'utf8',
    timeout: 5000,
  });
  const shellRun = spawnSync('bash', [path.join(root, 'scripts/run-batchtimeout-all.sh')], {
    encoding: 'utf8',
    timeout: 5000,
  });

  for (const run of [javascriptRun, shellRun]) {
    assert.equal(run.status, 2);
    assert.equal(run.stdout, '');
    assert.match(run.stderr, /UNSUPPORTED/);
    assert.doesNotMatch(run.stderr, /전체 BatchTimeout 벤치마크 완료|결과 저장/);
  }
});

test('superseded evidence runners fail closed before network or output access', () => {
  const runners = [
    'application/benchmark/http-bench.js',
    'application/benchmark/idemix-bench.js',
    'application/benchmark/phase-bc-bench.js',
    'scripts/measure-concurrent-vote.js',
    'scripts/generate-bt-report.js',
    'application/scripts/benchmark-paper-features.js',
    'application/benchmark/security-overhead-bench.js',
    'application/scripts/p2-threshold-test.js',
    'application/scripts/p5-track-test.js',
    'application/scripts/scenario-suite.js',
    'application/scripts/scenario-suite2.js',
    'application/scripts/rehearsal-browser.js',
  ];

  for (const relative of runners) {
    const run = spawnSync(process.execPath, [path.join(root, relative)], {
      encoding: 'utf8',
      timeout: 5000,
    });
    assert.equal(run.status, 2, relative);
    assert.equal(run.stdout, '', relative);
    assert.match(run.stderr, /UNSUPPORTED/, relative);
    assert.doesNotMatch(run.stderr, /결과 저장|완료/, relative);
  }
});

test('every repository-declared legacy evidence entrypoint is inventoried and fails closed', () => {
  const declaredLegacy = [
    ...filesBelow('application/benchmark'),
    ...filesBelow('application/scripts'),
    ...filesBelow('scripts'),
  ].filter(relative => /\.(?:js|sh)$/.test(relative))
    .filter(relative => /UNSUPPORTED|HISTORICAL ONLY|cannot produce.*evidence|legacy evaluator|legacy workload/s.test(read(relative)))
    .sort();

  const expected = [
    'application/benchmark/http-bench.js',
    'application/benchmark/idemix-bench.js',
    'application/benchmark/phase-bc-bench.js',
    'application/benchmark/security-overhead-bench.js',
    'application/scripts/benchmark-paper-features.js',
    'application/scripts/p2-threshold-test.js',
    'application/scripts/p5-track-test.js',
    'application/scripts/rehearsal-browser.js',
    'application/scripts/scenario-suite.js',
    'application/scripts/scenario-suite2.js',
    'scripts/batchtimeout-bench.js',
    'scripts/bench_full.sh',
    'scripts/bench_step45.sh',
    'scripts/generate-bt-report.js',
    'scripts/measure-concurrent-vote.js',
    'scripts/run-batchtimeout-all.sh',
    'scripts/security-scenarios-extended.js',
    'scripts/security-scenarios.js',
  ].sort();

  assert.deepEqual(declaredLegacy, expected);
  for (const relative of declaredLegacy) {
    const command = relative.endsWith('.sh') ? 'bash' : process.execPath;
    const run = spawnSync(command, [path.join(root, relative)], {
      encoding: 'utf8',
      timeout: 5000,
    });
    assert.equal(run.status, 2, relative);
    assert.equal(run.stdout, '', relative);
    assert.match(run.stderr, /UNSUPPORTED/, relative);
  }
});

test('BBS runtime and Linux build stay on the audited WASM dependency path', () => {
  const bbs = read('application/src/lib/bbs-idemix.js');
  const build = read('deploy/linux/build.sh');
  const docs = read('deploy/linux/README.md');
  const readme = read('README.md');
  const runGuide = read('docs/RUN_GUIDE.md');

  assert.match(bbs, /process\.env\.BBS_SIGNATURES_MODE\s*=\s*['"]WASM['"]/);
  assert.match(build, /npm --prefix \"\$\{MONGBAS_REPO_DIR\}\/application\" ci --omit=dev --omit=optional/);
  assert.match(build, /npm --prefix \"\$\{MONGBAS_REPO_DIR\}\/application\" audit --omit=dev --omit=optional --audit-level=high/);
  assert.match(docs, /BBS_SIGNATURES_MODE=WASM/);
  assert.match(docs, /npm ci --omit=dev --omit=optional/);
  assert.match(readme, /npm ci --omit=dev --omit=optional/);
  assert.doesNotMatch(readme, /cd application[\s\S]{0,160}npm install/);
  assert.match(runGuide, /application[\s\S]{0,100}npm ci --omit=dev --omit=optional/);
  assert.doesNotMatch(runGuide, /cd application[\s\S]{0,100}npm install/);
});

test('application lock overrides the vulnerable qs 6.15 dependency line', () => {
  const manifest = JSON.parse(read('application/package.json'));
  const lock = JSON.parse(read('application/package-lock.json'));

  assert.equal(manifest.overrides?.qs, '6.16.0');
  assert.equal(lock.packages?.['node_modules/qs']?.version, '6.16.0');
});
