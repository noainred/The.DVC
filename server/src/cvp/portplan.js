/**
 * cvp/portplan.js — ⑤ 미사용 포트 회수 · ⑨ 포트 고갈 · 업링크 포화 예측(순수, v3.38 — docs/design/cvp-network-features §3).
 *
 * 회수: 후보 = 지금 링크 없음(down · nolink) + 마지막 링크 날이 idleDays 넘음. 마지막 링크 날은 일 롤업(링크가 올라온 날만 쌓인다)에서 온다.
 *   · 기록 시작 뒤 한 번도 링크가 없던 포트는 '기록 시작 뒤 사용 없음'(never) — 일수를 지어내지 않고 기록 시작 날을 함께 말한다.
 *   · 장비 기록이 아예 없으면 후보가 아니다(noHistory 로 센다). 관리 포트는 뺀다. 포탈은 회수하지 않는다(읽기 전용 — 권고만).
 * 예측: 최근 기록 직선 추세(trend.forecast) · 기록 minDays 미만이면 '기록 부족' · 늘지 않으면 '예측 없음'.
 *   포트 고갈 = 사용 포트(일 최대) → 전체 포트 · 업링크 포화 = 일 최대 사용률(%) → satPct. 일 최대값 기준이다(95 백분위 아님 — 화면이 밝힌다).
 */
import { createYielder } from '../util/timeSlice.js';
import { forecast, DAY_MS } from './trend.js';

export const IDLE_CHOICES = Object.freeze([30, 90, 180]);
export const RECLAIM_ROWS_MAX = 3000;
export const FORECAST_MIN_DAYS = 90;
export const FORECAST_WINDOW_DAYS = 180;
export const UPLINK_SAT_PCT = 80;
const devKey = (a, c, k) => `${a}\u0000${c}\u0000${k}`;

/**
 * @param {{ ports:Array<{agent,cvpId,key,hostname,port,oper,admin,desc,speedBps}>, last:Map<string,number>, first:Map<string,number>, idleDays:number, now?:number }} a
 */
export function reclaimCandidates({ ports = [], last = new Map(), first = new Map(), idleDays = 90, now = Date.now() } = {}) {
  const counts = { idle: 0, never: 0, noHistory: 0, down: 0, byIdle: Object.fromEntries(IDLE_CHOICES.map((d) => [d, 0])) };
  const rows = [];
  for (const p of Array.isArray(ports) ? ports : []) {
    if (!p || /^management/i.test(String(p.port))) continue;
    if (p.oper !== 'down' && p.oper !== 'nolink') continue;
    counts.down++;
    const dk = devKey(p.agent, p.cvpId, p.key);
    const since = first.get(dk) ?? null;
    if (since == null) { counts.noHistory++; continue; }
    const ll = last.get(`${dk}\u0000${p.port}`) ?? null;
    const idle = ll != null ? Math.floor((now - ll) / DAY_MS) : null;
    const recorded = Math.floor((now - since) / DAY_MS);
    if (ll != null) for (const d of IDLE_CHOICES) if (idle >= d) counts.byIdle[d]++;
    const isIdle = ll != null && idle >= idleDays;
    const isNever = ll == null && recorded >= idleDays;
    if (!isIdle && !isNever) continue;
    counts[isIdle ? 'idle' : 'never']++;
    rows.push({ agent: p.agent, cvpId: p.cvpId, key: p.key, hostname: p.hostname || p.key, port: p.port, desc: p.desc ?? null, speedBps: p.speedBps ?? null,
      oper: p.oper, admin: p.admin || 'unknown', lastLink: ll, idleDays: idle, never: ll == null, since });
  }
  rows.sort((a, b) => (Number(a.never) - Number(b.never)) || ((b.idleDays ?? 0) - (a.idleDays ?? 0)) || String(a.hostname).localeCompare(String(b.hostname)) || String(a.port).localeCompare(String(b.port)));
  return { rows: rows.slice(0, RECLAIM_ROWS_MAX), counts, omitted: Math.max(0, rows.length - RECLAIM_ROWS_MAX) };
}

/**
 * 포트 고갈 예측 — 장비마다.
 * @param {{ devices:Array<{agent,cvpId,key,hostname,model,corpName}>, series:Map<string, Array<[number,number,number]>>, now?:number }} a  series 값 = [dayMs, total, usedMax]
 */
