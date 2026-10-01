/**
 * 포탈 DB 인벤토리 — 포탈이 실제로 사용하는 모든 데이터 파일(SQLite DB · JSON 레지스트리 ·
 * ndjson 로그)의 경로·파일명·용도·현재 크기·증가 추이를 한 곳에서 보여준다.
 *
 * 설계 메모(운영 환경 고려):
 *  - 파일 stat은 동기지만 개수가 수십 개 수준(O(N))이라 폴링 루프를 블로킹하지 않는다.
 *  - 증가 추이는 프로세스 메모리의 경량 링버퍼에 주기 샘플을 적재한다(파일 미기록 → DB write 없음).
 *  - 하드코딩 목록에 없는 파일도 configDir 스캔으로 자동 포함해 "사용 중 모든 DB"를 빠짐없이 노출.
 */

import fs from 'node:fs';
import path from 'node:path';
import { config, clampIntervalMs } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt } from '../util/atomicWrite.js';
import { registerStateFile } from '../util/stateFiles.js';
import { dayIndex } from '../util/dayKey.js';
import { linregSlope } from '../util/linreg.js';

const CONFIG_DIR = config.configDir;
// 옮긴 DB 저장 경로(null = configDir 사용). db-location.json → config.dbDir (v2.379).
const DB_DIR = config.dbDir || null;

