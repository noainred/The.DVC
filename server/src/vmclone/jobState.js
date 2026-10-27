/**
 * vmclone/jobState.js — 한 vCenter 의 VM 별 포탈 복제 잡과 그 '마지막 실행'(v2.803 — 백업 현황 › Detail 의 'Clone' 칸).
 *
 * 마지막 실행의 진실은 **실행하는 노드**다: 중앙 직접 수집 vCenter 는 이 노드의 잡 기록(job.lastRun), 엣지에 위임한(site) vCenter 는
 *   그 엣지가 올린 보고(dispatch.edgeStateOf — VM 백업 센터 화면 routes/api/vmClone.js mergeJobView 와 같은 규칙). 엣지가 아직 보고하지 않았거나
 *   담당 엣지가 불일치·미확정이면 '모름'(lastRun undefined) — 이 노드의 낡은 기록으로 채우지 않는다.
 * 잡 파일을 못 읽었으면 null(모름 — 빈 맵으로 '잡 없음' 을 지어내지 않는다).
 */
import { loadVcenterConfig } from '../config.js';
import { getDataSource } from '../runtime-settings.js';
import { listInventory } from '../central/inventory.js';
import { execTargetOf, edgeStateOf } from './dispatch.js';
import { jobsByVm } from './store.js';

/** @returns {Map<string, {job:object, lastRun:object|null|undefined}>|null} */
export function cloneStateByVm(vcenterId) {
  const jobs = jobsByVm(vcenterId);
  if (!jobs) return null;
  let mock = false;
  try { mock = getDataSource() === 'mock'; } catch { mock = false; }
  let tg = { where: 'local' };
  if (!mock && jobs.size) {
    let vc; let observed = '';
    try { vc = (loadVcenterConfig().vcenters || []).find((v) => String(v?.id) === String(vcenterId)); } catch { vc = undefined; }
    try { observed = (listInventory() || []).find((e) => String(e?.vcenterId) === String(vcenterId))?.agent || ''; } catch { observed = ''; }
    tg = execTargetOf(vc, observed, { mock: false });
  }
  const edge = tg.where === 'edge' ? edgeStateOf(tg.agent) : null;
  const out = new Map();
  for (const [vmId, job] of jobs) {
    let lastRun;   // undefined = 모름
    if (tg.where === 'local') lastRun = job.lastRun || null;
    else if (tg.where === 'edge') { const st = edge?.jobs?.get?.(job.id); if (st) lastRun = st.lastRun || null; }
    out.set(vmId, { job, lastRun });
  }
  return out;
}
