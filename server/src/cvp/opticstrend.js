/**
 * cvp/opticstrend.js — ⑮ GBIC 열화 추세 · 재고(순수, v3.38 — docs/design/cvp-network-features §3 'GBIC 추세').
 *
 * 추세: 트랜시버마다 일 최저 Rx(링크가 올라온 날만 — 링크 없는 날은 기록이 없다) · 최근 TREND_DAYS 일 직선 → 주의 · 장애 임계 도달 예상.
 *   기록 TREND_MIN_DAYS 일 미만은 '기록 부족' · 하루 사이 RECOVER_DB 이상 오르면(교체 · 청소) 그날부터 다시 본다.
 * 재고: 트랜시버 종류 × (링크 있음 · 꽂혔지만 링크 없음(예비 재고) · 빈 케이지). 부품 목록을 못 읽은 장비는 따로 센다(0 이 아니다).
 */
import { forecast, sinceLastRecovery } from './trend.js';

export const TREND_DAYS = 30;
export const TREND_MIN_DAYS = 14;
export const RECOVER_DB = 2;
export const TREND_ROWS_MAX = 2000;
const devKey = (a, c, k) => `${a}\u0000${c}\u0000${k}`;

/**
 * @param {{ series:Map<string, Array<[number, number|null, number|null]>>, names:Map<string,{hostname:string, cvpId:string, corpName?:string}>, warnDbm:number, faultDbm:number, now?:number }} a
 *   series 키 = agent␀cvp␀key␀intf
 */
export function opticTrends({ series = new Map(), names = new Map(), warnDbm = -10, faultDbm = -14, now = Date.now(), minDays = TREND_MIN_DAYS } = {}) {
  const rows = [];
  const counts = { short: 0, flat: 0, eta: 0, far: 0, already: 0, alreadyFault: 0, stale: 0 };
  // v3.42(버그 점검 1회차 A1-07 · A2-F3): 창은 '최근 TREND_DAYS 일'(날짜) — 예전 slice(-30) 은 링크가 있던 날만 행이 있어 '최근 30개 점' 이 최대 90일에 걸쳤고,
  //   61일 전에 끊긴 포트가 '오늘 주의 도달' 로 맨 위에 왔다. 마지막 기록이 오래됐으면 stale(forecast).
  const from = now - TREND_DAYS * 86_400_000;
  for (const [k, pts0] of series) {
    const [agent, cvpId, key, intf] = k.split('\u0000');
    const all = pts0.map((x) => [x[0], x[1]]);
    const { points, resetAt } = sinceLastRecovery(all.filter((x) => x[0] >= from), RECOVER_DB);
    const fw = forecast(points, { target: warnDbm, dir: 'down', minDays, now });
    const ff = forecast(points, { target: faultDbm, dir: 'down', minDays, now });
    const state = ff.state === 'already' ? 'alreadyFault' : (fw.state === 'stale' || (!points.length && all.length)) ? 'stale' : fw.state;
    counts[state] = (counts[state] || 0) + 1;
    const n = names.get(devKey(agent, cvpId, key)) || {};
    rows.push({ agent, cvpId, key, hostname: n.hostname || key, corpName: n.corpName || '', intf, state, days: fw.days, current: state === 'stale' ? null : fw.current,
      lastAt: all.length ? all[all.length - 1][0] : null, perMonth: fw.slopePerDay == null ? null : fw.slopePerDay * 30, warnEta: fw.eta, faultEta: ff.eta, resetAt, _all: all });
  }
  const order = { alreadyFault: 0, already: 1, eta: 2, far: 3, flat: 4, short: 5, stale: 6 };
  rows.sort((a, b) => (order[a.state] - order[b.state]) || ((a.warnEta ?? Infinity) - (b.warnEta ?? Infinity)) || ((a.current ?? 99) - (b.current ?? 99)));
  // v3.42(A4-F2): 점 배열은 내보내는 행에만 만든다(1.5만 계열 전부에 90점을 만들어 한 덩어리 268ms · 응답 4.4MB 였다).
  const shown = rows.slice(0, TREND_ROWS_MAX).map(({ _all, ...r }) => ({ ...r, points: _all.filter((x) => x[0] >= from) }));
  return { rows: shown, counts, omitted: Math.max(0, rows.length - TREND_ROWS_MAX), thresholds: { warnDbm, faultDbm } };
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
      else if (p.optic && typeof p.optic === 'object' && typeof p.optic.linked === 'boolean') slot = p.optic.linked ? 'linked' : 'spare';
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
