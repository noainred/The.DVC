/**
 * 백업 설정 + 스케줄러 + 변경 감시.
 *  - 정기 백업: 분/시간/일 단위 간격으로 자동 생성.
 *  - 변경 자동 백업: CONFIG_DIR의 설정 파일(*.json/*.env)이 바뀌면 디바운스 후 자동 생성.
 * 설정은 CONFIG_DIR/backup.json 에 보관.
 */

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt } from '../util/atomicWrite.js';
import { createBackup, isRuntimeStateFile } from './service.js';

const FILE = path.join(config.configDir, 'backup.json');

const UNIT_MS = { minute: 60_000, hour: 3_600_000, day: 86_400_000 };

const DEFAULTS = {
  scheduleEnabled: false,
  every: 1,
  unit: 'day',          // 'minute' | 'hour' | 'day'
  autoOnChange: true,   // 설정 변경 시 자동 백업
  retention: 30,        // 보관 개수
};

let cache = null;
export function loadBackupSettings() {
  if (cache) return cache;
  cache = { ...DEFAULTS };
  try { if (fs.existsSync(FILE)) cache = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) }; }
  catch (e) { preserveCorrupt(FILE, e.message); } // v2.479(감사 S-9): 손상 시 조용히 기본값(정기 백업 off)으로 돌아가지 않게 보존+경고
  return cache;
}

export function saveBackupSettings(body = {}) {
  const cur = loadBackupSettings();
  const unit = ['minute', 'hour', 'day'].includes(body.unit) ? body.unit : cur.unit;
  const next = {
    scheduleEnabled: body.scheduleEnabled != null ? !!body.scheduleEnabled : cur.scheduleEnabled,
    every: Math.max(1, Math.min(1000, Number(body.every) || cur.every)),
    unit,
    autoOnChange: body.autoOnChange != null ? !!body.autoOnChange : cur.autoOnChange,
    retention: Math.max(1, Math.min(500, Number(body.retention) || cur.retention)),
  };
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  atomicWriteFileSync(FILE, JSON.stringify(next, null, 2), { mode: 0o600 });
  cache = next;
  reschedule();
  return next;
}

let schedTimer = null;
let watcher = null;
let changeTimer = null;
let lastRun = null;
let lastSkip = null;

function safeBackup(reason) {
  try {
    // v2.590 P1: 'change' 는 설정 내용이 직전 백업과 같으면 만들지 않는다(상태 파일만 바뀐 경우). 건너뛴 사실은 lastSkip 으로 남긴다.
    const m = createBackup(reason, { retention: loadBackupSettings().retention, skipIfUnchanged: reason === 'change' });
    if (m.skipped) { lastSkip = { at: Date.now(), reason, why: m.why }; return null; }
    lastRun = { at: Date.now(), reason, name: m.name, size: m.size, skipped: m.skipped?.length || 0 }; return m;
  }
  catch (e) { console.warn(`[backup] ${reason} 백업 실패: ${e.message}`); return null; }
}

function reschedule() {
  const s = loadBackupSettings();
  if (schedTimer) { clearInterval(schedTimer); schedTimer = null; }
  if (s.scheduleEnabled) {
    const ms = Math.max(60_000, (Number(s.every) || 1) * (UNIT_MS[s.unit] || UNIT_MS.day));
    schedTimer = setInterval(() => safeBackup('schedule'), ms);
    schedTimer.unref?.();
    console.log(`[backup] 정기 백업 활성: 매 ${s.every} ${s.unit} (보관 ${s.retention})`);
  }
}

function startWatcher() {
  if (watcher) return;
  try {
    watcher = fs.watch(config.configDir, { persistent: false }, (_evt, filename) => {
      if (!filename) return;
      const ext = path.extname(String(filename)).toLowerCase();
      if (ext !== '.json' && ext !== '.env') return;          // 설정 파일만
      // 자기 자신·엣지 수신 사본·폴러/엣지 push 가 스스로 쓰는 상태·캐시 파일은 '설정 변경' 이 아니다(v2.590 P1 —
      // 예전엔 두 이름만 뺐고, 캐시 쓰기가 보관 슬롯을 채우거나 디바운스를 계속 초기화했다).
      if (isRuntimeStateFile(String(filename))) return;
      if (!loadBackupSettings().autoOnChange) return;
      if (changeTimer) clearTimeout(changeTimer);
      changeTimer = setTimeout(() => safeBackup('change'), 10_000); // 디바운스 10s
      changeTimer.unref?.();
    });
    console.log('[backup] 설정 변경 감시 시작');
  } catch (e) { console.warn(`[backup] 변경 감시 불가: ${e.message}`); }
}

export function startBackupScheduler() {
  reschedule();
  startWatcher();
  // 부팅 시 1회 스냅샷(설정이 있으면).
  setTimeout(() => safeBackup('startup'), 20_000).unref?.();
}

export function backupStatus() {
  return { settings: loadBackupSettings(), lastRun, lastSkip, scheduleActive: !!schedTimer, watching: !!watcher };
}
