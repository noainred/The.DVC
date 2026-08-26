# 관리자 가이드 — 설치·구성·보안 운영

포탈 관리자(admin)를 위한 운영 안내입니다. 사용법은
[GUIDE-BEGINNER.md](GUIDE-BEGINNER.md) / [GUIDE-INTERMEDIATE.md](GUIDE-INTERMEDIATE.md) 참고.

---

## 1. 설치와 업그레이드

- **설치**: [INSTALL.md](INSTALL.md) — 중앙/엣지/수집기 구성, 토큰·방화벽 포함 전 절차.
  오프라인(에어갭) 상세는 [packaging/offline/OFFLINE-INSTALL.md](../packaging/offline/OFFLINE-INSTALL.md).
- **업그레이드**: 상단 **⬆ 업그레이드** 탭 → [최신 버전 확인] → [적용]. 포탈이 번들을 받아
  sha256 검증 후 적용·자동 재시작합니다(롤백 지원). 엣지는 **엣지 푸시**로 일괄 배포.
  릴리스 절차(개발자용)는 [RELEASES.md](RELEASES.md).
- **서비스 허브**는 자동 업그레이드 대상이 아닙니다 — 포탈 업그레이드 후 코드 복사 3줄:
  ```bash
  sudo systemctl stop dc-service-hub
  sudo cp -a /opt/vmware-portal/app/pyportal/. /opt/dc-service-hub/
  sudo systemctl start dc-service-hub    # 확인: cat /opt/dc-service-hub/ver.txt
  ```

## 2. 인프라 등록 (설정 탭)

| 메뉴 | 내용 |
|---|---|
| vCenter 관리 | 등록(주소/계정)·연결 테스트. 등록 즉시 수집 시작(28개+ 병렬, 동시성 제한) |
| NSX 관리 | NSX-T/4.x 매니저 등록 — 게이트웨이·세그먼트·DFW 수집 |
| 수집 서버 | iDRAC 등록·IP 대역 스캔, 원격 수집 서버(에이전트), Edge 노드 설치 |
| GPU 사용량 수집 | ESXi 보고 + 게스트 OS 수집(패스쓰루 보완) |

- 고RTT 사이트(폴란드·미동부 등)는 **엣지 모드**(`EDGE_MODE=all` + `CENTRAL_URL` + `EDGE_TOKEN`)로
  현지 수집 후 중앙에 push하는 구성을 권장합니다 — [INSTALL.md §3](INSTALL.md).

- **대량 등록 CSV (v2.338+)** — 수집 서버(엣지)·엣지 배포 대상·iDRAC 스캔 대역·베어메탈
  스토리지 서버·**IP 스캔 대역(IP관리 › 대역·스캔, v2.369)** 을 CSV 로 가져오기/내보내기.
  드라이런 검증 → 덮어쓰기 확인 → 커밋 순서라
  잘못된 파일이 기존 등록을 조용히 덮지 않습니다(샘플 다운로드 제공).
- **베어메탈 스토리지 (v2.340, admin 전용)** — 특수기능 카드에서 SSH(df) 로 물리 서버 로컬
  디스크 용량을 주기 수집. 중앙에서 닿지 않는 서버는 엣지 위임으로 점검합니다.

## 3. 사용자·권한·보안

- **계정/역할** — admin(전체) / operator / viewer. **admin·operator는 OTP 전용**:
  발급 직후 첫 로그인에서 강제 등록 → 비밀번호는 폐기됩니다.
- **기능 권한 매트릭스** — 설정 › 사용자 관리에서 기능 키 17종을 역할별 체크박스로.
  서버(`requirePerm`)가 실제 강제하므로 메뉴만 숨는 게 아닙니다.
- **특수기능 도구별 접근** — 67개 도구를 역할별 개별 차단(deny-list).
- **데이터 범위(scope)** — 계정별로 볼 수 있는 vCenter/리전 지정(서버측 강제, 단건 조회 포함).
- **수정 가능 vCenter (v2.369)** — 데이터 범위 편집 창에서 계정별로 **변경 작업이 허용되는
  vCenter** 를 따로 지정. 비우면 조회 범위 전체에서 수정 가능(기존 동작), 지정하면 VM 생성/복제·
  Tools 업그레이드·게스트 계정 추가·VM 콘솔·IP 관리(수동지정/정책)가 그 vCenter 로 제한되고
  나머지는 조회 전용이 됩니다(조회 범위와의 교집합만 유효 — 서버측 강제).
- **특수 계정** — `noainred`(수퍼관리자, 강등/삭제 불가) · `thedvcdemp`(데모, viewer 고정).
- **OTP 전원 잠금 복구** — 콘솔에서 `otp-enroll.sh`(번들 래퍼) 실행. 문서의 경고대로
  **root 직접 실행 금지**(파일 소유권 사고). 긴급 해제는 `OTP_ROLE_ENFORCE=false`.
