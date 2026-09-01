<p align="center">
  <h1 align="center">Mongbas</h1>
  <p align="center">
    <strong>Hyperledger Fabric 기반 다조직 합의 익명 전자투표 시스템</strong>
  </p>
  <p align="center">
    Anonymous E-Voting on Hyperledger Fabric 2.5:<br>
    Practical Mitigation of the Verification Paradox and Coercion Resistance
  </p>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Hyperledger%20Fabric-2.5-blue?logo=hyperledger" alt="Fabric">
  <img src="https://img.shields.io/badge/Go-1.21-00ADD8?logo=go" alt="Go">
  <img src="https://img.shields.io/badge/Node.js-18+-339933?logo=node.js" alt="Node">
  <img src="https://img.shields.io/badge/React-Vite-61DAFB?logo=react" alt="React">
  <img src="https://img.shields.io/badge/Encryption-Exponential%20ElGamal-purple" alt="Encryption">
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Security%20Properties-independent%20verification%20in%20progress-orange" alt="Security verification in progress">
  <img src="https://img.shields.io/github/last-commit/SuBeen-Cho/blockchain_mongbas?label=Last%20Commit" alt="Last Commit">
  <img src="https://img.shields.io/github/repo-size/SuBeen-Cho/blockchain_mongbas" alt="Repo Size">
</p>

<p align="center">
  <img src="./docs/images/banner.png" width="750" alt="Mongbas 투표 완료 화면">
</p>

---

## 프로젝트 소개

전자투표 시스템은 **투표 비밀성**, **검증 가능성**, **강압 저항성** 간의 구조적 긴장을 본질적으로 내포합니다. 유권자는 자신의 투표가 정확히 포함되었는지 검증할 수 있어야 하나, 이러한 검증 정보가 제3자에게 증거로 제공될 경우 선거 이후 협박의 근거가 됩니다. 본 연구는 이러한 긴장을 **검증 역설(Verification Paradox)** 로 정의합니다.

**Mongbas**는 Hyperledger Fabric 2.5 기반 3개 조직 컨소시엄 위에 전자투표 프로토타입을 구현하여, **2-of-3 보증 정책**, **Nullifier 기반 익명성**, **Exponential ElGamal 동형 집계**, **Zero-Knowledge Proof 기반 투표 유효성 검증**, **패닉 비밀번호 기반 부인 가능 검증**, **Private Data Collection 기반 강압 투표 분리**를 결합하여 검증 역설의 다층적 완화를 제안합니다.

---

## 주요 기능

