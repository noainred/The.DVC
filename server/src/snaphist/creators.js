/**
 * snaphist/creators.js — VM 별 ‘최근 스냅샷을 만든 계정’(v3.28.0 · 설계 docs/design/snapshots §4 ‘만든 계정’ · §8 ① (다)).
 *
 * 재료: 스냅샷 이벤트 전용 DB(veeam/snapDb.js snap_ev — 로그 폴러가 ‘스냅샷’ 행만 31일 보관). vCenter 에 요청을 더하지 않는다.
 * 한계(화면이 말한다):
 *   · 이벤트에는 스냅샷 이름이 없을 수 있어 **VM 단위**로만 잇는다 — ‘그 VM 에 최근(31일 안) 스냅샷을 만든 계정’ 이지, 가장 오래된 스냅샷을 만든 계정이 아니다.
 *   · 이벤트는 VM **이름**만 준다 — 같은 이름의 VM 이 그 vCenter 에 둘 이상이면 잇지 않는다(ambiguous).
 *   · 백업 도구(Veeam) 계정이 만든 것은 뺀다(veeam/snapEvents.js 판정 그대로 — 백업마다 만들고 지우는 임시 스냅샷이 사람 계정을 가린다).
 *   · 엣지 위임(site) vCenter 의 이벤트는 그 법인 엣지에만 있다 — 'site' 로 말하고 비운다(지어내지 않는다).
 *   · 31일보다 오래된 스냅샷을 만든 계정은 모른다.
 *   · 153회차(재현): 이벤트 DB 가 그 vCenter 의 31일을 **빠짐없이 가졌을 때만** 'ok' 다(veeam/snapEvents.js snapCovered — Veeam 요약과 같은 판정).
 *     백필이 아직 31일에 닿지 않았거나(업그레이드 직후 — 먼저 8일) · 이 포탈이 그 vCenter 의 이벤트를 모으지 않거나(비활성 · 점검중 · 로그 수집 끔) ·
 *     적재 실패로 덮음이 무효면 'partial' — 찾은 계정은 맞지만 못 찾은 VM 을 ‘31일 안 기록 없음’ 이라 말할 수 없다(예전에는 'ok' 였다).
 *     coveredFrom[vCenter] = 빠짐없이 가진 가장 이른 시각(모르면 null).
 *   · 153회차: 이벤트가 **쌓이지 않는** 조건도 같은 규칙(Veeam 요약 · 미보호 리포트가 쓰는 이름 그대로) — vCenter 로그 수집을 껐으면 'log-off',
 *     정보 등급을 저장하지 않으면(최소 심각도가 info 보다 높다 — 스냅샷 작업 이벤트는 정보 등급) 'severity-filter', 이 포탈이 그 vCenter 의 이벤트를
 *     모으지 않으면(비활성 · 점검중 — logs/coverage.js eventNotCollectedMap) 'not-collected'. 예전에 쌓인 이벤트로 찾은 계정은 그대로 싣는다.
 */
import { isSnapshotCreateEvent, makeVeeamAccountMatcher, veeamAccounts, snapCovered, ROW_LIMIT } from '../veeam/snapEvents.js';
import { getSnapDb, RETENTION_MS } from '../veeam/snapDb.js';
import { createYielder } from '../util/timeSlice.js';
import { loadLogSettings } from '../logs/settings.js';
import { eventNotCollectedMap } from '../logs/coverage.js';

const USER_MAX = 128;

/**
 * 한 vCenter 의 VM 별 최근 생성 계정(순수 — 시험용).
 * @returns {{byVm: Map<string,{user:string, ts:number}>, ambiguous:number, unmatched:number, events:number}}
 */
