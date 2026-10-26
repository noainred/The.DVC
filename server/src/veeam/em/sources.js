/**
 * veeam/em/sources.js — Enterprise Manager 를 vCenter 화면의 Veeam 출처로(v2.795 — 사용자 요청 'EM 에서 등록되면 vCenter 화면에서도 등록되고
 *   vCenter 세부 백업 내용에도 반영' · 결정 'VM 단위까지' · 'B&R 우선, 실패 시 EM').
 *
 * 하는 일: EM 이 아는 백업 서버마다(매핑으로 vCenter 가 정해진 것만) VM 단위 기록(vmStore)을 **B&R 결과와 같은 모양**(veeam/parse.js buildServerResult
 *   의 jobs[]·vms[] 축약형)으로 만든다. 그래서 대조·수·판정은 기존 코어 하나(matchToVcenter·veeamCount·vmBackupView)를 그대로 탄다 — 판정을 복제하지 않는다.
 *
 * 규칙:
 *  · vCenter 는 매핑 결과(view.js mapBackupServers — 수동 > 짝지은 B&R 등록 > 모름)만. 모르면 어느 vCenter 에도 싣지 않는다(짐작해 붙이지 않는다).
 *  · 출처 우선(사용자 결정): 그 백업 서버와 짝지은 B&R 등록이 **이 vCenter 를 맡고 지금 정상**(마지막 읽기 성공 · 오래되지 않음)이면 EM 은 빼고,
 *    읽기 실패·첫 수집 대기·짝 없음이면 EM 을 넣는다(B&R 의 마지막 성공분이 있으면 둘 다 들어가 VM 단위로 합쳐진다 — 마지막 백업은 늦은 쪽).
 *  · 진행 중·진행률은 싣지 않는다(EM 은 15분 주기 — 오래된 '백업 중' 을 보이지 않게). 복원 지점 수는 모른다(rp -1 = 있음·수 모름).
 *  · EM 기록에는 vCenter 이름(h)이 없다 → matchToVcenter 는 moref 가 있으면 **moref 와 이름이 함께** 맞을 때만, 없으면 이 vCenter 안에서 유일한 이름일 때만 짝짓는다.
 *  · VM 기록을 아직 한 번도 저장하지 못했거나(첫 수집 전 · 항목 실패) 서버를 가릴 수 없는 기록뿐이면 결과를 내지 않는다 — '0대' 가 아니라 모름.
 */
import { listEms } from './registry.js';
import { getEmRecord } from './store.js';
import { getEmMap, emMapRev } from './mapping.js';
import { getEmVms, emVmRev } from './vmStore.js';
import { mapBackupServers } from './view.js';
import { listServers } from '../registry.js';

const lc = (v) => String(v || '').trim().toLowerCase();
const EM_FAIL_TEXT = 'Enterprise Manager 를 읽지 못했습니다 — 관리자가 설정 › Veeam 백업 서버 › Enterprise Manager 에서 확인해야 합니다.';

/** EM 백업 서버 1대의 VM 기록 → B&R 결과 모양(jobs[]·vms[]). */
export function serverResultOf(vmsMap, serverName, ts) {
  const want = lc(serverName);
  const jobs = []; const jobIdx = new Map(); const vms = [];
  for (const r of Object.values(vmsMap || {})) {
    if (lc(r.s) !== want || !r.n) continue;
    let ji = null;
    if (r.j) {
      if (!jobIdx.has(r.j)) { jobIdx.set(r.j, jobs.length); jobs.push({ id: `em:${r.j}`, name: r.j, type: '', disabled: false, status: '', lastResult: '', lastRun: null, nextRun: null, running: false }); }
      ji = jobIdx.get(r.j);
      const jb = jobs[ji];
      if (r.lt?.e != null && (jb.lastRun == null || r.lt.e > jb.lastRun)) { jb.lastRun = r.lt.e; jb.lastResult = r.lt.r; }
    }
    const rl = Array.isArray(r.rl) ? r.rl.filter(Number.isFinite).slice(0, 10) : [];
    vms.push({
      n: r.n, m: r.m || '', h: '', j: ji != null ? [ji] : [], rp: rl.length ? -1 : 0, run: 0, pg: null, by: '',
      ...(r.lt ? { lt: { r: r.lt.r, m: '', s: r.lt.s ?? null, e: r.lt.e ?? null, ...(ji != null ? { j: ji } : {}) } } : {}),
      ...(rl.length ? { rl } : {}),
    });
  }
  return { ok: true, ts, src: 'em', jobs, vms, counts: null, backups: [], notes: [] };
}