// 파일명 → 용도 설명. configDir 스캔 결과에 매칭해 사람이 읽을 설명을 붙인다.
const PURPOSES = {
  // ── SQLite 시계열/대장 ──────────────────────────────────────────────
  'host-temp.db': 'ESXi 호스트 온도 시계열(센서별, 최근 약 5년 보관)',
  'idrac-power.db': 'Dell iDRAC 서버 소비전력 시계열(샘플)',
  'ipam.db': 'IPAM IP 관리대장 — 센터별 IP 인벤토리(외부 공유용)',
  'vcenter-logs.db': 'vCenter 로그 수집 캐시',
  // ── JSON 레지스트리/설정 ────────────────────────────────────────────
  'vcenters.json': 'vCenter 등록 정보(호스트·계정·위치)',
  'vcenter-order.json': 'vCenter 화면 표시 순서',
  'users.json': '포탈 사용자/권한/TOTP(2FA) 자격',
  'auth.json': 'Active Directory(LDAP) 로그인 연동 설정(서버·도메인·그룹→역할 매핑) — 로컬 계정은 users.json',
  'idrac.json': 'iDRAC/OME 등록(서버·자격증명)',
  'gpu-guest.json': 'GPU 게스트(패스쓰루) 수집 설정/자격',
  'gpu-physical.json': '물리(베어메탈) 서버 GPU SSH 수집 등록',
  'agent-deploy-targets.json': '에이전트 배포 대상 목록',
  'remote-access.json': '원격 접속(HAProxy 중계) 매핑',
  'collectors.json': '분산 수집 에이전트(컬렉터) 등록',
  'central-inventory.json': '중앙이 수집한 사이트 인벤토리 캐시',
  'nsx.json': 'NSX Manager 등록부(주소·접속 계정 — 비밀 봉인, 0600)',
  'alerts.json': '알림(이메일/웹훅) 설정',
  'metrics.json': '지표 샘플링 설정',
  'emergency-stop.json': '긴급중단(수집 전체 정지) 상태 플래그',
  'security-session.json': '세션 보안 정책(만료·잠금)',
  'llm.json': '로컬 LLM(Ollama) 연결 설정',
  'packages.json': '업그레이드/설치 패키지 소스 설정',
  'os-scan.json': '실제 OS(게스트) 스캔 설정',
  'ipam-scan.json': 'IPAM 능동 스캔 설정',
  'ipam-scan-agents.json': 'IP 스캔 에이전트별 마지막 보고(시각·스캔 수·응답 수)',
  'ipam-scan-history.json': 'IPAM 스캔 이력',
  'ipam-scan-results.json': 'IPAM 스캔 결과(최근)',
  'ipam-scan-runs.json': 'IPAM 스캔 실행 기록',
  'backup.json': '구성 백업 스케줄 설정',
  'vcenter-logs.json': 'vCenter 로그 수집 설정',
  'capture-monitors.json': '네트워크 상시 모니터(캡처) 정의',
  'capture-history.json': '네트워크 트래픽 캡처 이력',
  'central-agent-tokens.json': '중앙↔에이전트 인증 토큰',
  'agent-assignments.json': 'iDRAC 위임 스캔 IP 배정',
  'agent-config.json': '현재 코드에서 쓰지 않는 파일(예전 버전이 남긴 것으로 추정 — 중앙의 엣지 설정 사본은 central-agent-config.json)',
  // ── ndjson 추가형 로그 ──────────────────────────────────────────────
  'audit.ndjson': '감사 로그 — 관리 작업 이력(추가형)',
  'login-fails.ndjson': '로그인 실패 기록(추가형)',
  'net-issues.ndjson': '네트워크 장애 탐지 로그(추가형)',
  'vcenter-logs.ndjson': 'vCenter 로그(파일 폴백, ndjson)',
  // ── v2.376~377 신규 ────────────────────────────────────────────────
  'vmperf.json': 'VM 성능 트래킹 설정(보존기간·대상 vCenter)',
  'vm-track.db': 'VM 수량·데이터스토어 사용량 추이(하루 2회 슬롯 스냅샷 + 변경분)',
  'capacity.db': '포탈 서버 자신의 리소스(CPU·메모리·디스크·네트워크) 샘플 — 리소스 적정성 진단용',
  'ping-monitor.db': '핑 모니터 응답/손실 시계열',
  'storage-history.db': '스토리지 장비(8종) 용량 이력',
  // ── v2.613 PERSIST2613-02: DB 위치 이전 대상(insights/dbLocation.js MIGRATABLE) 19개 중 13개가 여기 없어 '포탈 DB' 화면이
  //    용도 없이('SQLite 데이터베이스' 폴백) 나열했다. 테스트가 MIGRATABLE ⊆ PURPOSES 를 고정한다 — 새 DB 를 MIGRATABLE 에
  //    넣으면 여기에도 적어야 한다(한 줄 설명은 dbLocation 의 label 과 같은 뜻으로).
  'sanswitch-perf.db': 'SAN 스위치 포트 처리량 표본(포트별 초당 바이트 — 화면은 bps)·포트 연결 정보(v2.410)',
  'rma-history.db': '원격 명령(RMA) 실행 이력(v2.416)',
  'rma-tests.db': '원격 명령(RMA) 점검 결과(v2.418)',
  'dirusage.db': '폴더 사용량 리포트 이력(엣지 공유 폴더 Top-N)',
  'pdu.db': 'PDU 전력·온습도 이력(v2.424)',
  'guest-disk.db': '게스트 디스크 회수 리포트 추이(변경분 저장, v2.459)',
  'curuser.db': "'현재 사용자' 로그인 사용자 수 추이(v2.520)",
  'san-health.db': 'SAN 스위치 월간 점검 이력(최근 N회 비교, v2.522)',
  'horizon-sessions.db': 'Horizon 실시간 사용자(세션) 추이(v2.525)',
  'part-faults.db': '물리 파트(부품) 장애 이력 — 열림/변화/해소 전이만 적재(v2.547)',
  'bm-usage.db': '베어메탈 사용률(CPU·메모리·디스크·네트워크·HBA) 원시 90일 + 일 롤업(v2.550)',
  'link-check.db': '통신 점검 이력(중앙↔엣지·vCenter 링크 표본·이벤트·일 롤업, v2.552)',
  'cvp.db': 'Arista CloudVision(CVP) 네트워크 스위치 — 장비·포트 최신값·포트 사용량 이력(v2.608)',
  'log-analysis-stats.json': '로그 분석 누적 통계(로그 줄 종류별 개수 — 최근 7일, 시간 단위)',
  'portal-db-size-history.json': '포탈 DB 크기 표본(이 화면의 증가량·용량 예측용 — 10분 표본 + 일 표본 400일, v2.674)',
  'bmstor-history.db': '베어메탈 스토리지 디스크 사용량 12시간 이력 — 서버·그룹·합계(v2.635)',
  // ── v2.613 PERSIST2613-02: 신규 기능의 설정·등록부 JSON(화면에서 편집 — 백업 대상).
  'storage-devices.json': '스토리지 장비 등록부(호스트·계정·수집 방식·담당 엣지 — 비밀번호 봉인)',
  'sanswitch-devices.json': 'SAN 스위치 등록부(호스트·계정·담당 엣지 — 비밀번호 봉인)',
  'pdu-devices.json': 'PDU 등록부(호스트·SSH CLI 계정·담당 엣지 — 비밀 봉인)',
  'cvp-servers.json': 'Arista CloudVision(CVP) 서버 등록부(주소·토큰/계정·담당 엣지 — 비밀 봉인, v2.608)',
  'cvp-settings.json': 'CVP 수집 설정(켜짐·주기·보존일·동시성·장비 시한, v2.608)',
  'bm-storage.json': '베어메탈 스토리지 서버 등록부 + 수집 주기(마운트 경로·SSH 계정 — 비밀 봉인, v2.340)',
  'horizon.json': 'Horizon 커넥션 서버 등록(주소·계정 — 비밀 봉인)',
  'horizon-sessions.json': 'Horizon 실시간 사용자(세션) 수집 설정(켜짐·주기·보존일·페이지 상한, v2.525)',
  'curuser-settings.json': "'현재 사용자' 수집 설정(대상 폴더·주기·보존일·신선도 배수, v2.520)",
  'bmusage-settings.json': '베어메탈 사용률 수집 설정(법인별 켜짐·주기·보존일·임계 알림·Enterprise 동의, v2.550)',
  'bmusage-distribute.json': '베어메탈 사용률 설정의 엣지 배포(켬·제외 엣지, 중앙 — v2.627)',
  'bmusage-central.json': '엣지가 받은 베어메탈 사용률 설정 중앙 배포 사본(상태 — 원본은 중앙, v2.627)',
  'linkcheck-settings.json': '통신 점검 설정(켜짐·주기·단계별 시한·엣지 짝·보존일, v2.552)',
  'partfault-settings.json': '물리 파트 장애 기능 스위치(중앙·엣지별) + 이력 보존일(v2.548 · v2.613)',
  'storage-intervals.json': '스토리지 수집 주기 중앙 배포값(엣지별 지정 키만, v2.409)',
  // ── v2.613 PERSIST2613-02: 백업이 '상태·캐시' 로 분류하는 파일(backup/service.js RUNTIME_STATE_NAMES) 전부에 용도를 적는다 —
  //    테스트가 그 목록 ⊆ PURPOSES 를 고정한다. 폴러·엣지 push 가 스스로 다시 쓰는 파일이라 편집 대상이 아니다.
  'central-agent-config.json': '엣지가 push 한 자기 설정 사본(중앙 백업 번들에 포함 — 비밀은 엣지가 REDACTED 로 보낸다)',
  'central-fleet.json': '엣지가 push 한 베어메탈(fleet) 집계 캐시(TTL 30분)',
  'central-pdu.json': '엣지가 push 한 PDU 스냅샷 캐시',
  'central-agent-storage.json': '엣지가 push 한 스토리지 장비 스냅샷 캐시',
  'central-agent-sanswitch.json': '엣지가 push 한 SAN 스위치 스냅샷 캐시',
  'central-agent-sanswitch-perf.json': '엣지가 push 한 SAN 스위치 포트 사용량 상태(엣지별 마지막 push·표본 수)',
  'central-agent-gpu-guest.json': '중앙이 엣지별로 배포하는 GPU 게스트 수집 설정 사본(엣지가 pull — 비밀번호 포함 0600)',
  'central-agent-cvp.json': '엣지가 push 한 CVP 수집 상태 캐시(엣지별 마지막 push·장비 수·오류, v2.608)',
  'central-unsupported-servers.json': 'iDRAC 스캔이 찾은 비-Dell(미지원) 서버 보관소(위임 스캔 결과 포함, v2.495)',
  'agent-results.json': '에이전트(엣지) 위임 iDRAC 스캔 결과 보관소',
  'active-sessions.json': "'단일 세션 강제(ID 공유 금지)' 용 계정별 마지막 로그인 세션 ID(손상이면 재로그인)",
  'sanswitch-perf-push.json': '엣지 SAN 포트 사용량 push 커서(마지막으로 보낸 rowid)',
  'cvp-push.json': '엣지 CVP 포트 사용량 push 커서(마지막으로 보낸 rowid, v2.608)',
};
/** v2.613 PERSIST2613-02: 카탈로그 대조 테스트용 — MIGRATABLE·RUNTIME_STATE_NAMES 가 전부 설명을 갖는지 본다. */
export { PURPOSES };

