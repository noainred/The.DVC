/**
 * cvp/opticstrend.js — ⑮ GBIC 열화 추세 · 재고(순수, v3.38 — docs/design/cvp-network-features §3 'GBIC 추세').
 *
 * 추세: 트랜시버마다 일 최저 Rx(링크가 올라온 날만 — 링크 없는 날은 기록이 없다) · 최근 TREND_DAYS 일 직선 → 주의 · 장애 임계 도달 예상.
 *   기록 TREND_MIN_DAYS 일 미만은 '기록 부족' · 하루 사이 RECOVER_DB 이상 오르면(교체 · 청소) 그날부터 다시 본다.
 * 재고: 트랜시버 종류 × (링크 있음 · 꽂혔지만 링크 없음(예비 재고) · 빈 케이지). 부품 목록을 못 읽은 장비는 따로 센다(0 이 아니다).
 */
import { forecast, sinceLastRecovery } from './trend.js';
import { createYielder } from '../util/timeSlice.js';

export const TREND_DAYS = 30;
export const TREND_MIN_DAYS = 14;
export const RECOVER_DB = 2;
export const TREND_ROWS_MAX = 2000;
const devKey = (a, c, k) => `${a}\u0000${c}\u0000${k}`;

/**
 * v3.47(결정 D-7 — 사용자 선택 '권고'): 광모듈 Rx 기준 — 장비가 낮은 쪽 임계(LowWarn · LowAlarm)를 주면 그것, 없으면 포탈 설정(CVP 설정 화면).
 *   실시간 GBIC 판정(parse.judgeOptics — 장비 임계 먼저)과 같은 순서다. 예전에는 추세 · 링크 품질만 포탈 임계를 써서, 정상 Rx 가 -18dBm 인 장거리 광모듈이
 *   실시간 '정상' · 추세 '이미 장애' · 링크 품질 '교체' 로 화면마다 달랐다. 장비 임계 중 하나만 있으면 없는 쪽은 예측하지 않는다(null — 포탈 값과 섞지 않는다).
 * @returns {{ basis:'device'|'portal', warnDbm:number|null, faultDbm:number|null }}
 */
export function rxLimitsOf(optic, { warnDbm = -10, faultDbm = -14 } = {}) {
  const ok = (v) => (v != null && Number.isFinite(Number(v)) && Number(v) >= -60 && Number(v) <= 15 ? Number(v) : null);
  const w = optic && typeof optic === 'object' ? ok(optic.devWarnDbm) : null;
  const f = optic && typeof optic === 'object' ? ok(optic.devFaultDbm) : null;
  if (w != null || f != null) return { basis: 'device', warnDbm: w, faultDbm: f };
  return { basis: 'portal', warnDbm, faultDbm };
}
/** 장비들의 트랜시버별 기준 — 키 = agent␀cvp␀key␀intf(xcvr_daily 와 같은 인터페이스 이름 규칙: optic.intf). 장비 임계가 있는 것만 담는다. */
export function deviceRxLimits(devices = [], portal = {}) {
  const m = new Map();
  for (const d of Array.isArray(devices) ? devices : []) {
    if (!Array.isArray(d?.partsList)) continue;
    for (const p of d.partsList) {
      const o = p && p.kind === 'xcvr' && p.optic && typeof p.optic === 'object' ? p.optic : null;
      if (!o || typeof o.intf !== 'string' || !o.intf) continue;
      const lim = rxLimitsOf(o, portal);
      if (lim.basis === 'device') m.set(`${devKey(d.agent ?? '', d.cvpId, d.key)}\u0000${o.intf}`, lim);
    }
  }
  return m;
}

/**
 * @param {{ series:Map<string, Array<[number, number|null, number|null]>>, names:Map<string,{hostname:string, cvpId:string, corpName?:string}>, warnDbm:number, faultDbm:number, now?:number }} a
 *   series 키 = agent␀cvp␀key␀intf
 */
