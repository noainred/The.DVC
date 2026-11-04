/**
 * issues/visibility.js — '이 이름의 사람이 이 법인의 이슈를 볼 수 있는가' 판정 하나(v2.871 감사 A3-01 · A2-06 · A5-02).
 *
 * 쓰는 곳: 자동 할당·담당자 제안(routes/api/issues.js) · 알림 수신자 거르기(issues/notify.js). 두 벌로 두지 않는다.
 *   · 로컬 계정 — 그 계정의 조회 범위(scopedVcenterIds)로 본다. 범위가 없으면 전부, 있으면 그 법인을 포함할 때만(공용 이슈는 못 본다).
 *   · 로컬 계정이 아닌 이름 — AD 로그인 사용자로 본다. AD 사용자에게는 vCenter 범위가 없다(auth/ad.js authenticate 가
 *     username·name·role 만 돌려준다 — 범위 축이 없다)라서 전체 범위다. 그 이름이 AD 에도 없는 오타라면 메일 주소 표에 없으므로 받지 않는다.
 *   · 판정 근거(계정 목록·스냅샷)는 부를 때 한 번 읽는다 — 묶음 하나 · 요청 하나 안에서 같은 판정을 쓰게.
 */
import { listUsers } from '../auth/auth.js';
import { scopedVcenterIds } from '../auth/scope.js';
import { store } from '../store.js';

/** @returns {{ canSee: (name: string, vcenterId: string) => boolean, localNames: Set<string> }} */
export function issueViewers() {
  const snap = store.get();
  let users = [];
  try { users = listUsers(); } catch { users = []; }
  const byName = new Map(users.filter((u) => u?.username).map((u) => [u.username, u]));
  const memo = new Map();
  const readOf = (u) => {
    if (!memo.has(u.username)) memo.set(u.username, scopedVcenterIds(u, snap));
    return memo.get(u.username);
  };
  return {
    localNames: new Set(byName.keys()),
    canSee(name, vcenterId) {
      const u = byName.get(name);
      if (!u) return true;
      if (u.demo) return false; // 데모 계정에게는 실제 이슈 알림을 보내지 않는다
      const read = readOf(u);
      if (!read) return true;
      return !!vcenterId && read.has(vcenterId);
    },
  };
}
