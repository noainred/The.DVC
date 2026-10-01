/**
 * 로그인 실패 분석 — vCenter 이벤트 로그(장기보관 DB)에서 로그인 실패를 분류하고, 포탈 자체
 * 실패와 합쳐 사용자/출발지IP/대상별로 집계한다. 브루트포스(임계 이상 반복)를 탐지한다.
 */

import { getLogsDb } from '../logs/db.js';
import { isLoginFailRow } from '../logs/loginFailPattern.js';
import { createYielder } from '../util/timeSlice.js';
import { getStoredFails } from './loginStore.js';
import { numOrNull } from '../util/numOrNull.js';

const DAY = 86_400_000;
const IPV4 = /(?:\d{1,3}\.){3}\d{1,3}/;

// v2.673: 판정 정규식은 logs/loginFailPattern.js 하나다(SQL 후보 조건과 짝 — 한쪽만 고치면 놓친다).
const isLoginFail = isLoginFailRow;
const srcIp = (e) => (e.ip || IPV4.exec(e.message || '')?.[0] || '');

/*
 * v2.673(2026-10-01 운영 장애 — stallwatch 스택 analyzeLoginFails, 14초 넘게 정지):
 * 예전에는 vCenter 이벤트 7일치를 'login'·'auth'·'fail'·'로그인' 으로 **네 번** LIKE 검색했다(검색어마다 5,000행).
 *  ① 드문 단어는 매번 7일치 전체를 동기로 훑었다(재현: 이벤트 100만 행에 1회 849ms — 운영은 그보다 많다) — 기본 켜짐·15분 주기.
 *  ② 흔한 'login'(정상 로그인 이벤트)이 5,000행 상한을 채워 실제 실패를 덜 셌다(재현: 1,000건 중 30건).
 * 이제 좁은 조건 하나(정규식과 같은 뜻)로 **1시간 조각씩 한 번만** 훑고 조각 사이에 시간 기준으로 양보한다.
 * 상한은 '실패 후보' 에만 걸리고, 걸리면 scan.truncated 로 밝힌다(최근 것부터 담는다).
 */
const CHUNK_MS = 3_600_000;
export const LOGIN_FAIL_ROWS_MAX = 20_000;

/*
 * 증분(주기 감시 전용 — loginMonitor 가 deps.incremental 로 부른다). 15분마다 7일치를 다시 훑으면 이벤트가 많은 현장에서
 * 총 CPU 가 크다(재현: 100만 행에 약 1.5초 — 조각으로 나눠 멈춤은 없지만 매번 같은 일을 한다). 그래서
 *  · 직전 결과를 들고 있다가 **마지막으로 훑은 시각 − 2시간**부터만 다시 훑는다(엣지 push·수집 지연으로 늦게 들어온 이벤트).
 *  · 그보다 더 늦게 들어온 이벤트는 **6시간마다 한 번** 전 범위를 다시 훑을 때 들어온다(그 사이에는 빠질 수 있다 — 정직 기록).
 *  · 범위(vCenter)·기간(days)이 바뀌면 처음부터 다시 훑는다.
 * 화면의 수동 분석은 증분을 쓰지 않는다(언제나 전 범위 — 사람이 누를 때만이다).
 */
export const LOGIN_FAIL_OVERLAP_MS = 2 * 3_600_000;
export const LOGIN_FAIL_FULL_EVERY_MS = 6 * 3_600_000;
const inc = { key: '', fails: [], upTo: 0, fullAt: 0 };
/** 테스트 전용 — 증분 상태를 비운다. */
export function _resetLoginFailIncForTest() { inc.key = ''; inc.fails = []; inc.upTo = 0; inc.fullAt = 0; }

/** [from, ∞) 를 최근 1시간 조각부터 거슬러 훑어 실패를 모은다(최신순). scan 을 채운다. */
async function scanVcFails({ read, vcenterId, from, now, rowsMax, maybeYield, scan }) {
  const seen = new Set();
  const out = [];
  // 첫 조각은 위쪽이 열려 있다 — vCenter 시계가 포탈보다 앞서 '미래 시각' 으로 찍힌 실패도 빠뜨리지 않게(예전 쿼리와 같다).
  for (let hi = null, lo = now - CHUNK_MS; read; hi = Math.max(from, lo), lo -= CHUNK_MS) {
    const lower = Math.max(from, lo);
    await maybeYield();
    scan.chunks++;
    const room = rowsMax - out.length;
    let rows = [];
    // v2.682(감사 R3E-02): 조각 읽기 실패(DB 잠김·I/O 오류)를 '실패 0건' 으로 삼키지 않는다 — 세고, 사유를 남긴다.
    //   결과는 incomplete 이고 증분 상태는 전진하지 않는다(analyzeLoginFails). 나머지 조각은 계속 읽는다(일시 잠금일 수 있다).
    try { rows = read({ vcenterId: vcenterId || '', since: lower, ...(hi != null ? { until: hi - 1 } : {}) }, room + 1); }
    catch (e) { rows = []; scan.failedChunks += 1; if (!scan.error) scan.error = String(e?.message || e).slice(0, 300); }
    scan.candidates += rows.length;
    for (const e of rows) {
      const id = `${e.vcenterId}|${e.ts}|${e.type}|${e.user}`;
      if (seen.has(id) || !isLoginFail(e)) continue;
      if (out.length >= rowsMax) { scan.truncated = true; break; }
      seen.add(id);
      out.push({ ts: e.ts, source: e.vcenterId, kind: 'vcenter', user: (e.user || '').trim() || '(unknown)', ip: srcIp(e), type: e.type, message: e.message });
    }
    if (scan.truncated || lower <= from) break;
  }
  return out;
}

