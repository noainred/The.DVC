/**
 * vmclone/execOp.js — VM 백업 작업 실행기(v2.793). **그 vCenter 에 로그인하는 노드**에서 돈다:
 *   · 중앙 직접 수집 vCenter → 중앙(vmclone/dispatch.js 가 바로 부른다)
 *   · 사이트 위임 vCenter → 담당 엣지(agent/vmCloneWorker.js 가 중앙 명령을 받아 부른다)
 * 두 경로가 같은 함수를 써야 결과 기록(원장 검증 표시·잡 이력·감사)이 한 벌이다.
 *
 * 작업 종류(kind):
 *   run           — 백업 지금 실행(실행 큐에 넣는 것까지 — 결과는 잡 lastRun·이력이 말한다)
 *   verify        — 복원 지점 검증(vsOps.verifyClone)
 *   restore       — 복원 지점에서 새 VM(vsOps.restoreFromClone)
 *   nfsds-attach  — ESXi 호스트에 NFS 데이터스토어 연결(vsOps.attachNfsDatastore)
 *   bareos-nic    — v2.861 Bareos 복원으로 만든 VM 의 NIC 끊기(vsOps.disconnectRestoredVm — vmclone 잡 없음)
 * 결과: { ok, detail, ms?, hosts?, newName? } — 비밀을 담지 않는다(중앙으로 그대로 올라간다).
 */

import { getJob, patchClone, recordJobEvent } from './store.js';
import { enqueueRun, enqueueOp } from './runner.js';
import { verifyClone, restoreFromClone, attachNfsDatastore, detachNfsDatastore, disconnectRestoredVm, verifyRestoredVm } from './vsOps.js';
import { logAudit } from '../audit.js';

export const OP_KINDS = Object.freeze(['run', 'verify', 'restore', 'nfsds-attach', 'nfsds-detach', 'bareos-nic', 'bareos-verify']);
export const OP_LABEL = Object.freeze({ run: '지금 실행', verify: '검증', restore: '복구', 'nfsds-attach': 'NFS 데이터스토어 연결', 'nfsds-detach': 'NFS 데이터스토어 떼어 내기', 'bareos-nic': 'Bareos 복원 VM 네트워크 끊기', 'bareos-verify': 'Bareos 복원 검증(리허설)' });

/**
 * @param {{id:string, kind:string, jobId?:string, vcenterId?:string, spec?:object, by?:string}} op
 * @returns {Promise<{ok:boolean, detail:string, ms?:number, hosts?:object[], newName?:string}>}
 */
