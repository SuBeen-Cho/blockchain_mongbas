# 프로젝트 인수인계 문서 — BFT 기반 익명 전자투표 블록체인

> 작성일: 2026-03-27
> 대상: 다음 팀원 (이 문서를 처음 보는 사람 기준)

---

## 1. 지금까지 완료된 작업 요약

### 완료된 것

| 항목 | 상태 | 비고 |
|-----|------|------|
| 네트워크 인증서 설계 (crypto-config.yaml) | ✅ 완료 | 3개 조직 + 4 오더러 |
| 채널·제네시스 블록 설계 (configtx.yaml) | ✅ 완료 | 2-of-3 승인 정책 |
| Docker 네트워크 설계 (docker-compose.yaml) | ✅ 완료 | 오더러4 + 피어4 + CouchDB4 |
| 네트워크 기동 자동화 (network.sh) | ✅ 완료 | up/deploy/test/down/clean |
| 체인코드 데이터 구조 설계 (voting.go) | ✅ 완료 | Nullifier + PDC 익명투표 |
| 체인코드 전 함수 구현 | ✅ 완료 | CastVote / TallyVotes 포함 |
| CouchDB 인덱스 설정 | ✅ 완료 | docType + electionID 인덱스 |
| PDC(Private Data Collection) 설정 | ✅ 완료 | VotePrivateCollection |
| 네트워크 실제 기동 검증 | ✅ 완료 | 오더러·피어 채널 참여 성공 |
| 체인코드 배포 검증 | ✅ 완료 | 3개 기관 승인 / 2-of-3 커밋 |
| 투표 시나리오 테스트 | ✅ 완료 | 투표·Nullifier·이중투표차단 |

### 남은 것 (다음 팀원 작업)

| 항목 | 우선순위 |
|-----|---------|
| `application/` — Node.js 클라이언트 개발 | 높음 |
| 앵커 피어 업데이트 (조직 간 Gossip 통신) | 중간 |
| 유권자 등록 / 자격 검증 로직 체인코드 추가 | 중간 |
| 프론트엔드 UI | 낮음 |

---

## 2. 프로젝트 구조

```
blockchain_mongbas/
├── network/
│   ├── crypto-config.yaml        ← 인증서 생성 설정 (cryptogen)
│   ├── configtx.yaml             ← 채널·제네시스 블록 설정
│   ├── docker-compose.yaml       ← 컨테이너 정의 (오더러4·피어4·CouchDB4·CLI)
│   ├── channel-artifacts/
│   │   └── genesis.block         ← 생성된 제네시스 블록
│   ├── crypto-config/            ← 생성된 인증서 (gitignore 권장)
│   └── scripts/
│       └── network.sh            ← 네트워크 전체 관리 스크립트
├── chaincode/
│   └── voting/
│       ├── voting.go             ← 체인코드 (모든 함수 구현 완료)
│       ├── go.mod / go.sum
│       ├── collection_config.json  ← PDC 설정
│       └── META-INF/statedb/couchdb/indexes/
│           └── indexElection.json  ← CouchDB 인덱스
└── application/                  ← (미구현) Node.js 클라이언트
```

---

## 3. 네트워크 아키텍처

### 조직 구성 (2-of-3 승인 정책)

```
┌─────────────────────────────────────────────┐
│  ElectionCommissionMSP (선거관리위원회)        │
│  peer0.ec.voting.example.com  :7051         │
│  peer1.ec.voting.example.com  :7151         │
├─────────────────────────────────────────────┤
│  PartyObserverMSP (참관 정당)                 │
│  peer0.party.voting.example.com :8051       │
├─────────────────────────────────────────────┤
│  CivilSocietyMSP (시민단체)                   │
│  peer0.civil.voting.example.com :9051       │
└─────────────────────────────────────────────┘

승인 정책: OutOf(2, EC.peer, Party.peer, Civil.peer)
→ 3개 기관 중 어느 2개가 서명해도 트랜잭션 유효
→ 단일 기관 단독 조작 불가능
```

### 오더러 구성 (etcdraft, 4-node CFT)

```
orderer1 :7050 / admin :7053
orderer2 :7150 / admin :7153
orderer3 :7250 / admin :7253
orderer4 :7350 / admin :7353

4-node etcdraft → 노드 1개 장애 허용 (f=1)
※ SmartBFT(진정한 BFT)는 fabric-tools 안정 3.x 이미지
  미출시로 현재 etcdraft 사용. 운영 시 3.x 전환 예정.
```

