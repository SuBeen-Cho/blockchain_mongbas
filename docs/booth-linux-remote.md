# Windows에서 Linux 부스 서버에 붙어서 운영하기

부스 서버(Fabric 원장 + 백엔드)는 학교 Linux 서버(Ubuntu 24.04)에서 돌리고, Windows 노트북은 관제판 화면만 띄우는 방식이다. Windows에 Docker나 WSL을 깔 필요가 없다.

```
휴대폰 ──(QR, https://….trycloudflare.com)──▶ Linux 서버 :3100 (공개 입구)
Windows 브라우저 ──(SSH 터널)──▶ Linux 서버 127.0.0.1:3101 (관리자 입구, 관제판)
```

## 처음 한 번

1. Windows에 **Tailscale**을 설치하고, Linux 서버(`hansung-tfg256xg`, `100.103.93.65`)가 보이는 계정으로 로그인한다.
   PowerShell에서 `tailscale ping 100.103.93.65`가 응답하면 된다.
2. SSH는 Windows 10/11에 기본으로 들어 있다. PowerShell에서 `ssh -V`로 확인한다.
3. 로그인 계정은 `user1`이다. 비밀번호는 팀에서 따로 전달받는다(이 문서와 저장소에는 적지 않는다).
   매번 비밀번호를 치기 싫으면 Windows에서 `ssh-keygen -t ed25519`로 키를 만들고, 공개키를 서버의 `~/.ssh/authorized_keys`에 추가한다.

## 부스 켜기

PowerShell 창 두 개를 쓴다.

**창 1: 서버에서 부스 실행**

```powershell
ssh user1@100.103.93.65
cd ~/mongbas-booth
PORT=3100 OPEN_BROWSER=false ./scripts/booth-up.sh
```

마지막에 `✅ 부스 준비 완료`와 휴대폰 공개 주소가 나오면 된다. 실행이 끝나도 서버는 계속 켜져 있으므로 이 창은 닫아도 된다.

**창 2: 관제판 터널 (부스 운영 내내 열어 둠)**

```powershell
ssh -N -L 3101:127.0.0.1:3101 user1@100.103.93.65
```

아무것도 출력되지 않고 멈춰 있으면 연결된 상태다. 이제 브라우저에서 아래 주소를 연다.

- 관제판: `http://localhost:3101/?app=control`

**왼쪽 3101과 오른쪽 3101은 같은 숫자여야 한다.** 관리자 입구는 `localhost:3101`에서 온 요청만 받기 때문에, 다른 포트(예: 13101)로 터널을 열면 [새 세션 시작]이 403으로 거부된다.

## 운영 중

- [＋ 새 세션 시작]을 누를 때마다 새 선거와 새 QR이 만들어진다. 휴대폰은 QR만 찍으면 된다.
- 개표 애니메이션은 관제판 오른쪽 위 스위치로 켠다. 새 세션을 시작하면 다시 꺼진다.
- 서버를 다시 켜야 하면 창 1 명령을 다시 실행한다. 공개 주소가 바뀌어도 QR은 자동으로 새 주소를 쓴다.
  QR 주소를 유지한 채 백엔드만 재시작하려면 `KEEP_TUNNEL=true PORT=3100 OPEN_BROWSER=false ./scripts/booth-up.sh`를 쓴다.

## 끄기

```bash
ssh user1@100.103.93.65
cd ~/mongbas-booth && ./scripts/booth-down.sh
```

원장은 지우지 않는다. 다음에 다시 켜면 그대로 이어서 쓴다.

## 이 서버만의 사정

- 9월 실험 때 띄운 백엔드가 시스템 서비스(`mongbas-backend`)로 `127.0.0.1:3000`을 쓰고 있다. 그래서 부스는 3100(공개)·3101(관리자)을 쓴다.
- 부스 코드는 `~/mongbas-booth`(이 브랜치), Fabric 인증서는 9월 원장의 `~/mongbas/network`를 그대로 쓴다(`FABRIC_NETWORK_DIR`).
- 체인코드는 2026-11-25에 원장을 초기화하지 않고 sequence 1 → 2로 올렸다(패닉 칸 분리 버전).
- 비밀값은 `~/.local/state/mongbas/secrets/application.env`에 있고 Git에 올리지 않는다.

## 자주 막히는 곳

| 증상 | 확인할 것 |
|---|---|
| `ssh: connect ... timed out` | Windows Tailscale이 켜져 있는지, `tailscale ping 100.103.93.65` |
| 관제판이 안 열림 | 창 2 터널이 열려 있는지, 주소가 `localhost:3101`인지 |
| [새 세션 시작]을 눌러도 QR이 안 뜸 | 터널 포트가 3101 → 3101인지 |
| 휴대폰에서 접속 안 됨 | 창 1을 다시 실행해 새 공개 주소 받기 |
