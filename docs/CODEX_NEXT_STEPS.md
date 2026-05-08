# Mongbas Codex 작업 가이드라인

이 문서는 Mongbas 프로젝트를 이어서 개선할 Codex 작업자를 위한 실행 가이드이다. 목적은 지금까지 진행한 보안/검증성 개선을 기준선으로 삼고, 남은 작업을 최대한 작게 나누어 순서대로 처리할 수 있게 만드는 것이다.

## 0. 프로젝트 핵심 목적

Mongbas의 최종 목적은 Hyperledger Fabric 기반 전자투표 시스템을 구현하면서 “검증의 역설”을 완화하는 것이다.

검증의 역설은 투표의 검증가능성을 높일수록 투표자의 프라이버시와 강압저항성이 약해질 수 있고, 반대로 프라이버시를 강화할수록 외부 검증가능성과 감사가능성이 약해질 수 있는 구조적 긴장이다.

따라서 앞으로의 모든 코드 수정은 다음 세 목표의 균형을 기준으로 판단한다.

1. 비밀성: 후보자 평문, voterID, 투표자 식별 단서가 공개 원장과 넓은 PDC 범위에 남지 않게 한다.
2. 검증가능성: credential, nullifier, Merkle proof, tally 결과가 독립적으로 검증 가능해야 한다.
3. 담합/내부자 저항성: API 서버, 단일 Fabric 조직, 단일 발급자, 단일 운영자가 전체 보안을 좌우하지 않게 한다.

## 1. 현재 완료된 기준선

### 1.1 1차: privacy/auth/ops hardening

완료 내용:

- `Nullifier.CandidateID`를 레거시 호환 필드로 낮추고 신규 투표에서는 후보자 평문 저장을 제거했다.
- `VotePrivate`에서 `voterID`, `candidateID` 평문 저장을 제거했다.
- `candidateCommitment`, `encryptedCandidateID`를 추가했다.
- 선거 생성, 활성화, 종료, 집계, Merkle tree 생성, key sharing 초기화에 `ElectionCommissionMSP` 권한 확인을 추가했다.
- key share 제출/조회는 share index에 대응되는 MSP만 가능하도록 제한했다.
- `bypass` credential은 `ALLOW_BYPASS_CREDENTIAL=true`일 때만 허용되도록 했다.
- production 환경에서는 `IDEMIX_ENABLED=true`를 요구하도록 했다.

핵심 파일:

- `chaincode/voting/voting.go`
- `application/src/routes/vote.js`
- `application/src/routes/elections.js`
- `application/src/app.js`
- `application/src/gateway.js`

### 1.2 2차: Merkle leaf commitment 확장

완료 내용:

- Merkle leaf를 단순 `nullifierHash`가 아니라 `electionID|nullifierHash|candidateCommitment|encryptedCandidateID` 기반 hash로 확장했다.
- proof 응답에 `candidateCommitment`, `encryptedCandidateID`, `leafHash`를 포함했다.
- REST proof endpoint가 `GetNullifier`를 추가 조회하여 leaf metadata를 제공하도록 했다.

핵심 파일:

- `chaincode/voting/voting.go`
- `application/src/routes/elections.js`
- `frontend/src/pages/VerifyPage.jsx`

### 1.3 3차: 브라우저 로컬 Merkle 검증기

완료 내용:

- 프론트엔드에서 Merkle proof로 computed root를 직접 계산한다.
- chain root와 computed root가 일치해야 성공으로 표시한다.

핵심 파일:

- `frontend/src/utils/crypto.js`
- `frontend/src/pages/VerifyPage.jsx`

### 1.4 4차: Ed25519 credential 체인코드 직접 검증

완료 내용:

- 애플리케이션 credential 발급 서명 대상을 `header.payload`로 수정했다.
- 투표 요청 시 Ed25519 token 원문을 transient data로 체인코드에 전달한다.
- 체인코드는 `ED25519_PUBLIC_KEY_DER_B64` 공개키로 token 서명을 직접 검증한다.
- 체인코드는 `alg`, `voterEligible`, `electionID`, `exp`, `credHash`를 재검증한다.

핵심 파일:

- `application/src/lib/asym-keys.js`
- `application/src/routes/credential.js`
- `application/src/routes/vote.js`
- `chaincode/voting/voting.go`

