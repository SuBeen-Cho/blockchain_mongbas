# Repository boundary

이 공개 저장소는 Linux에서 프로젝트를 재현하는 데 필요한 소스, 설정 템플릿, 자동화와 공개 검증 문서만 포함한다.

## 포함

- backend, frontend, chaincode 소스
- Fabric network와 Docker/Compose 설정
- dependency lock 파일
- 실행·시험·benchmark 자동화
- 값이 제거된 환경변수 예제
- 공개 가능한 평가 방법과 요약 결과

## 제외

- 실제 `.env`, 개인키, 인증서, credential, token
- 생성된 channel/crypto artifact
- `node_modules`, Fabric binary와 전체 `fabric-samples`
- raw benchmark data와 내부 취약점 분석
- 논문 작업본, 심사 피드백, 발표·시연 원본

Linux runtime secret, data, log, result는 clone된 저장소 밖에 둔다. 공개 결과에는 실행에 사용한 commit과 image digest를 기록한다.