### 프라이버시 흐름

```
유권자 (클라이언트)
  │
  ├─ voterSecret (로컬 보관, 절대 체인에 전송 금지)
  │
  └─ nullifierHash = SHA256(voterSecret + electionID)  ← 클라이언트가 계산
          │
          ▼
  CastVote(electionID, candidateID, nullifierHash)
  + transient["votePrivate"] = { voterID, candidateID, ... }
          │
          ├─→ [공개 원장] Nullifier { nullifierHash, candidateID }
          │     → 이중투표 방지 / 신원 미노출
          │
          └─→ [PDC: VotePrivateCollection] VotePrivate { voterID, ... }
                → 오더러 미전달 / 피어 비공개 DB에만 저장
```

---

## 4. 환경 준비 (처음 세팅하는 경우)

### 필수 설치

| 도구 | 버전 | 용도 |
|-----|------|------|
| Docker + docker-compose | 최신 | 컨테이너 실행 |
| Go | 1.21+ | 체인코드 빌드 |
| Hyperledger Fabric 바이너리 | 2.5.9 | cryptogen, configtxgen, peer, osnadmin |
| python3 | 3.x | 패키지 ID 파싱 (network.sh 내부 사용) |

### Fabric 바이너리 위치 확인

`network.sh` 상단에 바이너리 경로가 하드코딩되어 있습니다.
**이 경로가 실제 환경과 다르면 반드시 수정하세요.**

```bash
# network/scripts/network.sh 26번째 줄
FABRIC_BIN="/home/hihi/fabric-capstone/fabric-samples/bin"
```

바이너리가 없다면:
```bash
cd /home/hihi/fabric-capstone
curl -sSL https://raw.githubusercontent.com/hyperledger/fabric/main/scripts/install-fabric.sh \
  | bash -s -- --fabric-version 2.5.9 binary
```

### peer CLI 설정 파일 위치 확인

`network.sh` 35번째 줄의 `PEER_CFG_PATH`도 확인하세요.
이 경로의 폴더 안에 `core.yaml`이 있어야 합니다.

```bash
# network/scripts/network.sh 35번째 줄
PEER_CFG_PATH="/home/hihi/fabric-capstone/fabric-samples/config"
```

---

## 5. 네트워크 실행 방법 (처음부터 시작)

**모든 명령은 `network/` 폴더 안에서 실행합니다.**

```bash
cd /home/hihi/fabric-capstone/blockchain_mongbas/network
```

### Step 1 — 네트워크 기동 (인증서 + 제네시스 블록 + Docker + 채널 참여)

```bash
./scripts/network.sh up
```

내부적으로 아래 5단계가 순서대로 실행됩니다:
1. `cryptogen` — 조직별 인증서 생성 → `crypto-config/`
2. `configtxgen` — 제네시스 블록 생성 → `channel-artifacts/genesis.block`
3. `docker-compose up -d` — 전체 컨테이너 기동
4. `osnadmin channel join` × 4 — 오더러 4개가 채널 참여 (Status: 201 확인)
5. `peer channel join` × 4 — 피어 4개가 채널 참여 (Successfully submitted 확인)

> **성공 지표**: 마지막 줄에 `네트워크 구동 완료!` 출력

### Step 2 — 체인코드 배포

```bash
./scripts/network.sh deploy
```

내부적으로 아래 7단계가 순서대로 실행됩니다:
1. 패키징 (`voting_1.0.tar.gz` 생성)
2. 4개 피어 전체 설치
3. 패키지 ID 조회
4. 3개 기관 각각 `approveformyorg` 실행
5. `checkcommitreadiness` — 3개 기관 모두 `true` 확인
6. `commit` — 2-of-3 충족 (선관위 + 참관 정당 피어를 endorser로)
7. `InitLedger` — 시연용 선거 데이터 초기화

> **성공 지표**: `체인코드 배포 완료! (3개 기관 승인 / 2-of-3 커밋)` 출력

### Step 3 — 동작 확인

```bash
./scripts/network.sh test
```

4가지 시나리오 자동 실행:
1. `GetElection` — 선거 정보 조회
2. `CastVote` — 실제 투표 제출 (Transient Map으로 비공개 데이터 전달)
3. `GetNullifier` — 투표 기록 확인
4. 이중투표 시도 — 에러 발생 확인 (정상)

