#!/usr/bin/env node
/**
 * generate-ps-bbs-env.js
 *
 * PS-BN254 / BBS+-BLS12381 발급자 키 생성 후 환경변수 출력.
 * 출력값을 application/.env 와 network/.env (chaincode 컨테이너용) 에 각각 추가하세요.
 *
 * 사용법:
 *   PS_ISSUER_SEED=<임의문자열>  BBS_ISSUER_SEED=<임의문자열>  node scripts/generate-ps-bbs-env.js
 *   (시드 미설정 시 랜덤 생성 — 서버 재시작마다 키가 바뀌므로 운영 환경에선 반드시 고정)
 */

'use strict';

const ps  = require('../src/lib/ps-idemix');
const bbs = require('../src/lib/bbs-idemix');

async function main() {
  const psB64  = ps.exportPublicKeyB64();
  const bbsB64 = await bbs.exportPublicKeyB64();

  console.log('# ── Application server (.env) ──────────────────────────────');
  console.log('IDEMIX_ENABLED=true');
  if (process.env.PS_ISSUER_SEED) {
    console.log(`PS_ISSUER_SEED=${process.env.PS_ISSUER_SEED}`);
  } else {
    console.log('# PS_ISSUER_SEED= (미설정 — 랜덤. 고정하려면 임의 문자열 입력)');
  }
  if (process.env.BBS_ISSUER_SEED) {
    console.log(`BBS_ISSUER_SEED=${process.env.BBS_ISSUER_SEED}`);
  } else {
    console.log('# BBS_ISSUER_SEED= (미설정 — 랜덤. 고정하려면 임의 문자열 입력)');
  }
  console.log('');
  console.log('# ── Chaincode container (network/.env or docker-compose) ───');
  console.log(`PS_ISSUER_PUBLIC_KEY_B64=${psB64}`);
  console.log(`BBS_PUBLIC_KEY_B64=${bbsB64}`);
  console.log('');
  console.log('# 주의: PS_ISSUER_SEED / BBS_ISSUER_SEED 는 application 서버에만 보관하세요.');
  console.log('#       체인코드 컨테이너에는 공개키(PUBLIC_KEY_B64)만 주입합니다.');
}

main().catch(err => { console.error(err); process.exit(1); });
