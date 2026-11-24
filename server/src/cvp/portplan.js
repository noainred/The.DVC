/**
 * cvp/portplan.js — ⑤ 미사용 포트 회수 · ⑨ 포트 고갈 · 업링크 포화 예측(순수, v3.38 — docs/design/cvp-network-features §3).
 *
 * 회수: 후보 = 지금 링크 없음(down · nolink) + 마지막 링크 날이 idleDays 넘음. 마지막 링크 날은 일 롤업(링크가 올라온 날만 쌓인다)에서 온다.
 *   · 기록 시작 뒤 한 번도 링크가 없던 포트는 '기록 시작 뒤 사용 없음'(never) — 일수를 지어내지 않고 기록 시작 날을 함께 말한다.
 *   · 장비 기록이 아예 없으면 후보가 아니다(noHistory 로 센다). 관리 포트는 뺀다. 포탈은 회수하지 않는다(읽기 전용 — 권고만).
 * 예측: 최근 기록 직선 추세(trend.forecast) · 기록 minDays 미만이면 '기록 부족' · 늘지 않으면 '예측 없음'.
 *   포트 고갈 = 사용 포트(일 최대) → 전체 포트 · 업링크 포화 = 일 최대 사용률(%) → satPct. 일 최대값 기준이다(95 백분위 아님 — 화면이 밝힌다).
 */
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
  const counts = { short: 0, flat: 0, eta: 0, far: 0, already: 0, none: 0 };
  for (const d of Array.isArray(devices) ? devices : []) {
    const s = series.get(devKey(d.agent, d.cvpId, d.key)) || [];
    if (!s.length) { counts.none++; rows.push({ ...pick(d), state: 'none', days: 0, used: null, total: null, eta: null, perMonth: null, points: [] }); continue; }
    const total = s[s.length - 1][1];
    const f = forecast(s.map((x) => [x[0], x[2]]), { target: total, dir: 'up', minDays, now });
    counts[f.state]++;
    rows.push({ ...pick(d), state: f.state, days: f.days, used: s[s.length - 1][2], total, eta: f.eta, perMonth: f.slopePerDay == null ? null : f.slopePerDay * 30,
      points: s.slice(-FORECAST_WINDOW_DAYS).map((x) => [x[0], x[2]]) });
  }
  const order = { already: 0, eta: 1, far: 2, flat: 3, short: 4, none: 5 };
  rows.sort((a, b) => (order[a.state] - order[b.state]) || ((a.eta ?? Infinity) - (b.eta ?? Infinity)) || String(a.hostname).localeCompare(String(b.hostname)));
  return { rows, counts };
}

/**
 * 업링크 포화 예측 — 포트마다(일 최대 사용률).
 * @param {{ uplinks:Array<{agent,cvpId,key,hostname,port,peer,speedBps}>, series:Map<string, Array<[number, number|null]>> }} a
 */
export function saturationForecast({ uplinks = [], series = new Map(), now = Date.now(), minDays = FORECAST_MIN_DAYS, satPct = UPLINK_SAT_PCT } = {}) {
  const rows = [];
  const counts = { short: 0, flat: 0, eta: 0, far: 0, already: 0 };
  for (const u of Array.isArray(uplinks) ? uplinks : []) {
    const s = series.get(`${devKey(u.agent, u.cvpId, u.key)}\u0000${u.port}`) || [];
    const f = forecast(s, { target: satPct, dir: 'up', minDays, now });
    counts[f.state]++;
    const vals = s.filter((x) => x[1] != null);
    rows.push({ agent: u.agent, cvpId: u.cvpId, key: u.key, hostname: u.hostname, port: u.port, peer: u.peer || '', speedBps: u.speedBps ?? null, basis: u.basis || 'lldp',
      state: f.state, days: f.days, current: f.current, max30: vals.slice(-30).reduce((m, x) => Math.max(m, x[1]), -Infinity), eta: f.eta, perMonth: f.slopePerDay == null ? null : f.slopePerDay * 30,
      points: s.slice(-FORECAST_WINDOW_DAYS) });
  }
  for (const r of rows) if (r.max30 === -Infinity) r.max30 = null;
  const order = { already: 0, eta: 1, far: 2, flat: 3, short: 4 };
  rows.sort((a, b) => (order[a.state] - order[b.state]) || ((a.eta ?? Infinity) - (b.eta ?? Infinity)) || ((b.current ?? -1) - (a.current ?? -1)));
  return { rows, counts, satPct };
}
const pick = (d) => ({ agent: d.agent, cvpId: d.cvpId, key: d.key, hostname: d.hostname || d.key, model: d.model || '', corpName: d.corpName || '' });
