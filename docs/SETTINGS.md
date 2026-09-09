# 설정 화면 안내 — 모든 탭·모든 설정 (v2.448)

포탈 상단 **설정** 메뉴의 32개 화면을 화면 순서대로 설명한다. 각 항목은
**무엇을 하는가 → 어디에 저장되는가 → 관련 환경변수 → 권한 → 주의사항** 순이다.

- 파일은 전부 `CONFIG_DIR`(설치본 기본 `/etc/vmware-portal`) 아래에 만들어진다 → [설정·데이터 파일 레퍼런스](CONFIG-FILES.md)
- 환경변수는 `portal.env` 에 `KEY=값` 으로 넣고 서비스를 재시작한다 → [환경변수 레퍼런스](ENV.md)
- 설정 화면 전체는 `settings` 권한이 필요하고(기본 admin 전용), 일부는 **설정 소유자**(`settings-owners.txt`)만 접근한다.

> **역할 3종**: `admin`(전체) · `operator`(조회 + 도구 + 원격접속·콘솔) · `viewer`(조회 + 인사이트).
> 세부 권한은 아래 *메인포탈 사용자 관리* 에서 역할별로 켜고 끌 수 있다.

---

## 🖥️ vCenter 관리

### 1. DataCenter(법인) — `#/settings/datacenter-admin`
- **무엇**: 법인(DataCenter)을 만들고 vCenter·iDRAC 장비를 그 아래로 배정한다. 화면 곳곳의 '법인' 필터와 지도 배치가 이 정의를 따른다. 표시 순서도 여기서 정한다.
- **저장**: `datacenters.json`(정의·순서), 배정 결과는 각 장비 레코드에 기록
- **권한**: `settings`
- **주의**: 법인을 지우면 그 아래 장비의 배정이 풀려 '미배정'으로 표시된다(장비 자체는 남는다).

### 2. vCenter 등록·관리 — `#/settings/vcenter-admin`
- **무엇**: 수집 대상 vCenter 를 등록·수정·삭제한다. 주소·계정·타임아웃·수집 on/off·지리 좌표(지도 표시용)를 설정하고, 데이터 소스(`live`/`mock`)를 바꾼다.
- **저장**: `vcenters.json`(계정은 봉인 저장), 표시 순서는 `vcenter-order.json`
- **환경변수**: `DATA_SOURCE`(live|mock|auto) · `COLLECT_CONCURRENCY`(동시 수집 수, 기본 8) · `VCENTERS_EXAMPLE_FALLBACK`(예제 템플릿 폴백, 기본 꺼짐)
- **권한**: `settings`
- **주의**: `DATA_SOURCE=auto` 는 접속 실패 시 **가짜 데이터로 폴백**한다 — 운영에서는 `live` 를 쓸 것(v2.443/444 에서 중앙이 목업 유입을 차단하도록 보강). vCenter id 는 한 번 정하면 바꾸지 않는 것이 좋다(시계열 DB·추이가 id 기준).

### 3. vCenter 연결 테스트 — `#/settings/vcenter-test`
- **무엇**: 등록된 vCenter 로 TCP → TLS → API 로그인까지 단계별로 시도해 어디서 막히는지 보여준다. 중계(HAProxy) 경유 구성이면 평문/무응답/리셋을 구분해 원인과 조치를 제시한다(v2.439).
- **저장**: 없음(즉시 실행)
- **권한**: `settings`(관리자)
- **주의**: SSRF 가드가 사설/루프백 주소를 막는다. 진단은 읽기 전용이다.

### 4. NSX 관리 — `#/settings/nsx-admin`
- **무엇**: NSX Manager 를 등록해 논리 스위치·라우터·방화벽 정보를 수집한다. 연결 테스트와 중계 프록시 경유 설정을 지원한다.
- **저장**: `nsx.json`(주소·계정, 봉인 저장)
- **환경변수**: `NSX_TLS_REJECT_UNAUTHORIZED`(자세한 내용은 [ENV.md](ENV.md))
- **권한**: `settings`(조회는 `inv.nsx`)
- **주의**: NSX 는 vCenter 와 별도 자격증명이다. 중계 뒤에 있으면 프록시를 지정해야 하며, SSRF 가드가 사설 대역 직접 접근을 검사한다.

---

## 🗄 수집 서버

