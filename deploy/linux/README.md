# Linux deployment

이 디렉터리는 Ubuntu Linux에서 재현 가능한 배포 설정을 수용한다.

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

`network/docker-compose.yaml`은 clone 직후 `voting-chaincode:1.0` 이미지가 없을 때 chaincode 소스에서 이미지를 빌드할 수 있도록 build context를 포함한다. 테스트 false positive와 ElGamal exact tally 결함은 별도 코드 수정 대상으로 유지한다.
