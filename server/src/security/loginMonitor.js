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
import { numOrNull } from '../util/numOrNull.js';

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

const RANGES = { intervalMin: [1, 1440], days: [1, 90], threshold: [2, 1000], windowMin: [1, 1440] };
function clampNumbers(p) {
  const out = {};
  for (const [k, [lo, hi]] of Object.entries(RANGES)) {
    const n = numOrNull(p?.[k]);
    out[k] = n == null || n <= 0 ? DEFAULTS[k] : Math.max(lo, Math.min(hi, n));
  }
  return out;
}

let cache = null;
export function loadLoginMonitor() {
  if (cache) return cache;
  cache = { ...DEFAULTS };
  try {
    if (fs.existsSync(FILE)) {
      const p = JSON.parse(fs.readFileSync(FILE, 'utf8'));
      if (!p || typeof p !== 'object' || Array.isArray(p)) throw new Error('객체가 아님'); // 형식 불일치도 손상
      // v2.602(감사 TIM2602-04): 로드에도 저장과 같은 범위를 적용한다. 손으로 고친 파일·복원한 백업의 intervalMin 0·''·음수가
      // 그대로 setInterval 로 가서 1ms 루프(초당 약 1,000회 runOnce)가 됐다. 범위 밖·숫자 아님은 기본값이다.
      cache = { ...DEFAULTS, ...p, ...clampNumbers(p) };
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

let running = false;   // v2.575 BUG-21 — 재진입 가드(아래 주석)

/**
 * 로그인 실패 분석 1회.
 *
 * ⚠⚠ v2.575 BUG-21 — **재진입 가드가 없었다.** 이 저장소의 폴러 규약은 두 가지다:
 *  ① `setInterval(()=>asyncFn())` 폴러는 이전 주기가 간격을 넘기면 **중첩 실행**돼 CPU 가 쌓인다
 *  ② **같은 작업의 수동 실행 API 도 그 가드를 공유**한다(`net/monitor.runMonitorNow` 패턴)
 * 이 함수는 둘 다 없어, 관리자가 `POST /admin/security/login-fails/run` 을 연타하면
 * `analyzeLoginFails`(로그 전량 스캔)가 그만큼 동시에 돈다. 2026-09-21 감사 전수 확인 결과
 * **다른 수동 실행 5곳은 전부 가드를 공유하고 있었고 여기만 예외**였다.
 * ⚠ 로컬 DB 조회라 계정 잠금 위험은 없다 — 그래서 🟡 였다. 그래도 규약의 유일한 구멍이다.
 * ⚠ 진행 중이면 **던지지 않고** 사유를 돌려준다 — 수동 실행 라우트가 500 이 되면
 *   관리자가 '고장' 으로 읽는다(연타는 오류가 아니다).
 */
async function runOnce() {
  const s = loadLoginMonitor();
  if (!s.enabled) return undefined;
  if (running) return { skipped: true, reason: '이미 분석이 진행 중입니다 — 이번 요청은 건너뜁니다.' };
  running = true;
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
  finally { running = false; }   // ⚠ 예외·조기 return 어느 쪽이든 반드시 푼다
  return undefined;
}

/** 진행 중인가 — 화면·테스트가 가드의 존재를 확인할 수 있게. */
export const loginMonitorBusy = () => running;

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
