// v2.757 — vCenter 카드의 'VM 백업 수량'(사용자 요청: Veeam 서버와 연동돼 있으면 Veeam 기준, 아니면 스냅샷 기준 · 182/195 형식).
// 판정만 하는 순수 함수(라우트 routes/api/veeam.js '/veeam/backup-counts' 가 부른다). 화면 문구는 web/src/views/veeamBadge.js backupCell.
// 원칙(루트 CLAUDE.md '못 읽은 값은 0 이 아니다'): 모르면 n=null + 이유 코드. 부분 합(마지막 성공 값·일부 서버만 읽음)은 partial 로 따로 표시한다.

/** 로그 폴러의 마지막 온전한 수집이 이보다 오래되면 스냅샷 기준 수량을 내지 않는다(그 뒤 백업이 빠진 부분 합 — snap-events 안내와 같은 6시간). */
export const SNAP_STALE_MS = 6 * 3_600_000;
/** v2.761(C3): 이보다 오래 남은 Veeam 임시 스냅샷은 '백업 중' 이 아니라 '잔존(정리 실패 의심)' — 웹 veeamBadge.js 의 같은 이름 상수와 같은 값(test/veeam2761b 가 대조). */
export const VEEAM_SNAP_STALE_MS = 24 * 3_600_000;

/**
 * Veeam 기준 — 그 vCenter 에 연결된 Veeam 서버 결과로 대조한 VM 수(작업 포함 또는 복원 지점 있음 = VM 화면 배지와 같은 기준).
 * @param {{ views: Array<{ok:(boolean|null), lastOkTs:(number|null), stale?:boolean}>, byVm: (object|null), vmTotal: number, otherVcenter?: number }} a
 *   byVm = matchToVcenter 결과(쓸 수 있는 결과가 하나도 없으면 null) · otherVcenter = 같은 결과에서 다른 vCenter 로 적힌 VM 수(matchToVcenter)
 */
export function veeamCount({ views, byVm, vmTotal, otherVcenter = 0 }) {
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
  // v2.761(B2): 쓸 수 있는 결과가 한도(주기 × 2 + 여유)보다 오래된 서버 — 숫자는 숨기지 않고(백업 대상은 천천히 바뀐다) 부분으로 표시한다.
  const stale = vs.filter((v) => v.stale === true).length;
  const other = Number.isInteger(otherVcenter) && otherVcenter > 0 ? otherVcenter : 0;
  return {
    src: 'veeam', n, vmTotal, running, pending, servers: vs.length,
    // 한 서버라도 이번에 실패(마지막 성공 값)·아직 못 읽음·오래됨이면 '부분' — 숫자는 보여 주되 표지를 단다.
    partial: failed + waiting + stale > 0, failed, waiting, stale,
    // v2.761(A5): 대조 0대인데 Veeam 이 다른 vCenter 이름으로 적은 VM 이 있으면 '0대' 가 아니라 이름 불일치 의심(n 은 그대로 둔다 — 정말 0대일 수도 있다).
    otherVcenter: other, ...(n === 0 && other > 0 ? { hostMismatch: true } : {}),
    basisTs: ok.length ? Math.min(...ok) : null,
  };
}

/**
 * v2.761(D4): 스냅샷 이벤트 요약(snap-events 결과)으로 수량을 낼 수 있는가 — 판정 코어 하나(카드 snapCount 와 VM 화면 칩이 같이 쓴다).
 * 이유 코드: 상태가 ok 가 아니면 그 상태 · 'stale-events'(마지막 온전한 수집이 6시간보다 오래됨 — 엣지 요약도) ·
 *   'no-collect-yet'(이 프로세스에서 로그 폴러가 돈 뒤에도 그 vCenter 수집 기록이 없음 — collectRan) · 'no-account'(계정 모름 + 찾은 VM 없음).
 *   collectedAt 이 없고 collectRan 도 없으면(재시작 직후 · 옛 엣지) 모름으로 보고 막지 않는다(업그레이드 중 전 엣지가 꺼지지 않게).
 * @returns {{ ok: boolean, reason: (string|null) }}
 */
export function snapVerdict(ev, now = Date.now()) {
  if (!ev || ev.status !== 'ok') return { ok: false, reason: ev?.status || 'no-data' };
  if (Number.isFinite(ev.collectedAt)) {
    if (now - ev.collectedAt > SNAP_STALE_MS) return { ok: false, reason: 'stale-events' };
  } else if (ev.collectRan === true) return { ok: false, reason: 'no-collect-yet' };
  if (ev.accounts === 0 && !Object.keys(ev.byVm || {}).length) return { ok: false, reason: 'no-account' };
  return { ok: true, reason: null };
}

/**
 * 스냅샷 기준 — 최근 N일 Veeam 이 스냅샷을 만든 VM(이벤트) ∪ 지금 Veeam 임시 스냅샷이 있는 VM(인벤토리). VM 단위로 한 번만.
 * v2.761(C3): 지금 임시 스냅샷은 만든 지 24시간 안(VEEAM_SNAP_STALE_MS)인 것만 — 그보다 오래된 것은 잔존(웹 배지 빨강)이라 snapStale 로 따로 센다.
 *   생성 시각을 모르는 스냅샷은 웹과 같이 포함한다.
 * @param {{ ev: object, vms: Array<{id:string, veeamSnaps?:number, veeamSnapTs?:number}>, now?: number }} a  ev = snap-events 결과
 */
export function snapCount({ ev, vms, now = Date.now() }) {
  const list = Array.isArray(vms) ? vms : [];
  const nowSet = new Set(); let snapStale = 0;
  for (const v of list) {
    if (!(Number(v?.veeamSnaps) > 0)) continue;
    if (Number.isFinite(v.veeamSnapTs) && Math.max(0, now - v.veeamSnapTs) >= VEEAM_SNAP_STALE_MS) snapStale++;
    else nowSet.add(v.id);
  }
  const base = { src: 'snap', vmTotal: list.length, snapNow: nowSet.size, snapStale, days: ev?.days ?? null };
  const vd = snapVerdict(ev, now);
  if (!vd.ok) {
    if (vd.reason === 'stale-events') return { ...base, n: null, reason: vd.reason, collectedAt: ev.collectedAt };
    if (vd.reason === 'no-account' || vd.reason === 'no-collect-yet') return { ...base, n: null, reason: vd.reason };
    return { ...base, n: null, reason: vd.reason, at: ev?.at ?? null };
  }
  const evIds = Object.keys(ev.byVm || {});
  const all = new Set([...evIds, ...nowSet]);
  const ambiguous = Number.isInteger(ev.ambiguous) && ev.ambiguous > 0 ? ev.ambiguous : 0;
  return {
    ...base, n: all.size, snapEv: evIds.length, overlap: evIds.length + nowSet.size - all.size,
    unpaired: ev.unpaired || 0, ambiguous,
    // 이벤트가 상한에 걸려 일부만 읽었거나(truncated) 동명 VM 이라 정하지 못한 이벤트가 있다(v2.761 C6 — unmatched 는 지운 VM 이 정상이라 넣지 않는다)
    partial: !!ev.truncated || ambiguous > 0,
    source: ev.source || 'local',
    at: ev.at ?? null, collectedAt: Number.isFinite(ev.collectedAt) ? ev.collectedAt : null,
  };
}
