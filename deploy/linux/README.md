# Linux deployment

이 디렉터리는 Ubuntu Linux에서 재현 가능한 배포 설정을 수용한다.

예정 항목:

- Docker Compose v2 사전 점검
- host와 container resource 기록
- 저장소 외부의 secret/data/log/result 경로
- fresh build, healthcheck, smoke test
- benchmark와 원격 QR 데모 profile 분리

실제 배포 자동화는 현재 Compose의 fresh-build 결함과 테스트 false positive를 수정한 뒤 추가한다.

