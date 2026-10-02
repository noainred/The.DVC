/**
 * horizon/appUsageReport.js — 앱별 사용 누적 보고서 조립(v2.684, **순수 모듈**).
 *
 * 입력은 `sessionDb.hzUsageRange()`(기간 안의 사용자×서비스 쌍·날짜별 고유 수·날짜별 수집 횟수)와
 * 최신 서버 레코드(지금 접속 중 — `latest.services`)다. DB 왕복은 없다.
 *
 * ── 정직성 규칙 ────────────────────────────────────────────────────────────────
 * 1. **누적은 하한이다.** 수집은 주기 폴링이라 주기보다 짧게 열고 닫은 세션은 잡히지 않는다.
 *    그 사실과 주기를 `lowerBound` 와 함께 싣는다(화면이 매번 말한다).
 * 2. **수집이 없던 날은 0명이 아니다.** 날짜별 `okCycles` 가 0 이면 사용자 수는 `null` 이다.
 *    수집이 일부만 된 날은 `partial` 로 밝힌다(기대 횟수 = 하루 / 주기 × 서버 수의 절반 미만).
 * 3. **같은 사람은 서버가 달라도 1명이다** — 키는 소문자 계정(`curuser/aggregate.userKey`)이다.
 * 4. 상한으로 자른 목록은 개수를 밝힌다(`usersOmitted`·`servicesOmitted`·`pairsOmitted`).
 */
import { dayKey, DAY_MS } from '../util/dayKey.js';

const n = (v) => (v == null || v === '' ? null : (Number.isFinite(Number(v)) ? Number(v) : null));

/** 기간(일 수) → 포탈 날짜 양끝. 1 = 오늘만. */
export function dayRange(days, now = Date.now()) {
  const d = Math.max(1, Math.round(Number(days) || 1));
  return { fromDay: dayKey(now - (d - 1) * DAY_MS), toDay: dayKey(now), days: d };
}