let _cache = { key: '', list: [] };
/**
 * 전 EM 의 백업 서버별 출처 목록(캐시 — EM 결과·VM 기록·매핑·B&R 등록이 바뀌면 다시 만든다).
 * @returns {Array<{ id, emId, emName, server, brId, vcenterIds, view:object, result:object|null }>}
 */
export function emBackupSources({ ems = listEms(), recOf = getEmRecord, map = getEmMap(), brServers = listServers(), vmsOf = getEmVms } = {}) {
  const live = ems.filter((d) => d.enabled !== false);
  const key = [emVmRev(), emMapRev(), ...live.map((d) => `${d.id}@${recOf(d.id)?.at || 0}`),
    ...brServers.map((b) => `${b.id}:${b.name}:${b.host}:${(b.vcenterIds || []).join(',')}`)].join('|');
  if (_cache.key === key) return _cache.list;
  const list = [];
  for (const em of live) {
    const rec = recOf(em.id);
    const data = rec?.result?.ok ? rec.result : (rec?.lastOk || null);
    if (!data?.backupServers) continue;
    const vmEntry = vmsOf(em.id);
    const hasVms = !!vmEntry && Object.keys(vmEntry.vms || {}).length > 0;
    const usable = !!vmEntry && (hasVms || !(vmEntry.ua > 0));   // 서버를 가릴 수 없는 기록뿐이면 모름
    for (const s of mapBackupServers(data.backupServers, { emId: em.id, map, brServers })) {
      if (!s.vcenterIds?.length) continue;
      const r = rec?.result || {};
      list.push({
        id: `em:${em.id}:${lc(s.name)}`, emId: em.id, emName: em.name, server: s.name, brId: s.brId || '', vcenterIds: s.vcenterIds,
        rec, vmAt: vmEntry?.at ?? null,
        failed: r.ok !== true, error: r.error || '', authStopped: !!r.authStop,
        result: usable ? serverResultOf(vmEntry.vms, s.name, vmEntry.at || data.ts) : null,
      });
    }
  }
  _cache = { key, list };
  return list;
}
export function _resetEmSourcesForTest() { _cache = { key: '', list: [] }; }

/**
 * 그 vCenter 에 넣을 EM 출처(출처 우선 적용 후).
 * @param {string} vcenterId
 * @param {{ brHealthy:(brId:string, vcenterId:string)=>boolean, admin?:boolean, maxAgeMs?:number, now?:number }} o
 *   brHealthy = 그 B&R 등록이 이 vCenter 를 맡고 지금 정상인가(호출부가 B&R 저장소·주기로 판정 — 같은 식을 두 벌 두지 않게)
 * @returns {{ results:Array<{server:{id,name,src}, result}>, views:Array<object> }}
 */
export function emSourcesForVcenter(vcenterId, { brHealthy = () => false, admin = false, maxAgeMs = 3 * 900_000, now = Date.now(), sources = null } = {}) {
  const results = []; const views = [];
  for (const s of sources || emBackupSources()) {
    if (!s.vcenterIds.includes(vcenterId)) continue;
    if (s.brId && brHealthy(s.brId, vcenterId)) continue;
    const name = `EM · ${s.server}`;
    const lastOkTs = s.result ? s.result.ts : null;
    views.push({
      name, src: 'em', ok: s.result ? !s.failed : null, ts: s.rec?.result?.ts ?? null, lastOkTs,
      stale: !!s.result && (!(Number(lastOkTs) > 0) || now - Number(lastOkTs) > maxAgeMs),
      error: s.failed ? (admin ? String(s.error || '').slice(0, 300) : EM_FAIL_TEXT) : (s.result ? '' : 'Enterprise Manager 의 VM 별 기록을 아직 받지 못했습니다(첫 수집 대기 · 또는 그 항목을 읽지 못함).'),
      authStopped: s.authStopped, via: 'em', notes: [], counts: null,
    });
    if (s.result) results.push({ server: { id: s.id, name, src: 'em' }, result: s.result });
  }
  return { results, views };
}

/** 이 vCenter 에 EM 출처가 하나라도 붙는가(출처 우선 전 — '연동됨' 판정용). */
export function emLinkedVcenter(vcenterId, sources = null) {
  return (sources || emBackupSources()).some((s) => s.vcenterIds.includes(vcenterId));
}
/** 응답 캐시 키 조각 — EM 기록·매핑이 바뀌면 바뀐다. */
export const emSourcesRev = () => `${emVmRev()}.${emMapRev()}`;
