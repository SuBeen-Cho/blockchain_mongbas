<p align="center">
  <h1 align="center">Mongbas</h1>
  <p align="center">
    <strong>Hyperledger Fabric 기반 다조직 합의 익명 전자투표 시스템</strong>
  </p>
  <p align="center">
    Anonymous E-Voting with Multi-Org Consensus on Hyperledger Fabric 2.5
  </p>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Hyperledger%20Fabric-2.5-blue?logo=hyperledger" alt="Fabric">
  <img src="https://img.shields.io/badge/Go-1.21-00ADD8?logo=go" alt="Go">
  <img src="https://img.shields.io/badge/Node.js-18+-339933?logo=node.js" alt="Node">
  <img src="https://img.shields.io/badge/React-Vite-61DAFB?logo=react" alt="React">
  <img src="https://img.shields.io/badge/Security%20Properties-7%2F7-brightgreen" alt="Security">
  <img src="https://img.shields.io/badge/Encryption-Exponential%20ElGamal-purple" alt="Encryption">
</p>

---

## Overview

기존 전자투표 시스템은 중앙 서버 의존으로 **단일 기관 조작 가능성**과 **유권자 익명성 침해** 위험이 존재합니다. 또한 E2E 검증을 위한 증명 데이터가 강압 증거로 악용되는 **"검증의 역설"** 문제가 있습니다.

**Mongbas**는 Hyperledger Fabric 블록체인 위에 학술 수준의 암호학적 보안 메커니즘을 구현하여, **검증가능성과 프라이버시를 동시에 달성**하는 익명 전자투표 시스템입니다.

### Key Features

- **다조직 합의 (2-of-3 Endorsement)** — 선거관리위원회, 참관정당, 시민단체 3개 독립 기관 중 2개 이상 서명 필요
- **Exponential ElGamal 암호화** — 공개키 암호화 + 동형 집계 (homomorphic tally)
- **Chaum-Pedersen ZKP** — 투표 유효성 증명 (disjunctive OR-proof, 비대화형 Fiat-Shamir)
- **Nullifier 기반 익명 투표** — 투표 사실은 증명 가능하되 투표자 식별 불가
- **Benaloh Challenge** — Cast-as-intended 검증
- **Shamir Secret Sharing (2-of-3)** — 분산 키 관리, 단일 관리자 없이 집계
- **Coercion Resistance** — Panic Credential + Re-voting + Panic Password + Receipt-Free 다층 방어
- **Merkle Tree 검증** — 투표 포함/배제 증명 (E2E verifiability)

---

## Security Properties

학술 전자투표 보안 프레임워크 기준 **7개 속성 모두 달성**:

| 속성 | 달성 | 메커니즘 |
|------|:----:|----------|
| **Ballot Secrecy** | **O** | DDH assumption (Exponential ElGamal) |
| **Cast-as-Intended** | **O** | Benaloh Challenge |
| **Recorded-as-Cast** | **O** | Merkle Proof |
| **Tallied-as-Recorded** | **O** | Homomorphic ZKP (Chaum-Pedersen) |
| **Universal Verifiability** | **O** | Homomorphic ZKP + Bulletin Board |
| **Eligibility Verifiability** | **O** | HMAC / Ed25519 chaincode verification |
| **Coercion Resistance** | **O** | Layered: Panic Credential + Re-voting + Panic Password + Receipt-Free |

> 보안 증명: BPRIV game-based proof (DDH reduction sketch for ballot privacy)

---

## Architecture

```
                    ┌─────────────────────────────────┐
                    │       Ordering Service           │
                    │  etcdraft 4-node (CFT consensus) │
                    └──────────┬──────────────────────┘
                               │
            ┌──────────────────┼──────────────────┐
            v                  v                  v
   ┌────────────────┐ ┌──────────────┐ ┌──────────────┐
   │  선거관리위원회  │ │  참관 정당    │ │   시민단체    │
   │ Election       │ │ Party        │ │ Civil        │
   │ Commission     │ │ Observer     │ │ Society      │
   │ peer0 + peer1  │ │ peer0        │ │ peer0        │
   │ CouchDB x2     │ │ CouchDB x1   │ │ CouchDB x1   │
   └────────────────┘ └──────────────┘ └──────────────┘

   Endorsement Policy: OutOf(2, EC, Party, Civil)
   → 어느 단일 기관도 독자적으로 결과를 조작할 수 없음
```