export function exhaustForecast({ devices = [], series = new Map(), now = Date.now(), minDays = FORECAST_MIN_DAYS } = {}) {
  const rows = [];
  const counts = { short: 0, flat: 0, eta: 0, far: 0, already: 0, none: 0, stale: 0 };
  for (const d of Array.isArray(devices) ? devices : []) {
    const s = series.get(devKey(d.agent, d.cvpId, d.key)) || [];
    if (!s.length) { counts.none++; rows.push({ ...pick(d), state: 'none', days: 0, used: null, total: null, eta: null, perMonth: null, points: [] }); continue; }
    // v3.42(버그 점검 1회차 A1-08): 하루 안에 포트 목록이 줄면 그날 '사용 최대' 가 '전체(마지막)' 보다 클 수 있다 — 그런 날은 어긋난 기록이라 쓰지 않는다(지어낸 '이미 고갈').
    const ok = s.filter((x) => x[1] > 0 && x[2] <= x[1]);
    const total = ok.length ? ok[ok.length - 1][1] : 0;
    // 전체 포트 0(포트 목록이 비었던 날)은 '이미 넘음' 이 아니다 — 판정하지 않는다(v3.38 Chromium 측정: 0/0 이 '이미 넘음' 으로 보였다).
    if (!(total > 0)) { counts.none++; rows.push({ ...pick(d), state: 'none', days: 0, used: null, total: null, eta: null, perMonth: null, points: [] }); continue; }
    const f = forecast(ok.map((x) => [x[0], x[2]]), { target: total, dir: 'up', minDays, now });
    counts[f.state] = (counts[f.state] || 0) + 1;
    rows.push({ ...pick(d), state: f.state, days: f.days, used: f.state === 'stale' ? null : ok[ok.length - 1][2], total, lastAt: ok[ok.length - 1][0], eta: f.eta,
      perMonth: f.slopePerDay == null ? null : f.slopePerDay * 30, points: ok.slice(-FORECAST_WINDOW_DAYS).map((x) => [x[0], x[2]]) });
  }
  const order = { already: 0, eta: 1, far: 2, flat: 3, short: 4, stale: 5, none: 6 };
  rows.sort((a, b) => (order[a.state] - order[b.state]) || ((a.eta ?? Infinity) - (b.eta ?? Infinity)) || String(a.hostname).localeCompare(String(b.hostname)));
  // v3.42(2회차 A4-F9): 점은 위험한 순서 앞쪽 행에만(장비마다 180점 — 응답 3.1MB 였다). 포화 예측과 같은 규칙.
  return { rows: rows.map((r, i) => (i < SAT_POINTS_ROWS ? r : { ...r, points: null })), counts, pointsRows: SAT_POINTS_ROWS };
}

/**
 * 업링크 포화 예측 — 포트마다(일 최대 사용률).
 * @param {{ uplinks:Array<{agent,cvpId,key,hostname,port,peer,speedBps}>, series:Map<string, Array<[number, number|null]>> }} a
 */
export const SAT_ROWS_MAX = 1000;
export const SAT_POINTS_ROWS = 300;
function satRow(u, series, now, minDays, satPct) {
  const s = series.get(`${devKey(u.agent, u.cvpId, u.key)}\u0000${u.port}`) || [];
  const f = forecast(s, { target: satPct, dir: 'up', minDays, now });
  // v3.42(A5-D11): '최근 30일 최대' 는 날짜로 자른다(예전 slice(-30) 은 값이 있는 기록 30개라 빠진 날이 있으면 30일보다 길었다).
  const last30 = s.filter((x) => x[1] != null && x[0] >= now - 30 * DAY_MS);
  let lastAt = null;   // v3.42(2회차 A5-F3): 끊긴 행이 '기록 끊김(마지막 —)' 이 되지 않게 마지막 값 있는 날을 싣는다
  for (let i = s.length - 1; i >= 0; i--) if (s[i][1] != null) { lastAt = s[i][0]; break; }
  return { lastAt, agent: u.agent, cvpId: u.cvpId, key: u.key, hostname: u.hostname, port: u.port, peer: u.peer || '', speedBps: u.speedBps ?? null, basis: u.basis || 'lldp',
    state: f.state, days: f.days, current: f.state === 'stale' ? null : f.current, max30: last30.length ? Math.max(...last30.map((x) => x[1])) : null, eta: f.eta,
    perMonth: f.slopePerDay == null ? null : f.slopePerDay * 30, _s: s };
}
function satFinish(rows, satPct) {
  const counts = { short: 0, flat: 0, eta: 0, far: 0, already: 0, stale: 0 };
  for (const r of rows) counts[r.state] = (counts[r.state] || 0) + 1;
  const order = { already: 0, eta: 1, far: 2, flat: 3, short: 4, stale: 5 };
  rows.sort((a, b) => (order[a.state] - order[b.state]) || ((a.eta ?? Infinity) - (b.eta ?? Infinity)) || ((b.current ?? -1) - (a.current ?? -1)));
  // v3.42(A4-F4): 행 상한 · 점은 앞쪽 행에만(15,000행 × 180점 = 12MB 응답 · 동기 직렬화 89ms 였다).
  const out = rows.slice(0, SAT_ROWS_MAX).map(({ _s, ...r }, i) => ({ ...r, points: i < SAT_POINTS_ROWS ? _s.slice(-FORECAST_WINDOW_DAYS) : null }));
  return { rows: out, counts, satPct, omitted: Math.max(0, rows.length - SAT_ROWS_MAX), pointsRows: SAT_POINTS_ROWS };
}
/**
 * 업링크 포화 예측 — 포트마다(일 최대 사용률).
 * @param {{ uplinks:Array<{agent,cvpId,key,hostname,port,peer,speedBps}>, series:Map<string, Array<[number, number|null]>> }} a
 */
export function saturationForecast({ uplinks = [], series = new Map(), now = Date.now(), minDays = FORECAST_MIN_DAYS, satPct = UPLINK_SAT_PCT } = {}) {
  const rows = [];
  for (const u of Array.isArray(uplinks) ? uplinks : []) rows.push(satRow(u, series, now, minDays, satPct));
  return satFinish(rows, satPct);
}
/** 요청 경로용 — 업링크마다 시간 기준 양보(2회차 반증 R6: 상한 6,000 이면 한 덩어리 106~119ms). 결과는 saturationForecast 와 같다. */
export async function saturationForecastAsync({ uplinks = [], series = new Map(), now = Date.now(), minDays = FORECAST_MIN_DAYS, satPct = UPLINK_SAT_PCT } = {}) {
  const rows = []; const y = createYielder(15);
  for (const u of Array.isArray(uplinks) ? uplinks : []) { rows.push(satRow(u, series, now, minDays, satPct)); await y(); }
  return satFinish(rows, satPct);
}
const pick = (d) => ({ agent: d.agent, cvpId: d.cvpId, key: d.key, hostname: d.hostname || d.key, model: d.model || '', corpName: d.corpName || '' });