/**
 * DB 상세 설명(v2.378) — "이 DB 가 정확히 무엇을 보관하는가"를 운영자가 판단할 수 있게 쓴다.
 * keeps: 보관 내용 · writer: 누가 쓰는지 · retention: 보존 정책 · note: 주의/삭제 가능성.
 * 여기 없는 파일은 PURPOSES 한 줄 설명으로 폴백한다(하드코딩 목록에 없어도 화면에 나온다).
 */
const DETAILS = {
  'host-temp.db': {
    keeps: 'ESXi 호스트 온도(temp_host)·클러스터/vCenter 평균(temp_cluster·temp_vc), GPU 사용률(gpu_util·gpu_cluster·gpu_vc), 데이터스토어 사용량(ds_usedgb), 포탈 자체 프로세스 메모리(mem_*) 시계열. 원본 samples 와 시간당 롤업 samples_hourly 두 테이블을 함께 유지한다.',
    writer: 'metrics 샘플러(기본 1분 주기) — 설정 › 지표 수집에서 주기·보존 변경 가능',
    retention: '설정값(기본 약 5년/1830일). 매 20틱마다 1회 prune(ts < 기준) + 롤업 동시 정리',
    note: '이름은 host-temp 지만 실제로는 포탈의 범용 시계열 DB 다(온도·GPU·DS·메모리 공용). 삭제하면 온도/GPU/용량예측 히스토리가 사라진다(현재값은 재수집됨).',
  },
  'idrac-power.db': {
    keeps: 'Dell iDRAC/OME 서버의 소비전력 샘플(서버별 W)과 시간당 롤업(power_hourly). 전력 대시보드·FinOps(kWh·비용·CO2) 계산의 원천.',
    writer: 'iDRAC 폴러(등록 서버 대상, 기본 30초~분 단위)',
    retention: '기본 90일(IDRAC_RETENTION_DAYS). 10틱마다 prune',
    note: '최신값은 인메모리 캐시(withLatestCache)로 O(1) 조회한다 — getDb() 래퍼를 우회한 직접 쓰기는 캐시를 낡게 만든다.',
  },
  'ipam.db': {
    keeps: 'IPAM IP 관리대장 — 센터/vCenter별 IP 인벤토리(IP·호스트명·소유·상태·관측 시각). 포탈 스냅샷에서 파생한 원장을 그대로 반영(syncLedger).',
    writer: 'store.refresh 후 IPAM 동기화(쓰기는 워커 스레드 ipam/writeWorker.js)',
    retention: '원장 성격 — 시간 기반 prune 없음(현재 인벤토리를 반영해 전량 갱신)',
    note: '⚠ 외부 프로그램이 직접 읽는 공유 파일이라 WAL 로 바꾸지 않는다(저널 기본 유지). 삭제하면 외부 연동이 끊긴다.',
  },
  'vcenter-logs.db': {
    keeps: 'vCenter 이벤트/태스크 로그 수집 캐시(시각·vCenter·심각도·유형·사용자·대상·메시지).',
    writer: '로그 폴러(설정 › 로그 수집 주기)',
    retention: '설정값(로그 화면에서 보존일수 지정, 0=무제한)',
    note: '검색·CSV 내보내기의 원천. 용량이 가장 빠르게 늘 수 있는 DB — 보존일수로 통제한다.',
  },
  'vm-track.db': {
    keeps: 'VM 수량 추이 스냅샷(snaps: 슬롯·vCenter별 총 VM 수·증감 요약), 증감 상세(changes: 생성/삭제/전원변경 VM), 데이터스토어 변경(ds_changes)·시계열(ds_series, 변경분만)·로스터(roster·ds_roster).',
    writer: 'vmtrack 폴러(하루 2회 슬롯 00시·12시 + 수동 스냅샷)',
    retention: 'prune 용 ts 인덱스 유지 — 슬롯 기반이라 증가가 완만',
    note: '전량 로스터를 매 슬롯 적재하지 않고 변경분만 저장한다(5,850 VM·1,100 DS 규모에서 연 수백만 행을 피하기 위함).',
  },
  'capacity.db': {
    keeps: '포탈이 설치된 서버 자신(중앙·엣지)의 CPU·메모리·디스크·네트워크 사용량 샘플 — 리소스 적정성 진단용(vCenter 클러스터 용량과는 무관).',
    writer: 'capacity 샘플러(기본 30초)',
    retention: '설정값',
    note: '',
  },
  'ping-monitor.db': {
    keeps: '핑 모니터 대상별 응답시간(RTT)·손실률 시계열.',
    writer: 'ping 모니터 폴러',
    retention: '기본 365일(PING_MON_RETENTION_DAYS)',
    note: '',
  },
  'storage-history.db': {
    keeps: '외부 스토리지 장비(PowerScale/PowerStore/Unity/XtremIO/PowerMax/VPLEX 등) 용량·사용량 이력.',
    writer: '스토리지 모니터링 폴러(엣지 위임 수집 결과 포함)',
    retention: '설정값',
    note: '',
  },
  'users.json': {
    keeps: '포탈 로컬 계정(사용자명·역할·권한·데이터 범위·TOTP 시크릿·비밀번호 해시).',
    writer: '사용자 관리 화면(원자적 쓰기 + 손상 보존)',
    retention: '영구(계정 데이터)',
    note: '⚠ 크라운주얼 — TOTP 시크릿과 해시가 들어 있다. 백업 아카이브에도 포함되므로 소유자 경계로 보호된다.',
  },
  'vcenters.json': {
    keeps: 'vCenter 등록 정보(id·이름·호스트 URL·계정/암호·위치·수집 모드).',
    writer: '설정 › vCenter 관리(원자적 쓰기 + 손상 보존)',
    retention: '영구(구성 데이터)',
    note: '⚠ 자격증명 포함. 손상 시 .corrupt.<ts> 로 보존 후 빈 값 반환(다음 저장이 원본을 소거하지 않게).',
  },
  'audit.ndjson': {
    keeps: '감사 로그 — 누가·언제·무엇을 변경했는지(추가형 append-only).',
    writer: 'logAudit() — 관리 작업 라우트 전반',
    retention: '추가형 — 최신 AUDIT_MAX(기본 2만) 줄만 남기고 앞쪽은 지운다',
    note: '보안 사고 조사의 근거라 임의 삭제/편집 금지.',
  },
};

