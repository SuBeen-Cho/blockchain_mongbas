# Mongbas Linux 성능·보안·원격 QR 평가

- 평가 기간: 2026년 9월 1일–5일
- 측정 코드 기준: 각 원시 결과 manifest에 기록된 commit. 본 공개 보고서는 `436d56c`에서 처음 추가
- 환경: Ubuntu 24.04 x86-64, Hyperledger Fabric 2.5, CouchDB 3.4, Node.js 22
- 배포 형태: 한 대의 Linux 서버에서 여러 Fabric 조직과 orderer를 컨테이너로 실행

## 한눈에 보는 결과

| 평가 항목 | 결과 | 판정 |
|---|---:|---|
| 1,000표 verifier 정상 bundle | 승인 | 통과 |
| 1,000표 변조 corpus | 18/18 거부 | 정의한 corpus 범위에서 통과 |
| 10,000표 동일 입력 verifier, 4 workers | 정상 393.74초, 변조 390.75초 | 동작하지만 실시간 사용에는 느림 |
| 10,000 voter operation state-growth | 10,000/10,000 commit | 통과 |
| 100×1,000 voter operation state-growth | 99,996/100,000 commit | exact-success 실패 |
| 100×1,000 tally | 100/100 완료, 합계 99,996 | committed vote와 일치 |
| 장시간 실행 안전장치 | OOM 0, 디스크·Fabric health 중단 없음 | 통과 |
| 공개 HTTPS QR API→Fabric E2E | 1표 commit 및 대시보드 반영 | 자동 경로 통과 |
| 실제 휴대폰 QR 스캔 | 수행하지 않음 | 미검증 |

## 1. 100×1,000표 state-growth

### 방법

기존 Fabric 원장과 Docker volume을 지우지 않은 상태에서 선거 ID가 서로 다른 100개 선거를 만들고, 선거마다 1,000건씩 투표를 요청했습니다. 한 건의 voter operation은 prepare와 cast 두 단계로 구성됩니다. 실행 중에는 30초 간격으로 여유 디스크, 사용 가능 메모리, swap, 커널 OOM 횟수와 Fabric health를 확인했습니다.

다음 조건에서는 해당 workload process group만 종료하고 원장과 원시 증거를 남기도록 구성했습니다.

- 여유 디스크가 60,000,000,000 bytes 미만
- OOM kill 증가
- Fabric health 실패
- 감시 프로세스 자체의 비정상 종료

### 결과

| 지표 | 측정값 |
|---|---:|
| 요청한 voter operation | 100,000 |
| commit 성공 | 99,996 |
| 실패 | 4 |
| 성공률 | 99.996% |
| 요청한 Fabric transaction | 200,000 |
| commit된 Fabric transaction | 199,996 |
| tally 완료 | 100/100 선거 |
| tally 합계 | 99,996표 |
| committed count와 tally 불일치 | 0건 |
| 평균 latency | 27.361초 |
| p50 | 28.376초 |
| p95 | 32.748초 |
| p99 | 35.176초 |
| 최대 latency | 39.155초 |
| committed voter operation 처리율 | 8.595건/초 |
| committed Fabric transaction 처리율 | 17.191건/초 |

실패 네 건은 모두 47번째 batch에서 발생했습니다. prepare transaction이 commit된 직후 cast endorsement가 다른 peer로 전달됐고, 그 peer가 prepared ballot을 아직 조회하지 못한 짧은 가시성 차이였습니다. 로그에는 같은 시각에 `준비된 vector ballot을 찾을 수 없습니다`가 남았습니다. ElGamal 암호문, 영지식증명이나 credential이 거부된 사례는 아니었습니다.

이 문제는 `6de1dab`에서 제한적으로 보완했습니다. `ABORTED` 상태와 정확한 missing-prepared 오류가 동시에 확인되는 경우에만 endorsement proposal을 새로 만들어 재시도합니다. submit 이후나 commit 결과는 재시도하지 않으며, 암호·credential·다른 chaincode 오류도 재시도하지 않습니다. 수정 후 단위 및 전체 애플리케이션 회귀 시험은 통과했지만, 같은 규모의 100,000건을 다시 실행하지 않았으므로 이 보고서에서는 여전히 `99,996/100,000`으로 기록합니다.

### 저장공간과 안전성

| 항목 | 측정값 |
|---|---:|
| 전체 replicated topology 증가 | 49,635,740 KiB |
| ledger 4개 증가 | 21,863,812 KiB |
| orderer 4개 증가 | 9,894,124 KiB |
| CouchDB 4개 증가 | 17,877,804 KiB |
| 최소 여유 디스크 | 271,043,067,904 bytes |
| 최소 `MemAvailable` | 11,521,277,952 bytes |
| 최소 `SwapFree` | 2,614,484,992 bytes |
| 관측된 OOM kill | 0 |
| monitor sample | 883개 |

실행 전후 컨테이너 ID·이름·이미지를 대조했으며 재시작은 없었습니다. Docker volume 수도 34개로 유지됐습니다. 위 저장공간 증가는 암호문 하나의 크기가 아니라 네트워크 복제, 블록, 인덱스와 state DB를 합친 이 배포 구조의 증가량입니다.