- 보안 감사 이력·불변조건: [SECURITY-AUDIT.md](../SECURITY-AUDIT.md), [AUDIT-2026-06-27.md](AUDIT-2026-06-27.md).

## 4. 알림 · 일일 리포트

- **채널**: Slack / **Microsoft Teams** / 일반 웹훅 — 설정 › 알림 또는 특수기능 › 알림 채널·이력에서
  URL 등록(+테스트 발송). 저장 시 SSRF 검증을 통과해야 하며, 같은 알림은 쿨다운·**전역 중복 억제
  창**으로 스팸이 되지 않습니다.
- **규칙**: 위험 알람·vCenter 다운·호스트 끊김·데이터스토어 임계·RAM 오버커밋·**VM 동시 다운**
  (vCenter별 임계 지정 가능).
- **일일 헬스체크 자동 발송**: 특수기능 › 일일 헬스체크 리포트 상단에서 시각 지정 + [지금 발송(테스트)].

## 5. 백업·로그

- **포탈 백업** — 설정 › 포탈 백업: 중앙+엣지 설정 통합 gzip(정기/변경 자동, 복원).
  ⚠️ 백업엔 자격증명이 담기므로 **다운로드/복원은 설정 소유자만** 가능합니다.
- **vCenter 로그 장기보관** — 이벤트 증분 수집(보관기간·용량 설정), 중앙 연합 조회.
- **감사 로그** — 모든 쓰기 작업 기록. 서버 데이터는 `/etc/vmware-portal` 백업 하나로 보존됩니다.

## 6. 서비스 허브 관리

- **설치/기동**: [INSTALL.md §10.1](INSTALL.md) · 상세 운영: [SERVICE-HUB.md](SERVICE-HUB.md)
- **초기 비밀번호**: `/etc/dc-service-hub/initial-settings-password.txt`(계정 admin, 변경 시 자동 삭제)
- **비밀번호 분실/전원 잠금 복구**(재시작 불필요):
  ```bash
  sudo -u dchub python3 /opt/dc-service-hub/app.py --data-dir /etc/dc-service-hub --reset-password admin
  ```
- **대량 등록(폐쇄망)**: JSON/CSV를 `/etc/dc-service-hub/import/`에 올리고 화면에서
  [🗂 서버 파일 가져오기] — 경로 탈출 차단·감사 로그 기록.
- 데이터는 전부 `/etc/dc-service-hub`(JSON 원자적 쓰기 + SQLite) — 이 폴더 하나가 백업 단위입니다.

## 7. 장애 대응 빠른 표

| 증상 | 확인 |
|---|---|
| 특정 vCenter `unreachable` | 카드의 한국어 힌트 → 설정 › vCenter 연결 테스트 → 중계 경로 단계 진단(TCP/TLS/HTTP) |
| 화면 전체 느림 | 특수기능 › 다빈치 서비스 점검(수집기 상태) · 포탈 DB(크기 추이) |
| 포탈 메모리 누수 의심 | 설정 › 진단의 **서버 메모리(누수 추적)** 카드(v2.368) — RSS/힙 추이·MB/일 추세 판정. 서버 로그의 시간당 `[memtrack]` 라인으로도 확인 |
| 엣지 보고 안 옴 | 설정 › 수집 서버의 인증 거부 카운터 → 토큰 강제 동기화 |
| 자동 업그레이드 안 됨 | `versions.json` 도달성(방화벽) · 업그레이드 탭 로그 |
| 알림이 안 옴 | 알림 채널 [테스트 발송] 결과 코드 확인(URL·SSRF 검증) |

## 문서 지도

| 대상 | 문서 |
|---|---|
| 처음 사용자 | [GUIDE-BEGINNER.md](GUIDE-BEGINNER.md) |
| 중급 사용자 | [GUIDE-INTERMEDIATE.md](GUIDE-INTERMEDIATE.md) |
| 관리자(본 문서) | GUIDE-ADMIN.md |
| 설치 | [INSTALL.md](INSTALL.md) · [OFFLINE-INSTALL.md](../packaging/offline/OFFLINE-INSTALL.md) |
| 서비스 허브 | [SERVICE-HUB.md](SERVICE-HUB.md) · [pyportal/README.md](../pyportal/README.md) |
| 네트워크/방화벽 | [NETWORK-COMMS-FIREWALL.md](NETWORK-COMMS-FIREWALL.md) |
| 릴리스/보안 | [RELEASES.md](RELEASES.md) · [SECURITY-AUDIT.md](../SECURITY-AUDIT.md) |