/** 파일별 상세 설명(없으면 null). */
export function detailFor(name) {
  return DETAILS[name] || null;
}

function typeOf(name) {
  if (/\.db$/i.test(name)) return 'sqlite';
  if (/\.ndjson$/i.test(name)) return 'ndjson';
  if (/\.json$/i.test(name)) return 'json';
  return 'file';
}

function purposeOf(name) {
  if (PURPOSES[name]) return PURPOSES[name];
  const t = typeOf(name);
  if (t === 'sqlite') return 'SQLite 데이터베이스';
  if (t === 'ndjson') return '추가형 로그(ndjson)';
  if (t === 'json') return 'JSON 설정/데이터';
  return '데이터 파일';
}

// SQLite는 -wal/-shm 사이드카가 생길 수 있다. 본 .db 크기에 합산해 한 줄로 보여준다.
function sqliteTotalSize(dbAbsPath) {
  let total = 0;
  let found = false;
  for (const suffix of ['', '-wal', '-shm']) {
    try { total += fs.statSync(dbAbsPath + suffix).size; found = true; } catch { /* 없음 */ }
  }
  return found ? total : null;
}

/** configDir(및 설정상 외부 경로 DB)의 사용 중 데이터 파일을 enumerate. 템플릿(*.example.json) 제외. */
export function enumerateDbFiles() {
  const seen = new Map(); // absPath -> entry

  const add = (absPath) => {
    const abs = path.resolve(absPath);
    if (seen.has(abs)) return;
    const name = path.basename(abs);
    if (/\.example\.json$/i.test(name)) return;             // 번들 템플릿은 사용 중 데이터 아님
    if (/-(wal|shm)$/i.test(name)) return;                  // SQLite 사이드카는 본 .db에 합산
    const type = typeOf(name);
    let sizeBytes = null; let exists = false; let mtime = null;
    try {
      const st = fs.statSync(abs);
      if (st.isDirectory()) return;
      exists = true; mtime = st.mtimeMs;
      sizeBytes = type === 'sqlite' ? (sqliteTotalSize(abs) ?? st.size) : st.size;
    } catch { /* 미존재(아직 생성 전) */ }
    seen.set(abs, { file: name, dir: path.dirname(abs), path: abs, type, purpose: purposeOf(name), exists, sizeBytes, mtime });
  };

  // 1) configDir 안의 모든 데이터 파일 스캔
  try {
    for (const name of fs.readdirSync(CONFIG_DIR)) {
      if (/\.(db|json|ndjson)$/i.test(name)) add(path.join(CONFIG_DIR, name));
    }
  } catch { /* configDir 없음 */ }

  // 1-b) DB 저장 경로를 옮겼으면(v2.379 db-location.json) 그 디렉터리도 스캔한다(v2.451 수정).
  // 예전에는 configDir 만 봐서, 마이그레이션 후 ping-monitor·capacity·vm-track·storage-history·
  // sanswitch-perf·rma-*·pdu·vmperf 가 이 화면에서 통째로 사라졌다. 마이그레이션 README 가
  // "완료 후 이 화면에서 경로·용량을 확인하세요" 라고 안내하는데 정작 확인이 불가능했다.
  if (DB_DIR && path.resolve(DB_DIR) !== path.resolve(CONFIG_DIR)) {
    try {
      for (const name of fs.readdirSync(DB_DIR)) {
        const abs = path.join(DB_DIR, name);
        if (/\.(db|json|ndjson)$/i.test(name)) { add(abs); continue; }
        // vmperf/ 처럼 vCenter별 DB 가 들어가는 하위 디렉터리도 한 단계 훑는다.
        try {
          if (fs.statSync(abs).isDirectory()) {
            for (const sub of fs.readdirSync(abs)) if (/\.db$/i.test(sub)) add(path.join(abs, sub));
          }
        } catch { /* 접근 불가 — 무시 */ }
      }
    } catch { /* dbDir 없음/권한 없음 */ }
  }

  // 2) 설정상 명시된 DB 경로(외부로 override 가능) — 누락 방지 위해 명시 추가.
  // v2.451: 개별 *_DB_PATH env 로 완전히 다른 위치를 가리킬 수 있는 것들을 전부 넣는다
  // (예전에는 temp·idrac·ipam 3개뿐이라 나머지가 목록에서 빠졌다).
  for (const p of [config.temp?.dbPath, config.idrac?.dbPath, config.ipam?.dbPath,
    config.ping?.dbPath, config.capacity?.dbPath]) {
    if (p) add(p);
  }

  // 정렬: 존재 + 큰 것 우선, 그다음 type, 파일명
  return [...seen.values()].sort((a, b) =>
    (b.exists - a.exists) || ((b.sizeBytes || 0) - (a.sizeBytes || 0)) || a.file.localeCompare(b.file));
}

