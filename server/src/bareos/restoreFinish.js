/**
 * bareos/restoreFinish.js — Bareos 복원 마무리: 새 VM 복원 뒤 네트워크 카드 끊기(v2.861 — 사용자 요청 '복원할 때 네트워크 연결 끊고 시작').
 *
 * Bareos VMware 플러그인은 새 VM 을 꺼진 채(restore_powerstate=off)로 만들지만 NIC 는 백업 때 그대로(연결 · 켤 때 연결)다. 원본이 살아 있는 망에
 * 같은 IP · 호스트명 · AD 계정으로 붙지 않게, 복원이 성공(T · W)으로 끝나면 그 vCenter 에 로그인하는 노드(중앙 직접 · 담당 엣지)에
 * vmclone 작업 'bareos-nic'(vsOps.disconnectRestoredVm)을 보낸다. 결과는 원장 restores[].finish 에 남는다.
 * 대상은 끊기를 고른 복원(nic === 'disconnect') — 새 VM 은 기본, 원래 VM 덮어쓰기는 사람이 고를 때만(그 VM 의 NIC 가 끊긴다 — 화면이 알린다).
 *  · 보내는 곳은 vmclone/opDispatch.js 하나(실행 위치 판정을 복제하지 않는다).
 *  · 같은 VM 을 다시 끊어도 결과가 같다(이미 끊겼으면 재구성하지 않고 확인만) — 재시작으로 보낸 작업을 잃었으면 다시 보낸다(최대 MAX_TRIES).
 *  · 복원이 실패 · 취소로 끝나면 'skipped'(플러그인이 VM 을 일부 만들었을 수 있다 — 사유가 확인을 권한다). 추적을 놓친 복원은 'failed'(결과 모름).
 *  · 켜져 있거나 같은 이름이 둘이면 손대지 않고 'failed'(사유 — 사람이 확인).
 *  · 원장 쓰기는 한 번에 묶는다(inBatch — 반증 검토 M2: 3,000 대상 원장에서 50건이면 동기 저장 50회 약 2.3초 블로킹).
 *  · 엣지가 가져가지 않은 작업은 여기서도 시한을 본다(reapOps — 아무도 VM 백업 센터를 열지 않으면 '끊는 중' 에 머물렀다 · L3).
 *  · 부르는 곳: 폴러 틱 시작(재시작 뒤 이어 가기 — Director 에 접속하지 않는다) · 복원 행 반영 뒤(폴러 · 로그 열기).
 */
import { restoresToFinish, patchRestoreFinish, inBatch } from './registry.js';
import { dispatchVmOp } from '../vmclone/opDispatch.js';
import { onOpFinish, opStateOf, reapOps } from '../vmclone/dispatch.js';

export const MAX_TRIES = 3;
const done = (f) => !!f && f.nic !== 'pending';

/** 마무리할 복원을 훑어 보낸다(던지지 않는다). @returns {number} 보낸 수 */
export function finishRestores(now = Date.now()) {
  try { reapOps(now); } catch { /* 시한 정리 실패는 다음 틱에 */ }
  let list = [];
  try { list = restoresToFinish(); } catch { return 0; }
  if (!list.length) return 0;
  // v2.870 감사 A2-06: '던지지 않는다' 계약 — 묶음 저장(디스크 오류)이 던지면 0 을 돌려준다.
  // v2.871 감사 A2-09(주석 정정 + 동작): 이때 메모리 원장은 이미 바뀌었고(pending + opId) vmclone 작업도 이미 나갔다 — '원장은 그대로' 가 아니다.
  //   registry 의 미저장 표지(_dirty)가 쓰기 성공 때만 내려가므로 다음 틱의 inBatch 끝에서 같은 메모리 원장을 다시 쓴다(작업을 다시 보내지는 않는다 —
  //   메모리의 pending + opId 를 보고 '도는 중' 으로 건너뛴다). 다시 쓰기 전에 재시작하면 디스크본 기준으로 다시 보낸다(끊기는 멱등 — 피해 작음).
  try { return inBatch(() => finishList(list, now)); } catch (e) { console.warn(`[bareos] 복원 마무리 원장 저장 실패: ${String(e?.message || e).slice(0, 200)}`); return 0; }
}

