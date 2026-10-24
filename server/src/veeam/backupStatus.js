/**
 * veeam/backupStatus.js — '백업' 메뉴(백업 서머리 · 백업 세부내용, v2.779 — 사용자 요청 "1개 vcenter 를 선택하면 VM 백업 전체 현황 ·
 *   전체 28개 vcenter 의 백업 현황 · veeam 백업과 snapshot 둘다 표시")의 판정(순수).
 *
 * 새 판정을 만들지 않는다 — 두 기준은 이미 있는 코어의 결과를 **VM 단위로 합칠** 뿐이다:
 *  · Veeam = veeam/parse.js matchToVcenter 의 byVm(VM 화면 Veeam 배지·카드 앞 수와 같은 기준)
 *  · 스냅샷 = 스냅샷 이벤트 요약(ev.byVm — [마지막 시각, 횟수]) ∪ 지금 Veeam 임시 스냅샷(하루 넘은 '잔존' 은 빼고 따로 센다)
 *    — veeam/backupCounts.js snapCount 와 같은 기준(그 수와 이 모듈의 스냅샷 수가 같아야 한다 — 테스트가 대조).
 * 못 읽은 쪽은 0 이 아니라 모름(null)이다. 한쪽을 모르면 '둘 다/한쪽만/확인 안 됨' 나눔도 모름이다(연동 없는 Veeam 은 모름이 아니라 '없음').
 */
import { VEEAM_SNAP_STALE_MS } from './backupCounts.js';

const isFin = (v) => typeof v === 'number' && Number.isFinite(v);

/** 지금 Veeam 임시 스냅샷 — { n, ts, stale } 또는 null. backupCounts.snapCount 와 같은 잔존 기준. */
export function currentSnapOf(vm, now = Date.now()) {
  const n = Number(vm?.veeamSnaps);
  if (!(n > 0)) return null;
  const ts = isFin(vm.veeamSnapTs) ? vm.veeamSnapTs : null;
  return { n, ts, stale: ts != null && Math.max(0, now - ts) >= VEEAM_SNAP_STALE_MS };
}

/**
 * vCenter 한 곳의 행.
 * @param {object} p
 * @param {Array} p.vms               그 vCenter 의 VM(인벤토리)
 * @param {boolean} p.linked          Veeam 서버가 연결돼 있는가(등록부)
 * @param {object|null} p.vcnt        backupCounts.veeamCount 결과(연동 없으면 null)
 * @param {object|null} p.match       parse.matchToVcenter 결과(쓸 결과가 없으면 null)
 * @param {object|null} p.sc          backupCounts.snapCount 결과
 * @param {object|null} p.ev          스냅샷 이벤트 요약(byVm)
 */
export function backupRow({ vms, linked, vcnt = null, match = null, sc = null, ev = null, now = Date.now() }) {
  const list = Array.isArray(vms) ? vms : [];
  const veeamKnown = !!(linked && vcnt && isFin(vcnt.n) && match);
  const snapKnown = !!(sc && isFin(sc.n));
  const V = veeamKnown ? new Set(Object.keys(match.byVm || {})) : null;
  let S = null; let snapStale = 0;
  const known = new Set(list.map((v) => v.id));
  if (snapKnown) {
    S = new Set(Object.keys(ev?.byVm || {}).filter((id) => known.has(id)));
  }
  for (const vm of list) {
    const c = currentSnapOf(vm, now);
    if (!c) continue;
    if (c.stale) snapStale++;
    else if (S) S.add(vm.id);
  }
  let lastBackup = null; let running = 0; let pending = 0;
  if (veeamKnown) {
    for (const e of Object.values(match.byVm || {})) {
      if (e && isFin(e.lb) && (lastBackup == null || e.lb > lastBackup)) lastBackup = e.lb;
      if (e?.run === 1) running++; else if (e?.run === 2) pending++;
    }
  }
  // 나눔 — 두 쪽을 다 알 때(연동 없는 vCenter 는 Veeam 이 '없음' 으로 확정이라 스냅샷만 알면 된다).
  let split = null;
  if (snapKnown && (veeamKnown || !linked)) {
    let both = 0; let vOnly = 0; let sOnly = 0;
    const Vs = V || new Set();
    for (const id of Vs) if (S.has(id)) both++; else vOnly++;
    for (const id of S) if (!Vs.has(id)) sOnly++;
    split = { both, vOnly, sOnly, none: Math.max(0, list.length - both - vOnly - sOnly) };
  }
  return {
    vm: list.length,
    veeam: linked ? (veeamKnown ? V.size : null) : null,
    veeamState: !linked ? 'unlinked' : veeamKnown ? (vcnt.partial ? 'partial' : 'ok') : (vcnt?.reason || 'unknown'),
    snap: snapKnown ? S.size : null,
    snapState: snapKnown ? (sc.partial ? 'partial' : 'ok') : (sc?.reason || 'unknown'),
    snapStale,
    split,
    running: veeamKnown ? running : null,
    pending: veeamKnown ? pending : null,
    lastBackup,
  };
}

/** 합계 — 모르는 값은 0 으로 더하지 않고 그 vCenter 를 센다. */
export function backupTotals(rows) {
  const t = { vcenters: 0, vm: 0, veeam: 0, snap: 0, both: 0, vOnly: 0, sOnly: 0, none: 0, running: 0, pending: 0, snapStale: 0,
    veeamUnknown: 0, veeamUnlinked: 0, snapUnknown: 0, splitUnknown: 0 };
  for (const r of Array.isArray(rows) ? rows : []) {
    t.vcenters++; t.vm += r.vm || 0; t.snapStale += r.snapStale || 0;
    if (r.veeamState === 'unlinked') t.veeamUnlinked++;
    else if (isFin(r.veeam)) { t.veeam += r.veeam; t.running += r.running || 0; t.pending += r.pending || 0; } else t.veeamUnknown++;
    if (isFin(r.snap)) t.snap += r.snap; else t.snapUnknown++;
    if (r.split) { t.both += r.split.both; t.vOnly += r.split.vOnly; t.sOnly += r.split.sOnly; t.none += r.split.none; } else t.splitUnknown++;
  }
  return t;
}

/**
 * VM 한 대(세부내용) — Veeam 배지 근거(matchToVcenter 의 원소)와 스냅샷 근거만 싣는다.
 * @param {object} vm 인벤토리 VM @param {object|undefined} ve matchToVcenter byVm[vm.id] @param {Array|undefined} evEntry ev.byVm[vm.id]
 */
export function vmBackupView(vm, ve, evEntry, { veeamKnown = true, snapKnown = true, now = Date.now() } = {}) {
  const v = ve ? {
    state: ve.run === 1 ? 'run' : ve.run === 2 ? 'wait' : 'ok', pg: ve.run === 1 && isFin(ve.pg) ? ve.pg : null, by: ve.by || '',
    jobs: Array.isArray(ve.jobs) ? ve.jobs.slice(0, 5) : [], rp: isFin(ve.rp) ? ve.rp : null,
    lb: isFin(ve.lb) ? ve.lb : null, lbSrc: ve.lbSrc || '', lastResult: ve.lastResult || '', ag: ve.ag === 1,
  } : null;
  const ev = Array.isArray(evEntry) && isFin(evEntry[0]) ? { ts: evEntry[0], n: Number.isInteger(evEntry[1]) ? evEntry[1] : null } : null;
  return {
    id: vm.id, name: String(vm.name || ''), folder: String(vm.folder || ''), power: vm.powerState || '',
    v: veeamKnown ? v : undefined,
    s: { ev: snapKnown ? ev : undefined, now: currentSnapOf(vm, now) },
  };
}
