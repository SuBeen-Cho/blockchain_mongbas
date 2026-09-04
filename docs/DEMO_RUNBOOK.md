# 부스 시연 운영 가이드 (DEMO RUNBOOK)

> 시연은 구현 기능을 보여주는 것이며 7대 보안 속성의 7/7 독립 검증이 아니다. normal/panic 비교는 API transcript 보완만 시연하며, PDC/backend 공모와 revote/participation pattern을 포함한 coercion resistance는 `unverified`입니다.

발표 당일 부스에서 그대로 따라 하는 실전 운영 절차. (설계 배경은 `DEMO_BOOTH_DESIGN.md` 참조)

---

## 0. 사전 준비 (발표 전날/당일 아침, 1회)

```bash
cd mongbas
./scripts/demo-start.sh        # 네트워크 확인 → 빌드 → 백엔드(:3000) → 헬스
```
- 네트워크가 안 떠 있으면 자동으로 `up + deploy`(수 분). 이미 떠 있으면 건너뜀.
- `./scripts/demo-reset.sh --confirm-destroy-demo-ledger`는 모든 데모 데이터와 생성 암호 자료를 삭제하므로 필요한 기록을 보존하고 명시적으로 초기화를 승인한 때만 사용한다.

폰 접속용 tailnet-only HTTPS(계정 Serve 활성화 후):
```bash
MONGBAS_RUNTIME_DIR="${HOME}/.local/state/mongbas" \
  ./deploy/linux/tailnet-serve-evaluation.sh ENABLE_TAILNET_ONLY_SERVE
```
> 이 명령은 tailnet 내부 Serve만 구성한다. Funnel, `demo-tunnel.sh`와 일반 인터넷 공개는 별도 승인이 없으면 사용하지 않는다.
> private Serve에서도 rate limit을 끄지 않는다. `live-count`, `live-votes`, `demo-events`는 관제판이 전송하는 관리자 bearer token이 있어야 조회된다. 관제판도 Serve HTTPS URL로 열어야 QR에 해당 origin이 들어간다.
>
> QR 시연 프로필에서는 `REQUIRE_DEMO_ADMISSION=true`를 반드시 사용한다. 관제판이 관리자 인증으로 120초짜리 일회용 admission을 발급하고, 폰은 URL fragment의 토큰을 즉시 지운 뒤 한 번만 교환한다. 이 admission은 실제 유권자 자격 증명이 아니며 eligibility 또는 ballot-stuffing 저항의 증거가 아니다. 승인된 단기 시험 외에는 인터넷 공개 터널로 노출하지 않는다.

화면 3개:
- **관제판(노트북)**: `http://localhost:3000/?app=control` (원격 실증 시 Serve HTTPS URL + `/?app=control`)
- **내 표 추적(노트북)**: `http://localhost:3000/?app=track`
- **폰 키오스크**: 관제판이 띄우는 단기 QR (`/?app=kiosk&e=<선거ID>#a=<일회용 토큰>`)

**전시용 쇼케이스(서브 컴퓨터)**: `https://mongbas-blockchain.netlify.app/` (Netlify 배포)
- 또는 로컬/Serve에서 `http://localhost:3000/showcase3.html` (`https://<tailnet-host>/showcase3.html`).
- 소스: `frontend/public/showcase3.html` (구 showcase.html/showcase2.html 시안은 제거됨).
- 일반인/부스 참여자용 설명 페이지. 원격 CDN 폰트·애니메이션은 인터넷이 없으면 생략될 수 있지만, 투표용 QR이나 admission을 처리하지 않는다.
- **QR 갱신**: 대시보드 [새 세션] 시 서버에서 일회용 admission을 발급해 로컬 화면의 QR을 갱신한다. 원시 토큰은 Firebase나 다른 외부 relay로 전송하지 않는다.

---

## 1. 방문자 1팀 체험 (2~3분, 반복)

| 단계 | 발표자(관제판) | 방문자(폰) |
|---|---|---|
| ① 맞이 | **[새 세션 시작]** → QR 갱신 | QR 스캔 |
| ② 투표 | (선택) **[투표 +5/+10]** 으로 분위기 채우기, 라이브 카운터 ↑ | 후보 선택 → **투표** → 큰 영수증 `7F3A-90` 확인 |
| ③ 종료 | **[집계 종료 & 결과]** (확인창 → 진행) | — |
|   | 자동: 종료 → 2-of-3 조각 복원 → 복호화 → 막대그래프 결과 | |
| ④ 내 표 추적 ★ | 추적 화면(`?app=track`)에 방문자 영수번호 입력 → **추적하기** | 본인 추적번호 불러줌 |
|   | 게시판 내 줄 하이라이트 → 봉인 일치 ✓ → "최종 N표 중 1표" → 개별 선택은 암호문으로 유지 | |
| ⑤ 변조 데모 | 추적 화면 **[번호 한 글자 바꿔 다시 추적]** → 빨간 X | "이래서 조작 불가" |
| → 반복 | 다음 팀: **[새 세션 시작]** 한 번 | |

