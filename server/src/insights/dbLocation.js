/**
 * DB 저장 경로 설정 + 마이그레이션(v2.379).
 *
 * 왜 필요한가: 시계열 DB(온도·GPU·전력·로그·VM성능 등)는 대용량으로 자라는데, 기본 위치인
 * CONFIG_DIR 은 보통 OS 파티션(/etc/vmware-portal)이라 여유가 작다. 큰 별도 볼륨으로 옮길 수
 * 있어야 한다.
 *
 * 동작 방식 — **포탈은 직접 옮기지 않는다.** 실행 스크립트를 만들어 주고 관리자가 root 로 돌린다
 * (열린 SQLite 를 프로세스가 살아 있는 채로 옮기면 손상 위험이 있고, 서비스 정지·기동은 systemd 관할이다).
 *  1. 화면에서 새 경로를 지정하면 **사전 점검**(preflight)을 한다 — 절대경로·문자 검증·존재·쓰기권한
 *     실측·여유공간·같은 경로 여부·systemd 하드닝 경로.
 *  2. '스크립트 생성'을 누르면 `migrateScript.js` 가 bash 스크립트 + README 를 만든다.
 *  3. 관리자가 `sudo bash <스크립트>` 로 실행한다 — 서비스 정지 → 복사(rsync/cp) → **SHA-256 검증**
 *     → 소유권·권한 설정 → db-location.json 기록.
 *  4. 관리자가 서비스를 다시 시작한다. 기동 시 config.js 가 db-location.json 을 읽어 DB 경로를 바꾼다.
 *  5. **원본은 지우지 않는다.** 새 경로로 정상 기동을 확인한 뒤 관리자가 직접 삭제한다.
 *
 * 적용 시점: 기동 시 config.js 가 이 파일을 읽어 각 DB 경로를 새 디렉터리로 바꾼다
 * (개별 *_DB_PATH env 가 있으면 env 가 우선 — 명시 설정을 덮지 않는다).
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// config.js 가 이 모듈을 import 하면 순환 참조가 되므로, 설정 파일 위치는 env 로 직접 계산한다.
const CONFIG_DIR = process.env.CONFIG_DIR || path.resolve(process.cwd(), 'config');
const FILE = path.join(CONFIG_DIR, 'db-location.json');

/** 이 디렉터리로 옮기는 대상 — 대용량 시계열/이력 DB. (JSON 설정·자격증명은 CONFIG_DIR 유지) */
export const MIGRATABLE = [
  { file: 'host-temp.db', label: '지표 시계열(온도·GPU·데이터스토어·메모리)' },
  { file: 'idrac-power.db', label: '전력 시계열(iDRAC/OME)' },
  { file: 'ping-monitor.db', label: '핑 모니터 이력' },
  { file: 'capacity.db', label: '용량 샘플' },
  { file: 'vm-track.db', label: 'VM 수량·스토리지 추이' },
  { file: 'storage-history.db', label: '스토리지 장비 이력' },
  // ▼ v2.379 이후 추가된 DB — 등재가 누락돼 있었다(v2.451 수정).
  //   이 파일들은 config.dbDir 을 **이미 따르므로**(rma/historyDb.js·rma/testResults.js·
  //   sanswitch/perfDb.js·pdu/db.js), 목록에서 빠지면 '경로는 새 곳을 보는데 복사는 안 된' 상태가 된다
  //   → 재시작 후 새 경로에 빈 DB 가 생기고 기존 이력은 옛 경로에 남아 화면에서 사라진다.
  //   README 4단계로 원본을 지우면 실제로 소실된다. 아래 dbFilesInCode() 회귀 테스트가 재발을 막는다.
  { file: 'sanswitch-perf.db', label: 'SAN 스위치 포트 처리량 이력(v2.410)' },
  { file: 'rma-history.db', label: '원격 명령(RMA) 실행 이력(v2.416)' },
  { file: 'rma-tests.db', label: '원격 명령(RMA) 점검 결과(v2.418)' },
  { file: 'dirusage.db', label: '폴더 사용량 리포트 이력(엣지 공유 폴더 Top-N)' },
  { file: 'pdu.db', label: 'PDU 전력·온습도 이력(v2.424)' },
  { file: 'guest-disk.db', label: '게스트 디스크 회수 리포트 추이(v2.459)' },
  { file: 'curuser.db', label: "'현재 사용자' 로그인 사용자 수 추이(v2.520)" },
  { file: 'san-health.db', label: 'SAN 스위치 점검 이력(최근 N회 비교, v2.522)' },
  { file: 'horizon-sessions.db', label: 'Horizon 실시간 사용자(세션) 추이(v2.525)' },
  // vcenter-logs.db 는 **이미 자체 경로 설정**(설정 › 로그 수집의 storagePath)이 있어 제외한다 —
  // 두 곳에서 경로를 제어하면 어느 쪽이 이겼는지 알 수 없다(그 화면에서 옮기세요).
  // ipam.db 는 **외부 프로그램이 경로를 고정해 읽는 공유 파일**이라 기본 대상에서 제외한다
  // (옮기면 외부 연동이 조용히 끊긴다). 옮기려면 사용자가 명시적으로 포함해야 한다.
];
/** 디렉터리 단위로 옮기는 대상(vCenter별 분리 DB). */
export const MIGRATABLE_DIRS = [
  { dir: 'vmperf', label: 'VM 성능(vCenter별 독립 DB)' },
  { dir: 'vmseries', label: 'VM 실시간 스파이크(vCenter별 독립 DB, v2.510)' },
];