/** fromDay..toDay 의 날짜 목록(포탈 날짜 문자열). */
export function daysBetween(fromDay, toDay) {
  const out = [];
  const a = Date.parse(`${fromDay}T00:00:00Z`); const b = Date.parse(`${toDay}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return out;
  for (let t = a; t <= b && out.length < 400; t += DAY_MS) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

/**
 * @param {object} range   hzUsageRange() 결과
 * @param {object} p
 * @param {string} p.fromDay
 * @param {string} p.toDay
 * @param {number} p.intervalMs  수집 주기(서버 설정 — 숫자를 화면에 박지 않는다)
 * @param {number} p.servers     대상 서버 수(기대 수집 횟수 계산용)
 * @param {object[]} [p.liveServices]  지금 접속 중 — 최신 서버 레코드들의 services 를 이어붙인 것
 */
export function buildUsageReport(range, { fromDay, toDay, intervalMs, servers = 1, liveServices = [], liveServers = 0, maxUsers = 2000, maxServices = 500, maxPairs = 20000 } = {}) {
  const pairs = Array.isArray(range?.pairs) ? range.pairs : [];
  const svc = new Map();
  const usr = new Map();
  for (const p of pairs) {
    if (!p?.userKey || !p?.serviceKey) continue;
    let s = svc.get(p.serviceKey);
    if (!s) { s = { key: p.serviceKey, name: p.service || p.serviceKey, kind: p.kind || 'unknown', basis: p.basis || '', users: 0, userDays: 0, firstTs: null, lastTs: null, connectedUsersNow: null, sessionsNow: null }; svc.set(p.serviceKey, s); }
    s.users += 1;
    s.userDays += Number(p.days) || 0;
    if (p.firstTs != null && (s.firstTs == null || p.firstTs < s.firstTs)) s.firstTs = p.firstTs;
    if (p.lastTs != null && (s.lastTs == null || p.lastTs > s.lastTs)) s.lastTs = p.lastTs;
    let u = usr.get(p.userKey);
    if (!u) { u = { key: p.userKey, name: p.user || p.userKey, days: null, services: [], lastTs: null }; usr.set(p.userKey, u); }
    if (p.user) u.name = p.user;
    u.services.push({ key: p.serviceKey, name: p.service || p.serviceKey, kind: p.kind || 'unknown', days: Number(p.days) || 0, lastTs: p.lastTs ?? null });
    if (p.lastTs != null && (u.lastTs == null || p.lastTs > u.lastTs)) u.lastTs = p.lastTs;
  }
  for (const r of range?.userDays || []) { const u = usr.get(r.userKey); if (u) u.days = Number(r.days) || 0; }
  // 지금 접속 중(최신 레코드) — 같은 서비스가 두 서버에 있으면 합친다. 사용자 수는 서버별 고유의 합이라 **하한이 아니라 상한일 수 있다**
  //   (같은 사람이 두 팟에 동시 접속). 그래서 `nowBySum` 으로 밝힌다.
  const liveSeen = new Map();
  for (const l of liveServices || []) {
    if (!l?.key) continue;
    const e = liveSeen.get(l.key) || { users: null, sessions: null, n: 0 };
    if (l.usersConnected != null) e.users = (e.users || 0) + Number(l.usersConnected);
    e.sessions = (e.sessions || 0) + (Number(l.sessions) || 0);
    e.n++;
    liveSeen.set(l.key, e);
    if (!svc.has(l.key)) svc.set(l.key, { key: l.key, name: l.name || l.key, kind: l.kind || 'unknown', basis: l.basis || '', users: 0, userDays: 0, firstTs: null, lastTs: null, connectedUsersNow: null, sessionsNow: null });
  }
  for (const [k, e] of liveSeen) { const s = svc.get(k); s.connectedUsersNow = e.users; s.sessionsNow = e.sessions; s.nowBySum = e.n > 1; }

  const services = [...svc.values()].sort((a, b) => b.users - a.users || (b.connectedUsersNow ?? 0) - (a.connectedUsersNow ?? 0) || String(a.name).localeCompare(String(b.name), 'ko'));
  const users = [...usr.values()].map((u) => ({ ...u, services: u.services.sort((a, b) => b.days - a.days || String(a.name).localeCompare(String(b.name), 'ko')) }))
    .sort((a, b) => (b.days ?? 0) - (a.days ?? 0) || b.services.length - a.services.length || String(a.name).localeCompare(String(b.name), 'ko'));

  // 날짜별 — 수집이 없던 날은 null(0 이 아니다), 일부만 된 날은 partial.
  const perDay = Math.max(1, Math.round(DAY_MS / Math.max(60_000, Number(intervalMs) || 300_000)));
  const expected = perDay * Math.max(1, Number(servers) || 1);
  const cov = new Map();
  for (const c of range?.cover || []) {
    const e = cov.get(c.day) || { cycles: 0, okCycles: 0, servers: new Set() };
    e.cycles += Number(c.cycles) || 0; e.okCycles += Number(c.okCycles) || 0; if (c.okCycles > 0) e.servers.add(c.serverId);
    cov.set(c.day, e);
  }
  const dly = new Map((range?.daily || []).map((d) => [d.day, d]));
  const today = toDay;
  const daily = daysBetween(fromDay, toDay).map((day) => {
    const c = cov.get(day);
    const ok = c ? c.okCycles : 0;
    const d = dly.get(day);
    return {
      day,
      users: ok > 0 ? (d ? d.users : 0) : null,
      services: ok > 0 ? (d ? d.services : 0) : null,
      cycles: c ? c.cycles : 0, okCycles: ok,
      // 오늘은 아직 끝나지 않은 날이라 '일부' 로 보지 않는다(지나간 날만 판정).
      partial: ok > 0 && day !== today && ok < expected / 2,
      today: day === today,
    };
  });
  const noData = daily.filter((d) => d.okCycles === 0).length;

  return {
    fromDay, toDay,
    totals: {
      users: usr.size, services: svc.size, pairs: pairs.length,
      // 기간 고유 사용자 · 일평균(수집이 있던 날만 분모)
      avgDailyUsers: (() => { const ok = daily.filter((d) => d.users != null && !d.today); return ok.length ? Math.round(ok.reduce((a, d) => a + d.users, 0) / ok.length) : null; })(),
      peakDailyUsers: (() => { const ok = daily.filter((d) => d.users != null); return ok.length ? Math.max(...ok.map((d) => d.users)) : null; })(),
      daysNoData: noData, daysPartial: daily.filter((d) => d.partial).length,
    },
    services: services.slice(0, maxServices), servicesOmitted: Math.max(0, services.length - maxServices),
    users: users.slice(0, maxUsers), usersOmitted: Math.max(0, users.length - maxUsers),
    pairsOmitted: Math.max(0, pairs.length - maxPairs),
    daily,
    expectedCyclesPerDay: expected,
    intervalMs: n(intervalMs),
    lowerBound: true,
    nowServers: Number(liveServers) || 0,
    firstDay: range?.firstDay || null,
  };
}
