/**
 * snaphist/creators.js — VM 별 ‘최근 스냅샷을 만든 계정’(v3.28.0 · 설계 docs/design/snapshots §4 ‘만든 계정’ · §8 ① (다)).
 *
 * 재료: 스냅샷 이벤트 전용 DB(veeam/snapDb.js snap_ev — 로그 폴러가 ‘스냅샷’ 행만 31일 보관). vCenter 에 요청을 더하지 않는다.
 * 한계(화면이 말한다):
 *   · 이벤트에는 스냅샷 이름이 없을 수 있어 **VM 단위**로만 잇는다 — ‘그 VM 에 최근(31일 안) 스냅샷을 만든 계정’ 이지, 가장 오래된 스냅샷을 만든 계정이 아니다.
 *   · 이벤트는 VM **이름**만 준다 — 같은 이름의 VM 이 그 vCenter 에 둘 이상이면 잇지 않는다(ambiguous).
 *   · 백업 도구(Veeam) 계정이 만든 것은 뺀다(veeam/snapEvents.js 판정 그대로 — 백업마다 만들고 지우는 임시 스냅샷이 사람 계정을 가린다).
 *   · v3.30.4: 관리자가 적은 ‘만든 계정에서 뺄 백업 계정’(vm-hygiene.json creatorExclude — Bareos · Rubrik · Commvault 등)도 뺀다.
 *     맞춤은 Veeam 계정과 같은 규칙(makeVeeamAccountMatcher — 도메인을 적으면 그 도메인만 · 안 적으면 어느 도메인의 같은 이름이든). 뺀 이벤트 수는 listed 로 밝힌다.
 *   · 엣지 위임(site) vCenter 의 이벤트는 그 법인 엣지에만 있다 — 'site' 로 말하고 비운다(지어내지 않는다).
 *   · 31일보다 오래된 스냅샷을 만든 계정은 모른다.
 */
import { isSnapshotCreateEvent, makeVeeamAccountMatcher, veeamAccounts, ROW_LIMIT } from '../veeam/snapEvents.js';
import { getSnapDb, RETENTION_MS } from '../veeam/snapDb.js';
import { createYielder } from '../util/timeSlice.js';

const USER_MAX = 128;

/**
 * 한 vCenter 의 VM 별 최근 생성 계정(순수 — 시험용).
 * @param {(user:string)=>any} isListed 관리자가 적은 백업 계정인가(기본: 없음)
 * @returns {{byVm: Map<string,{user:string, ts:number}>, ambiguous:number, unmatched:number, events:number, listed:number}}
 */
export function creatorsOf(vms, rows, isVeeam, isListed = () => null) {
  const byName = new Map();
  for (const v of vms || []) {
    if (!v || v.id == null) continue;
    const k = String(v.name || '').trim().toLowerCase();
    if (k) byName.set(k, byName.has(k) ? null : String(v.id));
  }
  const byVm = new Map();
  let ambiguous = 0; let unmatched = 0; let events = 0; let listed = 0;
  for (const r of rows || []) {
    if (!r || !isSnapshotCreateEvent(r) || !r.user || isVeeam(r.user)) continue;
    if (isListed(r.user)) { listed += 1; continue; }
    const ts = Number(r.ts);
    if (!Number.isFinite(ts)) continue;
    events += 1;
    const id = byName.get(String(r.entity || '').trim().toLowerCase());
    if (id === null) { ambiguous += 1; continue; }
    if (!id) { unmatched += 1; continue; }
    const cur = byVm.get(id);
    if (!cur || ts > cur.ts) byVm.set(id, { user: String(r.user).slice(0, USER_MAX), ts });
  }
  return { byVm, ambiguous, unmatched, events, listed };
}

/**
 * 관리자가 적은 백업 계정 맞춤(순수 — 시험용). Veeam 계정과 같은 규칙(도메인을 적으면 그 도메인만 · 안 적으면 어느 도메인의 같은 이름이든).
 * makeVeeamAccountMatcher 는 이름에 'veeam' 이 든 계정도 'name' 으로 맞추지만 그것은 isVeeam 이 먼저 거른다 — 여기서는 적은 계정('account')만 본다.
 */
export function listedMatcher(exclude) {
  const m = makeVeeamAccountMatcher(Array.isArray(exclude) ? exclude : []);
  return (u) => m(u) === 'account';
}

/**
 * 고른 vCenter 들의 생성 계정. vCenter 마다 상태: 'ok' | 'site'(엣지 위임) | 'no-db' | 'truncated'(읽은 행이 상한 — 더 오래된 것은 못 봤다).
 * @param {string[]} exclude 관리자가 적은 백업 계정(vm-hygiene.json creatorExclude)
 * @returns {Promise<{byVm: Record<string,{user:string, ts:number}>, vcenters: Record<string,string>, ambiguous:number, listed:number}>}
 */
export async function snapshotCreators({ snap, vcIds, now = Date.now(), exclude = [] }) {
  const db = await getSnapDb();
  const isVeeam = makeVeeamAccountMatcher(veeamAccounts(now));
  const isListed = listedMatcher(exclude);
  const vcs = (snap?.vcenters || []).filter((vc) => vc && vcIds.has(String(vc.id)));
  const out = { byVm: {}, vcenters: {}, ambiguous: 0, listed: 0 };
  const maybeYield = createYielder(15);
  for (const vc of vcs) {
    const id = String(vc.id);
    if (vc.collectSource === 'site') { out.vcenters[id] = 'site'; continue; }
    if (!db) { out.vcenters[id] = 'no-db'; continue; }
    const rows = db.rowsFor(id, now - RETENTION_MS, ROW_LIMIT);
    const vms = (snap.vms || []).filter((v) => String(v.vcenterId) === id);
    const r = creatorsOf(vms, rows, isVeeam, isListed);
    for (const [vmId, c] of r.byVm) out.byVm[`${id}\n${vmId}`] = c;
    out.ambiguous += r.ambiguous; out.listed += r.listed;
    out.vcenters[id] = rows.length >= ROW_LIMIT ? 'truncated' : 'ok';
    await maybeYield();
  }
  return out;
}