### Vote Flow (Exponential ElGamal Mode)

```
  Voter Browser
    │
    ├─ voterSecret (로컬 보관, 서버 전송 안 함)
    │
    ├─ nullifierHash = SHA256(voterSecret + electionID)
    │
    ├─ Encrypt vote: E(m) = (g^r, g^m · y^r)   ← Exponential ElGamal
    │
    ├─ Generate ZKP: Disjunctive Chaum-Pedersen  ← 투표 유효성 증명
    │
    └─ CastVote TX
          │
          ├── [Public Ledger] Nullifier {hash, encryptedBallot, ZKP}
          │     → 누가 투표했는지 알 수 없음 (해시만 저장)
          │     → 재투표 시 Eviction (덮어쓰기)
          │
          └── [PDC] VotePrivate {voterID, credentialType}
                → 오더러에게 전달되지 않음
                → 피어의 비공개 사이드DB에만 저장

  Tally Phase
    │
    ├─ Homomorphic aggregation: Π ciphertexts
    ├─ Threshold decryption (Shamir 2-of-3)
    ├─ BSGS discrete log recovery → per-candidate counts
    └─ Chaum-Pedersen ZKP verification → public audit
```

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Blockchain | Hyperledger Fabric 2.5 (etcdraft CFT) |
| State DB | CouchDB 3.4 |
| Smart Contract | Go 1.21 — `chaincode/voting/voting.go` (~3800 lines) |
| Backend API | Node.js + Express + `@hyperledger/fabric-gateway` |
| Frontend | React + Vite + Tailwind CSS |
| Cryptography | Exponential ElGamal, Chaum-Pedersen ZKP, Shamir SSS, Merkle Tree, HMAC/Ed25519 |
| Benchmarking | Hyperledger Caliper 0.6 |
| Container | Docker + docker compose v2 |

---

## Project Structure

```
mongbas/
├── chaincode/voting/          # Go smart contract (single file)
│   ├── voting.go              # 체인코드 전체 (~3800 lines)
│   ├── collection_config.json # PDC 설정
│   ├── Dockerfile             # CCAAS 배포용
│   └── vendor/                # Go dependencies
├── network/                   # Fabric 네트워크 설정
│   ├── crypto-config.yaml     # 3조직 + 4오더러 인증서
│   ├── configtx.yaml          # 채널, 2-of-3 정책
│   ├── docker-compose.yaml    # 컨테이너 구성
│   └── scripts/network.sh     # 네트워크 자동화 (up/deploy/test/down)
├── application/               # Express.js 백엔드
│   └── src/
│       ├── app.js             # 서버 엔트리
│       ├── gateway.js         # Fabric Gateway 연결
│       ├── routes/            # API 엔드포인트
│       ├── middleware/        # 인증 미들웨어
│       └── lib/               # 암호화 유틸리티
├── frontend/                  # React 프론트엔드
│   └── src/
│       ├── pages/             # Voter, Admin, Verify 페이지
│       └── utils/crypto.js    # 클라이언트 암호화
├── caliper/                   # Hyperledger Caliper 벤치마크
├── scripts/                   # 벤치마크, 보안 시나리오 스크립트
└── docs/                      # 상세 문서
    ├── performance/           # 성능 평가 결과
    └── security-eval/         # 보안 위협 시나리오 분석
```

---

## Quick Start

### Prerequisites

- Docker + docker compose v2
- Node.js 18+
- Go 1.21+
- Hyperledger Fabric 2.5 binaries (`cryptogen`, `configtxgen`, `peer`, `orderer`)

### Setup & Run

