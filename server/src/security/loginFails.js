/**
 * 로그인 실패 분석 — vCenter 이벤트 로그(장기보관 DB)에서 로그인 실패를 분류하고, 포탈 자체
 * 실패와 합쳐 사용자/출발지IP/대상별로 집계한다. 브루트포스(임계 이상 반복)를 탐지한다.
 */

import { getLogsDb } from '../logs/db.js';
import { getStoredFails } from './loginStore.js';

const DAY = 86_400_000;
const TYPE_RE = /BadUsername|InvalidLogin|NoAccess|AccountLock|LoginFailure|AuthenticationFailed|NoPermission/i;
const MSG_RE = /cannot login|failed to (log\s?in|authenticate)|login failure|authentication failed|invalid (login|credential|user)|bad username|account.*lock|로그인.*실패|인증.*실패/i;
const IPV4 = /(?:\d{1,3}\.){3}\d{1,3}/;

const isLoginFail = (e) => TYPE_RE.test(e.type || '') || MSG_RE.test(e.message || '');
const srcIp = (e) => (e.ip || IPV4.exec(e.message || '')?.[0] || '');

/**
 * @param opts { vcenterId?, days=7, threshold=5, windowMin=10 }
 * threshold: 같은 사용자/IP가 이 횟수 이상이면 브루트포스 의심. windowMin: 활성 브루트포스 판정 창.
 */
export async function analyzeLoginFails({ vcenterId = '', days = 7, threshold = 5, windowMin = 10 } = {}) {
  const db = await getLogsDb();
  const since = Date.now() - Math.max(1, days) * DAY;

  // vCenter 이벤트에서 로그인 실패 후보를 LIKE로 좁혀 가져온 뒤 분류.
  const seen = new Set();
  const vcFails = [];
  for (const q of ['login', 'auth', 'fail', '로그인']) {
    let rows = [];
    try { rows = db.query({ vcenterId: vcenterId || '', since, q }, 5000, 0); } catch { rows = []; }
    for (const e of rows) {
      const id = `${e.vcenterId}|${e.ts}|${e.type}|${e.user}`;
      if (seen.has(id) || !isLoginFail(e)) continue;
      seen.add(id);
      vcFails.push({ ts: e.ts, source: e.vcenterId, kind: 'vcenter', user: (e.user || '').trim() || '(unknown)', ip: srcIp(e), type: e.type, message: e.message });
    }
  }
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
  const winCut = Date.now() - windowMin * 60_000;
  const offenders = [];
  const offByKey = (label, m) => {
    for (const [key, count] of m) {
      if (count < threshold) continue;
      const recent = all.filter((f) => (label === 'user' ? f.user : f.ip) === key && f.ts >= winCut).length;
      const last = all.find((f) => (label === 'user' ? f.user : f.ip) === key)?.ts;
      offenders.push({ label, key, total: count, recent, active: recent >= threshold, lastTs: last });
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
    generatedAt: Date.now(),
  };
}