// ── 증가 추이 샘플러 ─────────────────────────────────────────────────────
// v2.674(사용자 신고 "1개월·6개월·1년 후가 안 나온다"): 예전에는 표본이 **프로세스 메모리에만** 있어 재시작(업그레이드)
//   마다 사라졌고, 관측이 1시간을 넘기 전에는 예측이 비었다. 업그레이드가 잦은 운영에서는 거의 늘 비어 있었다.
//   그리고 30분 표본(4점)의 기울기를 365배 늘려 '+4.1 GB/일' 같은 값을 냈다(WAL 이 커졌다 줄었다 하는 것까지 증가로 읽는다).
//   이제 ① 표본을 파일(portal-db-size-history.json — 상태 파일)에 남겨 재시작해도 이어 가고 ② 한국 시각 하루마다 마지막
//   표본 하나를 일 표본으로 400일 보관해 ③ 일 표본이 2일 이상 쌓이면 **최근 30일 일 표본의 최소제곱 기울기**로 예측한다.
const HISTORY = new Map();          // absPath -> [{ at, bytes }]  최근 표본(10분 간격)
const DAILY = new Map();            // absPath -> [{ at, bytes, day }]  하루 마지막 표본(한국 시각 기준)
const MAX_SAMPLES = 300;            // 파일당 보관 샘플 수(예: 10분 간격 ≈ 50시간)
const MAX_DAILY = 400;              // 일 표본 보관 일수
const DAILY_FIT_DAYS = 30;          // 예측 기울기에 쓰는 최근 일수
const DAY_MS = 86_400_000;
const MIN_DAILY_SPAN_MS = 2 * DAY_MS; // 일 표본 기울기는 2일 이상일 때만
const SHRINK_RESET_RATIO = 0.8;     // 이보다 크게 줄면 그 앞 표본은 기울기에서 뺀다
// v2.605(감사 TIM2605-04): 음수·2^31 초과 값은 setInterval 이 1ms 루프가 된다(재현: -5 → 1초에 statSync 4,405회) — 주기 헬퍼로 가둔다.
const SAMPLE_INTERVAL_MS = clampIntervalMs(Number(process.env.PORTAL_DB_SAMPLE_MS) || 10 * 60_000, 10 * 60_000, 10_000);
const HISTORY_FILE_NAME = registerStateFile('portal-db-size-history.json');
const historyFile = () => path.join(CONFIG_DIR, HISTORY_FILE_NAME);

