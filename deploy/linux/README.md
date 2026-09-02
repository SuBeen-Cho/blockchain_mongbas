# Linux deployment

이 디렉터리는 Ubuntu Linux에서 재현 가능한 배포·검증 명령을 제공한다.

검증된 기준 환경(2026-09-01):

- Ubuntu 24.04 x86-64
- Node.js 22.12 이상
- Go 1.23 이상 (`go.mod` 기준; 부족하면 bootstrap이 검증된 Go 1.26.5를 private runtime에 설치)
- Docker Engine 29 / Docker Compose v2
- Hyperledger Fabric CLI 2.5.9

운영 원칙:

- Docker Compose v2 사전 점검
- host와 container resource 기록
- 저장소 외부의 secret/data/log/result 경로
- fresh build, healthcheck, smoke test
- benchmark와 원격 QR 데모 profile 분리

`network/docker-compose.yaml`은 clone 직후 `voting-chaincode:1.0` 이미지가 없을 때 chaincode 소스에서 이미지를 빌드할 수 있도록 build context를 포함한다.

## Quick start

```bash
git clone https://github.com/SuBeen-Cho/blockchain_mongbas.git mongbas
cd mongbas
./deploy/linux/bootstrap.sh
./deploy/linux/prepare-runtime.sh
${EDITOR:-vi} "${HOME}/.local/state/mongbas/secrets/application.env"
./deploy/linux/build.sh
./deploy/linux/up.sh
```

기본 runtime은 `${HOME}/.local/state/mongbas`이며 `MONGBAS_RUNTIME_DIR`로 바꿀 수 있다. 기존 서버처럼 `/home/user1/mongbas-runtime`을 쓰려면 해당 변수를 export한다. 기존 `secrets/backend.env`가 있으면 보존하여 자동 선택하며, 다른 파일은 `MONGBAS_ENV_FILE`로 지정할 수 있다. secret 파일은 `0600`, runtime 디렉터리는 `0700`으로 생성되고 Git 저장소에는 들어가지 않는다. 기존 `application/.env`가 일반 파일이면 자동화가 덮어쓰지 않고 중단한다.

Backend는 직접 `npm --prefix application start`로 실행하거나 `systemd/mongbas-backend.service`의 절대 경로·사용자를 설치 환경에 맞춘 뒤 사용할 수 있다. unit 설치와 enable은 시스템 변경이므로 스크립트가 자동 수행하지 않는다.

BBS+ 실험 모드는 `@mattrglobal/bbs-signatures` 2.0.0의 WASM 경로만 사용한다. 아카이브된 optional native addon이 취약한 `node-pre-gyp`/`tar` 설치 경로를 끌어오므로 application 의존성은 `npm ci --omit=optional`로 설치한다. `build.sh`는 실제 배포 세트를 `npm audit --omit=optional --audit-level=high`로 검사하며, high/critical 이상이면 실패한다. 해당 BBS 구현은 현재 CFRG draft-10의 완전한 표준 준거를 주장하지 않으며, 최신 구현으로의 마이그레이션은 별도 보안 게이트로 다룬다.

## 검증과 증거

```bash
./deploy/linux/healthcheck.sh
./deploy/linux/smoke-test.sh
MONGBAS_PROFILE=benchmark ./deploy/linux/revocation-evaluation.sh
MONGBAS_PROFILE=benchmark ./deploy/linux/cast-intent-evaluation.sh
MONGBAS_PROFILE=benchmark ./deploy/linux/vector-audit-or-cast-evaluation.sh
./deploy/linux/status.sh
./deploy/linux/collect-environment.sh
MONGBAS_PROFILE=benchmark ./deploy/linux/benchmark.sh
MONGBAS_PROFILE=benchmark MONGBAS_CONCURRENCY_LEVELS=1,5,10,25,50 ./deploy/linux/concurrency-benchmark.sh
MONGBAS_PROFILE=benchmark ./deploy/linux/rate-evaluation.sh
MONGBAS_PROFILE=benchmark ./deploy/linux/fault-evaluation.sh
MONGBAS_PROFILE=benchmark ./deploy/linux/critical-fault-evaluation.sh
MONGBAS_RUNTIME_DIR=/home/user1/mongbas-runtime ./deploy/linux/pdc-custody-evaluation.sh
MONGBAS_RUNTIME_DIR=/home/user1/mongbas-runtime ./deploy/linux/dkg-evaluation.sh
MONGBAS_RUNTIME_DIR=/home/user1/mongbas-runtime ./deploy/linux/dkg-live-evaluation.sh
sudo MONGBAS_RUNTIME_DIR=/home/user1/mongbas-runtime ./deploy/linux/trustee-custody-evaluation.sh
MONGBAS_PROFILE=benchmark MONGBAS_LONGEVITY_KIND=steady ./deploy/linux/longevity-evaluation.sh
MONGBAS_PROFILE=benchmark MONGBAS_LONGEVITY_KIND=soak ./deploy/linux/longevity-evaluation.sh
MONGBAS_PROFILE=benchmark ./deploy/linux/verifier-evaluation.sh
./deploy/linux/supply-chain-evidence.sh
```