### 1.5 5차: Ed25519 키 생성 및 배포 경로 보강

완료 내용:

- `npm run keys:ed25519`로 Ed25519 DER base64 키쌍을 생성할 수 있게 했다.
- 체인코드 CCAAS 컨테이너 실행 시 `ED25519_PUBLIC_KEY_DER_B64`를 주입하도록 했다.
- 공개키 미설정 시 deploy 단계에서 경고한다.

핵심 파일:

- `application/scripts/generate-ed25519-env.js`
- `application/package.json`
- `network/scripts/network.sh`
- `network/docker-compose.yaml`

### 1.6 6차: Ed25519 E2E smoke test 자동화

완료 내용:

- `npm run e2e:ed25519`를 추가했다.
- credential 발급, 공개키 기반 로컬 검증, 변조 credential 거부, 다른 electionID credential 거부, 정상 투표 성공을 테스트한다.
- nullifier 계산 시 `/api/elections/:id/blinding-factor`를 조회한다.

핵심 파일:

- `application/scripts/ed25519-e2e-smoke.js`
- `application/package.json`

현재 한계:

- 실제 REST API 서버가 실행 중이지 않아 전체 E2E는 아직 수행하지 않았다.
- 현재 떠 있는 `voting-chaincode` 컨테이너에는 `ED25519_PUBLIC_KEY_DER_B64`가 들어 있지 않았다.

## 2. 작업 전 공통 원칙

### 2.1 Codex 작업 규칙

- 사용자 변경분을 되돌리지 않는다.
- `git status --short`로 변경 상태를 먼저 확인한다.
- 수동 편집은 `apply_patch`를 사용한다.
- 파일 검색은 `rg`, 파일 목록은 `rg --files`를 우선 사용한다.
- 테스트/검증 명령 결과를 최종 답변에 간단히 기록한다.
- 보고서가 필요한 단계는 Obsidian vault에도 추가한다.

Obsidian 보고서 위치:

```text
/Users/subeen/Documents/Obsidian Vault/Mongbas 프로젝트/전자투표_실효성_비판분석
```

### 2.2 공통 검증 명령

체인코드:

```bash
cd chaincode/voting
go test ./...
```

백엔드 문법:

```bash
node --check application/src/app.js application/src/routes/credential.js application/src/routes/vote.js application/src/routes/elections.js application/src/middleware/auth.js
```

네트워크 스크립트:

```bash
bash -n network/scripts/network.sh
```

프론트엔드:

```bash
cd frontend
npm run build
```

Ed25519 키 생성 스크립트:

```bash
cd application
npm run keys:ed25519
```

Ed25519 E2E smoke test:

```bash
cd application
npm run e2e:ed25519 -- --prepare
```

## 3. 남은 작업 전체 로드맵

모든 작업이 2026-05-07 완료되었다.

1. ✅ 실제 Ed25519 E2E 실행 환경 구성 (7차)
2. ✅ Ed25519 E2E 실패 조건 확장 (8차)
3. ✅ Merkle proof E2E 자동화 (9차)
4. ✅ 선거 종료/개표/tally 검증 자동화 (10차)
5. ✅ credential 발급 감사 로그 설계 (11차)
6. ✅ nullifier 재투표 정책 명확화 (12차)
7. ✅ PDC 접근 범위와 익명성 한계 개선 (13차)
8. ✅ Idemix/BBS+와 Ed25519의 역할 재정의 (14차)
9. ✅ BFT 주장의 정리 및 네트워크 합의 한계 문서화 (15차)
10. ✅ 운영 보안 hardening (16차)
11. ✅ Full Election E2E 통합 (17차)
12. ✅ 성능 벤치마크 재정리 (18차)
13. ✅ 최종 발표/논문형 보고서 정리 (19차)

추가 완료:
- ✅ 심사위원 비판 대응 문서 업데이트 (19차 이후)
- ✅ 프론트엔드 BFT 표현 수정

## 4. 7차 작업: 실제 Ed25519 E2E 실행

### 4.1 목표

`npm run e2e:ed25519 -- --prepare`가 실제 Fabric 네트워크와 REST API 서버에서 통과하도록 만든다.

### 4.2 이유