### 5. iDRAC 서버 등록 — `#/settings/idrac-admin`
- **무엇**: Dell iDRAC 장비를 등록해 전력·온도·하드웨어 인벤토리를 수집한다. 대역(IP 범위) 스캔으로 자동 발견하고, 법인별로 스캔을 위임할 수 있다.
- **저장**: `idrac.json`(장비·계정) · `idrac-scan-ranges.json`(대역) · `idrac-scan-settings.json` · `idrac-inventory.json`(하드웨어 캐시) · `idrac-power.db`(전력 시계열)
- **환경변수**: `IDRAC_POLL_CONCURRENCY` · `IDRAC_SCAN_INTERVAL_MS` · `IDRAC_SENSOR_SAMPLES`
- **권한**: `settings`
- **주의**: 전력 시계열은 90일 수렴 시 수억 행이 되므로 보존기간을 확인할 것. 스캔은 대역이 넓을수록 오래 걸린다(위임 스캔 권장).

### 6. 스캔 로그 — `#/settings/idrac-scan-log`
- **무엇**: iDRAC 스캔의 실행 이력을 본다. 법인별 최근 결과에 **발견 / 등록 / 스캔 수량과 성공·실패·대기**가 표시된다(v2.441~442, 등록 수는 빨간색 강조).
- **저장**: `idrac-scan-log.json`
- **권한**: `settings`
- **주의**: 위임 스캔은 에이전트가 결과를 회신해야 수량이 채워진다 — '대기'는 실패가 아니다.

### 7. 지표 수집 — `#/settings/metrics`
- **무엇**: 샘플러 주기와 보존기간, VM 성능 추적 대상 vCenter를 정한다. vCenter별 DB 사용량을 보고 개별 삭제도 할 수 있다.
- **저장**: `metrics.json`(주기·보존) · `vmperf.json`(VM 성능 대상·보존) · `metrics.db` · `vmperf/<vc>-<해시>.db`
- **환경변수**: `METRICS_SAMPLE_INTERVAL_MS` · `METRICS_RETENTION_DAYS` · `VMPERF_*`
- **권한**: 조회는 로그인 사용자, **변경·삭제는 admin**
- **주의**: 대상에서 vCenter 를 빼면 그 DB 파일을 지워 용량을 즉시 회수한다(되돌릴 수 없다). v2.448 부터 파일명에 해시가 붙어 id 가 비슷한 vCenter 끼리 서로를 지우던 문제가 없다.

### 8. 스토리지 수집 주기 — `#/settings/storage-intervals`
- **무엇**: 스토리지 장비 수집·push·설정 pull 주기를 **중앙에서 배포**한다. 엣지는 매 틱 이 값을 다시 읽어 즉시 반영한다.
- **저장**: `storage-intervals.json`
- **권한**: `settings`
- **주의**: **중앙이 지정한 키만 내려간다** — 전 키를 채워 보내면 각 법인이 `portal.env` 로 잡아둔 현장 설정을 덮어쓴다. 하한(60초 / 영역수집 10분)은 서버가 강제하고, 빈 값·0 은 '미지정'으로 버린다.

### 9. SAN 스위치 포트 사용량 — `#/settings/sansw-perf`
- **무엇**: SAN 스위치 포트 처리량 수집 주기·보존기간을 정하고 즉시 수집/정리를 실행한다.
- **저장**: `sanswitch-perf-settings.json` · `sanswitch-perf.db`
- **환경변수**: `SANSW_CONCURRENCY`(동시 수집, 기본 4)
- **권한**: `settings`
- **주의**: 포트 처리량은 누적 카운터의 델타라 **첫 수집은 값이 없다**(null). 카운터 리셋(음수 델타)도 null 이며 0 으로 채우지 않는다 — 0 은 '트래픽 없음'으로 오해되기 때문.

### 10. GPU 수집 — `#/settings/gpu-collect`
- **무엇**: ESXi 호스트의 물리 GPU 사용률 수집을 켜고 끈다.
- **저장**: `gpu-physical.json`
- **권한**: `settings`

