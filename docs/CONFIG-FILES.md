# 설정·데이터 파일 레퍼런스 (자동 생성)

포탈이 `CONFIG_DIR`(설치본 기본 `/etc/vmware-portal`) 아래에 만드는 파일 **133개**의 목록이다.
시계열 DB 는 `db-location.json` 이 가리키는 `dbDir` 로 옮길 수 있다.

- 생성: `node scripts/config-doc.mjs` (마지막 갱신 2026-09-12)
- **이 파일을 직접 고치지 말 것** — 코드가 진실의 원천이다. 설명 보완은 `scripts/config-doc.mjs` 의 `NOTES` 에 추가한다.
- 열 의미: **원자적** = 쓰기 도중 크래시에도 파일이 깨지지 않음(`atomicWriteFileSync`) · **손상보존** = 읽기 실패 시 원본을 `.corrupt.<ts>` 로 보존 · **0600** = 소유자만 읽기

> ⚠️ **백업**: 설정 › 포탈 백업이 이 디렉터리를 통째로 담는다. 수동 백업 시에도 `portal.env`·`auth-secret`·`secrets-key`·`users.json` 은 반드시 포함할 것 — 이 넷이 없으면 복원해도 로그인·복호가 안 된다.
>
> 💾 **용량**: 디스크를 쓰는 것은 거의 전부 `.db`(SQLite 시계열)다. 특수 기능 › 포탈 DB 에서
> 파일별 크기를 보고, 필요하면 `db-location.json` 으로 큰 볼륨에 옮긴다.
> **SQLite 의 보존기간 정리(DELETE)는 파일 크기를 줄이지 않는다** — 빈 공간이 재사용될 뿐이라
> 파일은 '더 커지지 않고 멈추는' 것이지 작아지지 않는다. 실제로 줄이려면 `VACUUM` 이 필요하고,
> `VACUUM` 은 **원본 크기만큼의 여유 공간**을 임시로 쓴다(34GB DB → 34GB 이상 필요).
> 여유가 부족하면 **먼저 경로를 큰 볼륨으로 옮긴 뒤** VACUUM 하는 순서가 맞다.