현재는 코드와 스크립트가 준비되었지만 실제 실행 결과가 없다. 심사 관점에서는 “구현되어 있다”보다 “실제 정상/실패 경로가 실행된다”가 더 강한 증거다.

### 4.3 세부 작업

1. 현재 컨테이너 상태 확인

```bash
docker ps --format '{{.Names}}\t{{.Status}}'
```

2. 현재 체인코드 컨테이너 환경변수 확인

```bash
docker inspect voting-chaincode --format '{{range .Config.Env}}{{println .}}{{end}}' | rg 'ED25519|ALLOW_BYPASS|CHAINCODE_ID'
```

3. Ed25519 키쌍 생성

```bash
cd application
npm run keys:ed25519 > /tmp/mongbas-ed25519.env
```

4. `/tmp/mongbas-ed25519.env`에서 공개키와 개인키를 확인한다.

주의:

- 개인키는 최종 답변에 출력하지 않는다.
- 공개키는 체인코드 배포 환경에만 전달한다.

5. shell에 공개키 export

```bash
export ED25519_PUBLIC_KEY_DER_B64='...'
```

6. 체인코드 컨테이너 재배포

`network/scripts/network.sh`의 사용법을 확인한 뒤 적절한 deploy 명령을 사용한다.

```bash
cd network
./scripts/network.sh deploy
```

실제 명령명이 다르면 `./scripts/network.sh help` 또는 파일 내부 `case` 문을 확인한다.

7. 재배포 후 공개키 주입 확인

```bash
docker inspect voting-chaincode --format '{{range .Config.Env}}{{println .}}{{end}}' | rg ED25519
```

8. 애플리케이션 서버 실행

```bash
cd application
ASYM_CRED_ENABLED=true \
IDEMIX_ENABLED=true \
ED25519_PRIVATE_KEY_DER_B64='...' \
ED25519_PUBLIC_KEY_DER_B64='...' \
npm start
```

9. 다른 터미널 또는 별도 exec 세션에서 E2E 실행

```bash
cd application
npm run e2e:ed25519 -- --prepare
```

### 4.4 완료 기준

다음 로그가 모두 나와야 한다.

- API root reachable
- issue credential
- local Ed25519 signature verification
- tampered credential vote rejected
- wrong-election credential vote rejected
- valid Ed25519 credential vote
- Ed25519 E2E smoke test completed

### 4.5 실패 시 우선 확인할 것

1. REST API 서버가 떠 있는지 확인

```bash
curl -sS http://localhost:3000/ | head
```

2. 체인코드 공개키 환경변수 확인

```bash
docker inspect voting-chaincode --format '{{range .Config.Env}}{{println .}}{{end}}' | rg ED25519
```

3. 애플리케이션 공개키와 체인코드 공개키가 같은지 확인

4. `ASYM_CRED_ENABLED=true`, `IDEMIX_ENABLED=true`가 API 서버에 적용되어 있는지 확인

5. 선거 생성/활성화가 성공했는지 확인

## 5. 8차 작업: Ed25519 실패 조건 확장

### 5.1 목표

현재 E2E smoke test에 빠져 있는 보안 실패 조건을 추가한다.

### 5.2 추가할 실패 조건

1. 만료 credential 거부
2. 공개키 불일치 거부
3. credential hash 불일치 거부
4. header alg 변조 거부
5. payload voterEligible 변조 거부
6. credentialToken 누락 거부
7. 같은 token으로 다른 electionID 투표 거부

### 5.3 추천 구현 방식

파일:

```text
application/scripts/ed25519-e2e-smoke.js
```

우선 추가할 테스트:

- `mutateTokenPayload(token, patch)` helper 추가
- `mutateTokenHeader(token, patch)` helper 추가
- `assertRejected('missing credential token vote', ...)` 추가

만료 credential 테스트는 바로 운영 엔드포인트를 바꾸지 말고 다음 중 하나를 선택한다.

방법 A:

- 테스트 실행 시 API 서버를 `CREDENTIAL_TTL_SEC=1`로 실행
- credential 발급 후 2초 대기
- 투표 요청이 거부되는지 확인

방법 B:

- test-only 발급 helper를 코드 내부 export로 만들고 REST 엔드포인트는 만들지 않는다.
- 운영 API에 임의 exp 발급 기능을 추가하지 않는다.

추천:

- 먼저 방법 A를 사용한다. 운영 코드 변경이 적다.