/*
 * v2.680 C-01: 분석 인자의 허용 범위 — security/loginMonitor.js RANGES 와 같은 값이다(설정 저장은 거기서 자른다).
 * 예전 GET 라우트는 쿼리값을 그대로 넘겨 ?days=Infinity 면 since=-Infinity 라 조각 루프가 끝나지 않았다(재현: 3초에 조회 1,258만 회).
 * 클램프는 헬퍼 안에도 둔다 — 새 호출부도 자동으로 보호된다(v2.574 rangeOf 규약). 못 읽은 값(빈 값·NaN·0 이하)은 기본값.
 */
export const LOGIN_FAIL_RANGES = Object.freeze({ days: [1, 90], threshold: [2, 1000], windowMin: [1, 1440] });
export const LOGIN_FAIL_DEFAULTS = Object.freeze({ days: 7, threshold: 5, windowMin: 10 });
export function clampLoginFailParams(p = {}, defaults = LOGIN_FAIL_DEFAULTS) {
  const out = {};
  for (const [k, [lo, hi]] of Object.entries(LOGIN_FAIL_RANGES)) {
    const n = numOrNull(p?.[k]);
    const d = numOrNull(defaults?.[k]);
    const v = n == null || n <= 0 ? (d == null || d <= 0 ? LOGIN_FAIL_DEFAULTS[k] : d) : n;
    out[k] = Math.max(lo, Math.min(hi, v));
  }
  return out;
}

/**
 * @param opts { vcenterId?, days=7, threshold=5, windowMin=10 }
 * threshold: 같은 사용자/IP가 이 횟수 이상이면 브루트포스 의심. windowMin: 활성 브루트포스 판정 창.
 */