| 파일 | 종류 | 용도 | 원자적 | 손상보존 | 0600 | 정의 모듈 |
|---|---|---|:--:|:--:|:--:|---|
| `_index.json` | 설정 | VM 성능 시계열 — **vCenter 별 독립 DB**(v2.376). |  |  | ✅ | metrics/vmperfDb.js |
| `active-sessions.json` | 설정 | 활성 세션 레지스트리 (v2.280) — '단일 세션 강제'(ID 공유 금지)의 상태 저장소. | ✅ |  | ✅ | auth/sessions.js |
| `agent-assignments.json` | 설정 | Central store for per-agent scan assignments and the results agents report | ✅ | ✅ | ✅ | central/assignments.js |
| `agent-deploy-targets.json` | 설정 | Edge 노드 설치 대상(SSH 접속 정보) | ✅ | ✅ | ✅ | agent/deployRegistry.js |
| `agent-results.json` | 설정 | Central store for per-agent scan assignments and the results agents report | ✅ | ✅ | ✅ | central/assignments.js |
| `alarm-mutes.json` | 설정 | 알람 음소거 규칙 | ✅ | ✅ | ✅ | alarm-mutes.js |
| `alerts.json` | 설정 | Alerting — evaluates threshold/condition rules against the current snapshot on | ✅ |  | ✅ | alerts.js |
| `audit.ndjson` | 로그(NDJSON) | 감사 로그(상태 변경 기록) | ✅ |  | ✅ | audit.js |
| `auth-secret` | 디렉터리 | 세션 토큰 서명 키(자동 생성) | ✅ | ✅ | ✅ | auth/auth.js |
| `auth.json` | 설정 | Active Directory (LDAP) authentication — UPN simple bind + group→role mapping. | ✅ | ✅ | ✅ | auth/ad.js |
| `backup.json` | 설정 | 백업 설정 + 스케줄러 + 변경 감시. | ✅ | ✅ | ✅ | backup/settings.js |
| `backups` | 디렉터리 | 포탈 백업 코어 — 중앙 포탈의 모든 설정(CONFIG_DIR의 *.json / *.env)과, 엣지 포탈(에이전트)이 | ✅ |  | ✅ | backup/service.js |
| `bm-storage.json` | 설정 | 베어메탈 스토리지 서버 목록 + 설정(v2.340). | ✅ | ✅ | ✅ | bmstor/registry.js |
| `capacity.db` | DB | 리소스 적정성(용량) 샘플 시계열 |  |  |  | config.js |
| `capture-history.json` | 설정 | 네트워크 캡처 이력 저장소 — 캡처 결과의 메타·요약·진단을 CONFIG_DIR/capture-history.json에 |  |  | ✅ | net/captureHistory.js |
| `capture-monitors.json` | 설정 | 연속 네트워크 모니터링 — 두 서버 간 캡처를 주기적으로 자동 실행해 이력에 기록하고, 경로 | ✅ |  | ✅ | net/monitor.js |
| `central-agent-config.json` | 설정 | 엣지 포탈(에이전트) 설정 저장소 — 에이전트가 push한 자기 CONFIG_DIR 설정을 보관한다. | ✅ |  | ✅ | central/agentConfig.js |
| `central-agent-gpu-guest.json` | 설정 | 중앙에서 지정하는 'agent(엣지)별 GPU 게스트 수집 설정' 저장소. | ✅ | ✅ | ✅ | central/agentGpuGuestConfig.js |
| `central-agent-sanswitch.json` | 설정 | 엣지들이 push 한 SAN 스위치 스냅샷의 중앙 보관(v2.410). | ✅ |  | ✅ | central/sanSwitchEdge.js |
| `central-agent-storage.json` | 설정 | 엣지들이 push 한 스토리지 스냅샷의 중앙 보관(v2.302). | ✅ |  | ✅ | central/storageEdge.js |
| `central-agent-tokens.json` | 설정 | 엣지 에이전트별 개별 토큰 | ✅ |  | ✅ | central/agentTokens.js |
| `central-agent-users.json` | 설정 | 중앙에서 지정하는 'agent(엣지)별 배포 사용자' 저장소. | ✅ | ✅ | ✅ | central/agentUsers.js |
| `central-fleet.json` | 설정 | 엣지 베어메탈 집계 — 중앙(OC2) 측 캐시. |  |  | ✅ | central/fleet.js |
| `central-inventory.json` | 설정 | 위임 사이트가 push 한 인벤토리 캐시 | ✅ |  | ✅ | central/inventory.js |
| `central-pdu.json` | 설정 | 엣지가 push 한 PDU 스냅샷의 중앙 보관소(v2.424). | ✅ | ✅ | ✅ | central/pduEdge.js |
| `central-svcmon-assign.json` | 설정 | 성능점검 배정 — 중앙이 관리하는 '어느 엣지가 어느 대상을 점검하는가'. | ✅ | ✅ |  | central/svcmonAssign.js |
| `central-unsupported-servers.json` | 설정 | iDRAC 스캔이 발견한 **비-Dell(미지원) 서버**의 중앙 보관소(v2.495). | ✅ | ✅ | ✅ | central/unsupportedServers.js |
| `collectors.json` | 설정 | 원격 수집 서버(엣지) 목록과 토큰 | ✅ | ✅ | ✅ | collector/registry.js |
| `credentials-usage.json` | 설정 | 통합 계정 관리 저장소(v2.419) — RMA 가 엣지 망 안의 서버에 SSH 로 점검·명령을 실행할 때 쓰는 | ✅ | ✅ | ✅ | security/credentialStore.js |
| `credentials.json` | 설정 | 통합 계정(장비 SSH/API 자격증명) | ✅ | ✅ | ✅ | security/credentialStore.js |
| `daily-report.json` | 설정 | 일일 헬스체크 리포트 발송 스케줄러 — 매일 지정 시각(HH:MM)에 computeHealthReport 결과를 | ✅ |  | ✅ | reports/dailyReport.js |
| `datacenters.json` | 설정 | DataCenter(법인) 레지스트리 — vCenter의 '상위 개념'. | ✅ |  |  | datacenter/store.js |
| `db-location.json` | 설정 | 시계열 DB 저장 경로(dbDir) |  |  |  | insights/dbLocation.js |
| `dirusage.db` | DB | 폴더 사용량 스캔 이력 DB (`dirusage.db`, v2.454). |  |  | ✅ | dirusage/db.js |
| `dirusage.json` | 설정 | 폴더 사용량 리포트 설정 (`dirusage.json`, v2.454). | ✅ | ✅ | ✅ | dirusage/settings.js |
| `download` | 디렉터리 | iDRAC-scan collector agent auto-deploy. The central portal pushes its offline |  |  | ✅ | agent/deploy.js |
| `emergency-stop.json` | 설정 | 긴급중단(Emergency Stop) — 2인 승인(관리자 2명 OTP)으로만 켜고/끄는 전역 수집 정지 스위치. | ✅ | ✅ | ✅ | security/emergencyStop.js |
| `finops.json` | 설정 | FinOps — 전력 수집(iDRAC/OME/원격) 데이터를 kWh·전기요금·CO2로 환산해 vCenter/지역별로 | ✅ |  |  | insights/finops.js |
| `fleet-assign.json` | 설정 | 통합 서버 인벤토리 — 베어메탈/물리 서버의 '소속 법인(vCenter)' 수동 등록 저장. | ✅ |  |  | insights/fleetAssign.js |
| `fleet-tags.json` | 설정 | 통합 서버 인벤토리 — 수동 분류 예외(override) 저장. | ✅ |  |  | insights/fleetTags.js |
| `gpu-guest.json` | 설정 | GPU 게스트 수집 설정 — 어떤 법인(vCenter)의 패스쓰루 GPU VM을 게스트 OS 계정으로 | ✅ | ✅ | ✅ | gpu/settings.js |
| `gpu-physical.json` | 설정 | 물리(베어메탈) GPU 서버 등록부 — 가상화하지 않은 서버를 IP+계정으로 등록해 SSH(nvidia-smi)로 | ✅ | ✅ | ✅ | gpu/physicalRegistry.js |
| `guest-disk.db` | DB | 게스트 디스크 회수 리포트 시계열 DB(v2.459). |  |  |  | guestdisk/db.js |
| `guest-disk.json` | 설정 | 게스트 디스크 회수 리포트 설정 (`guest-disk.json`, v2.459). | ✅ | ✅ | ✅ | guestdisk/settings.js |
| `guest-scans.json` | 설정 | 게스트 조사 스케줄러 — 사용자가 지정한 주기로 게스트 OS를 조사해 기록·저장한다. | ✅ |  | ✅ | security/guestScanScheduler.js |
| `horizon.json` | 설정 | Horizon Connection Server 연동 — 라이선스 만료일 확인 전용(가벼운 통합). | ✅ | ✅ | ✅ | horizon/horizon.js |
| `host-access.json` | 설정 | 호스트 접근 제어 설정(`host-access.json`, v2.485). | ✅ | ✅ | ✅ | hostaccess/settings.js |
| `host-temp.db` | DB | 지표 시계열(온도·GPU·데이터스토어·포탈 메모리) — 이름과 달리 범용 DB |  |  |  | config.js |
| `idrac-inventory.json` | 설정 | Cache of the latest hardware/firmware inventory collected per iDRAC server. |  |  | ✅ | idrac/invCache.js |
| `idrac-power.db` | DB | 서버 소비전력 시계열 + 시간당 롤업(power_hourly) |  |  |  | config.js |
| `idrac-scan-log.json` | 설정 | iDRAC 스캔 실행 로그 — 주기/수동 스캔의 법인(DataCenter)별 실행 결과를 영속 저장한다. | ✅ |  | ✅ | idrac/scanLog.js |
| `idrac-scan-ranges.json` | 설정 | 법인(DataCenter)별 iDRAC 스캔 대역 저장소 — 각 법인에 귀속된 iDRAC IP 대역과 그 대역 스캔에 | ✅ | ✅ | ✅ | idrac/scanRanges.js |
| `idrac-scan-settings.json` | 설정 | iDRAC 자동 발견 폴러 — vCenter별로 저장된 IP 대역을 주기적으로 스캔해 Dell iDRAC을 | ✅ | ✅ | ✅ | idrac/scanPoller.js |
| `idrac.json` | 설정 | iDRAC registry — the managed list of Dell servers whose power draw we collect | ✅ | ✅ | ✅ | idrac/registry.js |
| `initial-admin-password.txt` | 텍스트 | 최초 기동 시 생성된 관리자 임시 비밀번호 | ✅ | ✅ | ✅ | auth/auth.js |
| `ipam-annotations.json` | 설정 | Per-IP user annotations (custom memo + tags) for the IP ledger. These are | ✅ |  |  | ipam/annotations.js |
| `ipam-overrides.json` | 설정 | Per-IP 수동 관리(override) 저장소 — vCenter/스캔으로 자동 발견되는 정보와 별개로, | ✅ |  | ✅ | ipam/overrides.js |
| `ipam-range-policies.json` | 설정 | 대역(subnet/range) 단위 IP 정책 저장소 — IP 단위 override(overrides.js)와 '평행'한 | ✅ |  | ✅ | ipam/rangePolicies.js |
| `ipam-scan-agents.json` | 설정 | IP 스캔 설정(에이전트별) + 결과 저장소. | ✅ |  | ✅ | ipam/scanStore.js |
| `ipam-scan-history.json` | 설정 | IP 스캔 설정(에이전트별) + 결과 저장소. | ✅ |  | ✅ | ipam/scanStore.js |
| `ipam-scan-results.json` | 설정 | IP 스캔 설정(에이전트별) + 결과 저장소. | ✅ |  | ✅ | ipam/scanStore.js |
| `ipam-scan-runs.json` | 설정 | IP 스캔 설정(에이전트별) + 결과 저장소. | ✅ |  | ✅ | ipam/scanStore.js |
| `ipam-scan.json` | 설정 | IP 스캔 설정(에이전트별) + 결과 저장소. | ✅ |  | ✅ | ipam/scanStore.js |
| `ipam-settings.json` | 설정 | IPMS settings — IP ranges to hide from the IP ledger. Supports a global | ✅ |  |  | ipam/settings.js |
| `ipam-vcenter-ranges.json` | 설정 | vCenter별 IP 스캔 대역 저장소 — 각 vCenter(법인/사이트)에 귀속된 스캔 대역을 저장하고, | ✅ |  | ✅ | ipam/rangeStore.js |
| `ipam.db` | DB | IPAM IP 관리대장(외부 프로그램이 직접 읽는 공유 파일) |  |  |  | config.js |
| `llm.json` | 설정 | Local LLM (Ollama) settings for natural-language search. Stored in | ✅ | ✅ | ✅ | llm/config.js |
| `login-fails.ndjson` | 로그(NDJSON) | 로그인 실패 저장소(분석용) — 포탈 자체 실패 + 게스트 OS 조사 결과를 적재한다. |  |  | ✅ | security/loginStore.js |
| `login-monitor.json` | 설정 | 로그인 실패 주기 모니터 — 일정 주기로 로그인 실패를 분석하고, 브루트포스(임계 이상 반복) 의심이 | ✅ |  | ✅ | security/loginMonitor.js |
| `login-policy-users.txt` | 텍스트 | 세션 보안 설정 — 유휴 자동 로그아웃(분) 등. CONFIG_DIR/security-session.json. | ✅ | ✅ | ✅ | security/securitySettings.js |
| `mail.json` | 설정 | 포탈 공용 메일(SMTP) 설정 (`mail.json`, v2.454). | ✅ | ✅ | ✅ | mail/settings.js |
| `metrics.json` | 설정 | Runtime-editable metrics sampler settings (온도/용량/GPU 수집 주기·보존기간). | ✅ | ✅ | ✅ | metrics/settings.js |
| `net-issues-state.json` | 설정 | 게스트 네트워크 이슈 저장소 — 스캔마다 직전 카운터와 비교해 '증가분(델타)'을 산출하고, |  |  | ✅ | security/netIssueStore.js |
| `net-issues.ndjson` | 로그(NDJSON) | 게스트 네트워크 이슈 저장소 — 스캔마다 직전 카운터와 비교해 '증가분(델타)'을 산출하고, |  |  | ✅ | security/netIssueStore.js |
| `nfs-mounts.json` | 설정 | Edge 노드 NFS 마운트 관리(v2.299). | ✅ | ✅ | ✅ | system/nfsMounts.js |
| `nsx.json` | 설정 | NSX Manager registry — read/write the managed list in CONFIG_DIR/nsx.json, | ✅ | ✅ | ✅ | nsx/registry.js |
| `os-inventory.json` | 설정 | 실제 OS 인벤토리 저장소(별도 DB) — VM별 1행, vmId 키로 upsert. |  |  | ✅ | inventory/osStore.js |
| `os-scan.json` | 설정 | 실제 OS 인벤토리 스캐너 — 주기적으로 'DB에 없는(또는 오래된) VM'을 찾아 게스트에서 실제 OS를 읽어 저장. | ✅ |  | ✅ | inventory/osScanner.js |
| `packages` | 디렉터리 | 디렉터리 — 내려받은 설치/업그레이드 패키지 보관(PACKAGE_DIR) |  |  |  | config.js |
| `packages.json` | 설정 | Web-editable package source settings — lets an admin change the package | ✅ |  | ✅ | upgrade/packageSettings.js |
| `pdu-devices.json` | 설정 | PDU(APC Rack PDU 2G) 장비 등록 — `CONFIG_DIR/pdu-devices.json`(0600). | ✅ | ✅ | ✅ | pdu/registry.js |
| `pdu-intervals.json` | 설정 | PDU 수집 주기(사용자 요구: '수집 시간은 설정에서 지정'). | ✅ | ✅ | ✅ | pdu/intervals.js |
| `pdu-thresholds.json` | 설정 | PDU 임계치 판정 + 알림 연동(v2.425). | ✅ | ✅ | ✅ | pdu/thresholds.js |
| `pdu.db` | DB | PDU 전력 시계열 |  |  | ✅ | pdu/db.js |
| `permissions.json` | 설정 | 역할별 권한 매트릭스 + 도구별 접근 거부 | ✅ | ✅ | ✅ | auth/permissions.js |
| `ping-monitor.db` | DB | 핑 모니터 응답시간·손실 시계열 |  |  |  | config.js |
| `ping-targets.json` | 설정 | Ping 모니터링 대상 레지스트리 — CONFIG_DIR/ping-targets.json. | ✅ |  |  | ping/store.js |
| `portal.env` | 기타 | 환경변수(설치본이 읽는 유일한 설정 파일) |  |  |  | security/secretScan.js |
| `power-off-check.json` | 설정 | 전원 꺼짐 점검 설정(`power-off-check.json`, v2.484, 사용자 요청 "몇 시간마다 점검하는지 설정"). | ✅ | ✅ | ✅ | tools/powerOffSettings.js |
| `power-settings.json` | 설정 | 전력 집계 표시 설정 — CONFIG_DIR/power-settings.json. | ✅ |  | ✅ | idrac/powerSettings.js |
| `provision-saved.json` | 설정 | Saved VM-provisioning jobs — every created job's spec is persisted so it can | ✅ |  | ✅ | provision/saved.js |
| `relay-topology.json` | 설정 | 중계(HAProxy) 토폴로지 정의 | ✅ | ✅ | ✅ | relaytopo/store.js |
| `relaycheck-settings.json` | 설정 | HAProxy 경로 점검 설정(v2.429, 사용자 요구 '특수기능에 haproxy 설정을 주기적으로 점검해서 알람으로 알려주고 | ✅ | ✅ | ✅ | relaycheck/settings.js |
| `release-notes.json` | 설정 | Release notes: a built-in changelog (server/src/release-notes.json, shipped | ✅ | ✅ | ✅ | release-notes.js |
| `remote-access.json` | 설정 | Remote-access configuration + mapping store (CONFIG_DIR/remote-access.json). | ✅ | ✅ | ✅ | proxy/registry.js |
| `rma-agents.json` | 설정 | 중앙 측 RMA 에이전트 비밀번호 저장소 — `rma-agents.json` { version, agents: { name: { password, updatedAt } } }. | ✅ | ✅ | ✅ | rma/agentSecrets.js |
| `rma-history.db` | DB | 원격 명령(RMA) 실행 이력 |  |  | ✅ | rma/historyDb.js |
| `rma-schedules.json` | 설정 | RMA 점검 스케줄(중앙, v2.418) — `rma-schedules.json` { version, agents: { name: { version, tests: [...] } } }. | ✅ | ✅ | ✅ | rma/schedules.js |
| `rma-settings.json` | 설정 | RMA 분배 설정(중앙) — `rma-settings.json` { version, defaultMode, agents: { name: { mode, primary } } }. | ✅ | ✅ | ✅ | rma/settings.js |
| `rma-tests.db` | DB | 원격 점검(RMA) 결과 이력 |  |  | ✅ | rma/testResults.js |
| `runtime.json` | 설정 | Runtime-adjustable settings that can be changed from the portal UI (and | ✅ |  | ✅ | runtime-settings.js |
| `sanswitch-devices.json` | 설정 | SAN 스위치 등록부(v2.410). | ✅ | ✅ | ✅ | sanswitch/registry.js |
| `sanswitch-latest.json` | 설정 | 이 노드가 수집한 최신 스냅샷 보관(v2.410, storage/store.js 와 동일 철학). | ✅ |  | ✅ | sanswitch/store.js |
| `sanswitch-perf-push.json` | 설정 | 엣지 → 중앙 포트 사용량(portperfshow) 시계열 중계(v2.423, 사용자 요구 '연결은 됐는데 데이터 | ✅ |  | ✅ | sanswitch/perfPush.js |
| `sanswitch-perf-settings.json` | 설정 | 포트 사용량(portperfshow) 수집 설정(v2.411, 사용자 요구 | ✅ | ✅ | ✅ | sanswitch/perfSettings.js |
| `sanswitch-perf.db` | DB | SAN 스위치 포트 처리량(누적 카운터 델타) |  |  | ✅ | sanswitch/perfDb.js |
| `secrets-key` | 디렉터리 | 자격증명 봉인 키(암호화 모드) | ✅ | ✅ | ✅ | security/secretVault.js |
| `secrets-policy.json` | 설정 | 설정 파일 자격증명(비밀번호·SSH 키·토큰)의 저장 방식(평문/암호화) 중앙 모듈(v2.296). | ✅ | ✅ | ✅ | security/secretVault.js |
| `security-session.json` | 설정 | 세션 보안 설정 — 유휴 자동 로그아웃(분) 등. CONFIG_DIR/security-session.json. | ✅ | ✅ | ✅ | security/securitySettings.js |
| `settings-owners.txt` | 텍스트 | 설정 소유자 목록(백업·비밀 CSV 등 최상위 권한) | ✅ | ✅ | ✅ | security/securitySettings.js |
| `storage-activity.json` | 설정 | 스토리지 수집 '작업 로그'(v2.315, 사용자 요구 '진행중/완료 창'). | ✅ | ✅ | ✅ | storage/activityLog.js |
| `storage-devices.json` | 설정 | 스토리지 장비 등록부(v2.302). | ✅ | ✅ | ✅ | storage/registry.js |
| `storage-history.db` | DB | 스토리지 장비(8종) 용량 이력 |  |  | ✅ | storage/db.js |
| `storage-intervals.json` | 설정 | 스토리지 수집 주기(중앙에서 엣지 설정, v2.409). | ✅ | ✅ | ✅ | storage/intervals.js |
| `storage-latest.json` | 설정 | 이 노드가 수집한 최신 스냅샷 보관(v2.302). | ✅ | ✅ | ✅ | storage/store.js |
| `svcmon-batches.json` | 설정 | 성능점검 대량 등록/가져오기 **이력 원장**(+ 롤백) — `CONFIG_DIR/svcmon-batches.json`. | ✅ | ✅ |  | svcmon/batches.js |
| `svcmon-log.json` | 설정 | 성능점검 로그 설정 — CSV 적재/분할/보관 정책. `CONFIG_DIR/svcmon-log.json`. | ✅ | ✅ |  | svcmon/logsettings.js |
| `svcmon-templates.json` | 설정 | 성능점검 '점검 템플릿' — 서비스 유형별 점검 묶음을 저장하고 대상에 적용한다. | ✅ | ✅ |  | svcmon/templates.js |
| `svcmon.json` | 설정 | 성능점검 대상/폴더 저장소 — `CONFIG_DIR/svcmon.json` 전용 파일(포탈 코어와 분리). | ✅ | ✅ |  | svcmon/store.js |
| `tool-categories.json` | 설정 | 특수 기능 카테고리 설정 (`tool-categories.json`, v2.455). | ✅ | ✅ | ✅ | toolcats/settings.js |
| `tool-usage.json` | 설정 | 특수 기능 사용 빈도 집계 — "사람들이 자주 쓰는 메뉴"를 자동 추천하기 위한 카운터. | ✅ |  |  | tool-usage.js |
| `ui.json` | 설정 | Shared UI settings persisted server-side (CONFIG_DIR/ui.json) so layout | ✅ | ✅ | ✅ | ui-settings.js |
| `upgrade.json` | 설정 | Runtime-editable auto-upgrade settings. Env vars provide the defaults; values | ✅ |  | ✅ | upgrade/settings.js |
| `users.json` | 설정 | 포탈 계정(역할·비밀번호 해시·TOTP 시크릿) | ✅ | ✅ | ✅ | auth/auth.js |
| `vcenter-logs.db` | DB | vCenter 이벤트/태스크 로그 수집 캐시 |  |  | ✅ | logs/db.js |
| `vcenter-logs.json` | 설정 | vCenter 로그 보관 설정 — CONFIG_DIR/vcenter-logs.json. 보관 기간(retentionDays)을 여기서 지정. | ✅ |  | ✅ | logs/settings.js |
| `vcenter-order.json` | 설정 | vCenter display order — a user-defined ordering applied to every "vCenter | ✅ |  | ✅ | vcenter/order.js |
| `vcenters.json` | 설정 | vCenter 등록(주소·계정·수집 옵션) | ✅ | ✅ | ✅ | config.js, vcenter/registry.js |
| `vm-clone.json` | 설정 | VM 복제(백업식) 잡 저장소(v2.299). | ✅ | ✅ | ✅ | vmclone/store.js |
| `vm-track.db` | DB | VM 수량·데이터스토어 사용량 추이(변경분만 저장) |  |  | ✅ | vmtrack/db.js |
| `vmperf` | 디렉터리 | 디렉터리 — vCenter별 VM 성능 DB(+ _index.json 역산 매핑) |  |  | ✅ | metrics/vmperfDb.js |
| `vmperf.json` | 설정 | 낭비 리소스(VM 성능) 트래킹 설정 — 보존기간 + 대상 vCenter 선택(v2.376). | ✅ | ✅ | ✅ | metrics/vmperfSettings.js |
| `vmware-portal-release` | 디렉터리 | RedHat 계열의 /etc/redhat-release 처럼, CONFIG_DIR에 현재 포탈 버전을 한 줄로 명시하는 |  |  |  | util/releaseFile.js |

## 주의가 필요한 파일

- **`portal.env`** — ⚠ 지우면 인증 비밀·중앙 토큰이 사라져 로그인·수집이 전부 끊긴다. 백업 필수. 자세한 키는 docs/ENV.md
- **`auth-secret`** — ⚠ 바뀌면 전 사용자 세션 무효(재로그인). 유출 시 임의 계정 토큰 위조 가능 — 0600 유지
- **`users.json`** — ⚠ 지우면 관리자 계정이 사라진다. 기동 시 초기 관리자만 재생성
- **`secrets-key`** — ⚠ 지우면 저장된 모든 비밀번호를 복호할 수 없다(재입력 필요)
- **`credentials.json`** — 봉인 저장. API 응답에 값이 실리지 않는다
- **`settings-owners.txt`** — username 기준. 표시이름 승계 불가
- **`vcenters.json`** — ⚠ 지우면 수집 대상이 사라진다. v2.444 부터 예제 폴백 없음
- **`collectors.json`** — 중앙이 이 목록을 pull 한다
- **`agent-deploy-targets.json`** — 비밀 4종(centralToken·collectorToken 등) 포함 — 소유자만 CSV 내보내기
- **`central-inventory.json`** — 재시작 시 콜드스타트용. 지워도 다음 push 로 복구
- **`central-agent-tokens.json`** — ⚠ 지우면 엣지 push 가 전부 401
- **`audit.ndjson`** — 보안 자산 — 보존 정책에 따라 관리. AUDIT_MAX 로 상한
- **`alarm-mutes.json`** — v2.448 부터 원자적 쓰기 + 손상 보존
- **`permissions.json`** — v2.448 부터 서버가 도구 거부를 집행
- **`relay-topology.json`** — 노드 SSH 자격증명 포함 — host 변경 시 비밀 미이월
- **`db-location.json`** — 이 값이 가리키는 곳에 *.db 가 만들어진다
- **`vmperf`** — v2.448 부터 파일명에 해시 접미사(id 충돌 방지)
- **`packages`** — 에이전트 배포 설치본도 여기서 찾는다. 지워도 다시 내려받는다(폐쇄망은 PACKAGE_BASE_URL 로 LAN 미러 지정)
- **`initial-admin-password.txt`** — ⚠ 로그인 후 즉시 변경하고 이 파일을 삭제할 것
- **`host-temp.db`** — ⚠ 보통 가장 큰 파일(운영 실측 34.3GB). v2.451 부터 온도는 변화분만 저장한다(TEMP_RAW_RETENTION_DAYS·METRICS_DEADBAND_TEMP_C). 지우면 온도·GPU·용량예측 이력이 사라진다(현재값은 재수집)
- **`idrac-power.db`** — ⚠ 두 번째로 큰 파일(운영 실측 26.9GB). 지우면 전력 대시보드·FinOps(kWh·비용·CO2) 이력이 사라진다
- **`ping-monitor.db`** — 지워도 모니터는 계속 동작한다(이력만 사라짐)
- **`capacity.db`** — 지워도 현재 진단은 재수집된다(추이만 사라짐)
- **`vm-track.db`** — 슬롯 기반(하루 2회)이라 증가가 완만하다
- **`sanswitch-perf.db`** — 첫 수집·카운터 리셋은 값이 없다(null) — 0 으로 채우지 않는다
- **`rma-tests.db`** — 상태 변화 + 1시간 단위만 저장(diff-저장)
- **`ipam.db`** — ⚠ WAL 로 전환하지 말 것(외부 리더의 -wal/-shm 호환 미확인). **DB 경로 이관 대상에서도 제외**된다 — 외부 연동이 경로를 고정으로 알고 있기 때문
- **`vcenter-logs.db`** — 보존일수(설정 › vCenter 로그 보관)로 통제한다. 경로 이관 대상 아님

---

관련 문서: [환경변수 레퍼런스](ENV.md) · [설정 화면 안내](SETTINGS.md) · [설치](INSTALL.md)