### 11. GPU 게스트 수집 — `#/settings/gpu-guest`
- **무엇**: 패스쓰루 GPU 는 호스트에서 사용률이 보이지 않으므로, 게스트 OS 안에서 `nvidia-smi` 를 돌려 수집한다. 게스트 계정·SSH 접속을 설정하고 에이전트에 배포한다.
- **저장**: `gpu-guest.json` · 중앙 배포본은 `central-agent-gpu-guest.json`
- **권한**: `settings`
- **주의**: 게스트 자격증명이 필요하다 — 통합 계정(자격증명 저장 방식)과 함께 관리할 것.

### 12. GPU 수집 진단 — `#/settings/gpu-guest-diag`
- **무엇**: GPU 게스트 수집이 실패하는 VM 을 단계별(계정 → 로그인 → 명령 실행 → 파싱)로 추적한다.
- **저장**: 없음(진단 결과는 메모리)
- **권한**: `settings`

### 13. 게스트 계정 추가 — `#/settings/guest-account`
- **무엇**: 여러 VM 의 게스트 OS 안에 계정을 일괄 생성한다(수집용 계정 배포).
- **권한**: `guest.deploy`(기본 admin)
- **주의**: 게스트 OS 를 실제로 변경하는 작업이다 — 대상 VM 을 반드시 확인할 것.

### 14. 수집 서버(원격) — `#/settings/collectors`
- **무엇**: 원격 법인의 엣지 포탈을 '수집 서버'로 등록해 중앙이 데이터를 당겨온다. 연결 상태·수신 통계·이름 충돌·인증 거부를 배지로 보여주고, 배지를 누르면 원인·근거·해결 절차가 나온다(v2.437).
- **저장**: `collectors.json`(URL·토큰) · 수신 통계는 메모리
- **환경변수**: `COLLECTOR_TIMEOUT_MS` · `CENTRAL_REQUIRE_AGENT_TOKEN`
- **권한**: `settings`
- **주의**: 토큰이 어긋나면 엣지가 401/403 을 낸다 — **401 은 대개 엣지가 구버전**이라는 뜻이다(경로 없음). '진단'으로 엣지가 실제로 받는 값을 확인할 수 있다.

### 15. 원격 법인(DC)에 Edge 노드 포탈 설치 — `#/settings/agent-deploy`
- **무엇**: SSH 로 원격 서버에 포탈 설치본을 올려 엣지 노드를 만든다. 현황·추가·대량배포·패키지 탭으로 나뉘며 CSV 가져오기/내보내기를 지원한다.
- **저장**: `agent-deploy-targets.json`(SSH 접속 정보 + 토큰 4종, 봉인 저장) · `packages.json`
- **권한**: `settings`, **비밀 포함 CSV 내보내기는 설정 소유자만**
- **주의**: v2.448 부터 설치 패키지 경로는 **파일명 규격 + 허용 디렉터리**로 제한된다(이전에는 임의 파일을 원격 호스트로 보낼 수 있었다). 재배포는 엣지의 토큰을 대상 값으로 덮으므로 '진단'으로 방향을 확인하고 정렬할 것.

---

## 🔌 원격 접속 서버

### 16. 중계 서버 — `#/settings/proxy`
- **무엇**: 브라우저 SSH/RDP 를 중계하는 프록시 서버를 등록하고 배포·테스트한다.
- **저장**: `remote-access.json`
- **환경변수**: `GUACD_HOST` · `GUACD_PORT`
- **권한**: admin

### 17. 원격접속 설정 — `#/settings/remote`
- **무엇**: 원격 접속 매핑(대상 호스트 ↔ 공개 포트)을 관리한다.
- **저장**: `remote-access.json`
- **권한**: `remote.access`(매핑 소유자 개념 있음)
- **주의**: 매핑은 소유자만 사용·삭제할 수 있고, WebSocket 게이트웨이가 접속 시점에 권한·OTP·데이터 범위를 다시 검사한다.

---

## 👤 User Control

### 18. 메인포탈 사용자 관리 — `#/settings/users`
- **무엇**: 계정 생성·역할 변경·비밀번호 재설정·2FA(TOTP) 관리, **역할별 기능 권한 매트릭스**, **데이터 범위(vCenter 제한)**, **특수 기능 도구별 접근**을 설정한다.
- **저장**: `users.json`(해시·TOTP 시크릿) · `permissions.json`(매트릭스·도구 거부)
- **권한**: `users.manage`
- **권한 키 18종**: `dashboard` · `inv.hosts` · `inv.vms` · `inv.datastores` · `inv.networks` · `inv.nsx` · `inv.alarms` · `tools` · `insights` · `remote.access` · `vm.console` · `vm.reconfig` · `vm.provision` · `guest.deploy` · `settings` · `upgrade` · `users.manage`
- **주의**: **도구별 접근 거부는 v2.448 부터 서버가 집행한다** — 그 전에는 화면에서만 숨겨져 API 직접 호출이 통과했다. 데이터 범위를 건 계정은 전체 합계 조회가 막힌다(범위 밖 데이터가 섞이기 때문).

