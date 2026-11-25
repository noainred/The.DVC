/**
 * cvp/compliance.js — ③ 버전 준수(순수, v3.39 — docs/design/cvp-network-features §3 '버전 준수').
 *
 * **포탈은 판정하지 않는다** — CVP 가 준 값을 그대로 보인다: 설정 준수(레거시 인벤토리 complianceCode · complianceIndication) ·
 *   버그 · CVE 노출(bugexposure.v1) · 수명주기(lifecycle.v1 — 소프트웨어 지원 종료 · 하드웨어 단종). 모두 CVP 단위 항목으로 이미 수집하던 값이다(v2.641).
 * '못 읽음' 과 '없음' 을 가른다: 그 CVP 가 그 항목을 읽었는데(info.readKinds) 장비 값이 없으면 '공지 없음' · 읽지 못했으면 '못 읽음'.
 * 지원 종료일을 지어내지 않는다(값이 없으면 '—'). 임박 = 오늘부터 SOON_DAYS 안.
 */
import { numOrNull } from '../util/numOrNull.js';

export const SOON_DAYS = 180;
const DAY = 86_400_000;

/** 수명주기 날짜 → epoch ms(수집 · 엣지 정제는 ms 숫자, 옛 기록 · 다른 판본은 ISO 문자열일 수 있다). 못 읽으면 null. */
export function lifeMs(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number' || (typeof v === 'string' && /^\d+(\.\d+)?$/.test(v.trim()))) {
    const n = numOrNull(v);
    if (n == null || n <= 0) return null;
    return n > 1e14 ? Math.floor(n / 1e6) : n > 1e11 ? n : n * 1000;   // ns · ms · s
  }
  if (typeof v === 'string') { const t = Date.parse(v); return Number.isFinite(t) ? t : null; }
  return null;
}

/** 설정 준수 — ok · warn · bad · unknown(읽었지만 값 없음) · unread. CVP 가 준 코드 · 표시를 그대로 싣는다(뜻을 지어내지 않는다 — '0000' 만 준수로 읽는다). */
export function configState(info) {
  const read = Array.isArray(info?.readKinds) && info.readKinds.includes('enrich');
  if (!read) return { state: 'unread', code: null, indication: null };
  const code = typeof info.complianceCode === 'string' ? info.complianceCode : '';
  const ind = typeof info.complianceIndication === 'string' ? info.complianceIndication.toUpperCase() : '';
  let state = 'unknown';
  if (/ERROR|CRITICAL/.test(ind)) state = 'bad';
  else if (/WARN/.test(ind)) state = 'warn';
  else if (code === '0000' || (ind === 'NONE' && (!code || code === '0000'))) state = 'ok';
  else if (code) state = 'warn';
  return { state, code: code || null, indication: ind || null };
}
/** 버그 · CVE 노출 — high · low · none(공지 없음 · 노출 없음) · unread. */
export function bugState(info) {
  const read = Array.isArray(info?.readKinds) && info.readKinds.includes('bugs');
  const b = info && typeof info.bugs === 'object' ? info.bugs : null;
  if (!read && !b) return { state: 'unread', bugCount: null, cveCount: null, highestBug: null, highestCve: null, acknowledged: false };
  if (!b) return { state: 'none', bugCount: 0, cveCount: 0, highestBug: 'none', highestCve: 'none', acknowledged: false, noRecord: true };
  const hi = [b.highestCve, b.highestBug].includes('high') ? 'high' : [b.highestCve, b.highestBug].includes('low') ? 'low'
    : ((numOrNull(b.bugCount) ?? 0) + (numOrNull(b.cveCount) ?? 0) > 0 ? 'low' : 'none');
  return { state: hi, bugCount: numOrNull(b.bugCount), cveCount: numOrNull(b.cveCount), highestBug: b.highestBug ?? null, highestCve: b.highestCve ?? null, acknowledged: b.acknowledged === true };
}
/** 수명주기 — passed(지남) · soon(SOON_DAYS 안) · ok · none(공지 없음) · unread. 소프트웨어 · 하드웨어 중 이른 날 기준. */
export function lifeState(info, now = Date.now()) {
  const read = Array.isArray(info?.readKinds) && info.readKinds.includes('lifecycle');
  const l = info && typeof info.lifecycle === 'object' ? info.lifecycle : null;
  if (!read && !l) return { state: 'unread', swEnd: null, hwEnd: null, swVersion: null };
  if (!l) return { state: 'none', swEnd: null, hwEnd: null, swVersion: null, noRecord: true };
  const swEnd = lifeMs(l.swEndOfSupport);
  // 반증 E5: hwEndOfLife 는 '단종 공지일' 일 수 있어(뜻 미확인) 지원 종료 판정에 넣지 않는다 — TAC 지원 · RMA 종료만. 화면에는 따로 싣는다.
  const hwCands = [l.hwEndOfTacSupport, l.hwEndOfRma].map(lifeMs).filter((x) => x != null);
  const hwEnd = hwCands.length ? Math.min(...hwCands) : null;
  const ends = [swEnd, hwEnd].filter((x) => x != null);
  const first = ends.length ? Math.min(...ends) : null;
  const state = first == null ? 'none' : first < now ? 'passed' : first < now + SOON_DAYS * DAY ? 'soon' : 'ok';
  return { state, swEnd, hwEnd, hwEndOfSale: lifeMs(l.hwEndOfSale), hwEndOfLife: lifeMs(l.hwEndOfLife), swVersion: typeof l.swEolVersion === 'string' && l.swEolVersion ? l.swEolVersion : null, first };
}

