# 서버 실행 가이드 (macOS)

**팀 몽바스 — BFT 익명 전자투표 시스템** 실제 투표 시나리오 실행 순서입니다.
터미널 창 3개를 준비하세요.

---

## 1단계: 사전 요구사항 확인

```bash
# Docker 실행 확인
docker ps

# Node.js 버전 확인 (18 이상)
node --version

# Fabric 바이너리 확인
ls mongbas/fabric-samples/bin/cryptogen
```

Docker Desktop이 실행 중이어야 합니다. 아직 Fabric 바이너리가 없다면:

```bash
cd mongbas
curl -sSL https://raw.githubusercontent.com/hyperledger/fabric/main/scripts/install-fabric.sh | bash -s -- --fabric-version 2.5.9 binary
```

---

## 2단계: Fabric 네트워크 기동 (터미널 1)

```bash
cd mongbas/network

# 네트워크 시작 (인증서 생성 → 제네시스 블록 → 컨테이너 실행 → 채널 생성)
./scripts/network.sh up
```

완료 메시지 예시:
```
[INFO]  채널 voting-channel 생성 완료
[INFO]  peer0.ec, peer1.ec, peer0.party, peer0.civil 채널 가입 완료
```

> 첫 실행 시 Docker 이미지 다운로드로 5~10분 소요될 수 있습니다.

---

## 3단계: 체인코드 배포 (터미널 1 이어서)

```bash
# 3개 조직 모두에 체인코드 설치 + 2-of-3 승인 + 커밋 + InitLedger
./scripts/network.sh deploy
```

완료 메시지 예시:
```
[INFO]  체인코드 voting 커밋 완료 (sequence: N)
[INFO]  InitLedger 완료
```

> `deploy`는 실행할 때마다 sequence가 자동 증가합니다. 코드 변경 없이 재배포할 때도 동일하게 사용합니다.

---

## 4단계: 백엔드 API 서버 실행 (터미널 2)

```bash
cd mongbas/application
npm install       # 최초 1회
npm start         # 또는 개발 모드: npm run dev
```

정상 기동 메시지:
```
╔══════════════════════════════════════════════════════╗
║  팀 몽바스 — BFT 익명 전자투표 API 서버 기동         ║
║  http://localhost:3000                               ║
╚══════════════════════════════════════════════════════╝
```

서버 상태 확인:
```bash
curl http://localhost:3000/health
# → {"status":"ok","idemix":{"enabled":false,"mode":"bypass",...}}
```

> `idemix.mode: "bypass"` — 현재 개발 모드로 별도 자격증명 없이 투표 가능합니다.

---

## 5단계: 프론트엔드 실행 (터미널 3)

```bash
cd mongbas/frontend
npm install       # 최초 1회
npm run dev
```

브라우저에서 열기: **http://localhost:5173**

> Vite가 `/api` 요청을 자동으로 `localhost:3000`으로 프록시합니다.

---

## 6단계: 실제 투표 시나리오

### 6-1. 선거 생성 (관리자)

브라우저에서 **Admin** 탭으로 이동합니다.

**선거 생성** 섹션에 다음 내용을 입력합니다:

| 필드 | 예시 값 |
|------|---------|
| Election ID | `ELECTION_2026_TEST` |
| 제목 | `2026 테스트 선거` |
| 설명 | `기능 확인용 선거` |
| 후보자 (JSON 배열) | `["후보A","후보B","후보C"]` |
| 종료 시간 (Unix 타임스탬프) | `9999999999` (충분히 먼 미래) |

또는 curl로 직접 생성:

```bash
curl -X POST http://localhost:3000/api/elections \
  -H "Content-Type: application/json" \
  -d '{
    "electionID": "ELECTION_2026_TEST",
    "title": "2026 테스트 선거",
    "description": "기능 확인용",
    "candidates": ["후보A", "후보B", "후보C"],
    "endTime": 9999999999
  }'
```

---

### 6-2. 선거 활성화 (관리자)

Admin 탭의 **선거 활성화** 섹션에서 `ELECTION_2026_TEST` 입력 후 활성화.

```bash
# curl로 직접:
curl -X POST http://localhost:3000/api/elections/ELECTION_2026_TEST/activate
```

활성화 후 상태 확인:
```bash
curl http://localhost:3000/api/elections/ELECTION_2026_TEST
# → {"electionID":"ELECTION_2026_TEST","status":"ACTIVE",...}
```

---

### 6-3. 투표하기 (유권자)

브라우저에서 **Voter** 탭으로 이동합니다.