> **성공 지표**: `모든 테스트 통과!` 출력

---

## 6. 자주 쓰는 명령어

```bash
# 네트워크 종료 (볼륨 삭제 포함)
./scripts/network.sh down

# 완전 초기화 (인증서·블록·볼륨 전부 삭제)
./scripts/network.sh clean

# 컨테이너 상태 확인
docker-compose ps

# 오더러 로그 확인
docker logs orderer1.orderer.voting.example.com 2>&1 | tail -20

# 피어 로그 확인
docker logs peer0.ec.voting.example.com 2>&1 | tail -20

# CouchDB 웹 UI (Fauxton)
# 선관위 peer0: http://localhost:5984/_utils  (admin/adminpw)
# 선관위 peer1: http://localhost:5985/_utils
# 참관 정당:    http://localhost:6984/_utils
# 시민단체:     http://localhost:7984/_utils
```

### peer 명령어 직접 실행할 때 환경변수 설정

`network.sh` 밖에서 `peer` 명령을 직접 실행하려면 아래 환경변수가 필요합니다.

```bash
export PATH="/home/hihi/fabric-capstone/fabric-samples/bin:$PATH"
export FABRIC_CFG_PATH="/home/hihi/fabric-capstone/fabric-samples/config"

CRYPTO="/home/hihi/fabric-capstone/blockchain_mongbas/network/crypto-config"

# 선관위 peer0 기준
export CORE_PEER_TLS_ENABLED=true
export CORE_PEER_LOCALMSPID=ElectionCommissionMSP
export CORE_PEER_MSPCONFIGPATH="${CRYPTO}/peerOrganizations/ec.voting.example.com/users/Admin@ec.voting.example.com/msp"
export CORE_PEER_ADDRESS=localhost:7051
export CORE_PEER_TLS_ROOTCERT_FILE="${CRYPTO}/peerOrganizations/ec.voting.example.com/peers/peer0.ec.voting.example.com/tls/ca.crt"

ORDERER_CA="${CRYPTO}/ordererOrganizations/orderer.voting.example.com/orderers/orderer1.orderer.voting.example.com/tls/ca.crt"
```

---

## 7. 체인코드 구현된 함수 목록

| 함수 | 파라미터 | 설명 |
|-----|---------|------|
| `InitLedger` | 없음 | 시연용 선거 1개 초기화 |
| `CreateElection` | electionID, title, description, candidatesJSON, startTime, endTime | 새 선거 생성 |
| `GetElection` | electionID | 선거 정보 조회 |
| `CastVote` | electionID, candidateID, nullifierHash | 익명 투표 제출 |
| `GetNullifier` | nullifierHash | 특정 nullifier 조회 (이중투표 확인) |
| `CloseElection` | electionID | 선거 종료 + 집계 |
| `TallyVotes` | electionID | CouchDB Rich Query로 득표 집계 |
| `GetTally` | electionID | 집계 결과 조회 |

### CastVote 클라이언트 사용법 (중요)

비공개 데이터(`votePrivate`)는 **반드시 Transient Map**으로 전달해야 합니다.
일반 인자로 넣으면 오더러에 전달되어 프라이버시가 깨집니다.

```javascript
// Node.js SDK 예시 (application/ 폴더에서 구현 예정)
const { connect } = require('@hyperledger/fabric-gateway');

const nullifierHash = sha256(voterSecret + electionID);  // 클라이언트에서 계산

const privateData = Buffer.from(JSON.stringify({
  docType:       "votePrivate",
  voterID:       "voter001_encrypted",
  electionID:    "ELECTION_2026_PRESIDENT",
  candidateID:   "CANDIDATE_A",
  nullifierHash: nullifierHash,
  voteHash:      sha256(voterID + candidateID + salt),
}));

await contract.createTransaction('CastVote')
  .setTransient({ votePrivate: privateData })  // ← 오더러 미전달
  .submit(electionID, candidateID, nullifierHash);
```

---

## 8. 알려진 제약 사항

### BFT 합의 관련
현재 **etcdraft (CFT)** 를 사용합니다. 진정한 BFT(비잔틴 장애 허용)를 위해서는 Hyperledger Fabric 3.x의 **SmartBFT** 가 필요합니다. 그러나 `fabric-tools:3.x` 안정 이미지가 Docker Hub에 미출시 상태여서 SmartBFT genesis block 생성이 불가능합니다.