/**
 * 전 장비 → 행 · 개수 · 버전별 묶음.
 * @param {Array<{agent,cvpId,key,hostname,model,eosVersion,info,corpName?,cvpName?}>} devices
 */
export function complianceFleet(devices = [], { now = Date.now() } = {}) {
  const rows = [];
  const counts = { devices: 0, config: { ok: 0, warn: 0, bad: 0, unknown: 0, unread: 0 }, bugs: { high: 0, low: 0, none: 0, unread: 0 },
    life: { passed: 0, soon: 0, ok: 0, none: 0, unread: 0 }, cveDevices: 0 };
  const byVer = new Map();
  for (const d of Array.isArray(devices) ? devices : []) {
    const info = d.info && typeof d.info === 'object' ? d.info : {};
    const c = configState(info); const b = bugState(info); const l = lifeState(info, now);
    counts.devices++; counts.config[c.state]++; counts.bugs[b.state]++; counts.life[l.state]++;
    if ((b.cveCount ?? 0) > 0) counts.cveDevices++;
    const ver = String(d.eosVersion || '').trim();
    if (!byVer.has(ver)) byVer.set(ver, { version: ver, devices: 0, models: new Set(), bugHigh: 0, cveDevices: 0, lifePassed: 0, lifeSoon: 0, bugUnread: 0 });
    const v = byVer.get(ver);
    v.devices++; v.models.add(String(d.model || '').trim());
    if (b.state === 'high') v.bugHigh++;
    if (b.state === 'unread') v.bugUnread++;
    if ((b.cveCount ?? 0) > 0) v.cveDevices++;
    if (l.state === 'passed') v.lifePassed++;
    if (l.state === 'soon') v.lifeSoon++;
    rows.push({ agent: d.agent, cvpId: d.cvpId, key: d.key, hostname: d.hostname || d.key, model: d.model || '', version: ver, corpName: d.corpName || '', cvpName: d.cvpName || '',
      config: c, bugs: b, life: l });
  }
  const sev = (r) => (r.life.state === 'passed' ? 0 : 1) + (r.bugs.state === 'high' ? 0 : 2) + (r.config.state === 'bad' ? 0 : 4);
  rows.sort((a, b) => sev(a) - sev(b) || String(a.hostname).localeCompare(String(b.hostname)));
  const versions = [...byVer.values()].map((v) => ({ ...v, models: [...v.models].filter(Boolean).sort() }))
    .sort((a, b) => b.devices - a.devices || a.version.localeCompare(b.version));
  return { rows, counts, versions, soonDays: SOON_DAYS };
}