## 2. verifier 확장성

### 1,000표 기준선

정상 bundle은 승인했고, 삭제·대체·proof 변조 등 사전에 정한 18개 변조 입력은 모두 거부했습니다. 원시 결과 목록 137개도 SHA-256으로 다시 확인했습니다. 이는 해당 corpus에 대한 회귀 증거이지, 가능한 모든 공격을 100% 탐지한다는 의미는 아닙니다.

### 10,000표 동일 입력 비교

| 구현 | 정상 입력 | proof 변조 입력 | 최대 RSS |
|---|---:|---:|---:|
| 기존 baseline | 5,167.49초 | 5,175.27초 | 약 1.30 GiB |
| 최적화 synchronous | 1,362.78초 | 1,355.16초 | 약 1.39 GiB |
| 4-worker | 393.74초 | 390.75초 | 약 1.39 GiB |

세 경로 모두 같은 정상 입력을 승인하고 같은 proof 변조를 거부했습니다. 4-worker 경로는 기존 baseline보다 크게 빨라졌지만 약 6분 30초가 걸리므로 즉시 검증이 필요한 사용자 흐름에는 아직 무겁습니다.

현재 입력 제한은 256 MiB입니다. 10,000표 bundle 크기를 단순 선형 확장하면 100,000표 단일 bundle은 약 1.38 GB가 되므로 제한값만 높여 실행하지 않습니다. 100,000표 단일 선거 검증에는 streaming canonicalization, 증분 proof 처리와 bounded evidence format이 먼저 필요합니다.

## 3. 원격 QR 경로

Cloudflare Quick Tunnel을 사용해 Linux의 loopback backend를 임시 HTTPS 주소로 공개했습니다. 실행기는 공개 전 다음 항목을 검사했습니다.

- backend가 `127.0.0.1:3000`에만 binding됐는지
- 일회용 demo admission이 필수인지
- rate limit이 활성 상태인지
- 저장소가 기록되지 않은 변경 없이 clean한지
- 공개 응답에 HSTS와 CSP가 포함되는지

외부 Mac에서 root와 health endpoint의 HTTP 200, HSTS, CSP, `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`, frame denial을 확인했습니다. 같은 공개 HTTPS origin을 통한 자동 E2E 결과는 다음과 같습니다.

| 시나리오 | 결과 |
|---|---:|
| 인증 없는 admission 발급 | HTTP 401 |
| 다른 선거로 admission 교환 | HTTP 401 |
| 최초 정상 교환 | HTTP 200 |
| 동일 admission 재사용 | HTTP 401 |
| vector-v3 prepare/cast | Fabric commit 성공 |
| credential 검증 | `chaincode-ed25519` |
| 대시보드 live count/row/event | 1표 반영 |

시험이 끝난 뒤 Quick Tunnel 프로세스를 종료했고 backend와 Fabric health를 다시 확인했습니다. 다만 실제 휴대폰 카메라로 QR을 스캔하고 모바일 브라우저에서 투표한 과정은 아직 수행하지 않았습니다. 따라서 이 항목은 “공개 HTTPS API와 Fabric 종단 자동 시험 통과”로만 기록합니다.

## 4. 보안 속성별 현재 위치

| 속성 | 구현·시험된 부분 | 아직 남은 부분 |
|---|---|---|
| Ballot secrecy | vector ElGamal, DKG, 2-of-3 부분 복호화, ballot proof | 실제 분리 운영자/HSM, 공모 privacy game, 키 폐기 |
| Cast-as-intended | audit-or-cast 상태와 변조 시험 | 독립 단말·사용자 검증 절차와 확률 평가 |
| Recorded-as-cast | receipt, Merkle inclusion, 서명 checkpoint와 fork 탐지 | 독립 운영 witness와 complaint 절차 |
| Tallied-as-recorded | 동형 집계, 부분 복호화 proof, 정확한 tally 비교 | 더 넓은 trustee·peer 공모 및 장애 시험 |
| Universal verifiability | 독립 CLI, Node/Python/OpenSSL 교차 확인, tamper corpus | 외부 기관이 운영한 별도 검증 |
| Eligibility | 선거 귀속 credential/nullifier, replay와 revocation 시험 | 실제 등록부, issuer 공모, privacy-preserving non-revocation |
| Coercion resistance | 고정 응답 proof API, panic/revote 실험 경로 | credential surrender, 강제 기권, 공개 참여·재투표 패턴과 운영자 공모 |

현재 가장 큰 한계는 모든 Fabric 조직과 trustee가 한 물리 서버에 있다는 점입니다. 프로세스와 Unix 계정을 나눠도 root 관리자는 모두 관찰할 수 있습니다. 따라서 “세 기관이 독립적으로 운영됐다”거나 “2-of-3가 현실의 두 기관 공모를 막았다”는 결론은 이 환경에서 낼 수 없습니다.

## 5. 결과를 해석하는 기준

이번 평가로 확인한 것은 다음과 같습니다.

