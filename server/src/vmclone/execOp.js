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

/*
 * v2.862 Bareos 마무리(bareos-nic · bareos-verify)는 vmclone 전역 직렬 큐(runner.enqueueOp)에 서지 않는다 — 검증 한 건이 Tools 대기 · 삭제로
 * 수십 분 걸려 그날 VM 백업 · 다른 복원의 NIC 끊기가 몇 시간 밀렸다(반증 F6). 대신 **vCenter 마다 한 줄**로 차례로 돈다(같은 vCenter 에 동시에 손대지 않게).
 */
const _bareosChains = new Map();
// v2.874(점검 B2-02 — 재현): 이 줄의 작업(대기 · 실행)은 runner · inflight 어디에도 없어 자동 업그레이드가 기다리지 않았다 — 재시작하면 켠 검증 VM 이
//   끄기 · 지우기 없이 남았다(다시 보낸 검증은 '켜져 있습니다' 거짓 실패). upgrade/manager.js 가 이 목록이 빌 때까지 적용을 미룬다(종류 · 대상 이름 · 시각만).
const _finishOps = new Map();   // op id → { kind, vcenterId, name, since }
/** 지금 줄에 있거나 도는 Bareos 마무리(재시작하면 끊긴다) — upgrade/manager.js 대기 목록과 같은 모양. */
export function runningBareosFinishes() {
  return [..._finishOps].map(([id, o]) => ({ kind: 'bareos', key: `bareos-finish:${id}`, label: `${OP_LABEL[o.kind] || o.kind}(${o.vcenterId}/${o.name})`.slice(0, 120), since: o.since, resumable: false }));
}
function perVcenter(vcenterId, fn, meta = null) {
  const key = String(vcenterId || '');
  const prev = _bareosChains.get(key) || Promise.resolve();
  const mid = meta?.id ? String(meta.id) : '';
  if (mid) _finishOps.set(mid, { kind: meta.kind, vcenterId: key, name: String(meta.name || '').slice(0, 80), since: Date.now() });
  const run = prev.catch(() => {}).then(() => fn(() => {})).finally(() => { if (mid) _finishOps.delete(mid); });
  const tailP = run.catch(() => {});
  _bareosChains.set(key, tailP);
  tailP.then(() => { if (_bareosChains.get(key) === tailP) _bareosChains.delete(key); });
  return run;
}

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
    return perVcenter(vcenterId, async (setPhase) => {
      const r = await disconnectRestoredVm(vcenterId, name, { setPhase });
      logAudit({ user: by, action: r.ok ? 'Bareos 복원 VM 네트워크 끊기' : 'Bareos 복원 VM 네트워크 끊기 실패', target: `${vcenterId}/${name.slice(0, 60)}`, detail: String(r.detail).slice(0, 200) });
      return { ok: r.ok, detail: r.detail, ms: r.ms };
    }, { id: op.id, kind, name });
  }

  // v2.862 Bareos 복원 검증(리허설) — 검증용으로 복원한 새 VM 을 끊고 · 켜고 · Tools 확인 · 끄고 · (성공이면) 지운다
  if (kind === 'bareos-verify') {
    const vcenterId = String(op.vcenterId || '');
    const name = String(spec.name || '').slice(0, 200);
    return perVcenter(vcenterId, async (setPhase) => {
      const r = await verifyRestoredVm(vcenterId, name, { deleteOnOk: spec.deleteOnOk !== false, retry: spec.retry === true, setPhase });
      logAudit({ user: by, action: r.ok ? 'Bareos 복원 검증 성공' : 'Bareos 복원 검증 실패', target: `${vcenterId}/${name.slice(0, 60)}`, detail: String(r.detail).slice(0, 200) });
      return { ok: r.ok, detail: r.detail, ms: r.ms, toolsMs: r.toolsMs ?? null, deleted: !!r.deleted, nicOff: r.nicOff === true };   // v2.899(점검 B2)
    }, { id: op.id, kind, name });
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
