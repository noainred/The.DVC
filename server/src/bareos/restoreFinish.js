/**
 * bareos/restoreFinish.js — Bareos 복원 마무리: 새 VM 복원 뒤 네트워크 카드 끊기(v2.861 — 사용자 요청 '복원할 때 네트워크 연결 끊고 시작').
 *
 * Bareos VMware 플러그인은 새 VM 을 꺼진 채(restore_powerstate=off)로 만들지만 NIC 는 백업 때 그대로(연결 · 켤 때 연결)다. 원본이 살아 있는 망에
 * 같은 IP · 호스트명 · AD 계정으로 붙지 않게, 복원이 성공(T · W)으로 끝나면 그 vCenter 에 로그인하는 노드(중앙 직접 · 담당 엣지)에
 * vmclone 작업 'bareos-nic'(vsOps.disconnectRestoredVm)을 보낸다. 결과는 원장 restores[].finish 에 남는다.
 *  · 보내는 곳은 vmclone/opDispatch.js 하나(실행 위치 판정을 복제하지 않는다).
 *  · 같은 VM 을 다시 끊어도 결과가 같다(이미 끊겼으면 재구성하지 않고 확인만) — 재시작으로 보낸 작업을 잃었으면 다시 보낸다(최대 MAX_TRIES).
 *  · 복원이 실패 · 취소로 끝나면 'skipped'. 켜져 있거나 같은 이름이 둘이면 손대지 않고 'failed'(사유 — 사람이 확인).
 *  · 부르는 곳: 폴러 틱 시작(재시작 뒤 이어 가기 — Director 에 접속하지 않는다) · 복원 행 반영 뒤(폴러 · 로그 열기).
 */
import { restoresToFinish, patchRestoreFinish } from './registry.js';
import { dispatchVmOp } from '../vmclone/opDispatch.js';
import { onOpFinish, opStateOf } from '../vmclone/dispatch.js';

export const MAX_TRIES = 3;
const done = (f) => !!f && f.nic !== 'pending';

/** 마무리할 복원을 훑어 보낸다(던지지 않는다). @returns {number} 보낸 수 */
export function finishRestores(now = Date.now()) {
  let sent = 0;
  let list = [];
  try { list = restoresToFinish(); } catch { return 0; }
  for (const r of list) {
    try {
      if (!(r.state === 'ok' || r.state === 'warning')) {
        patchRestoreFinish(r.jobId, r.rid, { nic: 'skipped', detail: '복원이 성공으로 끝나지 않아 네트워크 끊기를 하지 않았습니다', at: now }, (cur) => !done(cur));
        continue;
      }
      if (!r.name) { patchRestoreFinish(r.jobId, r.rid, { nic: 'failed', detail: '복원한 VM 이름을 모릅니다 — 켜기 전에 vCenter 에서 네트워크 연결을 직접 끊으세요', at: now }, (cur) => !done(cur)); continue; }
      const f = r.finish;
      if (f?.nic === 'pending') {
        const st = f.opId ? opStateOf(f.opId) : null;
        if (st === 'pending' || st === 'running') continue;   // 아직 도는 중
        if (st === 'done') continue;                          // 훅이 곧 기록한다(같은 틱 경합)
        if ((f.tries || 0) >= MAX_TRIES) {
          patchRestoreFinish(r.jobId, r.rid, { nic: 'failed', detail: `네트워크 끊기를 ${MAX_TRIES}번 보냈지만 결과를 받지 못했습니다(재시작 · 엣지 응답 없음) — 켜기 전에 vCenter 에서 직접 확인하세요`, at: now, tries: f.tries }, (cur) => !done(cur));
          continue;
        }
      }
      const d = dispatchVmOp({ kind: 'bareos-nic', vcenterId: r.vcenterId, vmName: r.name, spec: { name: r.name, bareosJobId: r.jobId, rid: r.rid }, by: 'bareos-restore' });
      if (d.issue) {
        patchRestoreFinish(r.jobId, r.rid, { nic: 'failed', detail: `네트워크 끊기를 보내지 못했습니다(${d.issue}) — 켜기 전에 vCenter 에서 직접 끊으세요`, at: now }, (cur) => !done(cur));
        continue;
      }
      patchRestoreFinish(r.jobId, r.rid, { nic: 'pending', opId: d.op.id, tries: (f?.tries || 0) + 1, at: now }, (cur) => !done(cur));
      sent += 1;
    } catch (e) { console.warn(`[bareos] 복원 마무리 보내기 실패(${r.jobId} · ${r.rid}): ${e?.message || e}`); }
  }
  return sent;
}

/** vmclone 작업이 끝나면 원장에 남긴다 — 그 작업이 지금 기록된 작업일 때만(옛 작업의 늦은 결과가 새 시도를 덮지 않게). */
onOpFinish('bareos-nic', (op) => {
  const { bareosJobId, rid } = op.spec || {};
  if (!bareosJobId || !rid) return;
  patchRestoreFinish(String(bareosJobId), Number(rid), {
    nic: op.result?.ok ? 'ok' : 'failed', detail: String(op.result?.detail || '').slice(0, 400), at: op.doneAt || Date.now(), opId: op.id, ...(op.result?.late ? { late: true } : {}),
  }, (cur) => !cur || cur.nic === 'pending' ? (!cur?.opId || cur.opId === op.id) : false);
});