export async function executeOp(op) {
  const kind = String(op?.kind || '');
  const spec = op?.spec && typeof op.spec === 'object' ? op.spec : {};
  const by = String(op?.by || 'vm-clone').slice(0, 80);
  if (!OP_KINDS.includes(kind)) return { ok: false, detail: `모르는 작업 종류: ${kind.slice(0, 40)}` };

  if (kind === 'nfsds-attach' || kind === 'nfsds-detach') {
    const vcenterId = String(op.vcenterId || '');
    const detach = kind === 'nfsds-detach';
    return enqueueOp({ id: op.id, kind, label: OP_LABEL[kind] }, async (setPhase) => {
      const r = await (detach ? detachNfsDatastore : attachNfsDatastore)(vcenterId, spec, spec.hostIds, { setPhase });
      logAudit({ user: by, action: `${OP_LABEL[kind]}${r.ok ? '' : ' 실패'}`, target: `${vcenterId}/${String(spec.name || '').slice(0, 60)}`, detail: String(r.detail).slice(0, 200) });
      return { ok: r.ok, detail: r.detail, ms: r.ms, hosts: r.hosts };
    });
  }

  // v2.861 Bareos 복원 마무리 — vmclone 잡이 아니다(spec.name = 복원으로 만든 VM 이름). 그 vCenter 에 로그인하는 노드에서 돈다(위임이면 담당 엣지).
  if (kind === 'bareos-nic') {
    const vcenterId = String(op.vcenterId || '');
    const name = String(spec.name || '').slice(0, 200);
    return enqueueOp({ id: op.id, kind, label: OP_LABEL[kind] }, async (setPhase) => {
      const r = await disconnectRestoredVm(vcenterId, name, { setPhase });
      logAudit({ user: by, action: r.ok ? 'Bareos 복원 VM 네트워크 끊기' : 'Bareos 복원 VM 네트워크 끊기 실패', target: `${vcenterId}/${name.slice(0, 60)}`, detail: String(r.detail).slice(0, 200) });
      return { ok: r.ok, detail: r.detail, ms: r.ms };
    });
  }

  // v2.862 Bareos 복원 검증(리허설) — 검증용으로 복원한 새 VM 을 끊고 · 켜고 · Tools 확인 · 끄고 · (성공이면) 지운다
  if (kind === 'bareos-verify') {
    const vcenterId = String(op.vcenterId || '');
    const name = String(spec.name || '').slice(0, 200);
    return enqueueOp({ id: op.id, kind, label: OP_LABEL[kind] }, async (setPhase) => {
      const r = await verifyRestoredVm(vcenterId, name, { deleteOnOk: spec.deleteOnOk !== false, setPhase });
      logAudit({ user: by, action: r.ok ? 'Bareos 복원 검증 성공' : 'Bareos 복원 검증 실패', target: `${vcenterId}/${name.slice(0, 60)}`, detail: String(r.detail).slice(0, 200) });
      return { ok: r.ok, detail: r.detail, ms: r.ms, toolsMs: r.toolsMs ?? null, deleted: !!r.deleted };
    });
  }

  const job = getJob(String(op.jobId || ''));
  if (!job) return { ok: false, detail: '이 노드에 그 백업 잡이 없습니다(엣지라면 위임 동기화 전이거나 담당이 바뀌었습니다)' };

  if (kind === 'run') {
    const r = enqueueRun(job.id, 'manual');
    logAudit({ user: by, action: 'VM 복제 수동 실행', target: `${job.vcenterId}/${job.vmName}`, detail: r.queued ? '큐 등록' : r.reason });
    return { ok: !!r.queued, detail: r.queued ? '실행 큐에 넣었습니다' : `실행 불가: ${r.reason}` };
  }

  const ref = String(spec.ref || '');
  if (kind === 'verify') {
    return enqueueOp({ id: op.id, kind, jobId: job.id, label: OP_LABEL[kind] }, async (setPhase) => {
      const cur = getJob(job.id) || job;
      const r = await verifyClone(cur, ref, { setPhase });
      patchClone(job.id, ref, { verify: { at: Date.now(), ok: r.ok, detail: r.detail } });
      recordJobEvent(job.id, { kind: 'verify', ok: r.ok, detail: r.detail, ms: r.ms, trigger: 'manual', phases: r.phases });
      logAudit({ user: by, action: r.ok ? 'VM 백업 검증 성공' : 'VM 백업 검증 실패', target: `${job.vcenterId}/${job.vmName}`, detail: String(r.detail).slice(0, 200) });
      return { ok: r.ok, detail: r.detail, ms: r.ms };
    });
  }

  // restore
  return enqueueOp({ id: op.id, kind, jobId: job.id, label: OP_LABEL[kind] }, async (setPhase) => {
    const cur = getJob(job.id) || job;
    const r = await restoreFromClone(cur, ref, spec, { setPhase });
    recordJobEvent(job.id, { kind: 'restore', ok: r.ok, detail: r.detail, ms: r.ms, trigger: 'manual', phases: r.phases });
    logAudit({ user: by, action: r.ok ? 'VM 백업 복구' : 'VM 백업 복구 실패', target: `${job.vcenterId}/${job.vmName}`, detail: String(r.detail).slice(0, 200) });
    return { ok: r.ok, detail: r.detail, ms: r.ms, ...(r.newName ? { newName: r.newName } : {}) };
  });
}