### 5.4 완료 기준

`npm run e2e:ed25519 -- --prepare`가 정상/실패 조건을 모두 통과한다.

### 5.5 보고서

Obsidian에 `7차_구현_보고서_Ed25519_실패조건_확장.md`를 작성한다.

구조:

- 목적
- 기존 문제점
- 개선 방향성
- 개선 내용
- 개선 후 성능/보안 향상
- 검증 결과
- 남은 한계

## 6. 9차 작업: Merkle proof E2E 자동화

### 6.1 목표

투표 성공 후 Merkle tree를 생성하고 proof를 받아 로컬에서 root를 재계산하는 API-level E2E를 만든다.

### 6.2 이유

프론트엔드에는 로컬 Merkle 검증기가 있지만, 자동화된 E2E 검증은 아직 없다. 검증가능성 주장을 강화하려면 “투표 -> Merkle 생성 -> proof 조회 -> root 재계산”이 자동으로 검증되어야 한다.

### 6.3 추가할 스크립트 후보

새 파일:

```text
application/scripts/merkle-e2e-smoke.js
```

또는 기존 `ed25519-e2e-smoke.js`에 `--with-merkle` 옵션 추가.

추천:

- 초기에는 별도 파일을 만든다.
- 안정화 후 통합한다.

### 6.4 API 흐름

1. 선거 생성
2. 선거 활성화
3. credential 발급
4. 투표
5. 선거 종료
6. Merkle tree 생성
7. proof 조회
8. Merkle root 조회
9. 로컬 root 재계산
10. chain root와 computed root 비교

### 6.5 확인할 API

- `POST /api/elections`
- `POST /api/elections/:id/activate`
- `POST /api/vote`
- `POST /api/elections/:id/close`
- `POST /api/elections/:id/merkle`
- `GET /api/elections/:id/proof/:nullifier`
- `GET /api/elections/:id/merkle`

### 6.6 구현 시 주의

- 선거 종료 후 투표가 불가능하므로 모든 투표를 먼저 수행한다.
- proof leaf hash는 2차 구현 방식과 동일하게 계산한다.
- local root 계산은 `frontend/src/utils/crypto.js`와 같은 로직을 Node용으로 재구현한다.
- 단일 leaf인 경우 proof가 비어 있을 수 있다. 이 경우 root는 leafHash와 같아야 한다.

### 6.7 완료 기준

- chain root와 computed root가 일치한다.
- proof의 `candidateCommitment`, `encryptedCandidateID`, `leafHash`가 존재한다.
- 변조된 leafHash로 root 계산 시 일치하지 않는다.

## 7. 10차 작업: tally 검증 자동화

### 7.1 목표

선거 종료 후 집계 결과가 투표 수와 일치하는지 자동 검증한다.

### 7.2 이유

현재 후보자 평문은 암호화되어 저장된다. 집계는 체인코드에서 암호화 키를 사용해 복호화한다. 따라서 tally가 실제로 동작하는지, 암호화 후보자 저장과 충돌하지 않는지 반드시 확인해야 한다.

### 7.3 테스트 시나리오

1. 선거 생성: 후보 A, B
2. voter1 -> A 투표
3. voter2 -> B 투표
4. voter3 -> A 투표
5. 선거 종료
6. tally 조회
7. A=2, B=1, totalVotes=3 확인

### 7.4 구현 파일 후보

```text
application/scripts/tally-e2e-smoke.js
```

또는 `application/scripts/full-election-e2e.js`

추천:

- 최종적으로는 `full-election-e2e.js` 하나로 통합한다.
- 하지만 초기에는 tally 전용 smoke test가 디버깅에 좋다.

### 7.5 주의할 점

- 유권자별 nullifier는 반드시 달라야 한다.
- credential은 voter1, voter2, voter3 각각 발급받는다.
- 후보자 암호화 키가 `CreateElection`에서 PDC에 저장되므로 `CreateElection` 권한과 PDC 설정이 정상이어야 한다.
- `InitKeySharing`을 먼저 실행하면 encryption key가 삭제될 수 있으므로 tally 테스트 순서를 확인한다.

## 8. 11차 작업: credential 발급 감사 로그 설계

### 8.1 목표

credential 발급에 대한 감사가능성을 높이되 voterID와 투표 선택의 연결 가능성을 만들지 않는다.