### 19. 엣지 사용자 배포 — `#/settings/edge-users`
- **무엇**: 중앙에서 만든 계정을 엣지 포탈들에 일괄 배포한다.
- **저장**: `central-agent-users.json`
- **권한**: `users.manage`

### 20. 인증(AD) — `#/settings/auth-ad`
- **무엇**: Active Directory/LDAP 연동을 설정한다(도메인·서버·검색 필터·그룹↔역할 매핑). 연결 테스트를 제공한다.
- **저장**: `auth.json`
- **환경변수**: `AD_ENABLED` · `AD_URL` · `AD_DOMAIN` · `AD_ADMIN_GROUP` · `AD_OPERATOR_GROUP` · `AD_VIEWER_GROUP` · `AD_USER_FILTER` · `AD_TIMEOUT_MS`
- **권한**: admin
- **주의**: LDAP 필터 값은 RFC 4515 로 이스케이프된다(필터 인젝션 방지). v2.448 부터 이 파일도 원자적으로 쓰고 손상 시 원본을 보존한다 — 그 전에는 파일이 깨지면 조용히 AD 로그인이 꺼졌다.

---

## 🛡️ Security

### 21. 세션 보안 — `#/settings/session-security`
- **무엇**: 세션 만료 시간, 단일 세션 강제(ID 공유 금지), 로그인 실패 잠금, OTP 의무화를 설정한다.
- **저장**: `security-session.json` · `active-sessions.json`(현재 세션)
- **권한**: admin
- **주의**: OTP 의무화를 켜면 미등록 사용자는 등록 화면으로 강제 이동한다.

### 22. 자격증명 저장 방식 — `#/settings/secrets`
- **무엇**: 장비 비밀번호를 평문으로 둘지 **봉인(암호화)** 할지 정하고, 전환을 실행한다.
- **저장**: `secrets-policy.json` · 키는 `secrets-key`
- **권한**: admin(설정 소유자 권장)
- **주의**: **`secrets-key` 를 잃으면 봉인된 비밀은 복호할 수 없다** — 백업에 반드시 포함할 것. 비밀 값은 어떤 API 응답에도 실리지 않는다.

### 23. 이상동작 탐지 — `#/settings/anomaly`
- **무엇**: 사용량·이벤트의 이상 패턴 탐지 임계와 대상 vCenter 를 설정한다.
- **저장**: `anomaly` 관련 설정(`alerts.json` 과 연동)
- **권한**: admin

---

## 그 밖의 설정

### 24. AI 검색 — `#/settings/ai-search`
- **무엇**: 자연어 검색에 쓸 LLM(로컬 Ollama 또는 외부 API)을 설정하고, 에어갭 환경에 Ollama 를 배포한다.
- **저장**: `llm.json`
- **권한**: admin
- **주의**: 외부 API 를 쓰면 질의 내용이 외부로 나간다 — 에어갭 정책을 확인할 것.

### 25. 알림 — `#/settings/alerts`
- **무엇**: 임계 규칙과 알림 채널(Slack/Teams/이메일/웹훅)을 설정하고 테스트 발송한다. 일일 헬스체크 리포트 시각도 여기서 정한다.
- **저장**: `alerts.json` · `daily-report.json`
- **권한**: admin
- **주의**: v2.448 부터 채널이 하나도 없으면 테스트 발송이 **성공이 아니라 '설정 없음'** 으로 표시된다. 일일 리포트는 전송이 전부 실패하면 다음 주기에 재시도한다.

### 26. 포탈 백업 — `#/settings/backup`
- **무엇**: `CONFIG_DIR` 전체와 DB 를 묶어 백업하고, 스케줄·보존 개수·저장 위치(로컬/NFS)를 정한다. 복원도 여기서 한다.
- **저장**: `backup.json`(설정) · `backups/`(산출물)
- **권한**: **admin + 설정 소유자**(비밀이 통째로 들어가므로)
- **주의**: 백업 파일에는 `portal.env`·`auth-secret`·`secrets-key`·`users.json` 이 들어 있다 — **백업 파일 자체가 최고 등급 비밀**이다. 안전한 곳에 두고 접근을 제한할 것.