**SmartBFT로 전환하려면:**
1. `fabric-tools:3.1` 안정 이미지가 Docker Hub에 출시될 때까지 대기
2. 또는 GitHub Releases에서 Fabric 3.1.x ARM64 바이너리 직접 다운로드
3. configtx.yaml의 `OrdererType: etcdraft` → `OrdererType: smartbft` 로 변경
4. docker-compose.yaml 이미지를 `2.5` → `3.1` 로 변경
5. `network.sh clean && network.sh up` 으로 재기동

### 유권자 인증 미구현
현재 체인코드는 nullifierHash가 유효한지 **수학적으로만 검증**합니다.
실제 유권자 자격(선거인 명부 등록 여부)을 검증하는 로직이 없습니다.
`CreateElection` 시 유권자 목록을 등록하거나, CA 기반 자격 검증을 추가해야 합니다.

---

## 9. 주요 포트 맵

| 서비스 | 호스트 포트 | 용도 |
|-------|----------|------|
| orderer1 | 7050 | 트랜잭션 수신 |
| orderer1 admin | 7053 | osnadmin (채널 관리) |
| orderer2 | 7150 / 7153 | |
| orderer3 | 7250 / 7253 | |
| orderer4 | 7350 / 7353 | |
| peer0.ec | 7051 | 선관위 주 피어 |
| peer1.ec | 7151 | 선관위 보조 피어 |
| peer0.party | 8051 | 참관 정당 |
| peer0.civil | 9051 | 시민단체 |
| couchdb-ec0 | 5984 | peer0.ec 상태 DB |
| couchdb-ec1 | 5985 | peer1.ec 상태 DB |
| couchdb-party | 6984 | peer0.party 상태 DB |
| couchdb-civil | 7984 | peer0.civil 상태 DB |

---

## 10. 트러블슈팅

### Q: `network.sh up` 실패 시 어디서 막혔는지 모르겠다
```bash
# 컨테이너 상태 확인
docker-compose ps

# 오더러 에러 확인
docker logs orderer1.orderer.voting.example.com 2>&1 | grep -E "ERROR|WARN|panic"

# 피어 에러 확인
docker logs peer0.ec.voting.example.com 2>&1 | grep -E "ERROR|WARN|panic"
```

### Q: 오더러 채널 참여 시 TLS 오류
crypto-config.yaml의 SANS 설정을 확인하세요. `localhost`와 `127.0.0.1`이 반드시 포함되어야 합니다.
```yaml
# crypto-config.yaml
Specs:
  - Hostname: orderer1
    SANS:
      - localhost
      - 127.0.0.1
```
빠져 있다면 `network.sh clean && network.sh up` 으로 재생성합니다.

### Q: `configtxgen: 명령을 찾을 수 없습니다`
```bash
export PATH="/home/hihi/fabric-capstone/fabric-samples/bin:$PATH"
```

### Q: `core.yaml not found` 오류
`PEER_CFG_PATH` 변수가 `core.yaml`이 있는 폴더를 가리키는지 확인하세요.
```bash
ls /home/hihi/fabric-capstone/fabric-samples/config/core.yaml
```

### Q: `deploy` 시 체인코드 승인 실패 (이미 배포된 상태에서 재배포)
sequence 번호를 올려야 합니다. `network.sh deploy` 내부의 `--sequence 1` 을 `--sequence 2` 등으로 수정하거나, `network.sh down && network.sh up && network.sh deploy` 로 초기화 후 재배포합니다.

### Q: `TallyVotes` 결과가 0으로 나온다
CouchDB 인덱스가 생성되지 않았을 수 있습니다. 체인코드를 먼저 invoke한 후 `META-INF/` 인덱스 파일이 정상적으로 배포되었는지 CouchDB Fauxton UI(`http://localhost:5984/_utils`)에서 확인하세요.

---

## 11. 다음 팀원 작업 가이드 (남은 항목 2~5)

### 권장 진행 순서

```
2번 Node.js 백엔드
  → 4번 React 프론트엔드 연동
      → 3번 Panic Mode (단순화 버전 먼저)
          → 5번 Caliper 성능 측정
              → 3번 Idemix (시간 여유 있을 때)
```

---

