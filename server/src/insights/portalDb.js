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
import { config } from '../config.js';

const CONFIG_DIR = config.configDir;

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
  'auth.json': '포탈 사용자/권한/TOTP(2FA) 자격',
  'idrac.json': 'iDRAC/OME 등록(서버·자격증명)',
  'gpu-guest.json': 'GPU 게스트(패스쓰루) 수집 설정/자격',
  'gpu-physical.json': '물리(베어메탈) 서버 GPU SSH 수집 등록',
  'agent-deploy-targets.json': '에이전트 배포 대상 목록',
  'remote-access.json': '원격 접속(HAProxy 중계) 매핑',
  'collectors.json': '분산 수집 에이전트(컬렉터) 등록',
  'central-inventory.json': '중앙이 수집한 사이트 인벤토리 캐시',
  'nsx.json': 'NSX 등록/버전 정보',
  'alerts.json': '알림(이메일/웹훅) 설정',
  'metrics.json': '지표 샘플링 설정',
  'emergency-stop.json': '긴급중단(수집 전체 정지) 상태 플래그',
  'session-security.json': '세션 보안 정책(만료·잠금)',
  'llm.json': '로컬 LLM(Ollama) 연결 설정',
  'packages.json': '업그레이드/설치 패키지 소스 설정',
  'os-scan.json': '실제 OS(게스트) 스캔 설정',
  'os-results.json': '실제 OS(게스트) 스캔 결과 캐시',
  'ipam-scan.json': 'IPAM 능동 스캔 설정',
  'ipam-scan-agents.json': 'IPAM 스캔 에이전트 목록',
  'ipam-scan-history.json': 'IPAM 스캔 이력',
  'ipam-scan-results.json': 'IPAM 스캔 결과(최근)',
  'ipam-scan-runs.json': 'IPAM 스캔 실행 기록',
  'backup-settings.json': '구성 백업 스케줄 설정',
  'log-settings.json': 'vCenter 로그 수집 설정',
  'net-monitors.json': '네트워크 상시 모니터(캡처) 정의',
  'capture-history.json': '네트워크 트래픽 캡처 이력',
  'central-token.json': '중앙↔에이전트 인증 토큰',
  'idrac-assignments.json': 'iDRAC 위임 스캔 IP 배정',
  'agent-config.json': '에이전트별 배포 구성',
  // ── ndjson 추가형 로그 ──────────────────────────────────────────────
  'audit.ndjson': '감사 로그 — 관리 작업 이력(추가형)',
  'login-fails.ndjson': '로그인 실패 기록(추가형)',
  'net-issues.ndjson': '네트워크 장애 탐지 로그(추가형)',
  'vcenter-logs.ndjson': 'vCenter 로그(파일 폴백, ndjson)',
  // ── v2.376~377 신규 ────────────────────────────────────────────────
  'vmperf.json': 'VM 성능 트래킹 설정(보존기간·대상 vCenter)',
  'vm-track.db': 'VM 수량·데이터스토어 사용량 추이(하루 2회 슬롯 스냅샷 + 변경분)',
  'capacity.db': '리소스 적정성(용량) 샘플 시계열',
  'ping-monitor.db': '핑 모니터 응답/손실 시계열',
  'storage-history.db': '스토리지 장비(8종) 용량 이력',
};

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
    keeps: '리소스 적정성 진단용 샘플(클러스터/호스트 여유·오버커밋 계산 입력) 시계열.',
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
    retention: '추가형(자동 삭제 없음)',
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

  // 2) 설정상 명시된 DB 경로(외부로 override 가능) — 누락 방지 위해 명시 추가
  for (const p of [config.temp?.dbPath, config.idrac?.dbPath, config.ipam?.dbPath]) {
    if (p) add(p);
  }

  // 정렬: 존재 + 큰 것 우선, 그다음 type, 파일명
  return [...seen.values()].sort((a, b) =>
    (b.exists - a.exists) || ((b.sizeBytes || 0) - (a.sizeBytes || 0)) || a.file.localeCompare(b.file));
}

// ── 증가 추이 샘플러(메모리 링버퍼) ─────────────────────────────────────
const HISTORY = new Map();          // absPath -> [{ at, bytes }]
const MAX_SAMPLES = 300;            // 파일당 보관 샘플 수(예: 10분 간격 ≈ 50시간)
const SAMPLE_INTERVAL_MS = Number(process.env.PORTAL_DB_SAMPLE_MS) || 10 * 60_000;

/** 현재 크기를 1회 샘플링해 링버퍼에 적재. */
export function recordDbSizeSample(now = Date.now()) {
  for (const f of enumerateDbFiles()) {
    if (!f.exists) continue;
    let arr = HISTORY.get(f.path);
    if (!arr) { arr = []; HISTORY.set(f.path, arr); }
    const last = arr[arr.length - 1];
    // 직전과 동일 크기면 타임스탬프만 의미가 적으므로 기록하되 버퍼는 bound.
    arr.push({ at: now, bytes: f.sizeBytes || 0 });
    if (arr.length > MAX_SAMPLES) arr.splice(0, arr.length - MAX_SAMPLES);
    void last;
  }
}