핵심 메시지(멘트):
- ②: "정상 집계 경로는 개별 선택 평문 대신 암호문을 저장하고, 2-of-3 부분복호화로 합계만 엽니다. 단일 host root·trustee 공모는 현재 한계입니다."
- ③: "결과는 2개 기관 키조각이 모여야만 열립니다(2-of-3)."
- ④: "당신의 번호로 당신 표가 변조 없이 집계에 들어간 걸 그 자리에서 확인."
- ⑤: "번호를 조작하면 추적 자체가 실패합니다."

---

## 2. 7대 보안 속성 ↔ 체험 매핑 (Q&A 대비)

> 아래는 시연에서 보여주는 기능 매핑이며 7/7 보안 증명이 아니다. 각 속성의 공격자 모델·신뢰 가정·독립 검증 상태는 별도 security matrix를 따른다.

| 속성 | 보이는 지점 |
|---|---|
| 투표 비밀성 | ② 폰 투표(개별 선택을 암호문으로 제출) / ④ 정상 합계만 2-of-3 부분복호화. 공모·단일 host 한계는 별도 표시 |
| 의도대로 투표 | (심화) Benaloh — 전체 파이프라인 화면 |
| 기록대로 투표 | ④ Merkle 봉인 일치 |
| 기록대로 집계 | ④ 집계 기여 / ZKP |
| 보편 검증 | ④ 공개 게시판 / ⑤ 변조 탐지 |
| 자격 검증 | ② 폰 접속 시 자격증명 자동 발급 |
| 강압 저항(목표) | (심화) opaque normal/panic API 비교. 전체 속성은 `unverified`로 표시 |

---

## 3. 트러블슈팅

| 증상 | 대응 |
|---|---|
| 폰이 페이지 못 엶 | 휴대폰 tailnet 연결, Serve HTTPS URL, 인증서와 QR 만료를 확인한다. 공개 tunnel이나 LAN HTTP로 자동 전환하지 않는다. |
| 투표가 거부됨(자격증명) | 백엔드를 `.env` 로드해 띄웠는지 확인(`demo-start.sh` 사용). bypass 모드면 체인코드가 거부. |
| 결과가 안 열림 | 관제판이 조각 2개를 자동 제출함. 로그 확인. 안 되면 [집계 종료] 다시. |
| 전부 꼬임 | 복구 증거 보존·초기화 승인 후 `./scripts/demo-reset.sh --confirm-destroy-demo-ledger`, 그런 다음 `demo-start.sh`. |
| 네트워크 up 실패(crypto-config 삭제 오류) | `demo-reset.sh`가 macOS ACL을 벗기고 정리함. |

---

## 4. 현재 지원 검증 경로

```bash
cd application
npm test                            # 코드·보안 경계 전체 회귀
npm run e2e:full                    # 현재 credential-bound 투표 통합 E2E
npm run e2e:vector-aoc              # vector-v3 audit-or-cast 경로
node scripts/dkg-election-e2e.js    # 현재 DKG transcript 경로
node scripts/qr-admission-live-e2e.js # 일회용 QR admission 경로

cd ../verifier
npm test                            # bundle/history/checkpoint 독립 검증 회귀
```

실제 Fabric·QR·성능 증거는 `deploy/linux/`의 versioned evaluator가 생성한 환경 manifest, 종료 상태와 SHA-256 inventory까지 함께 통과해야 한다. 위 로컬 테스트만으로 보안 속성이나 실제 휴대폰 HTTPS 경로가 검증됐다고 판단하지 않는다.

`p2-threshold-test.js`, `p5-track-test.js`, `scenario-suite*.js`, `rehearsal-browser.js`는 legacy dealer-share/AES/짧은 receipt prefix/구형 UI 경로를 혼합하므로 실행 전 fail-closed한다. 과거 스크립트의 `PASS` 문구는 현재 DKG, receipt, coercion resistance 또는 QR 보안 증거로 사용할 수 없다.

> 모바일 화면 점검: `"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless --screenshot=/tmp/k.png --window-size=500,900 --virtual-time-budget=9000 "http://localhost:3000/?app=kiosk&e=<선거ID>"`