const readFile = () => {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')) || {}; } catch { return {}; }
};

/** 현재 설정된 DB 디렉터리(미설정이면 null = CONFIG_DIR 사용). */
export function dbDir() {
  const v = readFile().dbDir;
  return v && String(v).trim() ? String(v).trim() : null;
}



const sidecars = (p) => [p, `${p}-wal`, `${p}-shm`];

function sizeOf(p) {
  try { return fs.statSync(p).size; } catch { return 0; }
}

function sha256(p) {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(p, 'r');
  try {
    const buf = Buffer.alloc(1024 * 1024);
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (n <= 0) break;
      h.update(buf.subarray(0, n));
    }
  } finally { fs.closeSync(fd); }
  return h.digest('hex');
}

/** 현재 경로에 있는 이전 대상 목록 + 총 용량. */
export function migrationInventory(fromDir = null) {
  const src = fromDir || dbDir() || CONFIG_DIR;
  const files = [];
  for (const m of MIGRATABLE) {
    const base = path.join(src, m.file);
    const bytes = sidecars(base).reduce((s, p) => s + sizeOf(p), 0);
    if (bytes > 0) files.push({ ...m, kind: 'file', bytes });
  }
  for (const m of MIGRATABLE_DIRS) {
    const dir = path.join(src, m.dir);
    let bytes = 0; let count = 0;
    try {
      for (const f of fs.readdirSync(dir)) { bytes += sizeOf(path.join(dir, f)); count++; }
    } catch { /* 없음 */ }
    if (count > 0) files.push({ ...m, kind: 'dir', bytes, count });
  }
  return { sourceDir: src, files, totalBytes: files.reduce((s, f) => s + f.bytes, 0) };
}

/**
 * 사전 점검 — 실제 복사 전에 실패 요인을 모두 잡아낸다.
 * { ok, reasons[], warnings[], inventory, targetFree }
 */
