/**
 * 백업 설정 + 스케줄러 + 변경 감시.
 *  - 정기 백업: 분/시간/일 단위 간격으로 자동 생성.
 *  - 변경 자동 백업: CONFIG_DIR의 설정 파일(*.json/*.env)이 바뀌면 디바운스 후 자동 생성.
 * 설정은 CONFIG_DIR/backup.json 에 보관.
 */

import fs from 'node:fs';
import path from 'node:path';
import { config, clampIntervalMs } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt } from '../util/atomicWrite.js';
import { createBackup, isRuntimeStateFile } from './service.js';
import { every as everyLong } from '../util/longTimer.js';
import { numOrNull } from '../util/numOrNull.js';

const FILE = path.join(config.configDir, 'backup.json');

const UNIT_MS = { minute: 60_000, hour: 3_600_000, day: 86_400_000 };

const DEFAULTS = {
  scheduleEnabled: false,
  every: 1,
  unit: 'day',          // 'minute' | 'hour' | 'day'
  autoOnChange: true,   // 설정 변경 시 자동 백업
  retention: 30,        // 보관 개수
};

/**
 * v2.604(감사 TIM2604-03): 저장과 로드가 **같은 정규화**를 거친다. 예전엔 저장만 클램프하고 로드는 파일 값을 그대로 펼쳐,
 * 손으로 고친·옛 파일의 every=-5·0.00001 이 reschedule 의 max(60초, …) 에 걸려 **1분마다 정기 백업**이 돌았고
 * retention=0 은 createBackup → pruneBackups(0) 으로 **백업을 전부 지울** 수 있었다.
 * 숫자: 빈 값·0 이하·숫자 아님은 '미지정' = base 값 유지(저장이면 현재 값, 로드면 기본값). 범위는 every 1–1000 · retention 1–500.
 * unit 은 목록에 있을 때만, 불리언은 불리언일 때만(로드 경로에서 문자열 'false' 가 참으로 읽히지 않게).
 */
const pickNum = (v, base, lo, hi) => { const n = numOrNull(v); return n == null || n <= 0 ? base : Math.max(lo, Math.min(hi, n)); };
export function normalizeBackupSettings(raw = {}, base = DEFAULTS) {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    scheduleEnabled: typeof r.scheduleEnabled === 'boolean' ? r.scheduleEnabled : base.scheduleEnabled,
    every: pickNum(r.every, base.every, 1, 1000),
    unit: ['minute', 'hour', 'day'].includes(r.unit) ? r.unit : base.unit,
    autoOnChange: typeof r.autoOnChange === 'boolean' ? r.autoOnChange : base.autoOnChange,
    retention: Math.round(pickNum(r.retention, base.retention, 1, 500)),
  };
}

let cache = null;
export function loadBackupSettings() {
  if (cache) return cache;
  cache = { ...DEFAULTS };
  try { if (fs.existsSync(FILE)) cache = normalizeBackupSettings(JSON.parse(fs.readFileSync(FILE, 'utf8')), DEFAULTS); }
  catch (e) { preserveCorrupt(FILE, e.message); } // v2.479(감사 S-9): 손상 시 조용히 기본값(정기 백업 off)으로 돌아가지 않게 보존+경고
  return cache;
}

export function saveBackupSettings(body = {}) {
  const cur = loadBackupSettings();
  const b = body && typeof body === 'object' ? body : {};
  // 화면은 불리언 칸에 !! 를 거쳐 보내 왔다 — 예전처럼 null/undefined 가 아니면 참거짓으로 읽는다.
  const next = normalizeBackupSettings({
    ...b,
    scheduleEnabled: b.scheduleEnabled != null ? !!b.scheduleEnabled : undefined,
    autoOnChange: b.autoOnChange != null ? !!b.autoOnChange : undefined,
  }, cur);
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  atomicWriteFileSync(FILE, JSON.stringify(next, null, 2), { mode: 0o600 });
  cache = next;
  reschedule();
  return next;
}

/** 테스트 전용 — 캐시를 비워 다음 load 가 파일을 다시 읽게 한다. */
export function _resetBackupSettingsForTest() { cache = null; }

let schedTimer = null;
let watcher = null;
let changeTimer = null;
let lastRun = null;
let lastSkip = null;

// v2.620(PERF2620-01): createBackup 이 비동기(gzip 을 libuv 스레드로)가 됐다 — 호출부 타이머는 promise 를 버리지만
//   이 함수가 안에서 실패를 잡으므로 unhandled rejection 은 없다.
async function safeBackup(reason) {
  try {
    // v2.590 P1: 'change' 는 설정 내용이 직전 백업과 같으면 만들지 않는다(상태 파일만 바뀐 경우). 건너뛴 사실은 lastSkip 으로 남긴다.
    const m = await createBackup(reason, { retention: loadBackupSettings().retention, skipIfUnchanged: reason === 'change' });
    // v2.591 L5: `m.skipped` 는 성공한 백업에서도 **배열**(크기 상한으로 뺀 파일 — v2.590 D5)이라 빈 배열도 참이다. 그 값으로
    //   '생략' 을 판정하면 모든 자동 백업이 lastSkip 으로 가고 lastRun 이 영원히 비어 서비스 점검이 '백업 없음' 이라 말했다.
    if (m.skipped === true) { lastSkip = { at: Date.now(), reason, why: m.why }; return null; }
    lastRun = { at: Date.now(), reason, name: m.name, size: m.size, skipped: Array.isArray(m.skipped) ? m.skipped.length : 0 }; return m;
  }
  catch (e) { console.warn(`[backup] ${reason} 백업 실패: ${e.message}`); return null; }
}

function reschedule() {
  const s = loadBackupSettings();
  if (schedTimer) { schedTimer.clear(); schedTimer = null; }
  if (s.scheduleEnabled) {
    const ms = Math.max(60_000, (Number(s.every) || 1) * (UNIT_MS[s.unit] || UNIT_MS.day));
    // v2.591 L2: setInterval 은 24.8일(2^31−1ms)을 넘으면 1ms 로 바뀐다(월 1회·600시간 이상 설정) — 조각 타이머로 건다.
    schedTimer = everyLong(() => safeBackup('schedule'), ms);
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
  // v2.617: 기동 20초 뒤 → 기본 10분 뒤. 시작 백업은 CONFIG_DIR 전체 + 전 엣지 설정 사본을 **동기로**
  //   JSON.stringify + gzipSync 한다(엣지가 많으면 수백 MB). 기동 직후는 엣지 ~30곳이 한꺼번에 다시 push 하는 가장
  //   바쁜 구간이라, 그때 이 작업이 겹치면 힙 순간치가 겹친다(2026-09-26 운영 중앙 멈춤의 기여 후보 — 확정 아님).
  //   BACKUP_STARTUP_DELAY_MS 로 조정(최소 20초).
  const startupDelay = clampIntervalMs(process.env.BACKUP_STARTUP_DELAY_MS, 10 * 60_000, 20_000); // 상한: setTimeout 2^31 함정(config 헬퍼)
  setTimeout(() => safeBackup('startup'), startupDelay).unref?.();
}

export function backupStatus() {
  return { settings: loadBackupSettings(), lastRun, lastSkip, scheduleActive: !!schedTimer, watching: !!watcher };
}
