/**
 * DB 저장 경로 설정 + 마이그레이션(v2.379).
 *
 * 왜 필요한가: 시계열 DB(온도·GPU·전력·로그·VM성능 등)는 대용량으로 자라는데, 기본 위치인
 * CONFIG_DIR 은 보통 OS 파티션(/etc/vmware-portal)이라 여유가 작다. 큰 별도 볼륨으로 옮길 수
 * 있어야 한다.
 *
 * 동작 방식(중요 — 프로세스 재시작은 사용자가 한다)
 *  1. 설정 화면에서 새 경로를 지정하면 먼저 **사전 점검**을 한다(존재/쓰기권한/여유공간/같은 경로 여부).
 *  2. '마이그레이션 시작'을 누르면 **수집을 전면 정지**(emergencyStop 재사용)하고 DB 핸들을 닫은 뒤
 *     파일을 **복사**한다(이동이 아니라 복사 — 원본을 남겨 실패 시 즉시 되돌릴 수 있게).
 *  3. 복사 후 **크기·SHA-256 검증**을 하고, 성공하면 새 경로를 db-location.json 에 저장한다.
 *  4. 프로세스를 스스로 재시작하지 않는다(systemd 관할). 화면에 **"수동 재시작 필요"** 를 안내하고
 *     그때까지 수집은 정지 상태로 둔다 — 옛 경로에 새 데이터가 섞이는 것을 막기 위함이다.
 *  5. **원본은 지우지 않는다.** 사용자가 새 경로로 정상 기동을 확인한 뒤 직접 삭제한다.
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
  // vcenter-logs.db 는 **이미 자체 경로 설정**(설정 › 로그 수집의 storagePath)이 있어 제외한다 —
  // 두 곳에서 경로를 제어하면 어느 쪽이 이겼는지 알 수 없다(그 화면에서 옮기세요).
  // ipam.db 는 **외부 프로그램이 경로를 고정해 읽는 공유 파일**이라 기본 대상에서 제외한다
  // (옮기면 외부 연동이 조용히 끊긴다). 옮기려면 사용자가 명시적으로 포함해야 한다.
];
/** 디렉터리 단위로 옮기는 대상(vCenter별 분리 DB). */
export const MIGRATABLE_DIRS = [
  { dir: 'vmperf', label: 'VM 성능(vCenter별 독립 DB)' },
];

const readFile = () => {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')) || {}; } catch { return {}; }
};

/** 현재 설정된 DB 디렉터리(미설정이면 null = CONFIG_DIR 사용). */
export function dbDir() {
  const v = readFile().dbDir;
  return v && String(v).trim() ? String(v).trim() : null;
}

/**
 * 파일명 → 실제 사용할 절대 경로. config.js 가 각 DB 경로를 만들 때 쓴다.
 * dbDir 이 설정돼 있으면 그 아래, 없으면 CONFIG_DIR 아래.
 */
export function dbFilePath(name) {
  const d = dbDir();
  return path.join(d || CONFIG_DIR, name);
}

/** 설정 저장(경로만). 검증은 호출부(라우트)가 preflight 로 먼저 한다. */
export function saveDbDir(dir) {
  const next = { ...readFile(), dbDir: dir ? String(dir) : '', updatedAt: Date.now() };
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(next, null, 2), { mode: 0o600 });
  return dbDir();
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
  const src = dbDir() || CONFIG_DIR;
  if (target && path.resolve(target) === path.resolve(src)) reasons.push('현재 경로와 같습니다.');
  // 대상이 소스의 하위 디렉터리면 복사가 자기 자신을 파고들 수 있다.
  if (target && path.resolve(target).startsWith(path.resolve(src) + path.sep)) {
    warnings.push('대상이 현재 경로의 하위입니다 — 권장하지 않습니다(백업·정리가 헷갈립니다).');
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

/**
 * 실제 복사 + 검증. **원본은 삭제하지 않는다.**
 * onProgress({ file, copiedBytes, totalBytes }) 로 진행률을 알린다.
 * 반환 { ok, copied[], failed[], totalBytes, verified }
 */
export async function copyToDir(targetDir, { onProgress = null } = {}) {
  const src = dbDir() || CONFIG_DIR;
  const inv = migrationInventory(src);
  const copied = []; const failed = [];
  let done = 0;

  const copyOne = (from, to) => {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
    // 검증: 크기 + SHA-256(무성 손상으로 절단본이 남는 것을 막는다).
    const a = sizeOf(from); const b = sizeOf(to);
    if (a !== b) throw new Error(`크기 불일치(${a} → ${b})`);
    if (sha256(from) !== sha256(to)) throw new Error('체크섬 불일치');
    try { fs.chmodSync(to, 0o600); } catch { /* best effort */ }
    return b;
  };

  for (const f of inv.files) {
    try {
      if (f.kind === 'file') {
        for (const p of sidecars(path.join(src, f.file))) {
          if (!fs.existsSync(p)) continue;
          const to = path.join(targetDir, path.basename(p));
          done += copyOne(p, to);
          if (onProgress) onProgress({ file: path.basename(p), copiedBytes: done, totalBytes: inv.totalBytes });
          await new Promise((r) => setImmediate(r)); // 큰 파일 사이 양보
        }
      } else {
        const fromDir = path.join(src, f.dir);
        for (const name of fs.readdirSync(fromDir)) {
          done += copyOne(path.join(fromDir, name), path.join(targetDir, f.dir, name));
          if (onProgress) onProgress({ file: `${f.dir}/${name}`, copiedBytes: done, totalBytes: inv.totalBytes });
          await new Promise((r) => setImmediate(r));
        }
      }
      copied.push({ ...f });
    } catch (e) {
      failed.push({ ...f, error: e.message });
    }
  }
  return { ok: failed.length === 0, copied, failed, totalBytes: inv.totalBytes, copiedBytes: done, sourceDir: src, targetDir };
}

export const dbLocationFile = () => FILE;
export const defaultDbDir = () => CONFIG_DIR;