let _loaded = false;
/** 저장된 표본을 읽는다(1회). 손상이면 .corrupt 로 보존하고 빈 상태로 시작한다 — 지난 표본은 다시 만들 수 없다. */
function loadHistory(now = Date.now()) {
  if (_loaded) return;
  _loaded = true;
  let raw;
  try { raw = JSON.parse(fs.readFileSync(historyFile(), 'utf8')); } catch (e) {
    if (e?.code !== 'ENOENT') { console.warn(`[portal-db] 크기 표본 파일을 읽지 못했습니다(${e.message}) — 새로 시작합니다`); preserveCorrupt(historyFile(), e.message); }
    return;
  }
  const take = (obj, map, maxAge, max) => {
    if (!obj || typeof obj !== 'object') return;
    for (const [p, arr] of Object.entries(obj)) {
      if (!Array.isArray(arr)) continue;
      const pts = arr.filter((x) => Array.isArray(x) && Number.isFinite(x[0]) && Number.isFinite(x[1]) && x[1] >= 0 && x[0] <= now + 60_000 && now - x[0] <= maxAge)
        .map(([at, bytes]) => ({ at, bytes, day: dayIndex(at) }))
        .sort((a, b) => a.at - b.at).slice(-max);
      if (pts.length) map.set(p, pts);
    }
  };
  take(raw?.recent, HISTORY, MAX_SAMPLES * SAMPLE_INTERVAL_MS * 2, MAX_SAMPLES);
  take(raw?.daily, DAILY, MAX_DAILY * DAY_MS, MAX_DAILY);
}

function saveHistory() {
  const pack = (map) => Object.fromEntries([...map].map(([p, arr]) => [p, arr.map((x) => [x.at, x.bytes])]));
  try { atomicWriteFileSync(historyFile(), JSON.stringify({ v: 1, recent: pack(HISTORY), daily: pack(DAILY) })); } catch (e) {
    console.warn(`[portal-db] 크기 표본을 저장하지 못했습니다: ${e.message}`);
  }
}

/** 현재 크기를 1회 샘플링해 적재(최근 표본 + 그날의 일 표본 갱신) 후 파일에 남긴다. */
export function recordDbSizeSample(now = Date.now(), { persist = true } = {}) {
  loadHistory(now);
  const day = dayIndex(now);
  for (const f of enumerateDbFiles()) {
    if (!f.exists) continue;
    const pt = { at: now, bytes: f.sizeBytes || 0, day };
    let arr = HISTORY.get(f.path);
    if (!arr) { arr = []; HISTORY.set(f.path, arr); }
    arr.push(pt);
    if (arr.length > MAX_SAMPLES) arr.splice(0, arr.length - MAX_SAMPLES);
    let d = DAILY.get(f.path);
    if (!d) { d = []; DAILY.set(f.path, d); }
    if (d.length && d[d.length - 1].day === day) d[d.length - 1] = pt; else d.push(pt);
    if (d.length > MAX_DAILY) d.splice(0, d.length - MAX_DAILY);
  }
  if (persist) saveHistory();
}