function finishList(list, now) {
  let sent = 0;
  for (const r of list) {
    try {
      if (r.abandoned) {
        patchRestoreFinish(r.jobId, r.rid, { nic: 'failed', detail: `복원 추적을 놓쳐 결과를 모릅니다 — ‘${r.name || '?'}’ VM 이 만들어졌다면 네트워크가 연결된 채일 수 있습니다. 켜기 전에 vCenter 에서 확인하세요`, at: now }, (cur) => !done(cur));
        continue;
      }
      if (!(r.state === 'ok' || r.state === 'warning')) {
        patchRestoreFinish(r.jobId, r.rid, { nic: 'skipped', detail: `복원이 성공으로 끝나지 않아 네트워크 끊기를 하지 않았습니다 — 플러그인이 ‘${r.name || '?'}’ VM 을 일부 만들었을 수 있으니 vCenter 에서 확인하세요`, at: now }, (cur) => !done(cur));
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
      // v2.862 복원 검증(리허설)은 끊기 + 켜 보기 + (성공이면) 지우기를 한 작업으로(bareos-verify — 끊기를 확인 못 하면 켜지 않는다)
      const d = r.verify
        ? dispatchVmOp({ kind: 'bareos-verify', vcenterId: r.vcenterId, vmName: r.name, spec: { name: r.name, bareosJobId: r.jobId, rid: r.rid, deleteOnOk: r.deleteOnOk !== false, ...((f?.tries || 0) > 0 ? { retry: true } : {}) }, by: 'bareos-rehearsal' })
        : dispatchVmOp({ kind: 'bareos-nic', vcenterId: r.vcenterId, vmName: r.name, spec: { name: r.name, bareosJobId: r.jobId, rid: r.rid }, by: 'bareos-restore' });
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

/**
 * 이 결과를 원장에 쓸 것인가 — 지금 기록된 시도의 결과일 때만(옛 작업의 늦은 결과가 새 시도를 덮지 않게).
 * v2.870 감사 A2-03: 시한이 지나 닫힌(reapOps → 'failed') **같은 작업**의 늦은 회신(ackOp → late)은 받는다 — 예전에는 cur.nic 이 'failed' 라
 *   버려져 훅의 late 칸이 죽은 코드였고, 엣지가 실제로 끝낸 검증이 '실패' 로 남았다. 재시도(다른 opId)가 나간 뒤의 늦은 회신은 여전히 버린다.
 */
export const sameOp = (op) => (cur) => !cur || (cur.nic === 'pending' ? (!cur.opId || cur.opId === op.id) : (!!op.result?.late && !!cur.opId && cur.opId === op.id));
/** v2.862 복원 검증 결과 — 끊기 · 켜 보기 · 지우기를 한 기록에(Tools 응답 시간은 모르면 없음 — 0 이 아니다). */
onOpFinish('bareos-verify', (op) => {
  const { bareosJobId, rid } = op.spec || {};
  if (!bareosJobId || !rid) return;
  const ok = !!op.result?.ok;
  patchRestoreFinish(String(bareosJobId), Number(rid), {
    // v2.899(점검 B2 — 재현): 끊기를 확인한 뒤의 실패(Tools 시한 · 켜기 · 끄기)는 nic 'ok' — 예전엔 검증 실패면 늘 '네트워크 끊기 실패' 로 적고 세었다(재해 복구 사유 · 요약 메일).
    //   nicOff 를 모르는 옛 엣지 회신은 예전 판정(실패면 failed)을 그대로 — 끊었다고 지어내지 않는다.
    nic: ok || op.result?.nicOff === true ? 'ok' : 'failed', verify: ok ? 'ok' : 'failed', detail: String(op.result?.detail || '').slice(0, 400), at: op.doneAt || Date.now(), opId: op.id,
    ...(Number.isFinite(op.result?.toolsMs) ? { toolsMs: op.result.toolsMs } : {}), ...(typeof op.result?.deleted === 'boolean' ? { deleted: op.result.deleted } : {}), ...(op.result?.late ? { late: true } : {}),   // v2.874 B3-01 남김(false)도 — 없으면 화면이 '모름'
  }, sameOp(op));
});

/** vmclone 작업이 끝나면 원장에 남긴다 — 그 작업이 지금 기록된 작업일 때만(옛 작업의 늦은 결과가 새 시도를 덮지 않게). */
onOpFinish('bareos-nic', (op) => {
  const { bareosJobId, rid } = op.spec || {};
  if (!bareosJobId || !rid) return;
  patchRestoreFinish(String(bareosJobId), Number(rid), {
    nic: op.result?.ok ? 'ok' : 'failed', detail: String(op.result?.detail || '').slice(0, 400), at: op.doneAt || Date.now(), opId: op.id, ...(op.result?.late ? { late: true } : {}),
  }, sameOp(op));
});