### 8.2 현재 문제

현재 credential 발급 서버는 등록 유권자 확인을 위해 `enrollmentID`를 안다. 이 자체는 현실적으로 필요할 수 있지만, 발급 로그 설계가 부주의하면 “누가 어느 선거에 참여했는지”가 서버 로그에 남을 수 있다.

### 8.3 설계 원칙

저장 가능:

- credential hash
- electionID
- issuedAt
- expiresAt
- issuer key id
- 발급 성공/실패 여부

주의 필요:

- enrollmentID 평문
- IP 주소
- user agent
- credential token 원문

금지 권장:

- voterID와 nullifierHash를 함께 저장
- voterID와 candidateID를 함께 저장
- credential token 원문 장기 저장

### 8.4 추천 구현

새 모듈:

```text
application/src/lib/audit-log.js
```

기능:

- append-only JSONL 형식
- 기본 저장 위치: `application/audit-logs/credential-issuance.jsonl`
- 운영 환경에서는 외부 append-only log sink로 교체 가능하게 추상화

환경변수:

```text
CREDENTIAL_AUDIT_ENABLED=true
CREDENTIAL_AUDIT_PATH=...
```

### 8.5 완료 기준

- credential 발급 시 감사 로그가 남는다.
- 로그에 credential token 원문은 없다.
- 로그에 candidateID는 없다.
- 로그에 nullifierHash는 없다.
- 테스트 또는 스크립트로 필드 검증을 한다.

## 9. 12차 작업: nullifier 재투표 정책 명확화

### 9.1 현재 상태

`CastVote`는 기존 nullifier가 있으면 이중투표 에러가 아니라 eviction처럼 이전 값을 덮어쓰는 구조다. `EvictCount`, `LastEvictedAt`이 존재한다.

### 9.2 비판점

전자투표에서 재투표 허용은 강압저항성에 도움이 될 수 있다. 그러나 정책이 명확하지 않으면 다음 문제가 생긴다.

- 이중투표 방지라고 설명했는데 실제로는 재투표 허용이다.
- 최종 투표만 유효한지, 모든 변경이 감사 가능한지 불명확하다.
- 강압자가 마지막 투표를 감시하면 재투표 효과가 약해진다.

### 9.3 결정해야 할 정책

정책 A: strict one-vote

- 같은 nullifier 재사용 시 거부
- 이중투표 방지 설명이 단순해짐
- 강압저항성은 약함

정책 B: revoting allowed, last vote counts

- 같은 nullifier 재사용 시 이전 투표 대체
- 강압 상황 이후 재투표 가능
- 문서와 UI에서 명확히 설명해야 함

추천:

- 프로젝트 목적이 강압저항성 균형이므로 정책 B를 유지하되, “이중투표 방지”라는 표현을 “최종 1표만 유효”로 바꾼다.

### 9.4 구현 작업

1. API 설명 문구 수정
2. 프론트엔드 문구 수정
3. 체인코드 로그와 에러 문구 정리
4. nullifier 조회 결과에 `evictCount`, `lastEvictedAt` 표시
5. 보고서에 재투표 정책을 명확히 작성

### 9.5 완료 기준

- 코드와 UI가 같은 정책을 말한다.
- 같은 nullifier로 다시 투표했을 때 최종 후보만 tally에 반영되는지 테스트한다.
- 이전 후보가 tally에 중복 반영되지 않아야 한다.

## 10. 13차 작업: PDC 익명성 한계 개선

### 10.1 현재 개선된 점

- 신규 `VotePrivate`에는 `voterID`, `candidateID` 평문이 없다.
- 공개 `Nullifier`에도 후보자 평문은 신규 투표에서 저장하지 않는다.

### 10.2 남은 문제

- PDC 접근 권한이 넓으면 내부 조직은 암호문, commitment, nullifier를 함께 볼 수 있다.
- 암호화 키가 PDC에 저장되는 동안 해당 PDC 접근 조직은 복호화 가능성이 있다.
- `CreateElection`에서 생성된 encryption key의 관리와 삭제 시점이 중요하다.

### 10.3 개선 방향

1. PDC collection config 검토
2. encryption key 저장 collection 분리
3. votePrivate collection과 key collection 접근 조직 분리
4. key sharing 초기화 후 원본 encryption key 삭제 검증
5. key share 제출/조회 테스트 추가

