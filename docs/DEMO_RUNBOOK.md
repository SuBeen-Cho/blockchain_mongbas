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
- `./scripts/demo-reset.sh`는 모든 데모 데이터를 삭제하므로 필요한 기록을 보존하고 명시적으로 재설정할 때만 사용한다.

폰 접속용 공개 URL(다른 터미널):
```bash
./scripts/demo-tunnel.sh       # cloudflared 무료 터널 → https://*.trycloudflare.com
```
> 공개 Quick Tunnel은 사용자 승인을 받은 일시 시험에만 사용한다. 발표/장기 운영은 named tunnel, vote/admin 경로 분리와 관리자 인증을 적용한다. cloudflared 미설치: `brew install cloudflared`.
> 공개 터널에서도 rate limit을 끄지 않는다. `live-count`, `live-votes`, `demo-events`는 관제판이 전송하는 관리자 bearer token이 있어야 조회된다. 관제판도 터널 URL로 열어야 QR에 해당 HTTPS origin이 들어간다.
>
> QR 시연 프로필에서는 `REQUIRE_DEMO_ADMISSION=true`를 반드시 사용한다. 관제판이 관리자 인증으로 120초짜리 일회용 admission을 발급하고, 폰은 URL fragment의 토큰을 즉시 지운 뒤 한 번만 교환한다. 이 admission은 실제 유권자 자격 증명이 아니며 eligibility 또는 ballot-stuffing 저항의 증거가 아니다. 승인된 단기 시험 외에는 인터넷 공개 터널로 노출하지 않는다.

화면 3개:
- **관제판(노트북)**: `http://localhost:3000/?app=control` (또는 터널 URL + `/?app=control`)
- **내 표 추적(노트북)**: `http://localhost:3000/?app=track`
- **폰 키오스크**: 관제판이 띄우는 단기 QR (`/?app=kiosk&e=<선거ID>#a=<일회용 토큰>`)

**전시용 쇼케이스(서브 컴퓨터)**: `https://mongbas-blockchain.netlify.app/` (Netlify 배포)
- 또는 로컬/터널에서 `http://localhost:3000/showcase3.html` (`https://<tunnel>/showcase3.html`).
- 소스: `frontend/public/showcase3.html` (구 showcase.html/showcase2.html 시안은 제거됨).
- 일반인/부스 참여자용 전시 페이지. 인터넷 연결 필요(폰트·애니메이션 CDN, QR·Firebase 동기화).
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
|   | 게시판 내 줄 하이라이트 → 봉인 일치 ✓ → "최종 N표 중 1표" → 운영자도 못 봄 | |
| ⑤ 변조 데모 | 추적 화면 **[번호 한 글자 바꿔 다시 추적]** → 빨간 X | "이래서 조작 불가" |
| → 반복 | 다음 팀: **[새 세션 시작]** 한 번 | |

핵심 메시지(멘트):
- ②: "서버는 암호문만 봅니다. 누구에게 찍었는지 우리도 몰라요."
- ③: "결과는 2개 기관 키조각이 모여야만 열립니다(2-of-3)."
- ④: "당신의 번호로 당신 표가 변조 없이 집계에 들어간 걸 그 자리에서 확인."
- ⑤: "번호를 조작하면 추적 자체가 실패합니다."

---

## 2. 7대 보안 속성 ↔ 체험 매핑 (Q&A 대비)

> 아래는 시연에서 보여주는 기능 매핑이며 7/7 보안 증명이 아니다. 각 속성의 공격자 모델·신뢰 가정·독립 검증 상태는 별도 security matrix를 따른다.

| 속성 | 보이는 지점 |
|---|---|
| 투표 비밀성 | ② 폰 투표(서버 암호문만) / ④ 운영자도 못 봄 |
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
| 폰이 페이지 못 엶 | 터널 URL 확인. 끊겼으면 `demo-tunnel.sh` 재실행(URL 바뀜 → QR 갱신). LAN 백업 전환. |
| 투표가 거부됨(자격증명) | 백엔드를 `.env` 로드해 띄웠는지 확인(`demo-start.sh` 사용). bypass 모드면 체인코드가 거부. |
| 결과가 안 열림 | 관제판이 조각 2개를 자동 제출함. 로그 확인. 안 되면 [집계 종료] 다시. |
| 전부 꼬임 | `./scripts/demo-reset.sh` 로 초기화 후 `demo-start.sh`. |
| 네트워크 up 실패(crypto-config 삭제 오류) | `demo-reset.sh`가 macOS ACL을 벗기고 정리함. |

---

## 4. 검증 스크립트 (사전 점검)

```bash
cd application
node scripts/p2-threshold-test.js   # ElGamal 2-of-3 threshold 복호화
node scripts/p5-track-test.js       # 내 표 추적(게시판 매칭 + 봉인 일치 + 변조 탐지)
node scripts/scenario-suite.js      # 재투표/종료후/빈선거/패닉제외/다중세션/단일표 (10검사)
node scripts/scenario-suite2.js     # 대량집계/동시투표/보편검증/조각거부/receipt-free/AES (8검사)
node scripts/rehearsal-browser.js   # 실 브라우저(Chrome) 관제판+키오스크 UI 드라이브스루 (6검사)
npm run e2e:full                    # 전체 15-페이즈 통합 E2E
```
전부 `✅ PASS` 면 데모 흐름 정상. 리허설 스크립트는 `/tmp/rehearsal-*.png` 스크린샷도 남깁니다.

> 모바일 화면 점검: `"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless --screenshot=/tmp/k.png --window-size=500,900 --virtual-time-budget=9000 "http://localhost:3000/?app=kiosk&e=<선거ID>"`