/**
 * 증가 추이 + **용량 예측**(v2.378 · v2.674).
 *
 * 예측은 일 증가율을 그대로 연장한 **단순 선형 추정**이다. 기울기 출처는 둘이다:
 *  - 일 표본이 2일 이상이면 최근 30일 일 표본의 최소제곱 기울기(basis 'daily') — 재시작·WAL 출렁임에 덜 흔들린다.
 *  - 아니면 최근 표본의 처음·끝 차이(basis 'recent'). 관측이 1시간 미만이면 예측을 만들지 않는다
 *    (짧은 구간의 노이즈를 365배 증폭해 허수를 보여주지 않기 위함) — 대신 '약 N분 뒤 표시' 를 말한다.
 *  - 감소 추세(prune 직후 등)면 예측은 현재 크기로 둔다(shrinking:true). 크게 줄어든 지점(80% 미만) 앞의 일 표본은 쓰지 않는다.
 *  - confidence: 관측 구간 길이로 low/medium/high.
 */
const MIN_FORECAST_SPAN_MS = Number(process.env.PORTAL_DB_MIN_FORECAST_MS) || 3_600_000; // 1시간

function forecastFrom(nowBytes, perDayBytes, spanMs) {
  if (!(spanMs >= MIN_FORECAST_SPAN_MS) || !Number.isFinite(perDayBytes)) {
    const leftMin = spanMs > 0 ? Math.max(1, Math.ceil((MIN_FORECAST_SPAN_MS - spanMs) / 60_000)) : null;
    return {
      available: false,
      reason: spanMs > 0 ? `관측 ${Math.max(1, Math.round(spanMs / 60_000))}분 — 1시간 이상 필요(약 ${leftMin}분 뒤 표시)` : '표본 부족(첫 표본 대기)',
      readyInMs: spanMs > 0 ? MIN_FORECAST_SPAN_MS - spanMs : null,
      confidence: null, in1d: null, in1w: null, in1m: null, in6m: null, in1y: null,
    };
  }
  // 감소 추세면 현재 크기로 둔다 — 줄어드는 기울기를 1년 늘리면 '0 B' 가 되는데, 정리가 끝나면 다시 늘기 때문이다.
  const at = (days) => Math.round(nowBytes + Math.max(0, perDayBytes) * days);
  // 관측 구간이 길수록 신뢰도 상향: 7일+ high · 1일+ medium · 그 외 low.
  const confidence = spanMs >= 7 * 86_400_000 ? 'high' : spanMs >= 86_400_000 ? 'medium' : 'low';
  return {
    available: true, reason: null, readyInMs: 0, confidence,
    in1d: at(1), in1w: at(7), in1m: at(30), in6m: at(182), in1y: at(365),
    // 감소 추세면 '언제 0 이 되는가' 는 무의미하므로 표기하지 않는다.
    shrinking: perDayBytes < 0,
  };
}

/** 일 표본(최근 30일 + 지금 값)의 최소제곱 기울기(바이트/일). 2일 미만이면 null. */
function dailySlope(daily, nowPt) {
  if (!Array.isArray(daily) || !daily.length) return null;
  const cut = (nowPt?.at ?? daily[daily.length - 1].at) - DAILY_FIT_DAYS * DAY_MS;
  let pts = daily.filter((x) => x.at >= cut);
  if (nowPt && (!pts.length || pts[pts.length - 1].at < nowPt.at)) pts.push(nowPt);
  // 크게 줄어든 지점(정리·VACUUM·이전 — 직전의 80% 미만) 앞은 다른 기준이다. 섞으면 기울기가 큰 음수가 되어
  // '1년 후 0 B' 가 나온다(v2.674 Chromium 검증에서 발견). 마지막 급감 지점부터만 쓴다.
  for (let i = pts.length - 1; i > 0; i--) {
    if (pts[i].bytes < pts[i - 1].bytes * SHRINK_RESET_RATIO) { pts = pts.slice(i); break; }
  }
  if (pts.length < 2) return null;
  const span = pts[pts.length - 1].at - pts[0].at;
  if (!(span >= MIN_DAILY_SPAN_MS)) return null;
  const slope = linregSlope(pts.map((x) => x.at / DAY_MS), pts.map((x) => x.bytes));
  return Number.isFinite(slope) ? { perDay: Math.round(slope), spanMs: span, points: pts.length } : null;
}

