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
};

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

function trendFor(absPath) {
  const arr = HISTORY.get(absPath) || [];
  if (arr.length < 2) return { samples: arr.slice(-60), growthBytes: 0, spanMs: 0, perDayBytes: 0 };
  const first = arr[0];
  const last = arr[arr.length - 1];
  const spanMs = Math.max(0, last.at - first.at);
  const growthBytes = last.bytes - first.bytes;
  const perDayBytes = spanMs > 0 ? Math.round((growthBytes / spanMs) * 86_400_000) : 0;
  return { samples: arr.slice(-60), growthBytes, spanMs, perDayBytes };
}

/** 화면용 리포트 — 파일 목록 + 현재 크기 + 증가 추이. */
export function portalDbReport(now = Date.now()) {
  const files = enumerateDbFiles().map((f) => ({ ...f, trend: trendFor(f.path) }));
  const totalBytes = files.reduce((s, f) => s + (f.sizeBytes || 0), 0);
  return {
    generatedAt: now,
    configDir: CONFIG_DIR,
    sampleIntervalMs: SAMPLE_INTERVAL_MS,
    totalBytes,
    count: files.length,
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