| 기능 | 설명 |
|------|------|
| **다조직 합의 (2-of-3)** | 3개 MSP의 2-of-3 보증 정책 구현. 기본 Docker 배포는 단일 호스트 에뮬레이션이며 기관 독립성 증거가 아님 |
| **Exponential ElGamal 동형 집계** | 개별 ballot 평문을 열지 않고 후보별 암호문을 집계하고 threshold partial proof로 검증 |
| **Chaum-Pedersen ZKP** | 이접적 OR-증명(CDS'94)으로 투표 유효성을 후보 선택 노출 없이 증명 |
| **Benaloh Challenge** | 투표 제출 전 암호화 정확성을 유권자가 독립적으로 검증 (Cast-as-Intended) |
| **Shamir Secret Sharing (2-of-3)** | 개표 키를 3개 기관에 분산 — 단일 관리자 없이 합의 기반 집계 |
| **부인 가능 검증 (Deniable Verification)** | 정상/패닉 응답 구조를 맞추는 실험 기능. 강압자 비구별성은 아직 공격 평가 중 |
| **Merkle Tree 검증** | 투표 포함/배제를 암호학적으로 증명 (E2E Verifiability) |
| **Nullifier 기반 재투표** | 동일 nullifier로 재투표 시 기존 기록 덮어쓰기 — 강압 후 자유 의사 반영 가능 |

---

## 시스템 아키텍처

<p align="center">
  <img src="./docs/images/fig_architecture.png" width="800" alt="시스템 아키텍처 다이어그램">
</p>

네트워크는 **ElectionCommission**(선거관리위원회), **PartyObserver**(참관정당), **CivilSociety**(시민단체) 3개 조직으로 구성됩니다. 정렬 서비스는 etcdraft 4노드 CFT 아키텍처를 채택하며, 핵심 트랜잭션은 2-of-3 보증 정책을 요구하여 단일 기관이 투표 기록이나 집계 결과를 일방적으로 갱신할 수 없습니다.

데이터는 **공개 원장**과 **PDC(Private Data Collection)** 의 두 계층으로 분리됩니다. 공개 원장에는 nullifier 해시, 암호화된 후보 기록, Merkle 루트 등 검증 가능한 데이터가 저장되고, PDC에는 자격 증명 유형(정상/패닉), 비밀번호 해시 등 민감 데이터가 격리 저장됩니다. PDC 데이터는 오더러에게 전달되지 않으며, 인가된 조직의 피어만 접근할 수 있습니다.

---

## 투표 흐름

<p align="center">
  <img src="./docs/images/fig_castvote.png" width="500" alt="투표 트랜잭션 처리 흐름">
</p>

1. **자격증명 발급자**가 선거별 결합값을 서명하고, 브라우저가 `nullifierHash = SHA256(nullifierMaterial || electionID || blindingFactor)`를 산출합니다. 체인코드도 서명된 값으로 이를 독립 재계산합니다.
2. 선택한 후보를 **Exponential ElGamal**으로 암호화하고, **이접적 Chaum-Pedersen ZKP**를 생성합니다.
3. 암호문 + ZKP + nullifier를 **Transient Map**으로 제출합니다 (오더러 및 공개 원장에 기록되지 않음).
4. **보증 피어**는 입력 형식, 선거 상태, 자격 증명을 검증한 뒤, nullifier 중복 처리(Last-Vote-Wins)를 수행합니다.
5. ZKP 유효성을 검증한 후, **공개 원장**에는 nullifier + 암호문 + 커밋먼트를, **PDC**에는 투표자 ID + 자격 증명 유형을 저장합니다.

---

## 강압 저항 메커니즘

<p align="center">
  <img src="./docs/images/fig_panicmode.png" width="500" alt="패닉 비밀번호 기반 부인 가능 검증 흐름">
</p>

강압자가 유권자에게 투표 증명을 요구할 경우, 유권자는 **정상 비밀번호** 또는 **패닉 비밀번호**를 입력합니다.

- **정상 비밀번호** → 실제 nullifier를 재생성하여 실제 투표의 Merkle 포함 증명을 반환
- **패닉 비밀번호** → 더미 nullifier를 결정론적으로 선택하여 더미 투표의 Merkle 포함 증명을 반환

두 경우의 응답 구조를 동일하게 만드는 것이 구현 목표입니다. 그러나 공개 padding 인덱스, 투표 패턴, 타이밍·네트워크·로컬 상태 등 사이드채널 평가가 끝나지 않았으므로 현재 구현만으로 강압자 비구별성이나 강압 저항성을 보장한다고 주장하지 않습니다.

---

## 보안 속성 검증 상태

이 프로젝트는 7대 전자투표 보안 속성을 목표로 개발 중이지만, 현재 **7/7이 독립적으로 완전 검증되었다고 주장하지 않습니다.** `GetSecurityProperties`는 구현 기능을 나열하는 자기 선언일 뿐 보안 증명이 아닙니다.

| 속성 | 현재 구현·증거 | 주요 미해결 조건 |
|---|---|---|
| Ballot secrecy | vector ElGamal, threshold partial decryption, ballot proof | dealerless DKG, metadata privacy game, key deletion |
| Cast-as-intended | audit-or-cast 기능 및 E2E 테스트 | 엄격한 상태기계·독립 audit 증거 |
| Recorded-as-cast | Merkle inclusion 검증 | 서명된 checkpoint, omission/fork witness |
| Tallied-as-recorded | 후보별 동형 집계, 2-of-3 partial proof, tamper tests | 더 넓은 공모·장애 평가 |
| Universal verifiability | standalone bundle verifier와 tamper corpus | 외부 witness/checkpoint와 다른 운영 주체 검증 |
| Eligibility | election-bound credential/nullifier 검증, 선거별 append-only revocation 구현 | 실제 등록부 연동, 익명 accumulator non-revocation proof, Linux 공격 증거 |
| Coercion resistance | panic/revote 실험 메커니즘 | 강압자 모델, 패턴·타이밍·네트워크 사이드채널 공격 평가 |

---

## 시연 화면

<table>
  <tr>
    <td align="center"><strong>관리자 — 선거 생성</strong></td>
    <td align="center"><strong>투표자 — 후보 선택</strong></td>
  </tr>
  <tr>
    <td><img src="./docs/images/screenshot_admin.png" width="400" alt="관리자 선거 생성"></td>
    <td><img src="./docs/images/screenshot_vote.png" width="400" alt="투표자 후보 선택"></td>
  </tr>
  <tr>
    <td align="center"><strong>검증자 — E2E 검증</strong></td>
    <td align="center"><strong>보안 속성 — 구현 현황(독립 검증 진행 중)</strong></td>
  </tr>
  <tr>
    <td><img src="./docs/images/screenshot_verify.png" width="400" alt="E2E 검증 화면"></td>
    <td><img src="./docs/images/screenshot_security.png" width="400" alt="보안 속성 구현 현황 화면"></td>
  </tr>
</table>

---

## 기술 스택

| Layer | Technology |
|-------|-----------|
| Blockchain | Hyperledger Fabric 2.5 (etcdraft CFT, 4 Orderer) |
| State DB | CouchDB 3.4 |
| Smart Contract | Go 1.21 — `chaincode/voting/voting.go` (~4,000 lines, single file) |
| Backend API | Node.js 18 + Express + `@hyperledger/fabric-gateway` |
| Frontend | React 18 + Vite + Tailwind CSS |
| Cryptography | Exponential ElGamal, Chaum-Pedersen ZKP, Shamir SSS, Merkle Tree, HMAC/Ed25519 |
| Benchmarking | Hyperledger Caliper 0.6 |
| Container | Docker + docker compose v2 |

---

## 실행 방법

> 📖 **상세 실행 가이드(도커 설치 → Fabric 부트스트랩 → 데모 원클릭 → 개발모드 → 쇼케이스 → 트러블슈팅)**: [docs/RUN_GUIDE.md](./docs/RUN_GUIDE.md)
> 부스 데모는 `./scripts/demo-up.sh` 한 번이면 됩니다(네트워크·빌드·백엔드·공개터널 자동).

### 사전 요구사항

- Docker + docker compose v2
- Node.js 18+
- Go 1.21+
- Hyperledger Fabric 2.5 binaries (`cryptogen`, `configtxgen`, `peer`, `orderer`)

> Fabric 바이너리가 없는 경우, 아래 명령으로 설치할 수 있습니다 (~280MB):
> ```bash
> curl -sSL https://bit.ly/2ysbOFE | bash -s -- 2.5.0 1.5.7
> ```

### 1. 클론

```bash
git clone https://github.com/SuBeen-Cho/blockchain_mongbas.git
cd blockchain_mongbas
```

### 2. Fabric 네트워크 시작

```bash
cd network
./scripts/network.sh up       # 인증서 생성 + 채널 생성 + 컨테이너 기동
```

### 3. 체인코드 배포

```bash
./scripts/network.sh deploy   # 체인코드 패키징 + 설치 + 승인 + 커밋 (자동)
```

### 4. 백엔드 API 서버 시작

```bash
cd ../application
cp .env.example .env          # 환경변수 설정 (.env.example 참고)
npm install
npm start                     # http://localhost:3000
```

### 5. 프론트엔드 시작

```bash
cd ../frontend
npm install
npm run dev                   # http://localhost:5173
```

### 종료 및 정리

```bash
cd network
./scripts/network.sh down     # 컨테이너 중지 및 제거
./scripts/network.sh clean    # 인증서 및 채널 아티팩트 전체 삭제
```

### 트러블슈팅

| 증상 | 해결 |
|------|------|
| `peer lifecycle` 명령 실패 | `fabric-samples/bin`이 `$PATH`에 포함되어 있는지 확인 |
| 체인코드 배포 시 시퀀스 에러 | `./scripts/network.sh clean` 후 `up` → `deploy` 재실행 |
| CouchDB 연결 실패 | `docker ps`로 CouchDB 컨테이너 상태 확인, 포트 충돌 여부 점검 |
| 프론트엔드 API 연결 실패 | `.env`의 `CORS_ORIGIN`에 `http://localhost:5173` 추가 |

---

## 성능 평가

### Hyperledger Caliper — CastVote TPS

| Round | Target TPS | Success | Avg Latency | Throughput |
|-------|-----------|---------|-------------|------------|
| Low | 1 TPS | 48 | 2.14s | **1.0 TPS** |
| Mid | 5 TPS | 100 | 1.39s | **4.7 TPS** |
| High | 10 TPS | 148 | 1.34s | **9.6 TPS** |

### 보안 위협 시나리오 검증

| 시나리오 | 결과 |
|----------|--------|
| A. 선관위 단독 조작 시도 | 2-of-3 보증 정책으로 차단 |
| B. 이중투표 시도 | Nullifier Eviction으로 100% 처리 |
| C. 강압 투표 (Panic) | Normal/Panic 응답 타이밍 차이 0.2ms (통계적 비구별성 확인) |
| D. 집계 키 단독 탈취 | 1-share 복원 실패 100%, 2-share 성공 100% |
| E. 결과 조작 외부 주장 | Merkle 검증 정확도 100% |

> 상세 평가 원자료(성능·보안)는 로컬 `docs/performance/`·`docs/security-eval/` 에 보관됩니다. (용량 문제로 GitHub에는 미포함)

---

## 팀 몽바스

2026 캡스톤디자인

<p align="center">
  <a href="https://github.com/SuBeen-Cho">
    <img src="https://github.com/SuBeen-Cho.png" width="120" style="border-radius:50%" alt="조수빈">
  </a>
  &nbsp;&nbsp;&nbsp;&nbsp;
  <a href="https://github.com/ningning56">
    <img src="https://github.com/ningning56.png" width="120" style="border-radius:50%" alt="정윤녕">
  </a>
  &nbsp;&nbsp;&nbsp;&nbsp;
  <a href="https://github.com/nanpingpingee">
    <img src="https://github.com/nanpingpingee.png" width="120" style="border-radius:50%" alt="윤서현">
  </a>
</p>

<p align="center">
  <strong><a href="https://github.com/SuBeen-Cho">조수빈</a></strong> (팀장)
  &nbsp;&nbsp;|&nbsp;&nbsp;
  <strong><a href="https://github.com/ningning56">정윤녕</a></strong>
  &nbsp;&nbsp;|&nbsp;&nbsp;
  <strong><a href="https://github.com/nanpingpingee">윤서현</a></strong>
</p>