export function creatorsOf(vms, rows, isVeeam) {
  const byName = new Map();
  for (const v of vms || []) {
    if (!v || v.id == null) continue;
    const k = String(v.name || '').trim().toLowerCase();
    if (k) byName.set(k, byName.has(k) ? null : String(v.id));
  }
  const byVm = new Map();
  let ambiguous = 0; let unmatched = 0; let events = 0;
  for (const r of rows || []) {
    if (!r || !isSnapshotCreateEvent(r) || !r.user || isVeeam(r.user)) continue;
    const ts = Number(r.ts);
    if (!Number.isFinite(ts)) continue;
    events += 1;
    const id = byName.get(String(r.entity || '').trim().toLowerCase());
    if (id === null) { ambiguous += 1; continue; }
    if (!id) { unmatched += 1; continue; }
    const cur = byVm.get(id);
    if (!cur || ts > cur.ts) byVm.set(id, { user: String(r.user).slice(0, USER_MAX), ts });
  }
  return { byVm, ambiguous, unmatched, events };
}

/**
 * 고른 vCenter 들의 생성 계정. vCenter 마다 상태: 'ok' | 'site'(엣지 위임) | 'no-db' | 'truncated'(읽은 행이 상한 — 더 오래된 것은 못 봤다) |
 *   'partial'(이벤트 DB 가 31일을 다 덮지 못했다 — 153회차) | 'log-off' | 'severity-filter' | 'not-collected'(이벤트가 쌓이지 않는다 — 머리말).
 * @param {object} a
 * @param {object|null} [a.logSettings]        vCenter 로그 보관 설정(주지 않으면 loadLogSettings — 못 읽으면 판정하지 않는다)
 * @param {Map<string,string>} [a.notCollected] 이 포탈이 이벤트를 모으지 않는 vCenter → 사유(주지 않으면 eventNotCollectedMap)
 * @returns {Promise<{byVm: Record<string,{user:string, ts:number}>, vcenters: Record<string,string>, coveredFrom: Record<string,number|null>, ambiguous:number}>}
 */
export async function snapshotCreators({ snap, vcIds, now = Date.now(), logSettings, notCollected }) {
  const db = await getSnapDb();
  let ls = logSettings;
  if (ls === undefined) { try { ls = loadLogSettings(); } catch { ls = null; } }
  let nc = notCollected;
  if (!(nc instanceof Map)) { try { nc = eventNotCollectedMap(); } catch { nc = new Map(); } }
  const logWhy = ls?.enabled === false ? 'log-off' : (ls?.minSeverity && ls.minSeverity !== 'info') ? 'severity-filter' : null;
  const isVeeam = makeVeeamAccountMatcher(veeamAccounts(now));
  const vcs = (snap?.vcenters || []).filter((vc) => vc && vcIds.has(String(vc.id)));
  const out = { byVm: {}, vcenters: {}, coveredFrom: {}, ambiguous: 0 };
  const since = now - RETENTION_MS;
  const maybeYield = createYielder(15);
  for (const vc of vcs) {
    const id = String(vc.id);
    const ncWhy = nc.get(id) || null;
    if (vc.collectSource === 'site' || ncWhy === 'site') { out.vcenters[id] = 'site'; continue; }
    if (!db) { out.vcenters[id] = 'no-db'; continue; }
    const rows = db.rowsFor(id, since, ROW_LIMIT);
    const vms = (snap.vms || []).filter((v) => String(v.vcenterId) === id);
    const r = creatorsOf(vms, rows, isVeeam);
    for (const [vmId, c] of r.byVm) out.byVm[`${id}\n${vmId}`] = c;
    out.ambiguous += r.ambiguous;
    // 153회차: 31일을 빠짐없이 가졌는가 — 아니면 'partial'(못 찾은 VM 은 ‘없음’ 이 아니라 모름). 판정은 snapCovered 하나.
    const covered = snapCovered(db, id, since);
    if (!covered) out.coveredFrom[id] = typeof db.coveredFrom === 'function' ? db.coveredFrom(id) : null;
    out.vcenters[id] = rows.length >= ROW_LIMIT ? 'truncated' : logWhy || (ncWhy ? 'not-collected' : covered ? 'ok' : 'partial');
    await maybeYield();
  }
  return out;
}