### 10.4 확인할 파일

```text
chaincode/voting/collection_config.json
chaincode/voting/voting.go
network/configtx.yaml
network/docker-compose.yaml
```

### 10.5 완료 기준

- vote data와 key data가 같은 접근 범위에 놓이지 않는다.
- 최소한 보고서에서 현재 PDC 접근 한계를 정직하게 설명한다.
- 가능하면 collection 분리를 구현한다.

## 11. 14차 작업: Idemix/BBS+ 역할 재정의

### 11.1 현재 상태

Ed25519는 실제 서명 검증이 가능하고 구현 안정성이 높다. 그러나 익명 credential로는 한계가 있다. Idemix/BBS+는 익명성 주장에 더 적합하지만 현재 구현의 완성도와 체인코드 직접 검증 연결은 Ed25519보다 약하다.

### 11.2 정리해야 할 주장

Ed25519:

- 더미 credential 제거
- 공개키 기반 검증 가능
- 구현 실효성 높음
- 익명 credential은 아님

Idemix/BBS+:

- 익명 credential 방향성에 적합
- 선택적 공개와 비연결성 주장 가능
- 현재 체인코드 직접 검증과 운영 배포 완성도는 추가 작업 필요

### 11.3 코드 작업 후보

1. `credType`별 보안 수준을 API status에 노출
2. `/api/bench/auth` 결과에 credential mode 설명 추가
3. 보고서에서 Ed25519를 “baseline”으로, Idemix/BBS+를 “future privacy credential path”로 분리

### 11.4 완료 기준

- 발표에서 Ed25519를 Idemix라고 과장하지 않는다.
- 코드와 문서에서 credential mode가 명확히 구분된다.

## 12. 15차 작업: BFT 주장 정리

### 12.1 현재 상태

`network/configtx.yaml`은 `OrdererType: etcdraft`이다. 이것은 CFT 합의다. endorsement가 2-of-3이어도 orderer 합의가 Byzantine fault tolerant가 되는 것은 아니다.

### 12.2 반드시 지켜야 할 표현

사용 가능:

- “2-of-3 endorsement로 실행 결과 조작을 일부 견제한다.”
- “Fabric etcdraft 기반 CFT 네트워크다.”
- “Byzantine orderer fault를 견디는 엄밀한 BFT 시스템은 아니다.”

피해야 할 표현:

- “BFT 블록체인”
- “비잔틴 공격을 완전히 방어”
- “악의적 orderer를 견딘다”

### 12.3 코드/문서 작업

1. README, docs, API 설명에서 BFT 표현 검색

```bash
rg -n "BFT|Byzantine|비잔틴|담합|CFT|etcdraft" .
```

2. 부정확한 표현 수정
3. “CFT + 다조직 endorsement + 감사가능성”으로 정확히 표현

### 12.4 완료 기준

- BFT 과장 표현이 사라진다.
- 네트워크 한계가 문서에 명시된다.

## 13. 16차 작업: 운영 보안 hardening

### 13.1 목표

캡스톤 데모 수준에서 운영형 보안에 가까운 기본 방어를 추가한다.

### 13.2 작업 목록

1. `.env.example` 작성
2. production 필수 환경변수 검증 강화
3. credential secret 기본값 사용 금지
4. Ed25519 dev key 자동 생성은 development에서만 허용
5. CORS 정책 명확화
6. request body size 제한
7. 보안 header 추가
8. rate limit 추가
9. 개발용 `/api/credential/voters` production 비활성화
10. 로그에서 credential token, nullifier, private key 출력 방지

### 13.3 우선 수정 파일

```text
application/src/app.js
application/src/lib/asym-keys.js
application/src/routes/credential.js
application/package.json
```

### 13.4 완료 기준

- `NODE_ENV=production`에서 필수 env 누락 시 서버가 시작되지 않는다.
- 개발용 endpoint가 production에서 막힌다.
- 민감값이 로그에 출력되지 않는다.

## 14. 17차 작업: full election E2E 통합

### 14.1 목표

credential부터 tally까지 한 번에 검증하는 통합 스크립트를 만든다.

### 14.2 추천 파일

```text
application/scripts/full-election-e2e.js
```

### 14.3 시나리오

