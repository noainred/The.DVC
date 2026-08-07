# UAG Monitor — Horizon UAG(Unified Access Gateway) 모니터

Horizon UAG 어플라이언스의 상태·세션을 모아 보는 경량 모니터입니다.
**Node 내장 모듈만 사용**(외부 의존성 0)하며, 하나의 코드로 세 가지 배포를 지원합니다.

| 배포 | 파일 | 실행 |
|---|---|---|
| 서버(웹) | `uag-monitor-<v>.tar.gz` | 서버에서 `./run-server.sh --host 0.0.0.0 --port 8123` → 브라우저 접속 (동봉 `uag-monitor.service` 참고) |
| Windows | `uag-monitor-<v>-win-x64.zip` | 압축 해제 후 `UAG-Monitor.bat` 더블클릭 (Node 동봉, 브라우저 자동 오픈) |
| macOS | `uag-monitor-<v>-macos-arm64.tar.gz` (Apple Silicon) / `-macos-x64` (Intel) | `UAG Monitor.command` 더블클릭 |

## 데이터 소스

UAG **관리 인터페이스**(기본 9443)의 모니터링 통계 API 를 사용합니다:

```
GET https://<uag>:9443/rest/v1/monitor/stats     (HTTP Basic — 관리 계정)
```

수집 항목: 버전, 종합 상태, 총/인증 세션 수, 최고 수위(HWM), CPU/메모리(응답에 있을 때),
엣지 서비스별(VIEW·BLAST·TUNNEL 등) 상태/세션. JSON(신형)과 XML(구형) 응답을 모두
관용적으로 파싱하며, 응답에 없는 필드는 화면에 `—` 로 표시됩니다.
UAG 버전에 따라 필드 구성이 다를 수 있으니 첫 도입 시 실제 장비로 값 검증을 권장합니다.

- 세션 수 추이는 **인메모리**(최근 2,880 샘플)이며 프로세스를 재시작하면 초기화됩니다.
- 폴링 기본 30초, per-UAG 10초 타임아웃, 이전 주기가 끝나지 않으면 다음 틱을 건너뜁니다.

## 보안

- **서버(웹) 모드는 비밀번호 필수** — `127.0.0.1` 이외 주소로 바인딩하려면
  `--set-password <8자 이상>` 을 먼저 실행해야 하며, 없으면 기동을 거부합니다.
  로그인 실패 잠금은 출발지(IP)별 5회/5분입니다. API 인증은 `Authorization: Bearer`
  헤더만 사용(쿠키 미사용 → CSRF 표면 없음).
- **등록 주소 가드** — 루프백·링크로컬(클라우드 메타데이터)·우회표기(10진/16진/8진·
  IPv4-mapped IPv6)는 등록을 거부합니다. RFC1918 은 사내 장비 대상이므로 허용합니다.
  호스트네임은 표기 검증만 하며 DNS 해석 결과까지는 검사하지 않습니다.
- **TLS** — 자체서명 UAG 는 대상별 "인증서 검증 안 함" 옵션으로만 완화됩니다(전역 완화 없음).
- UAG 자격증명은 `data/uag-config.json`(0600, 원자적 쓰기)에만 저장되며, 파일이 손상되면
  `.corrupt.<ts>` 로 보존 후 빈 설정으로 시작합니다(원본 덮어쓰기 방지).

## macOS 안내

브라우저로 내려받은 압축은 격리(quarantine) 속성 때문에 첫 실행이 차단될 수 있습니다.
`UAG Monitor.command` 를 **우클릭 → 열기**로 1회 승인하거나, 터미널에서
`xattr -dr com.apple.quarantine <풀린 폴더>` 후 실행하세요.

## 개발/직접 실행

```
node server.js                 # http://127.0.0.1:8123 (로컬 전용, 인증 없음)
node server.js --open          # + 기본 브라우저 자동 오픈
node server.js --host 0.0.0.0 --port 8123   # 서버 모드(비밀번호 설정 필수)
node server.js --set-password 'xxxxxxxx'    # 서버 모드용 비밀번호 저장
```

데이터 디렉터리: `--data <dir>` 또는 `UAGMON_DATA` (기본 `<앱>/data`).
포탈(vmware-portal) 서버에는 앱 디렉터리에 `uagmon/` 으로 동봉됩니다 —
`/opt/vmware-portal/runtime/node/bin/node /opt/vmware-portal/app/uagmon/server.js …` 로 실행할 수 있습니다.