export async function analyzeLoginFails(opts = {}, deps = {}) {
  const vcenterId = opts?.vcenterId || '';
  const { days, threshold, windowMin } = clampLoginFailParams(opts);
  const db = deps.db || await getLogsDb();
  const now = Number.isFinite(deps.now) ? deps.now : Date.now();
  const since = now - Math.max(1, days) * DAY;
  const rowsMax = Number.isFinite(deps.rowsMax) && deps.rowsMax > 0 ? deps.rowsMax : LOGIN_FAIL_ROWS_MAX;
  const maybeYield = createYielder(Number.isFinite(deps.sliceMs) ? deps.sliceMs : 15);
  const t0 = performance.now();

  // vCenter 이벤트에서 로그인 실패 후보를 좁은 조건 하나로, 최근 1시간 조각부터 거슬러 가져와 정규식으로 분류.
  // v2.675: rowsMax·days 를 싣는다 — 화면이 '최근 N건까지만 셌다' 를 숫자를 박지 않고 말한다.
  const scan = { chunks: 0, candidates: 0, failedChunks: 0, error: null, truncated: false, ms: 0, source: 'candidates', mode: 'full', from: since, rowsMax, days: Math.max(1, days) };
  const read = typeof db.loginFailCandidates === 'function' ? db.loginFailCandidates : null;
  if (!read) scan.source = 'unavailable';   // 구버전 db 객체 — 네 단어 전 범위 검색(정지 원인)으로 되돌리지 않는다
  const key = `${vcenterId || ''}|${Math.max(1, days)}`;
  const canInc = !!deps.incremental && read && inc.key === key && inc.upTo > since && now - inc.fullAt < LOGIN_FAIL_FULL_EVERY_MS;
  let vcFails;
  if (canInc) {
    const from = Math.max(since, inc.upTo - LOGIN_FAIL_OVERLAP_MS);
    const fresh = await scanVcFails({ read, vcenterId, from, now, rowsMax, maybeYield, scan });
    // [from, ∞) 는 방금 다시 훑은 값으로 바꾸고, 그 이전은 직전 결과에서 기간 안의 것만 이어 붙인다(ts 로 갈라 겹치지 않는다).
    vcFails = [...fresh, ...inc.fails.filter((f) => f.ts >= since && f.ts < from)];
    if (vcFails.length > rowsMax) { vcFails = vcFails.slice(0, rowsMax); scan.truncated = true; }
    scan.mode = 'incremental'; scan.from = from;
  } else {
    vcFails = await scanVcFails({ read, vcenterId, from: since, now, rowsMax, maybeYield, scan });
    if (deps.incremental && !scan.failedChunks) inc.fullAt = now;
  }
  // v2.682(감사 R3E-02): 일부 조각을 못 읽었으면 그 결과를 다음 증분의 기준으로 삼지 않는다(upTo 를 전진시키면 못 읽은 구간이
  //   다음 주기에도 빠진다 — 겹침 2시간 밖이면 영영). 상태는 그대로 두고 다음 주기가 같은 범위를 다시 훑는다.
  const incomplete = scan.failedChunks > 0;
  if (deps.incremental && read && !incomplete) { inc.key = key; inc.fails = vcFails; inc.upTo = now; }
  scan.ms = Math.round(performance.now() - t0);
  // 저장된 실패(포탈 + 게스트 OS 조사). vCenter 범위 지정 시 게스트는 그 vCenter만.
  const stored = getStoredFails(since)
    .filter((r) => !vcenterId || r.kind === 'portal' || r.vcenterId === vcenterId)
    .map((r) => ({ ts: r.ts, source: r.kind === 'guest' ? (r.vm || r.vcenterId || 'guest') : 'portal', kind: r.kind, user: r.user || '(unknown)', ip: r.ip || '', type: r.kind === 'guest' ? `GuestLoginFail${r.os ? `(${r.os})` : ''}` : 'PortalLoginFail', message: r.reason || '' }));
  const guestFails = stored.filter((r) => r.kind === 'guest');
  const portalFails = stored.filter((r) => r.kind === 'portal');

  const all = [...vcFails, ...stored].sort((a, b) => b.ts - a.ts);

  // 집계
  const byUser = new Map(); const byIp = new Map(); const bySource = new Map();
  const bump = (m, k) => { if (!k) return; m.set(k, (m.get(k) || 0) + 1); };
  for (const f of all) { bump(byUser, f.user); if (f.ip) bump(byIp, f.ip); bump(bySource, f.source); }
  const top = (m, n = 15) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([key, count]) => ({ key, count }));

  // 브루트포스 탐지: 사용자/IP 단위로 전체 윈도 누적 + 최근 windowMin 내 집중.
  // v2.675: 대상마다 전체 실패 목록을 다시 훑지 않는다(예전 filter·find — 대상 수 × 실패 수. 계정명을 바꿔 가며 5번씩 실패하는
  //   스프레이 공격이면 대상 수천 × 실패 2만 = 수억 번 비교로 수백 ms~초를 동기로 썼다). 한 번 훑어 최근 횟수·마지막 시각을 센다.
  //   all 은 최신순이므로 처음 만난 시각이 마지막 시각이다(예전 find 와 같다).
  // v2.675: 기준 시각은 분석 시각(now — deps 로 고정 가능)이다. 예전 Date.now() 는 분석 기간(since)과 다른 시계를 썼다.
  const winCut = now - windowMin * 60_000;
  const recentBy = { user: new Map(), ip: new Map() };
  const lastBy = { user: new Map(), ip: new Map() };
  for (const f of all) {
    for (const label of ['user', 'ip']) {
      const key = label === 'user' ? f.user : f.ip;
      if (!key) continue;
      if (!lastBy[label].has(key)) lastBy[label].set(key, f.ts);
      if (f.ts >= winCut) recentBy[label].set(key, (recentBy[label].get(key) || 0) + 1);
    }
  }
  const offenders = [];
  const offByKey = (label, m) => {
    for (const [key, count] of m) {
      if (count < threshold) continue;
      const recent = recentBy[label].get(key) || 0;
      offenders.push({ label, key, total: count, recent, active: recent >= threshold, lastTs: lastBy[label].get(key) });
    }
  };
  offByKey('user', byUser); offByKey('ip', byIp);
  offenders.sort((a, b) => (b.active - a.active) || (b.recent - a.recent) || (b.total - a.total));

  // 시간대별(시간 버킷) 추세(최근 days).
  const hourly = new Map();
  for (const f of all) { const h = Math.floor(f.ts / 3_600_000) * 3_600_000; hourly.set(h, (hourly.get(h) || 0) + 1); }
  const timeline = [...hourly.entries()].sort((a, b) => a[0] - b[0]).slice(-Math.min(days * 24, 336)).map(([ts, count]) => ({ ts, count }));

  return {
    config: { days, threshold, windowMin, vcenterId: vcenterId || '' },
    summary: {
      total: all.length, vcenter: vcFails.length, portal: portalFails.length, guest: guestFails.length,
      users: byUser.size, ips: byIp.size,
      offenders: offenders.length, active: offenders.filter((o) => o.active).length,
    },
    offenders: offenders.slice(0, 50),
    topUsers: top(byUser), topIps: top(byIp), bySource: top(bySource, 30),
    timeline,
    recent: all.slice(0, 100),
    // v2.682(감사 R3E-02): vCenter 이벤트 일부를 못 읽었다 — 합계는 '실패 0건' 이 아니라 '확인 불가가 섞인 하한' 이다.
    incomplete,
    scan,   // v2.673: 훑은 조각 수·후보 수·상한으로 잘렸는지·소요(정직 — 잘렸으면 화면이 '최근 N건까지' 라고 말할 수 있다)
    generatedAt: Date.now(),
  };
}