### 항목 2 — Node.js 백엔드 API 개발 ✅ 바로 시작 가능

**폴더:** `application/`

**설치할 패키지:**
```bash
cd application
npm init -y
npm install @hyperledger/fabric-gateway @grpc/grpc-js
```

**구현할 REST API 목록:**

| 엔드포인트 | 메서드 | 설명 |
|-----------|--------|------|
| `/api/elections/:id` | GET | 선거 정보 조회 |
| `/api/vote` | POST | 투표 제출 |
| `/api/nullifier/:hash` | GET | 내 투표 확인 (이중투표 여부) |
| `/api/elections/:id/tally` | GET | 개표 결과 조회 |
| `/api/elections/:id/close` | POST | 선거 종료 (관리자) |
| `/api/elections` | POST | 선거 생성 (관리자) |

**가장 중요한 주의사항 — CastVote Transient 처리:**

`CastVote`를 호출할 때 비공개 데이터는 반드시 `setTransient()`로 전달해야 합니다.
일반 인자(`submit()` 파라미터)로 넣으면 오더러를 통해 모든 조직에 노출됩니다.

```javascript
// application/src/gateway.js 예시

const { connect, hash } = require('@hyperledger/fabric-gateway');
const grpc = require('@grpc/grpc-js');
const crypto = require('crypto');

// nullifierHash는 서버가 아닌 클라이언트(브라우저)에서 계산해야 함
// voterSecret이 서버로 전달되면 안 됨
// → 클라이언트: nullifierHash = SHA256(voterSecret + electionID)

async function castVote({ electionID, candidateID, nullifierHash, voterID, voteHash }) {
  const privateData = Buffer.from(JSON.stringify({
    docType:       'votePrivate',
    voterID,           // 암호화된 유권자 식별자
    electionID,
    candidateID,
    nullifierHash,
    voteHash,          // SHA256(voterID + candidateID + salt)
  }));

  await contract
    .createTransaction('CastVote')
    .setTransient({ votePrivate: privateData })  // ← 핵심: 오더러 미전달
    .submit(electionID, candidateID, nullifierHash);
}
```

**Fabric Gateway 연결 예시:**
```javascript
const fs = require('fs');
const path = require('path');
const grpc = require('@grpc/grpc-js');
const { connect, signers } = require('@hyperledger/fabric-gateway');
const crypto = require('crypto');

const CRYPTO = path.join(__dirname,
  '../../network/crypto-config/peerOrganizations/ec.voting.example.com');

const tlsCert   = fs.readFileSync(path.join(CRYPTO, 'peers/peer0.ec.voting.example.com/tls/ca.crt'));
const certPem   = fs.readFileSync(path.join(CRYPTO, 'users/User1@ec.voting.example.com/msp/signcerts/User1@ec.voting.example.com-cert.pem'));
const keyPem    = fs.readFileSync(path.join(CRYPTO, 'users/User1@ec.voting.example.com/msp/keystore/priv_sk'));

const client = new grpc.Client('localhost:7051', grpc.credentials.createSsl(tlsCert));

const gateway = connect({
  client,
  identity: { mspId: 'ElectionCommissionMSP', credentials: certPem },
  signer:   signers.newPrivateKeySigner(crypto.createPrivateKey(keyPem)),
});

const network  = gateway.getNetwork('voting-channel');
const contract = network.getContract('voting');
```

---

### 항목 3 — 보안 고도화 ⚠️ 난이도 주의

#### 3-A. Panic Mode (먼저 구현 — 현실적)

**개념:** 강압 상황에서 패닉 비밀번호를 입력하면, 실제 투표가 아닌 가짜 투표 기록을 반환하여 강압자를 속임.

**구현 방향 (단순화 버전):**

1. `InitLedger`에서 더미 투표 데이터 몇 개를 미리 원장에 심어둠
2. 백엔드 API에서 패닉 비밀번호(`panicPassword`)를 감지
3. 감지 시, 실제 nullifier 조회 대신 더미 nullifier를 반환

```javascript
// application/src/routes/vote.js
app.get('/api/nullifier/:hash', async (req, res) => {
  const { panicMode } = req.session;  // 패닉 세션 여부

  if (panicMode) {
    // 더미 nullifier 반환 (가짜 머클 경로)
    return res.json({ nullifierHash: FAKE_NULLIFIER_HASH, candidateID: 'CANDIDATE_FAKE' });
  }

  const result = await contract.evaluateTransaction('GetNullifier', req.params.hash);
  res.json(JSON.parse(result.toString()));
});
```

