# Linux deployment

이 디렉터리는 Ubuntu Linux에서 재현 가능한 배포·검증 명령을 제공한다.

검증된 기준 환경(2026-09-01):

- Ubuntu 24.04 x86-64
- Node.js 22.12 이상
- Go 1.22 이상
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

## 검증과 증거

```bash
./deploy/linux/healthcheck.sh
./deploy/linux/smoke-test.sh
./deploy/linux/status.sh
./deploy/linux/collect-environment.sh
MONGBAS_PROFILE=benchmark ./deploy/linux/benchmark.sh
```

`smoke-test.sh`는 HTTP 200만 확인하지 않고 15단계 Fabric E2E의 종료 코드를 그대로 전파한다. 결과와 환경 기록은 runtime의 `logs/`, `results/`에 저장한다. benchmark는 demo 실행과 결과가 섞이지 않도록 명시적인 `benchmark` profile에서만 시작한다.

## 안전한 종료

```bash
./deploy/linux/down.sh
```

이 명령은 컨테이너만 정지하고 volume·원장·raw evidence를 삭제하지 않는다. `network/scripts/network.sh down`과 `clean`은 volume 또는 생성 artifact를 제거할 수 있으므로 데이터 보존 여부를 확인한 뒤 별도로 실행해야 한다.