1. **선거 ID 조회**: `ELECTION_2026_TEST` 입력 후 조회 버튼 클릭
2. **유권자 비밀값(voterSecret)**: 자동 생성 버튼 클릭 (또는 직접 입력)
   - 이 값은 **브라우저에만 존재**하며 서버로 전송되지 않습니다
   - **반드시 메모하세요** — 나중에 내 투표 확인에 필요합니다
3. **후보 선택**: 후보A / 후보B / 후보C 중 선택
4. **투표 제출** 클릭

성공 시 결과에 `nullifierHash`가 표시됩니다. 이것이 익명 투표 증명입니다.

```bash
# curl로 직접 (nullifierHash는 클라이언트에서 직접 계산해야 하므로 브라우저 사용 권장)
# 참고용 — 실제로는 프론트엔드가 SHA256(voterSecret + electionID)를 계산하여 전송
curl -X POST http://localhost:3000/api/vote \
  -H "Content-Type: application/json" \
  -d '{
    "electionID": "ELECTION_2026_TEST",
    "candidateID": "후보A",
    "nullifierHash": "<브라우저에서_계산된_해시>"
  }'
```

---

### 6-4. 이중투표 방지 확인

같은 voterSecret으로 다시 투표를 시도하면 오류가 발생해야 합니다:
```
"이미 투표하셨습니다. (nullifier 중복)"
```

---

### 6-5. 선거 종료 및 개표 (관리자)

Admin 탭의 **선거 종료** 섹션에서 종료합니다.

```bash
curl -X POST http://localhost:3000/api/elections/ELECTION_2026_TEST/close
```

개표 결과 조회:
```bash
curl http://localhost:3000/api/elections/ELECTION_2026_TEST/tally
# → {"후보A": 1, "후보B": 0, "후보C": 0, ...}
```

---

### 6-6. Merkle Tree 구축 (관리자, 검증 활성화)

```bash
curl -X POST http://localhost:3000/api/elections/ELECTION_2026_TEST/merkle
```

Merkle Root 확인:
```bash
curl http://localhost:3000/api/elections/ELECTION_2026_TEST/merkle
# → {"merkleRoot": "abc123..."}
```

---

### 6-7. 내 투표 검증 (유권자)

브라우저에서 **Verify** 탭으로 이동합니다.

- 선거 ID: `ELECTION_2026_TEST`
- voterSecret: 6-3에서 저장한 값
- 일반 검증 비밀번호: 투표 시 입력한 normalPassword (없으면 빈 칸)

Merkle 포함 증명(proof)이 반환되면 **내 투표가 블록체인에 포함되었음**이 수학적으로 검증됩니다.

```bash
# nullifierHash로 직접 확인
curl "http://localhost:3000/api/nullifier/<nullifierHash>"
# → {"voted": true}
```

---

## 환경변수 옵션

백엔드 실행 시 환경변수로 동작을 제어할 수 있습니다:

```bash
# Panic Password 기능 활성화 (강압 상황 대비 부인 가능 증명)
PANIC_PASSWORD=mysecret npm start

# Idemix 인증 활성화 (기본: bypass)
IDEMIX_ENABLED=true npm start

# 포트 변경
PORT=4000 npm start
```

---

## 네트워크 종료

```bash
cd mongbas/network

# 컨테이너 종료 (볼륨 삭제, 체인데이터 초기화)
./scripts/network.sh down

# 완전 초기화 (인증서·아티팩트 포함 삭제)
./scripts/network.sh clean
```

---

## 문제 해결

### "crypto-config 경로를 찾을 수 없습니다"
`network.sh up`이 완료되지 않은 상태입니다. 백엔드 실행 전 반드시 `up` + `deploy` 완료를 확인하세요.

### "체인코드 연결 실패 / gRPC error"
Docker 컨테이너가 모두 실행 중인지 확인합니다:
```bash
docker ps | grep voting
# peer0.ec, peer1.ec, peer0.party, peer0.civil, orderer1-4, chaincode 컨테이너가 보여야 함
```

### "선거 활성화 오류 — CREATED 상태가 아님"
이미 활성화된 선거입니다. `GET /api/elections/:id`로 현재 상태를 확인하세요.

### CouchDB 직접 확인 (데이터 디버깅)
| 피어 | URL |
|------|-----|
| peer0.ec | http://localhost:5984/_utils (admin/adminpw) |
| peer1.ec | http://localhost:5985/_utils |
| party | http://localhost:6984/_utils |
| civil | http://localhost:7984/_utils |

`voting-channel_voting` 데이터베이스에서 선거·투표 데이터를 직접 확인할 수 있습니다.