```bash
# 1. Clone
git clone https://github.com/SuBeen-Cho/blockchain_mongbas.git
cd blockchain_mongbas

# 2. Install Fabric binaries (~280MB)
curl -sSL https://bit.ly/2ysbOFE | bash -s -- 2.5.0 1.5.7

# 3. Start network (auto-generates crypto materials)
cd network
./scripts/network.sh up

# 4. Deploy chaincode
./scripts/network.sh deploy

# 5. Start backend API
cd ../application && npm install && npm start
# → http://localhost:3000

# 6. Start frontend (optional)
cd ../frontend && npm install && npm run dev
# → http://localhost:5173
```

### Shutdown

```bash
cd network && ./scripts/network.sh down
```

---

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/elections` | 선거 생성 |
| `POST` | `/api/elections/:id/activate` | 선거 활성화 |
| `GET` | `/api/elections/:id` | 선거 정보 조회 |
| `GET` | `/api/elections/:id/elgamal-pubkey` | ElGamal 공개키 조회 |
| `POST` | `/api/vote` | 투표 제출 (ElGamal + ZKP) |
| `POST` | `/api/vote/prepare` | Benaloh Challenge 준비 |
| `POST` | `/api/vote/audit` | Benaloh Challenge 검증 (spoil) |
| `POST` | `/api/elections/:id/close` | 선거 종료 + 집계 |
| `GET` | `/api/elections/:id/tally` | 개표 결과 |
| `POST` | `/api/elections/:id/verify-elgamal` | ElGamal ZKP 검증 |
| `POST` | `/api/elections/:id/merkle` | Merkle Tree 구축 |
| `GET` | `/api/elections/:id/proof/:hash` | Merkle 포함 증명 |
| `POST` | `/api/elections/:id/proof` | Deniable Verification |
| `POST` | `/api/elections/:id/keysharing` | Shamir 키 분산 초기화 |
| `POST` | `/api/elections/:id/shares` | Shamir share 제출 |
| `GET` | `/api/elections/:id/bulletin-board` | Bulletin Board 조회 |
| `POST` | `/api/credential/idemix` | Idemix 자격증명 발급 |
| `GET` | `/api/nullifier/:hash` | Nullifier 조회 |
| `GET` | `/health` | 서버 상태 확인 |

---

## Performance

> 상세 결과: [docs/performance/PERF-SUMMARY.md](./docs/performance/PERF-SUMMARY.md)

### Hyperledger Caliper — CastVote TPS

| Round | Target TPS | Success | Avg Latency | Throughput |
|-------|-----------|---------|-------------|------------|
| Low | 1 TPS | 48 | 2.14s | **1.0 TPS** |
| Mid | 5 TPS | 100 | 1.39s | **4.7 TPS** |
| High | 10 TPS | 148 | 1.34s | **9.6 TPS** |

### Security Scenario Tests

> 상세 결과: [docs/security-eval/SECURITY-SCENARIOS.md](./docs/security-eval/SECURITY-SCENARIOS.md)

| Scenario | Result |
|----------|--------|
| A. 선관위 단독 조작 시도 | 2-of-3 정책으로 차단 |
| B. 이중투표 시도 | Eviction 100% 처리 |
| C. 강압 투표 (Panic) | Normal/Panic 타이밍 차이 0.2ms (구분 불가) |
| D. 집계 키 단독 탈취 | 1-share 복원 실패 100%, 2-share 성공 100% |
| E. 결과 조작 외부 주장 | Merkle 검증 정확도 100% |

---

## Documentation

| Document | Description |
|----------|-------------|
| [HANDOFF.md](./HANDOFF.md) | 개발자 인계 문서 |
| [docs/performance/](./docs/performance/) | 성능 평가 (6 STEP 상세) |
| [docs/security-eval/](./docs/security-eval/) | 보안 위협 시나리오 분석 |
| [docs/server_run_guide.md](./docs/server_run_guide.md) | 서버 실행 가이드 |

---

## Team

**팀 몽바스** — 한양대학교 ERICA 융합보안 캡스톤디자인

| Name | Student ID |
|------|-----------|
| 조수빈 | 2394025 |
| 정윤녕 | 2394043 |
| 윤서현 | 2394048 |

**지도교수:** 서화정 교수님

---

## License

This project was developed as an academic capstone project. All rights reserved.