1. 키/환경 확인
2. 선거 생성
3. 선거 활성화
4. voter1 credential 발급
5. voter2 credential 발급
6. voter3 credential 발급
7. voter1 투표
8. voter2 투표
9. voter3 투표
10. 변조 credential 거부
11. wrong election credential 거부
12. 선거 종료
13. tally 조회
14. Merkle tree 생성
15. 각 voter proof 조회
16. 각 proof local root 검증
17. tally expected count 검증

### 14.4 완료 기준

스크립트 하나로 프로젝트의 핵심 주장이 재현되어야 한다.

성공 조건:

- credential 검증 성공/실패 모두 확인
- 투표 저장 성공
- 후보자 평문이 공개 Nullifier에 없는지 확인
- Merkle proof 검증 성공
- tally 결과 일치

## 15. 18차 작업: 성능 벤치마크 재정리

### 15.1 목표

보안 개선 전후 성능 비용을 정리한다.

### 15.2 현재 관련 파일

```text
caliper/
application/benchmark-reports/
docs/performance/
```

### 15.3 측정해야 할 항목

1. credential 발급 지연
2. credential 검증 지연
3. vote transaction latency
4. throughput
5. Merkle build time
6. proof verification time
7. tally time

### 15.4 비교 모드

- bypass
- HMAC
- Ed25519
- PS/BBS+ 가능 시

### 15.5 완료 기준

- 표 형태 결과 정리
- 보안 강화로 인한 latency 증가를 정직하게 설명
- “성능은 낮아졌지만 검증가능성은 증가”처럼 trade-off를 명시

## 16. 19차 작업: 최종 보고서 통합

### 16.1 목표

Obsidian에 흩어진 1차~최종 보고서를 발표/논문형 최종본으로 통합한다.

### 16.2 포함해야 할 장

1. 연구 목적
2. 검증의 역설 문제 정의
3. 관련 연구
4. 시스템 아키텍처
5. 위협 모델
6. 구현 상세
7. 보안성 분석
8. 실효성 분석
9. 한계
10. 성능 평가
11. 향후 연구

### 16.3 반드시 정직하게 써야 할 한계

- etcdraft는 BFT가 아니다.
- Ed25519는 익명 credential이 아니다.
- Idemix/BBS+는 아직 최종 완성 경로가 아니다.
- PDC 접근 조직 내부자 문제는 완전히 해결되지 않았다.
- 강압저항성은 부분 설계이며 완전한 receipt-freeness는 아니다.
- 공공 선거 운영 수준의 키 관리는 아니다.

## 17. Codex에게 권장하는 다음 실행 순서

가장 바로 이어서 할 작업은 다음 순서다.

1. `git status --short`로 현재 변경분 확인
2. `application/scripts/ed25519-e2e-smoke.js` 재검토
3. Ed25519 키 생성
4. 체인코드 공개키 포함 재배포
5. API 서버 실행
6. `npm run e2e:ed25519 -- --prepare` 실제 실행
7. 실패하면 로그를 기준으로 수정
8. 성공하면 Obsidian에 7차 실행 결과 보고서 작성
9. 이후 만료 credential/공개키 불일치 테스트 추가
10. Merkle proof E2E 자동화로 이동

## 18. 작업 완료 시 최종 답변 형식

Codex는 각 단계 완료 후 사용자에게 다음만 간결하게 보고한다.

```text
N차 단계 완료했습니다.

수정 파일:
- ...

검증:
- ... 통과
- ... 실패 또는 미실행 사유

보고서:
- ...

다음 우선순위:
- ...
```

## 19. 현재 가장 중요한 판단

지금 프로젝트에서 가장 중요한 것은 새로운 주장을 추가하는 것이 아니라, 이미 추가한 보안 주장을 실제 실행 결과로 고정하는 것이다.

따라서 다음 작업은 논문 조사나 문구 수정이 아니라 실제 E2E 실행이다. Ed25519 credential이 정상 요청은 통과시키고 변조/오용 요청은 거부한다는 것을 실제 네트워크에서 확인해야 한다. 그 다음 Merkle proof와 tally까지 자동화하면, Mongbas는 “개념 설명 중심 프로젝트”에서 “핵심 보안 경로를 재현 가능한 코드로 검증하는 프로젝트”에 가까워진다.