N=100 측정은 독립된 loopback 벤치마크 백엔드를 `DISABLE_RATE_LIMITS=true`로 기동한 후에만 실행한다. 벤치마크 프로그램은 `/health`에서 이 상태를 확인하고, 일반 rate limit이 켜진 백엔드에서는 부분 측정을 시작하지 않는다. 측정 후에는 즉시 일반 백엔드로 재기동해야 한다.

`smoke-test.sh`는 HTTP 200만 확인하지 않고 15단계 Fabric E2E의 종료 코드를 그대로 전파한다. 결과와 환경 기록은 runtime의 `logs/`, `results/`에 저장한다. benchmark는 demo 실행과 결과가 섞이지 않도록 명시적인 `benchmark` profile에서만 시작한다.

`e2e:revocation`은 실행 중인 backend의 `E2E_BASE_URL`을 대상으로 별도 선거를 만들고, 폐기 등록의 idempotency·충돌 거부·폐기 credential 투표 거부·미폐기 credential commit·신규 공개 Nullifier의 `credentialHash` 부재를 검사한다. 관리자 토큰이 설정된 환경에서는 같은 shell에 `ADMIN_API_TOKEN`을 안전하게 주입해야 하며, demo credential이 명시적으로 활성화된 평가 profile에서만 `voter1/voter2` fixture를 사용한다.

`fault-evaluation.sh`는 volume을 삭제하지 않고 허용 목록의 잉여 컴포넌트만 `docker stop/start`한다. 모든 장애 구간과 복구 후에 새 vector-v3 선거를 생성해 1표 exact threshold tally까지 검증하며, trap으로 정상 상태를 복원한다.
`critical-fault-evaluation.sh`는 현재 Gateway peer, primary CouchDB, chaincode service 중단 시 요청이 fail-closed하는지와 복구 후 exact threshold tally가 돌아오는지를 분리해 기록한다.

`pdc-custody-evaluation.sh`는 CouchDB 비밀값이나 private value를 출력하지 않고, 각 조직 DB가 어떤 trustee-share index의 문서 ID를 보유하는지만 집계한다. 한 조직 DB에 1·2·3 share가 모두 보이면 기관별 custody 게이트를 종료코드 1로 실패시킨다. 현재 shared PDC 설계에서는 예상된 실패이며, DKG/조직별 trustee custody 완료 전에 통과로 바꾸어서는 안 된다.

`dkg-evaluation.sh`는 세 기관의 X25519/Ed25519 key를 서로 다른 0700 secret 디렉터리에 생성하고, 서명된 Feldman contribution·암호화 share 교환·각자의 합산 share·공개 transcript를 실행한다. public evidence에 scalar/private key field가 없고 비밀 파일이 0600인지 검사한다. 서명된 complaint는 sender/dealer/reason/evidence hash를 귀속하고 transcript finalization을 반드시 exit 1로 중단한다. 현재 n=3,t=2 구성은 complaint 후 dealer를 자동 제외하거나 threshold를 변경하지 않는다.

`dkg-live-evaluation.sh`는 공개 transcript를 실제 Fabric 선거에 전달하고 세 MSP 승인, 승인 전 활성화 거부, 잘못된 hash, shared-PDC partial, 변조/duplicate external partial 거부, 2-of-3 external proof, exact 1:1:1 tally와 별도 audited ballot 공개를 검증한다. 첫 partial만 제출된 `t-1` 상태에서는 tally가 암호화 상태로 남고, 두 번째 partial 이후에만 복호화되어야 한다. 실행 전후 legacy share 문서 수가 변하지 않아야 한다. 이 선거 ID를 `MONGBAS_VERIFIER_ELECTION_ID`로 `verifier-evaluation.sh`에 전달하면 bundle v5의 DKG 방정식과 28개 위변조 corpus를 clean package로 재검증한다.