체인코드에는 `GetPanicNullifier` 함수를 추가하여 더미 데이터를 반환하게 하는 것이 더 깔끔합니다.

#### 3-B. Idemix (시간 여유 있을 때 — 어려움)

Idemix는 Fabric CA가 발급하는 ZKP 기반 익명 자격증명입니다.

**주의:** Node.js Gateway SDK에서 Idemix 자격증명 지원이 불완전합니다.
구현이 막힐 경우 **설계 문서 + 개념 증명 수준**으로 보고서에 기술하는 것도 인정됩니다.

구현 시도 시 참고:
- `fabric-ca-client` 패키지의 `reenroll` + Idemix 옵션
- Fabric CA 서버에 `idemix` issuer 설정 필요 (docker-compose에 CA 컨테이너 추가)

---

### 항목 4 — React 프론트엔드 ✅ 바로 시작 가능

**구현할 화면:**

| 화면 | 설명 |
|-----|------|
| 투표 화면 | 선거 목록 → 후보자 선택 → 제출 |
| 내 투표 확인 | nullifierHash 입력 → 내 투표 기록 조회 |
| 개표 결과 | 후보자별 득표수 시각화 |
| 관리자 화면 | 선거 생성 / 종료 |

**Deniable UI 구현 요령:**

비밀번호 입력창 하나로 일반 로그인과 패닉 모드를 구분합니다.
UI 상으로는 완전히 동일하게 보여야 합니다.

```jsx
// 로그인 폼에서 비밀번호 입력 시
const handleLogin = async (password) => {
  const response = await fetch('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ password }),
  });
  // 서버가 패닉 모드를 세션에 기록 → 이후 API 응답이 달라짐
  // 프론트엔드는 패닉 여부를 알 수 없어야 함 (자연스러운 부인 가능성)
};
```

---

### 항목 5 — 시스템 검증 및 성능 평가 ⚠️ 용어 주의

#### 5-A. 장애 시뮬레이션

현재 네트워크는 **etcdraft (CFT)** 입니다.
오더러 1개를 꺼도 정상 작동하면 **"CFT 검증 성공"** 이라고 기술해야 합니다.
보고서에서 "BFT 검증"이라고 쓰면 교수님께 지적받을 수 있습니다.

```bash
# 오더러 1개 강제 종료
docker stop orderer1.orderer.voting.example.com

# 나머지 3개로 투표가 정상 작동하는지 확인
bash scripts/network.sh test

# 복구
docker start orderer1.orderer.voting.example.com
```

#### 5-B. Hyperledger Caliper 성능 측정

Caliper는 마지막에 설치하세요. Fabric 버전 호환 설정이 까다롭습니다.

```bash
# 설치
npm install -g @hyperledger/caliper-cli
caliper bind --caliper-bind-sut fabric:2.4

# 워크로드 파일 작성 후 실행
caliper launch manager \
  --caliper-workspace ./caliper \
  --caliper-networkconfig network-config.yaml \
  --caliper-benchconfig benchmark.yaml
```

측정 지표: **TPS (초당 처리량)**, **Latency (지연시간)**
변수: 오더러 노드 수 (1/2/4), 블록 크기 (`BatchSize.MaxMessageCount`)

---

## 12. 코드 검토 결과 (2026-03-27 기준)

| 파일 | 이슈 | 상태 |
|-----|-----|------|
| `network.sh` | step 번호 불일치 (1/3 → 1/5) | ✅ 수정 완료 |
| `configtx.yaml` | 헤더 주석이 SmartBFT라고 써있었으나 실제 etcdraft | ✅ 수정 완료 |
| `collection_config.json` | `memberOnlyWrite: false` — 의도적 설정 (유권자가 클라이언트로서 PDC에 쓰기 가능해야 함) | ✅ 정상 |
| `voting.go` | 모든 함수 구현 완료, getTxTime() 사용으로 다중 피어 RW-set 일치 보장 | ✅ 정상 |
| `docker-compose.yaml` | 모든 서비스 정상, CouchDB healthcheck 연동 | ✅ 정상 |
| `crypto-config.yaml` | 모든 노드에 localhost/127.0.0.1 SAN 포함 | ✅ 정상 |