function trendCtx({ names = new Map(), warnDbm = -10, faultDbm = -14, limits = null, now = Date.now(), minDays = TREND_MIN_DAYS } = {}) {
  return { names, warnDbm, faultDbm, limits, now, minDays, from: now - TREND_DAYS * 86_400_000, rows: [], counts: { short: 0, flat: 0, eta: 0, far: 0, already: 0, alreadyFault: 0, stale: 0 }, deviceBasis: 0 };
}
function trendRow(ctx, k, pts0) {
  const { names, now, minDays, from, rows, counts } = ctx;
  const [agent, cvpId, key, intf] = k.split('\u0000');
  // v3.47(D-7): 그 광모듈의 장비 임계가 있으면 그것(rxLimitsOf) — 없으면 포탈 임계
  const lim = (ctx.limits && ctx.limits.get(k)) || { basis: 'portal', warnDbm: ctx.warnDbm, faultDbm: ctx.faultDbm };
  if (lim.basis === 'device') ctx.deviceBasis++;
  const { warnDbm, faultDbm } = lim;
  const all = pts0.map((x) => [x[0], x[1]]);
  const { points, resetAt } = sinceLastRecovery(all.filter((x) => x[0] >= from), RECOVER_DB);
  const fw = forecast(points, { target: warnDbm, dir: 'down', minDays, now });
  const ff = forecast(points, { target: faultDbm, dir: 'down', minDays, now });
  const state = ff.state === 'already' ? 'alreadyFault' : (fw.state === 'stale' || (!points.length && all.length)) ? 'stale' : fw.state;
  counts[state] = (counts[state] || 0) + 1;
  const n = names.get(devKey(agent, cvpId, key)) || {};
  // v3.42(2회차 A1-F9): 끊긴(stale) 행도 마지막으로 잰 값(lastRx)을 싣는다 — 장애 수준 Rx 로 링크가 끊긴 광모듈이 3일 뒤 '위험만 보기' 에서 사라졌다(화면이 lastRx 로 위험에 넣는다).
  let lastRx = null;
  for (let i = all.length - 1; i >= 0; i--) if (all[i][1] != null) { lastRx = all[i][1]; break; }
  rows.push({ agent, cvpId, key, hostname: n.hostname || key, corpName: n.corpName || '', intf, state, days: fw.days, current: state === 'stale' ? null : fw.current,
    lastAt: all.length ? all[all.length - 1][0] : null, lastRx, perMonth: fw.slopePerDay == null ? null : fw.slopePerDay * 30, warnEta: fw.eta, faultEta: ff.eta, resetAt,
    basis: lim.basis, warnDbm, faultDbm, _all: all });
}
function trendFinish(ctx) {
  const { rows, counts, from, warnDbm, faultDbm } = ctx;
  const order = { alreadyFault: 0, already: 1, eta: 2, far: 3, flat: 4, short: 5, stale: 6 };
  // 끊긴 행 중 마지막 값이 그 광모듈의 임계 이하인 것은 위험 행 바로 뒤(정렬 상한 TREND_ROWS_MAX 에 잘리지 않게)
  const low = (r) => (r.warnDbm != null ? r.warnDbm : r.faultDbm);
  const ord = (r) => (r.state === 'stale' && r.lastRx != null && low(r) != null && r.lastRx <= low(r) ? 2.5 : order[r.state]);
  rows.sort((a, b) => (ord(a) - ord(b)) || ((a.warnEta ?? Infinity) - (b.warnEta ?? Infinity)) || ((a.current ?? a.lastRx ?? 99) - (b.current ?? b.lastRx ?? 99)));
  // v3.42(A4-F2): 점 배열은 내보내는 행에만 만든다(1.5만 계열 전부에 90점을 만들어 한 덩어리 268ms · 응답 4.4MB 였다).
  const shown = rows.slice(0, TREND_ROWS_MAX).map(({ _all, ...r }) => ({ ...r, points: _all.filter((x) => x[0] >= from) }));
  return { rows: shown, counts, omitted: Math.max(0, rows.length - TREND_ROWS_MAX), thresholds: { warnDbm, faultDbm }, deviceBasis: ctx.deviceBasis };
}
/**
 * 트랜시버별 추세. 창은 '최근 TREND_DAYS 일'(날짜 — v3.42 1회차 A1-07 · A2-F3: 예전 slice(-30) 은 '최근 30개 점' 이 최대 90일에 걸쳤다) · 마지막 기록이 오래됐으면 stale.
 */
export function opticTrends(opts = {}) {
  const ctx = trendCtx(opts);
  for (const [k, pts] of opts.series || new Map()) trendRow(ctx, k, pts);
  return trendFinish(ctx);
}
/** 요청 경로용 — 계열마다 시간 기준 양보(v3.42 2회차 A4-F2: 1.5만 계열을 한 덩어리 212~246ms 돌았다). 결과는 opticTrends 와 같다. */
export async function opticTrendsAsync(opts = {}) {
  const ctx = trendCtx(opts); const y = createYielder(15);
  for (const [k, pts] of opts.series || new Map()) { trendRow(ctx, k, pts); await y(); }
  return trendFinish(ctx);
}

/** 재고 — devices: [{ partsList, ports? }] · 포트 oper 로 '링크 있음' 을 가른다(optic.linked 가 있으면 그 값). */
export function opticInventory(devices = []) {
  const byType = new Map();
  const tot = { linked: 0, spare: 0, empty: 0, unknown: 0, devicesUnread: 0 };
  for (const d of Array.isArray(devices) ? devices : []) {
    const xs = Array.isArray(d.partsList) ? d.partsList.filter((p) => p && p.kind === 'xcvr') : null;
    if (!xs || !xs.length) { tot.devicesUnread++; continue; }
    for (const p of xs) {
      const type = p.state === 'absent' ? null : (typeof p.media === 'string' && p.media.trim() ? p.media.trim().slice(0, 48) : '종류 모름');
      let slot;
      if (p.state === 'absent') slot = 'empty';
      else if (p.optic && typeof p.optic === 'object' && typeof p.optic.linked === 'boolean') slot = p.optic.linked || p.optic.lanesPartial === true ? 'linked' : 'spare';
      else slot = 'unknown';
      tot[slot]++;
      if (!type) continue;
      if (!byType.has(type)) byType.set(type, { type, linked: 0, spare: 0, unknown: 0 });
      byType.get(type)[slot]++;
    }
  }
  const rows = [...byType.values()].sort((a, b) => (b.linked + b.spare + b.unknown) - (a.linked + a.spare + a.unknown) || a.type.localeCompare(b.type));
  return { rows, totals: tot };
}
