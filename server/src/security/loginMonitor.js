/**
 * 로그인 실패 주기 모니터 — 일정 주기로 로그인 실패를 분석하고, 브루트포스(임계 이상 반복) 의심이
 * 새로 발생하면 알림(설정 > 알림 채널)을 보낸다. 설정은 CONFIG_DIR/login-monitor.json.
 */

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { analyzeLoginFails } from './loginFails.js';
import { notify } from '../alerts.js';
import { atomicWriteFileSync } from '../util/atomicWrite.js';

const FILE = path.join(config.configDir, 'login-monitor.json');
const DEFAULTS = { enabled: true, intervalMin: 15, days: 7, threshold: 5, windowMin: 10, alert: true };

/**
 * 손상 파일 보존 — 파싱 실패를 조용히 기본값으로 되돌리면 다음 저장이 손상본을 덮어써
 * 운영자가 조정한 임계/주기가 조용히 기본값으로 되돌아간 사실조차 알 수 없다.
 * <file>.corrupt.<ts>로 옮겨 두고 경고만 — 기동은 계속(기본값).
 */
function backupCorrupt(err) {
  try {
    const bak = `${FILE}.corrupt.${Date.now()}`;
    fs.renameSync(FILE, bak);
    console.warn(`[loginmon] ${FILE} 읽기/파싱 실패(${err?.message || err}) — ${bak}로 보존하고 기본 설정으로 시작합니다.`);
  } catch { /* 보존 실패가 기동을 막지 않게 */ }
}

let cache = null;
export function loadLoginMonitor() {
  if (cache) return cache;
  cache = { ...DEFAULTS };
  try {
    if (fs.existsSync(FILE)) {
      const p = JSON.parse(fs.readFileSync(FILE, 'utf8'));
      if (!p || typeof p !== 'object' || Array.isArray(p)) throw new Error('객체가 아님'); // 형식 불일치도 손상
      cache = { ...DEFAULTS, ...p };
    }
  } catch (e) { cache = { ...DEFAULTS }; backupCorrupt(e); }
  return cache;
}
export function saveLoginMonitor(body = {}) {
  const c = loadLoginMonitor();
  const next = {
    enabled: body.enabled != null ? !!body.enabled : c.enabled,
    intervalMin: Math.max(1, Math.min(1440, Number(body.intervalMin) || c.intervalMin)),
    days: Math.max(1, Math.min(90, Number(body.days) || c.days)),
    threshold: Math.max(2, Math.min(1000, Number(body.threshold) || c.threshold)),
    windowMin: Math.max(1, Math.min(1440, Number(body.windowMin) || c.windowMin)),
    alert: body.alert != null ? !!body.alert : c.alert,
  };
  // 원자적 쓰기 — 부분기록으로 파일이 깨지면 다음 기동이 조용히 기본값(enabled=true·임계 5)으로
  // 돌아가 운영자가 끈 알림이 되살아나거나 조정한 임계가 사라진다.
  atomicWriteFileSync(FILE, JSON.stringify(next, null, 2), { mode: 0o600 });
  cache = next; reschedule();
  return next;
}

let timer = null;
let lastRun = null;
let lastSummary = null;
const alerted = new Map(); // key -> lastAlertTs (쿨다운)
const COOLDOWN = 60 * 60_000;

async function runOnce() {
  const s = loadLoginMonitor();
  if (!s.enabled) return;
  try {
    const r = await analyzeLoginFails({ days: s.days, threshold: s.threshold, windowMin: s.windowMin });
    lastRun = Date.now(); lastSummary = r.summary;
    if (!s.alert) return;
    const now = Date.now();
    const active = r.offenders.filter((o) => o.active);
    for (const o of active) {
      const k = `${o.label}:${o.key}`;
      if (alerted.has(k) && now - alerted.get(k) < COOLDOWN) continue;
      alerted.set(k, now);
      notify({ key: `loginfail:${k}`, severity: 'critical', title: '로그인 실패 브루트포스 의심', detail: `${o.label === 'user' ? '계정' : '출발지 IP'} ${o.key} — 최근 ${s.windowMin}분 ${o.recent}회(누적 ${o.total}회) 로그인 실패` }).catch(() => {});
    }
    // 쿨다운 만료 정리
    for (const [k, t] of alerted) if (now - t > COOLDOWN) alerted.delete(k);
  } catch (e) { console.warn(`[loginmon] 분석 실패: ${e.message}`); }
}

function reschedule() {
  if (timer) { clearInterval(timer); timer = null; }
  const s = loadLoginMonitor();
  if (!s.enabled) return;
  timer = setInterval(() => runOnce().catch(() => {}), s.intervalMin * 60_000);
  timer.unref?.();
}

export function startLoginMonitor() {
  reschedule();
  setTimeout(() => runOnce().catch(() => {}), 40_000).unref?.();
  console.log('[loginmon] 로그인 실패 모니터 시작');
}

export function loginMonitorStatus() { return { settings: loadLoginMonitor(), lastRun, lastSummary, alertedActive: alerted.size }; }
export { runOnce as runLoginAnalysisNow };