`trustee-custody-bootstrap.sh`와 `trustee-custody-evaluation.sh`는 root 권한으로 `mongbas-ec`, `mongbas-party`, `mongbas-civil` non-login 계정을 생성하고 각 계정이 자신의 0600 scalar share만 소유하게 한다. 공개 contribution/transcript만 공유 group으로 교환하며, 일반 operator의 접근 0/3과 trustee 상호 교차 접근 0/6을 모두 요구한다. `os-trustee-live-evaluation.sh`는 소유자별 share로 실제 partial을 생성하고 MSP/index/effective UID/share owner/output owner를 scalar 없이 기록한다. 이는 Unix DAC 경계이지 실제 기관 독립성이 아니다. 같은 호스트의 root는 모든 share에 접근할 수 있으므로 evidence는 `physicalHostIndependent=false`, `rootAdministratorTrusted=true`를 기록한다. 스크립트는 시스템 계정과 `/var/lib/mongbas-trustees`, `/opt/mongbas-trustee`를 생성하므로 실행 전에 운영 범위를 확인한다.
`longevity-evaluation.sh`는 일반 3000 번 백엔드를 건드리지 않고 loopback 3001 번에 rate-limit을 해제한 독립 측정 백엔드를 기동한다. `steady`는 기본 30분, `soak`는 기본 2시간 동안 반복 라운드의 0건 실패, exact tally, 2개 이상의 partial-decryption proof, 자원·컨테이너 상태를 검증한다. 개발자용 짧은 dry run만 `MONGBAS_LONGEVITY_SECONDS`(60초 이상)로 조정하며, 정식 평가는 기본 시간을 사용한다.
`rate-evaluation.sh`는 loopback 3002 번의 격리 backend에서 실제 credential-bound nullifier, vector-v3 proof, Fabric commit과 exact threshold tally를 유지하며 고정 offered-rate를 측정한다. 한 유권자 작업은 `prepare-vector`와 `cast-vector` 두 Fabric commit이므로 보고서는 voter-operation TPS와 Fabric transaction TPS, 두 단계 latency를 분리한다. 기본 60초/1회는 자동화 검증용 예비 측정이다. 논문용 실행은 `MONGBAS_RATE_DURATION_SECONDS=600`, `MONGBAS_RATE_REPEATS=5`, `MONGBAS_RATE_LEVELS=1,5,10,25,50`으로 수행하고 raw report와 SHA inventory를 보존한다. 기존 `caliper/workloads/castVote.js`는 bypass credential과 plaintext candidate를 직접 chaincode에 보내는 legacy workload이므로 vector-v3 결과로 인용하지 않는다.
`verifier-evaluation.sh`는 live vector-v3 선거를 만들거나 `MONGBAS_VERIFIER_ELECTION_ID`로 기존 DKG 선거를 재사용한다. bundle source를 export·임시 2-of-3 Ed25519 서명한 후 `npm pack` clean verifier로 honest exit 0과 모든 corpus exit 1을 요구한다. v4는 22개, DKG v5는 추가 6개를 포함한 28개다. 임시 private key는 result에 저장하지 않고 서명 후 삭제하며, single-host 임시 서명은 기관 독립성 증거로 해석하지 않는다.

`coercion-evaluation.sh`는 격리 backend에서 opaque normal/panic proof capability를 무작위 균형 순서로 조회한다. target nullifier 노출, byte size, latency를 raw JSONL로 보존하고, 훈련/평가를 분리한 threshold classifier와 Wilson 95% CI를 보고한다. 이 gate는 동일 호스트 API transcript만 평가하며 PDC/backend 공모, 공개 revote pattern, compromised client를 증명하지 않는다.
`full-e2e-evaluation.sh`는 일반 3000 번 서비스를 건드리지 않고 3006 번의 최신 코드 격리 backend에서 full-election E2E를 실행한다. backend log, stdout/stderr, 종료 코드, Git commit과 SHA-256 inventory를 runtime result에 보존하고 worktree가 dirty하면 시작하지 않는다.
`supply-chain-evidence.sh`는 application/frontend/verifier의 production dependency CycloneDX 1.5 SBOM, deployed npm audit, vendored Go module/toolchain inventory, Docker image digest inventory를 외부 runtime에 저장한다. strict validator는 중복 component reference나 deployed high/critical npm finding이 있으면 non-zero로 종료한다. npm dev/build dependency는 이 production inventory에 포함되지 않으므로 별도 build-tool SBOM/audit이 필요하다. SBOM 존재는 취약점 부재나 공급망 인증을 의미하지 않으며, Go/container/OS 취약점 scanner와 signed provenance는 별도 gate로 남는다.

## 안전한 종료

```bash
./deploy/linux/down.sh
```

이 명령은 컨테이너만 정지하고 volume·원장·raw evidence를 삭제하지 않는다. `network/scripts/network.sh down`과 `clean`은 volume 또는 생성 artifact를 제거할 수 있으므로 데이터 보존 여부를 확인한 뒤 별도로 실행해야 한다.
