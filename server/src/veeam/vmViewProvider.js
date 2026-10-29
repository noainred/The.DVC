/**
 * veeam/vmViewProvider.js — 'VM 한 대의 Veeam·스냅샷 판정'(vmBackupView)을 다른 도메인이 받는 통로(v2.801).
 *
 * 왜: VM 전체 정보 내보내기(vcenter/vmExport — 라우트 routes/api/vmExport.js)에 Veeam 묶음을 넣는다(사용자 요청 2026-10-27
 *   "선택 항목에 veeam 마지막 백업 여부 / 백업용 snapshot 최근 생성 여부도"). 그 판정의 입력(vCenter 대조 · 스냅샷 이벤트 캐시 · EM 출처)은
 *   routes/api/veeam.js 의 vcBackup 이 만든다 — 라우트끼리 import 하면 의존 방향 규칙(routes/ 는 index.js 만 import — test/arch2579)을 깨고,
 *   그 함수를 통째로 옮기면 백업 메뉴 전체를 흔든다. 그래서 veeam 라우트가 mount 될 때 자기 함수를 여기에 걸고, 다른 쪽은 여기서 부른다.
 *   판정 코어는 그대로 하나다(vcBackup → vmBackupView — VM 목록 내보내기와 같은 값).
 *
 * 걸린 것이 없으면(veeam 라우트가 mount 되지 않은 테스트·도구) null — 받는 쪽은 Veeam 칸을 '수집 안 됨' 으로 쓴다(지어내지 않는다).
 */
let provider = null;

/** veeam 라우트가 mount 때 건다. fn(vc, vms, req, { now }) → { linked, snapDays, byId: Map(vmId → view) } | null */
export function setVeeamVmViewProvider(fn) { provider = typeof fn === 'function' ? fn : null; }

/** 그 vCenter 의 VM 판정 묶음. 걸린 것이 없거나 실패하면 null(받는 쪽이 '수집 안 됨'). */
export async function veeamVmViews(vc, vms, req, opts = {}) {
  if (!provider) return null;
  try { return (await provider(vc, vms, req, opts)) || null; } catch { return null; }
}