### 27. NFS 마운트(백업 대상) — `#/settings/nfs-mounts`
- **무엇**: 백업을 저장할 NFS 마운트를 등록·확인한다.
- **저장**: `nfs-mounts.json`
- **권한**: admin

### 28. vCenter 로그 보관 — `#/settings/vclogs`
- **무엇**: vCenter 이벤트를 주기적으로 수집해 장기 보관한다. 최소 심각도·보존기간·주기를 정하고 즉시 수집을 실행한다.
- **저장**: `vcenter-logs.json`(설정) · `logs.db`(이벤트)
- **환경변수**: `VCLOGS_CONCURRENCY`(동시 수집 vCenter 수, 기본 6 — v2.448 신설)
- **권한**: admin
- **주의**: v2.448 부터 vCenter 를 병렬로 수집하고 장비당 데드라인을 둔다(느린 1곳이 전체를 막지 않게).

### 29. 진단·로그 — `#/settings/diagnostics`
- **무엇**: 서버 상태(업타임·메모리·이벤트 루프 지연)와 최근 로그를 본다. DB 용량·폴러 상태도 확인할 수 있다.
- **저장**: 없음(실시간)
- **권한**: admin

### 30. 감사 로그 — `#/settings/audit`
- **무엇**: 누가 언제 무엇을 바꿨는지 기록을 조회한다.
- **저장**: `audit.ndjson`
- **환경변수**: `AUDIT_MAX`(보관 행 수)
- **권한**: admin
- **주의**: 상태 변경 API 가 자동으로 기록한다. 보안 자산이므로 별도 보관 정책을 두는 것이 좋다.

### 31. ⬆ 업그레이드 — `#/settings/upgrade`
- **무엇**: 새 버전을 확인·내려받아 적용하고 재시작한다. 오프라인(에어갭) 번들 업로드도 지원한다.
- **저장**: `upgrade.json` · `vmware-portal-release`
- **환경변수**: `UPGRADE_REMOTE_BASE` · `UPGRADE_ALLOW_UNVERIFIED`
- **권한**: `upgrade`
- **주의**: 번들은 **sha256 검증에 실패하면 설치를 거부**한다. `UPGRADE_ALLOW_UNVERIFIED=true` 는 그 검증을 **모든 소스에 대해** 끄므로 권장하지 않는다.

### 32. About — `#/settings/about`
- **무엇**: 현재 버전·릴리스 노트·라이선스·시스템 정보를 본다.
- **권한**: 로그인 사용자

---

## 자주 묻는 것

**Q. 설정을 바꿨는데 반영이 안 된다**
대부분은 즉시 반영된다. `portal.env` 는 **서비스 재시작**이 필요하다. 스토리지·SAN 수집 주기는 중앙 배포값이 현장 설정보다 우선한다.

**Q. 어떤 파일을 백업해야 하나**
설정 › 포탈 백업이 전부 담는다. 수동이라면 최소한 `portal.env` · `auth-secret` · `secrets-key` · `users.json` · `vcenters.json` · `collectors.json`.

**Q. 계정을 잠갔는데 다시 들어가려면**
`portal.env` 에 `AUTH_ENABLED=false` 를 넣고 재시작하면 인증 없이 들어갈 수 있다(임시 조치). 이때 `AUTH_DISABLED_ROLE=viewer` 로 낮춰 두는 것이 안전하다. 복구 후 반드시 되돌릴 것.

**Q. 권한을 줬는데 화면이 안 보인다**
기능 권한(매트릭스) · 데이터 범위(vCenter 제한) · 도구별 접근 거부 세 가지가 각각 작용한다. 화면에 "권한이 없습니다" 대신 필요한 권한과 요청 방법이 안내된다(403 은 오류가 아니라 정책대로 동작한 것이다).

---

관련 문서: [환경변수 레퍼런스](ENV.md) · [설정·데이터 파일](CONFIG-FILES.md) · [설치](INSTALL.md) · [관리자 가이드](GUIDE-ADMIN.md)
