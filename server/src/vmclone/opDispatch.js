/**
 * vmclone/opDispatch.js — 실행 위치(중앙 직접 · 담당 엣지)를 정해 작업을 보낸다(v2.861 — routes/api/vmClone.js 에서 옮겼다).
 *   Bareos 복원 마무리(bareos/restoreFinish.js)도 같은 길로 보낸다 — 라우트 파일을 도메인 모듈이 import 하지 않게(의존 방향 — docs/rules/common.md).
 *   중앙(직접)이면 바로 실행하고, 엣지면 대기로 두어 엣지가 인출한다(dispatch.js takeOps).
 */
import { store } from '../store.js';
import { loadVcenterConfig } from '../config.js';
import { getDataSource } from '../runtime-settings.js';
import { listInventory } from '../central/inventory.js';
import { demoSiteVcenters } from '../mock/demo/edge.js';   // v2.793: 데모 법인 묶음(mock 전용 — live 는 빈 배열)
import { execTargets, createOp, finishOp } from './dispatch.js';
import { executeOp } from './execOp.js';

const mockNow = () => { try { return getDataSource() === 'mock'; } catch { return false; } };

/**
 * 등록부 vCenter + 실행 위치. 데모(mock)는 등록부 파일이 비어 있으므로 수집 스냅샷의 vCenter 로 채우고, 데모 엣지가 맡는 vCenter 는
 * 위임(site)·담당 엣지로 표시한다(portalCheck 의 demoSiteVcenters 와 같은 판정 — 실행은 이 노드가 시뮬레이션한다).
 */
export function targetsNow() {
  const cfg = loadVcenterConfig();
  let vcenters = cfg.vcenters || [];
  const mock = mockNow();
  if (mock) {
    const snapVcs = store.get()?.vcenters || [];
    const have = new Set(vcenters.map((v) => String(v.id)));
    const site = new Map(demoSiteVcenters(snapVcs).map((v) => [String(v.id), v]));
    vcenters = [...vcenters, ...snapVcs.filter((v) => !have.has(String(v.id))).map((v) => site.get(String(v.id)) || { id: v.id, name: v.name || v.id, collectMode: 'direct', demo: true })];
  }
  return { vcenters, targets: execTargets(vcenters, listInventory(), { mock }) };
}

/**
 * 실행 위치에 작업을 보낸다. 실행 위치를 정할 수 없으면(conflict · none) 보내지 않고 사유를 돌려준다.
 * @returns {{ op: object } | { issue: string }}
 */
export function dispatchVmOp({ kind, job = null, vcenterId, vmName = '', spec = {}, by }) {
  const tg = targetsNow().targets.get(String(vcenterId));
  if (!tg || tg.where === 'conflict' || tg.where === 'none') return { issue: tg?.reason || '이 vCenter 의 실행 위치를 정할 수 없습니다.' };
  const op = createOp({ kind, jobId: job?.id || '', vcenterId, vmName: vmName || job?.vmName || '', spec, by, target: tg });
  if (tg.where === 'local') {
    op.state = 'running'; op.claimedAt = Date.now();
    executeOp({ id: op.id, kind, jobId: op.jobId, vcenterId, spec, by })
      .then((r) => finishOp(op, r))
      .catch((e) => finishOp(op, { ok: false, detail: String(e?.message || e) }));
  }
  return { op };
}
