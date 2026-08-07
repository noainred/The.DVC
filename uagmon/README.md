# UAG Monitor — Horizon UAG(Unified Access Gateway) 모니터

Horizon UAG 어플라이언스의 상태·세션을 모아 보는 경량 모니터입니다.
**Node 내장 모듈만 사용**(외부 의존성 0)하며, 하나의 코드로 세 가지 배포를 지원합니다.

| 배포 | 파일 | 실행 |
|---|---|---|
| 서버(웹) | `uag-monitor-<v>.tar.gz` | 서버에서 `./run-server.sh --host 0.0.0.0 --port 8123` → 브라우저 접속 (동봉 `uag-monitor.service` 참고) |
| Windows 앱 | `uag-monitor-app-<v>-win-x64.zip` | 압축 해제 후 `UAG Monitor.exe` 실행 — **자체 창**(브라우저 불필요) |
| macOS 앱 | `uag-monitor-app-<v>-macos-arm64.tar.gz` (Apple Silicon) / `-macos-x64` (Intel) | `UAG Monitor.app` 실행 — **자체 창**(브라우저 불필요) |

데스크톱 앱은 내장 서버를 127.0.0.1 임의 포트에 띄우고 자체 창(Electron)으로 엽니다.
데이터는 OS 사용자 폴더(`~/Library/Application Support/uag-monitor` · `%APPDATA%/uag-monitor`)에
저장되어 앱을 교체해도 유지됩니다. 창을 모두 닫으면 내장 서버도 함께 종료됩니다.

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

## 데스크톱 앱 첫 실행 안내 (미서명 앱)

Apple 공증/코드서명을 받지 않은 앱이라 첫 실행 시 OS 승인이 한 번 필요합니다.

- **macOS** — 다음 중 하나:
  1. (가장 빠름) 터미널: `xattr -dr com.apple.quarantine "<풀린 폴더>"` 후 앱 실행
  2. 앱 실행(차단됨) → **시스템 설정 → 개인정보 보호 및 보안** → 보안 섹션의
     **"그래도 열기"** → 다시 실행
  - 처음부터 터미널로 압축을 풀면(`tar -xzf …`) 격리 속성이 붙지 않아 바로 실행됩니다.
  - ⚠ '우클릭 → 열기' 우회는 **macOS 14까지만** 동작합니다(15 Sequoia 부터 제거됨).
- **Windows**: SmartScreen 경고가 뜨면 **추가 정보 → 실행**으로 1회 승인하세요.
- 경고 자체를 없애려면 Developer ID 서명+공증(macOS)·Authenticode 서명(Windows)이
  필요합니다 — 인증서 확보 시 CI 에 서명 단계를 추가할 수 있습니다.

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
