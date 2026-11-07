/**
 * bmusage/logs/run.js — 7a단계 로그 분석의 **주기 배선**(폴러 pollBmUsageOnce 가 부른다).
 *
 *   beginLogCycle()  — 주기 시작: 설정(perfRules logs) · 이 노드의 읽기 위치 전부를 한 번 읽는다(서버 수만큼 점 조회 없음).
 *   logExtraFor()    — 서버 하나의 로그 읽기 명령(같은 SSH 세션의 별도 exec — osSsh extraCommands). 위치 값은 화이트리스트를 지난 것만 명령에 들어간다(command.js).
 *   finishLogCycle() — 주기 끝: 파싱 → 분류(시간 기준 양보) → 한 트랜잭션 쓰기(위치 비교 후 쓰기) → 함대 요약 갱신(메모리 — 봉투 · 함대 표는 요청마다 SQL 을 돌리지 않는다).
 *
 * ⚠⚠ 읽지 못한 주기를 0 으로 만들지 않는다: SSH 실패 · 예산 부족(skipped) · 출력 잘림 · 권한 없음 · Windows 는 그 서버의 이번 주기 결과가 없거나 출처 상태로 남는다
 *   (위치는 넘어가지 않는다 — 다음 주기에 같은 줄을 읽는다). 알림 규칙 입력(logAlertInputs)도 못 읽은 서버는 없다(= 판정 보류).
 * ⚠ 데모(mock) 대상은 SSH 를 열지 않고 합성 출력(mock/demo/bmLogs.js — 명령 출력과 같은 꼴)을 같은 파서 · 분류 · 쓰기에 넣는다(화면 판독용 · 값은 가상).
 */
import { config } from '../../config.js';
import { numOrNull } from '../../util/numOrNull.js';
import { logCommand, OUTPUT_MAX, LINE_CAP_DEFAULT } from './command.js';
import { parseLogOutput } from './parse.js';
import { classifyItems, HOUR, BURST_DEFAULTS } from './classify.js';
import { logCursorsAll, logWriteBatch, logPrune } from './store.js';
import { refreshLogSummary } from './view.js';
import { classCover } from './rules.js';

export const LOG_DEFAULTS = Object.freeze({ on: true, lineCap: LINE_CAP_DEFAULT, keepDays: 30, burstCount: BURST_DEFAULTS.count, burstWindowMin: BURST_DEFAULTS.windowMin });
/** 로그 exec 시한(같은 세션 남은 예산과 작은 쪽 — osSsh 가 자른다). journalctl 15 + dmesg 5 + find 5 + 여유. */
export const LOG_EXEC_TIMEOUT_MS = 30_000;

let _last = null;
let _alertIn = new Map();
export function logCycleStatus() { return _last; }
/** 알림 규칙(perfAlerts 'logs') 입력 — 이번 주기에 로그를 읽은 서버만. */
export function logAlertInputs() { return _alertIn; }
export function _resetLogRunForTest() { _last = null; _alertIn = new Map(); }

async function settingsOf() {
  try { const r = (await import('../perfRules.js')).loadPerfRules(); return { ...LOG_DEFAULTS, ...(r.logs || {}) }; } catch { return { ...LOG_DEFAULTS }; }
}

/** 주기 시작 — 설정 · 읽기 위치. 못 읽으면 ctx.cursors 가 null(그 주기는 로그를 읽지 않는다 — 위치를 모르면 처음 읽기로 겹쳐 세게 된다). */
export async function beginLogCycle({ agent = config.agent?.name || '' } = {}) {
  const cfg = await settingsOf();
  if (!cfg.on) return { on: false, cfg, cursors: null, agent };
  let cursors = null; let error = null;
  try { cursors = await logCursorsAll({ agent }); } catch (e) { error = String(e?.message || e).slice(0, 200); }
  return { on: true, cfg, cursors, agent, ...(cursors ? {} : { error: error || 'db-unavailable' }) };
}

/** 서버 하나의 로그 exec(이름 ‘logs’ — osSsh extraCommands 규약). OS 경로가 없거나 위치를 모르면 null. */
export function logExtraFor(target, ctx) {
  if (!ctx?.on || !ctx.cursors || !target?.key) return null;
  const prev = ctx.cursors.get(target.key);
  const pos = prev && !prev.corrupt ? prev.state?.pos || {} : {};
  return { name: 'logs', cmd: logCommand(pos, { lineCap: ctx.cfg.lineCap }), timeoutMs: LOG_EXEC_TIMEOUT_MS, maxBytes: OUTPUT_MAX + 64 * 1024 };
}

