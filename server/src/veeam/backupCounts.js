// v2.757 — vCenter 카드의 'VM 백업 수량'(사용자 요청: Veeam 서버와 연동돼 있으면 Veeam 기준, 아니면 스냅샷 기준 · 182/195 형식).
// 판정만 하는 순수 함수(라우트 routes/api/veeam.js '/veeam/backup-counts' 가 부른다). 화면 문구는 web/src/views/veeamBadge.js backupCell.
// 원칙(루트 CLAUDE.md '못 읽은 값은 0 이 아니다'): 모르면 n=null + 이유 코드. 부분 합(마지막 성공 값·일부 서버만 읽음)은 partial 로 따로 표시한다.

/** 로그 폴러의 마지막 온전한 수집이 이보다 오래되면 스냅샷 기준 수량을 내지 않는다(그 뒤 백업이 빠진 부분 합 — snap-events 안내와 같은 6시간). */
export const SNAP_STALE_MS = 6 * 3_600_000;

/**
 * Veeam 기준 — 그 vCenter 에 연결된 Veeam 서버 결과로 대조한 VM 수(작업 포함 또는 복원 지점 있음 = VM 화면 배지와 같은 기준).
 * @param {{ views: Array<{ok:(boolean|null), lastOkTs:(number|null)}>, byVm: (object|null), vmTotal: number }} a
 *   byVm = matchToVcenter 결과(쓸 수 있는 결과가 하나도 없으면 null)
 */
export function veeamCount({ views, byVm, vmTotal }) {
  const vs = Array.isArray(views) ? views : [];
  if (!byVm) {
    const reason = vs.some((v) => v.ok == null) ? 'veeam-pending' : 'veeam-failed';
    return { src: 'veeam', n: null, vmTotal, reason };
  }
  let n = 0; let running = 0; let pending = 0;
  for (const e of Object.values(byVm)) {
    if (!e || typeof e !== 'object') continue;
    n++;
    if (e.run === 1) running++; else if (e.run === 2) pending++;
  }
  const ok = vs.filter((v) => Number.isFinite(v.lastOkTs)).map((v) => v.lastOkTs);
  const failed = vs.filter((v) => v.ok === false).length;
  const waiting = vs.filter((v) => v.ok == null).length;
  return {
    src: 'veeam', n, vmTotal, running, pending, servers: vs.length,
    // 한 서버라도 이번에 실패(마지막 성공 값) 또는 아직 못 읽었으면 '부분' — 숫자는 보여 주되 표지를 단다.
    partial: failed + waiting > 0, failed, waiting,
    basisTs: ok.length ? Math.min(...ok) : null,
  };
}

/**
 * 스냅샷 기준 — 최근 N일 Veeam 이 스냅샷을 만든 VM(이벤트) ∪ 지금 Veeam 임시 스냅샷이 있는 VM(인벤토리). VM 단위로 한 번만.
 * @param {{ ev: object, vms: Array<{id:string, veeamSnaps?:number}>, now?: number }} a  ev = snap-events 결과
 */
export function snapCount({ ev, vms, now = Date.now() }) {
  const list = Array.isArray(vms) ? vms : [];
  const nowSet = new Set(list.filter((v) => Number(v?.veeamSnaps) > 0).map((v) => v.id));
  const base = { src: 'snap', vmTotal: list.length, snapNow: nowSet.size, days: ev?.days ?? null };
  if (!ev || ev.status !== 'ok') return { ...base, n: null, reason: ev?.status || 'no-data', at: ev?.at ?? null };
  if (ev.source === 'local' && Number.isFinite(ev.collectedAt) && now - ev.collectedAt > SNAP_STALE_MS) {
    return { ...base, n: null, reason: 'stale-events', collectedAt: ev.collectedAt };
  }
  const evIds = Object.keys(ev.byVm || {});
  // 계정을 모르고 이벤트로 찾은 VM 도 없으면 0 이 아니라 '모름'(snap-events 안내 #6 과 같은 조건).
  if (ev.accounts === 0 && !evIds.length) return { ...base, n: null, reason: 'no-account' };
  const all = new Set([...evIds, ...nowSet]);
  return {
    ...base, n: all.size, snapEv: evIds.length, overlap: evIds.length + nowSet.size - all.size,
    unpaired: ev.unpaired || 0, partial: !!ev.truncated, // 이벤트가 상한에 걸려 일부만 읽었다
    source: ev.source || 'local',
    at: ev.at ?? null, collectedAt: Number.isFinite(ev.collectedAt) ? ev.collectedAt : null,
  };
}