function trendFor(absPath, sizeBytes = 0) {
  const arr = HISTORY.get(absPath) || [];
  const last = arr[arr.length - 1] || null;
  const d = dailySlope(DAILY.get(absPath), last);
  if (d) {
    const growthBytes = arr.length >= 2 ? last.bytes - arr[0].bytes : 0;
    // 재시작 직후처럼 최근 표본이 모자라면 추이 그림은 일 표본으로 그린다(빈 칸 대신).
    const samples = arr.length >= 2 ? arr.slice(-60) : (DAILY.get(absPath) || []).slice(-60).map(({ at, bytes }) => ({ at, bytes }));
    return { samples, growthBytes, spanMs: d.spanMs, perDayBytes: d.perDay, basis: 'daily', basisPoints: d.points,
      // 출발점은 지금 실제 파일 크기다(마지막 표본은 최대 10분 전 값).
      forecast: forecastFrom(Number.isFinite(sizeBytes) && sizeBytes > 0 ? sizeBytes : (last ? last.bytes : 0), d.perDay, d.spanMs) };
  }
  if (arr.length < 2) {
    return { samples: arr.slice(-60), growthBytes: 0, spanMs: 0, perDayBytes: null, basis: null, forecast: forecastFrom(sizeBytes, 0, 0) };
  }
  const first = arr[0];
  const spanMs = Math.max(0, last.at - first.at);
  const growthBytes = last.bytes - first.bytes;
  // 1시간 미만이면 일 증가량을 내지 않는다(30분 차이를 48배로 늘린 값은 숫자처럼 보이지만 뜻이 없다).
  const perDayBytes = spanMs >= MIN_FORECAST_SPAN_MS ? Math.round((growthBytes / spanMs) * 86_400_000) : null;
  return { samples: arr.slice(-60), growthBytes, spanMs, perDayBytes, basis: 'recent', forecast: forecastFrom(last.bytes, perDayBytes ?? NaN, spanMs) };
}

/** 테스트 전용 — 메모리 표본을 비우고 다시 읽게 한다. */
export function _resetDbSizeHistoryForTest() { HISTORY.clear(); DAILY.clear(); _loaded = false; }

/**
 * DB 가 실제로 쌓이는 파일시스템의 여유 공간 — 예측이 디스크를 넘는지 판단하는 기준.
 * v2.451: 경로를 옮겼으면 **새 볼륨**을 봐야 한다. 예전에는 CONFIG_DIR 고정이라
 * 마이그레이션 후 '디스크 소진 예상일' 이 엉뚱한(옛) 볼륨 기준으로 나왔다.
 */
function diskFree() {
  try {
    const st = fs.statfsSync(DB_DIR || CONFIG_DIR);
    const total = st.blocks * st.bsize;
    const free = st.bavail * st.bsize;
    return { totalBytes: total, freeBytes: free, usedBytes: total - free };
  } catch { return null; }
}

/** 화면용 리포트 — 파일 목록 + 현재 크기 + 증가 추이. */
export function portalDbReport(now = Date.now()) {
  loadHistory(now);   // 기동 직후 첫 표본보다 먼저 화면을 열어도 저장분을 쓴다
  const files = enumerateDbFiles().map((f) => ({
    ...f,
    trend: trendFor(f.path, f.sizeBytes || 0),
    detail: detailFor(f.file),
  }));
  const totalBytes = files.reduce((s, f) => s + (f.sizeBytes || 0), 0);
  // 전체 합계 예측 — 파일별 일 증가량을 합산해 같은 방식으로 연장한다.
  const perDayTotal = files.reduce((s, f) => s + (f.trend?.perDayBytes || 0), 0);
  const spanMax = files.reduce((m, f) => Math.max(m, f.trend?.spanMs || 0), 0);
  // v2.674: 일 증가량을 낼 수 없는 파일(관측 1시간 미만)은 합계에서 빠진다 — 몇 개인지 밝힌다.
  const perDayUnknown = files.filter((f) => f.exists && f.trend?.perDayBytes == null).length;
  const totalForecast = forecastFrom(totalBytes, perDayTotal, spanMax);
  const persistedAt = (() => { try { return fs.statSync(historyFile()).mtimeMs; } catch { return null; } })();
  const disk = diskFree();
  // 디스크 소진 예상 — 여유 공간 ÷ 일 증가량. 증가가 0 이하면 '해당 없음'.
  let daysUntilFull = null;
  if (disk && perDayTotal > 0 && totalForecast.available) daysUntilFull = Math.floor(disk.freeBytes / perDayTotal);
  return {
    generatedAt: now,
    configDir: CONFIG_DIR,
    dbDir: DB_DIR,                     // 화면이 '어느 볼륨 기준인지' 표시할 수 있게(v2.451)
    diskPath: DB_DIR || CONFIG_DIR,
    sampleIntervalMs: SAMPLE_INTERVAL_MS,
    totalBytes,
    count: files.length,
    perDayTotalBytes: totalForecast.available ? perDayTotal : null,
    perDayUnknown,
    historyPersistedAt: persistedAt,
    totalForecast,
    disk,
    daysUntilFull,
    minForecastSpanMs: MIN_FORECAST_SPAN_MS,
    files,
  };
}

let _timer = null;
/** 주기적으로 파일 크기를 샘플링해 증가 추이를 누적(기동 시 1회 즉시 기록). */
export function startDbSizeSampler() {
  if (_timer) return;
  try { recordDbSizeSample(); } catch (e) { console.warn(`[portal-db] 크기 표본 실패: ${e.message}`); }
  _timer = setInterval(() => { try { recordDbSizeSample(); } catch { /* */ } }, SAMPLE_INTERVAL_MS);
  _timer.unref?.();
}