export function preflight(targetDir) {
  const reasons = []; const warnings = [];
  const target = String(targetDir || '').trim();
  if (!target) reasons.push('경로를 입력하세요.');
  if (target && !path.isAbsolute(target)) reasons.push('절대 경로를 입력하세요(예: /data/vmware-portal-db).');
  // 제어문자·인용부호·백슬래시 금지(v2.388) — 생성되는 bash 스크립트/README 의 주석·코드블록에
  // 경로가 삽입되므로, 개행이 들어가면 주석을 탈출한 실행 라인을 만들 수 있다(admin → root 상승).
  // Linux 에서 개행은 합법 파일명이라 isAbsolute/mkdir/statfs 검사로는 걸러지지 않는다.
  if (target && /[\x00-\x1f\x7f'"\\`$]/.test(target)) {
    reasons.push('경로에 제어문자·인용부호·백슬래시·$·백틱은 쓸 수 없습니다(마이그레이션 스크립트 안전).');
  }
  const src = dbDir() || CONFIG_DIR;
  if (target && path.resolve(target) === path.resolve(src)) reasons.push('현재 경로와 같습니다.');
  // 대상이 소스의 하위 디렉터리면 복사가 자기 자신을 파고들 수 있다.
  if (target && path.resolve(target).startsWith(path.resolve(src) + path.sep)) {
    warnings.push('대상이 현재 경로의 하위입니다 — 권장하지 않습니다(백업·정리가 헷갈립니다).');
  }
  // systemd 하드닝(v2.451) — packaging/offline/vmware-portal.service 는
  //   ProtectSystem=full  → /usr·/boot·/efi·/etc 읽기전용
  //   ProtectHome=true    → /home·/root·/run/user 접근 차단
  //   ReadWritePaths=@PREFIX@ @CONFIG_DIR@  → 이 둘만 예외
  // 새 경로가 위 보호 대상 안이면 서비스가 **기동 후에야** 쓰기 실패를 만난다(스크립트는 root 로
  // 도니 복사는 성공한다). 그래서 사전에 걸러 준다. 유닛을 직접 읽지는 않으므로(설치 위치가
  // 배포마다 다르다) 경로 규칙으로만 판단하고, 확정이 아니라 경고/차단 문구로 안내한다.
  if (target && !reasons.length) {
    const abs = path.resolve(target);
    const under = (dir) => abs === dir || abs.startsWith(`${dir}/`);
    const cfgAbs = path.resolve(CONFIG_DIR);
    const inConfigDir = abs === cfgAbs || abs.startsWith(`${cfgAbs}/`);
    if ((under('/home') || under('/root'))) {
      reasons.push('systemd 하드닝(ProtectHome=true) 때문에 /home·/root 아래는 서비스가 접근할 수 없습니다 — /data 같은 별도 볼륨을 쓰세요.');
    } else if ((under('/usr') || under('/boot') || under('/efi')) || (under('/etc') && !inConfigDir)) {
      reasons.push('systemd 하드닝(ProtectSystem=full) 때문에 /usr·/boot·/etc 아래는 서비스가 쓸 수 없습니다(CONFIG_DIR 은 예외) — /data 같은 별도 볼륨을 쓰거나 유닛의 ReadWritePaths 에 경로를 추가하세요.');
    }
  }
  let created = false;
  if (target && !reasons.length) {
    try {
      if (!fs.existsSync(target)) { fs.mkdirSync(target, { recursive: true }); created = true; }
      const st = fs.statSync(target);
      if (!st.isDirectory()) reasons.push('경로가 디렉터리가 아닙니다.');
    } catch (e) { reasons.push(`디렉터리를 만들 수 없습니다: ${e.message}`); }
  }
  // 쓰기 권한 실측 — 권한 판정을 추측하지 않고 실제로 써 본다.
  if (target && !reasons.length) {
    const probe = path.join(target, `.write-probe-${Date.now()}`);
    try { fs.writeFileSync(probe, 'x'); fs.rmSync(probe); }
    catch (e) { reasons.push(`쓰기 권한이 없습니다: ${e.message}`); }
  }
  const inv = migrationInventory(src);
  let targetFree = null;
  if (target && !reasons.length) {
    try {
      const st = fs.statfsSync(target);
      targetFree = st.bavail * st.bsize;
      // 복사는 원본을 남기므로 대상에 전체 용량 + 여유 10% 가 필요하다.
      const need = Math.ceil(inv.totalBytes * 1.1);
      if (targetFree < need) reasons.push(`대상 여유 공간 부족 — 필요 약 ${Math.round(need / 1048576)}MB, 여유 ${Math.round(targetFree / 1048576)}MB`);
    } catch { warnings.push('대상 파일시스템 여유 공간을 확인할 수 없습니다.'); }
  }
  if (!inv.files.length) warnings.push('옮길 DB 파일이 없습니다(아직 생성되지 않았을 수 있습니다). 경로만 저장됩니다.');
  return { ok: reasons.length === 0, reasons, warnings, created, inventory: inv, targetFree, estimatedSeconds: Math.ceil(inv.totalBytes / (50 * 1024 * 1024)) };
}


export const defaultDbDir = () => CONFIG_DIR;