/**
 * 증가 추이 + **용량 예측**(v2.378).
 *
 * 예측은 관측 구간의 선형 증가율(일 평균)을 그대로 연장한 **단순 추정**이다. 그래서:
 *  - 표본이 2개 미만이거나 관측 구간이 짧으면(기본 1시간 미만) 예측을 만들지 않고 null 을 준다
 *    (짧은 구간의 노이즈를 365배 증폭해 '1년 후 40TB' 같은 허수를 보여주지 않기 위함).
 *  - 감소 추세(prune 직후 등)면 예측은 현재 크기로 수렴시킨다(음수 용량 방지).
 *  - confidence: 관측 구간 길이로 low/medium/high 를 매겨 화면이 신뢰도를 함께 표기한다.
 */
const MIN_FORECAST_SPAN_MS = Number(process.env.PORTAL_DB_MIN_FORECAST_MS) || 3_600_000; // 1시간

function forecastFrom(nowBytes, perDayBytes, spanMs) {
  if (!(spanMs >= MIN_FORECAST_SPAN_MS) || !Number.isFinite(perDayBytes)) {
    return { available: false, reason: spanMs > 0 ? '관측 구간이 짧아 예측을 만들지 않습니다(1시간 이상 필요)' : '표본 부족', confidence: null, in1m: null, in6m: null, in1y: null };
  }
  const at = (days) => Math.max(0, Math.round(nowBytes + perDayBytes * days));
  // 관측 구간이 길수록 신뢰도 상향: 7일+ high · 1일+ medium · 그 외 low.
  const confidence = spanMs >= 7 * 86_400_000 ? 'high' : spanMs >= 86_400_000 ? 'medium' : 'low';
  return {
    available: true, reason: null, confidence,
    in1m: at(30), in6m: at(182), in1y: at(365),
    // 감소 추세면 '언제 0 이 되는가' 는 무의미하므로 표기하지 않는다.
    shrinking: perDayBytes < 0,
  };
}

function trendFor(absPath, sizeBytes = 0) {
  const arr = HISTORY.get(absPath) || [];
  if (arr.length < 2) {
    return { samples: arr.slice(-60), growthBytes: 0, spanMs: 0, perDayBytes: 0, forecast: forecastFrom(sizeBytes, 0, 0) };
  }
  const first = arr[0];
  const last = arr[arr.length - 1];
  const spanMs = Math.max(0, last.at - first.at);
  const growthBytes = last.bytes - first.bytes;
  const perDayBytes = spanMs > 0 ? Math.round((growthBytes / spanMs) * 86_400_000) : 0;
  return { samples: arr.slice(-60), growthBytes, spanMs, perDayBytes, forecast: forecastFrom(last.bytes, perDayBytes, spanMs) };
}

/** 설정 디렉터리가 있는 파일시스템의 여유 공간 — 예측이 디스크를 넘는지 판단하는 기준. */
function diskFree() {
  try {
    const st = fs.statfsSync(CONFIG_DIR);
    const total = st.blocks * st.bsize;
    const free = st.bavail * st.bsize;
    return { totalBytes: total, freeBytes: free, usedBytes: total - free };
  } catch { return null; }
}

/** 화면용 리포트 — 파일 목록 + 현재 크기 + 증가 추이. */
export function portalDbReport(now = Date.now()) {
  const files = enumerateDbFiles().map((f) => ({
    ...f,
    trend: trendFor(f.path, f.sizeBytes || 0),
    detail: detailFor(f.file),
  }));
  const totalBytes = files.reduce((s, f) => s + (f.sizeBytes || 0), 0);
  // 전체 합계 예측 — 파일별 일 증가량을 합산해 같은 방식으로 연장한다.
  const perDayTotal = files.reduce((s, f) => s + (f.trend?.perDayBytes || 0), 0);
  const spanMax = files.reduce((m, f) => Math.max(m, f.trend?.spanMs || 0), 0);
  const totalForecast = forecastFrom(totalBytes, perDayTotal, spanMax);
  const disk = diskFree();
  // 디스크 소진 예상 — 여유 공간 ÷ 일 증가량. 증가가 0 이하면 '해당 없음'.
  let daysUntilFull = null;
  if (disk && perDayTotal > 0 && totalForecast.available) daysUntilFull = Math.floor(disk.freeBytes / perDayTotal);
  return {
    generatedAt: now,
    configDir: CONFIG_DIR,
    sampleIntervalMs: SAMPLE_INTERVAL_MS,
    totalBytes,
    count: files.length,
    perDayTotalBytes: perDayTotal,
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
  try { recordDbSizeSample(); } catch { /* */ }
  _timer = setInterval(() => { try { recordDbSizeSample(); } catch { /* */ } }, SAMPLE_INTERVAL_MS);
  _timer.unref?.();
}