- 기존 원장을 초기화하지 않고 누적 부하를 실행할 수 있다.
- 99,996건의 committed vote는 100개 선거 tally에 빠짐없이 반영됐다.
- 선언한 verifier 변조 corpus와 독립 구현 교차검증이 회귀 방어선으로 작동한다.
- admission을 요구하는 공개 HTTPS 경로에서 한 번의 실제 Fabric 투표를 자동으로 끝낼 수 있다.
- 장시간 부하 중 디스크·메모리·OOM·Fabric health를 감시하고 증거를 보존할 수 있다.

반대로 다음은 확인되지 않았습니다.

- 100,000건 모두의 성공
- 한 선거에 100,000표를 넣고 하나의 bundle로 검증하는 경로
- 실제 휴대폰을 이용한 사용자 종단 시험
- 실제 기관·관리자·키 보관을 분리한 운영 독립성
- 완전한 강압 저항성 또는 7개 보안 속성 전체의 독립 검증

## 6. 재현과 증거 관리

### 공개 전 clean-clone 검증

GitHub feature 브랜치를 새 디렉터리에 다시 clone하고 lockfile 그대로 의존성을 설치한 뒤 아래 검사를 수행했습니다. 프론트엔드 build와 애플리케이션 테스트를 처음에 동시에 실행했을 때 `frontend/dist`가 생성되기 전에 보안 헤더 테스트가 시작돼 1건이 실패했습니다. build 완료 후 순서대로 다시 실행한 결과는 170/170 통과였습니다. 이 첫 결과는 코드 실패가 아니라 실행 순서 오류로 분류했습니다.

| 검사 | 최종 결과 |
|---|---:|
| application | 170/170 통과 |
| frontend | 11/11 통과 |
| frontend production build | 461 modules, 성공 |
| standalone verifier | 134/134 통과 |
| trustee | 12/12 통과 |
| chaincode | `go test ./...` 성공 |
| application/frontend/verifier/trustee npm audit | 배포 조건에서 high 이상 0건 |
| Markdown 상대 링크 | 누락 0건 |
| Git object 검사 | 오류 없음 |

Gitleaks 8.30.1로 GitHub의 origin 브랜치 이력과 clean clone 현재 파일을 각각 검사했습니다. 두 검사 모두 격리된 과거 benchmark 스크립트의 synthetic credential fixture 하나를 탐지했습니다. 이 값은 실제 운영 credential이 아니며 해당 스크립트는 네트워크와 출력 생성 전에 종료되도록 회귀 시험합니다. 따라서 결과는 “신규 운영 비밀 0건, 분류된 synthetic fixture 1건”으로 기록합니다. Gitleaks 보고서는 모든 match를 마스킹해 비공개 증거 보관소에 남겼습니다.

공개 재현 진입점:

```bash
# 애플리케이션 회귀
cd application && npm test

# 프론트엔드 회귀와 빌드
cd frontend && npm test && npm run build

# standalone verifier 회귀
cd verifier && npm test

# chaincode 회귀
cd chaincode/voting && go test ./...

# Linux state-growth 예시(기존 원장에 상태가 누적되므로 preflight 후 실행)
MONGBAS_PROFILE=benchmark \
MONGBAS_STATE_GROWTH_BALLOTS=1000 \
MONGBAS_STATE_GROWTH_MIN_FREE_BYTES=60000000000 \
  ./deploy/linux/state-growth-evaluation.sh

# 승인된 일회성 공개 QR 평가
MONGBAS_RUNTIME_DIR="${HOME}/.local/state/mongbas" \
  ./deploy/linux/quick-tunnel-evaluation.sh ENABLE_PUBLIC_QUICK_TUNNEL
```

원시 로그는 공개 Git에 넣지 않았습니다. 결과 디렉터리마다 실행 commit, 환경 정보, 종료 코드와 SHA-256 목록을 보존했으며, 공개 보고서는 그 자료에서 민감정보와 운영 경로를 제외해 옮겼습니다.

## 7. 수정 후 재측정 계획

prepared-ballot visibility 재시도 로직을 반영한 100×1,000표 재실험과 별도로, 수정 후 처리율을 이전 결과와 같은 offered-rate 축에서 다시 측정합니다. 두 workload는 동시에 실행하지 않습니다.

| 설정 | 값 |
|---|---|
| offered rate | 1, 5, 10, 25, 50 voter operation/s |
| 구간 길이 | rate별 60초 |
| 반복 | 각 3회 |
| voter operation | prepare commit + cast commit, Fabric transaction 2건 |
| 주요 지표 | committed voter operation/s, Fabric transaction/s, 평균·p50·p95·p99·최대 latency, scheduler lag |
| 통계 | 반복 평균·표준편차·Student-t 95% 신뢰구간 |
| 정확성 gate | 실패 0건, 모든 선거 tally 성공, transaction accounting 일치 |
| 안전 gate | 시작 시 80GB 이상, 실행 중 60GB 미만·OOM·메모리 하한·Fabric health 실패 시 중단 |

실행기는 [`post-fix-tps-evaluation.sh`](../../deploy/linux/post-fix-tps-evaluation.sh)입니다. 실행 결과가 나오기 전에는 이 계획을 측정 완료로 표현하지 않습니다.