/** 한 서버의 출력 → 쓰기 항목(순수에 가깝다 — 분류만 비동기). */
export async function buildLogWrite({ key, stdout, prev = null, now = Date.now(), cfg = LOG_DEFAULTS }) {
  const prevPos = prev && !prev.corrupt ? prev.state?.pos || {} : {};
  const carry = prev && !prev.corrupt ? prev.state?.carry || null : null;
  const parsed = parseLogOutput(stdout, { prev: prevPos, now });
  const cls = await classifyItems(parsed.items, { now, burst: { count: cfg.burstCount, windowMin: cfg.burstWindowMin }, carry, authSrc: parsed.authSrc });
  const hourNow = Math.floor(now / HOUR) * HOUR;
  const hours = [...cls.hours.values()];
  const readNow = new Set(Object.entries(parsed.sources).filter(([, x]) => x?.status === 'ok').map(([k]) => k));
  for (const [src, s] of Object.entries(parsed.sources)) {
    if (s.status !== 'ok') continue;
    if (numOrNull(s.n) != null) hours.push({ hour: hourNow, sig: `#read:${src}`, cls: 'read', count: s.n });
    if (numOrNull(s.truncated) > 0) hours.push({ hour: hourNow, sig: `#trunc:${src}`, cls: 'trunc', count: s.truncated });
  }
  const status = {
    at: now, ended: parsed.ended, cut: parsed.cut || null, sources: parsed.sources, lineCap: cfg.lineCap, authSrc: parsed.authSrc,
    counts: cls.counts, bursts: cls.bursts.slice(0, 16), ...(prev?.corrupt ? { cursorReset: 'corrupt' } : {}),
  };
  return {
    write: { key, readRev: prev ? prev.rev : null, at: now, state: { pos: parsed.next, carry: cls.carry }, status, ...(prev?.corrupt ? { bad: prev.rawBad || '(손상)' } : {}),
      patterns: [...cls.patterns.values()], hours, sec: [...cls.sec.values()] },
    // 알림 입력은 최근 FRESH_MS 안의 줄만(첫 읽기의 지난 줄 · 시각 모름 줄은 알림이 아니다 — 반증 F6)
    //   분류별 읽기 범위(이번 주기 — classCover): 장애 · 보안을 담는 출처를 하나도 못 읽은 주기는 ‘없음(해소)’ 이 아니라 보류(perfAlerts — 추가 수정)
    alert: { read: Object.values(parsed.sources).some((s) => s.status === 'ok'), faultLines: cls.counts.faultLines, secHigh: cls.counts.secHigh, bursts: cls.counts.freshBursts,
      cover: Object.fromEntries(['fault', 'sec'].map((c) => [c, classCover(c, readNow, parsed.sources).cover])) },
  };
}

/**
 * 주기 끝 — 결과 전부(실제 수집 + 데모)를 한 번에.
 * @param {Array} results  collectOne 결과({target, os:{extra:{logs}}})
 */
export async function finishLogCycle(results = [], ctx = null, { now = Date.now(), demoStdout = null } = {}) {
  const t0 = Date.now();
  _alertIn = new Map();
  if (!ctx?.on) { _last = { at: now, on: false }; return _last; }
  if (!ctx.cursors) { _last = { at: now, on: true, error: ctx.error || 'db-unavailable', written: 0 }; return _last; }
  const items = []; const counts = { servers: 0, read: 0, skipped: 0, failed: 0, notLinux: 0, cut: 0 };
  for (const r of results) {
    const key = r?.target?.key;
    if (!key) continue;
    const demo = typeof demoStdout === 'function' ? demoStdout(r.target, now) : null;
    const ex = demo != null ? { stdout: demo } : r?.os?.extra?.logs;
    if (!ex) { if (r?.os?.ok && r.os.osKind === 'windows') counts.notLinux += 1; continue; }
    counts.servers += 1;
    if (ex.skipped) { counts.skipped += 1; continue; }
    if (typeof ex.stdout !== 'string') { counts.failed += 1; continue; }
    try {
      const b = await buildLogWrite({ key, stdout: ex.stdout, prev: ctx.cursors.get(key) || null, now, cfg: ctx.cfg });
      if (!b.write.status.ended) counts.cut += 1;
      items.push(b.write);
      if (b.alert.read) { _alertIn.set(key, b.alert); counts.read += 1; }
    } catch { counts.failed += 1; }
  }
  let w = { ok: true, written: 0, conflicts: 0, overflow: 0 };
  if (items.length) w = await logWriteBatch({ agent: ctx.agent, items });
  if (!w.ok) _alertIn = new Map();   // 못 쓴 주기는 알림 입력도 버린다(다음 주기에 같은 줄을 다시 읽어 그때 센다 — 두 번 알리지 않게)
  else {
    // 비교 후 쓰기에서 진 서버(conflicts — 다른 주기가 먼저 썼다)는 이번 결과를 버렸다 → 알림 입력에서도 뺀다(반증 의심 — 쓰지 않은 줄로 알리지 않게)
    const wrote = new Set(Array.isArray(w.writtenKeys) ? w.writtenKeys : []);
    for (const k of [..._alertIn.keys()]) if (!wrote.has(k)) _alertIn.delete(k);
  }
  try { await refreshLogSummary({ agent: ctx.agent, now }); } catch { /* 요약 실패는 다음 주기에 */ }
  _last = { at: now, on: true, ms: Date.now() - t0, ...counts, written: w.written ?? 0, conflicts: w.conflicts ?? 0, overflow: w.overflow ?? 0, ...(w.ok ? {} : { error: w.reason || 'write-failed' }) };
  return _last;
}

/** 보존 정리(폴러 pruneTick 이 스로틀해서 부른다) — 설정 보관 일수 밖 + 사라진 서버의 읽기 위치. */
export async function logPruneTick({ agent = config.agent?.name || '', keys = null, now = Date.now() } = {}) {
  const cfg = await settingsOf();
  const before = now - Math.max(1, Number(cfg.keepDays) || LOG_DEFAULTS.keepDays) * 86_400_000;
  return logPrune({ before, agent, keys });
}
