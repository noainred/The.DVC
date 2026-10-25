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
 * v2.780(사용자 요청 '켜져 있는 VM 과 꺼져 있는 VM 선택' + 템플릿·vCLS 제외): 집계할 VM 범위(순수).
 *  · power 'on' = POWERED_ON · 'off' = 전원 값이 있고 ON 이 아닌 것(일시 중지 포함 — 사용자 결정) · 그 밖 = 전체.
 *    전원 값이 없는 VM 은 on·off 어느 쪽에도 넣지 않고 powerUnknown 으로 센다(지어내지 않는다).
 *  · excl(기본 true) = 템플릿(vm.template)·vCLS 시스템 VM(이름이 vCLS 로 시작)을 빼고 excluded 로 센다 — 백업 대상이 아니라 '확인 안 됨' 을 부풀린다.
 * @returns {{ vms:Array, excluded:number, powerUnknown:number, power:'all'|'on'|'off', excl:boolean }}
 */
export const POWER_VALUES = Object.freeze(['all', 'on', 'off']);
export function isSystemVm(vm) { return vm?.template === true || /^vcls/i.test(String(vm?.name || '')); }
export function vmScope(vms, { power = 'all', excl = true } = {}) {
  const pw = POWER_VALUES.includes(power) ? power : 'all';
  const ex = excl !== false;
  let excluded = 0; let powerUnknown = 0;
  const out = [];
  for (const vm of Array.isArray(vms) ? vms : []) {
    if (ex && isSystemVm(vm)) { excluded++; continue; }
    if (pw !== 'all') {
      const ps = typeof vm?.powerState === 'string' ? vm.powerState.trim() : '';
      if (!ps) { powerUnknown++; continue; }
      if ((ps === 'POWERED_ON') !== (pw === 'on')) continue;
    }
    out.push(vm);
  }
  return { vms: out, excluded, powerUnknown, power: pw, excl: ex };
}

export const RPO_DAYS = Object.freeze([1, 3, 7]);
const DAY = 86_400_000;
/** VM 의 마지막 결과 — 그 VM 의 마지막 task 결과(lr)가 먼저, 없으면 작업의 마지막 결과. */
export const resultOf = (ve) => String(ve?.lr || ve?.lastResult || '');

/**
 * vCenter 한 곳의 행.
 * @param {object} p
 * @param {Array} p.vms               그 vCenter 의 VM(인벤토리)
 * @param {boolean} p.linked          Veeam 서버가 연결돼 있는가(등록부)
 * @param {object|null} p.vcnt        backupCounts.veeamCount 결과(연동 없으면 null)
 * @param {object|null} p.match       parse.matchToVcenter 결과(쓸 결과가 없으면 null)
 * @param {object|null} p.sc          backupCounts.snapCount 결과
 * @param {object|null} p.ev          스냅샷 이벤트 요약(byVm)
 * @param {boolean} [p.runningStale]  v2.781(점검 G3 B-B1): 마지막 읽기가 실패했거나 오래된 서버가 있어 그 서버의 '백업 중' 을 지웠다(resultsFor runningStale)
 *   — 수는 지우지 않는다(다른 서버의 수는 사실 = 하한). 행에 runningStale 표지만 단다(badges 와 같은 판정).
 * @param {boolean} [p.noInventory]   v2.781(점검 G3 C-B1): vCenter **전체** 인벤토리가 없다(재시작 직후 골격·VM 0대) — vm 은 0 이 아니라 모름(null).
 */
export function backupRow({ vms, linked, vcnt = null, match = null, sc = null, ev = null, runningStale = false, noInventory = false, now = Date.now() }) {
  const list = Array.isArray(vms) ? vms : [];
  const veeamKnown = !!(linked && vcnt && isFin(vcnt.n) && match);
  const snapKnown = !!(sc && isFin(sc.n));
  const known = new Set(list.map((v) => v.id));
  // v2.780: 매칭은 vCenter 전체로 한 결과를 받는다(캐시·별칭 학습을 범위와 무관하게) — 여기서 지금 범위의 VM 만 센다.
  const V = veeamKnown ? new Set(Object.keys(match.byVm || {}).filter((id) => known.has(id))) : null;
  let S = null; let snapStale = 0;
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
  const rpo = { d1: 0, d3: 0, d7: 0, unknown: 0 }; const results = { failed: 0, warning: 0 };
  if (veeamKnown) {
    for (const id of V) {
      const e = match.byVm[id];
      if (e && isFin(e.lb) && (lastBackup == null || e.lb > lastBackup)) lastBackup = e.lb;
      if (e?.run === 1) running++; else if (e?.run === 2) pending++;
      // 오래된 백업(RPO) — 마지막 백업 완료가 N일 넘음 · 시각을 모르면 따로
      if (!e || !isFin(e.lb)) rpo.unknown++;
      else { const age = now - e.lb; if (age > DAY) rpo.d1++; if (age > 3 * DAY) rpo.d3++; if (age > 7 * DAY) rpo.d7++; }
      const r = resultOf(e);
      if (/^fail/i.test(r)) results.failed++; else if (/^warn/i.test(r)) results.warning++;
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
    vm: noInventory ? null : list.length,
    veeam: linked ? (veeamKnown ? V.size : null) : null,
    veeamState: !linked ? 'unlinked' : veeamKnown ? (vcnt.partial ? 'partial' : 'ok') : (vcnt?.reason || 'unknown'),
    snap: snapKnown ? S.size : null,
    snapState: snapKnown ? (sc.partial ? 'partial' : 'ok') : (sc?.reason || 'unknown'),
    snapStale,
    split,
    running: veeamKnown ? running : null,
    pending: veeamKnown ? pending : null,
    ...(veeamKnown && runningStale ? { runningStale: true } : {}),
    lastBackup,
    rpo: veeamKnown ? rpo : null,
    results: veeamKnown ? results : null,
  };
}

/**
 * 합계 — 모르는 값은 0 으로 더하지 않고 그 vCenter 를 센다.
 * v2.781(점검 G3 B-B2 ≡ C-B2): 기존 필드(veeam·snap·running … 0 에서 시작)의 뜻은 그대로 두고, '얼마나 알았는가' 를 같이 낸다 —
 *   웹은 아는 곳이 0 이면 '—', 비율의 분모는 그 기준을 아는 vCenter 의 VM 합(확인 불가 vCenter 의 VM 을 분모에 넣지 않는다), 부분 합이면 표지.
 *   · veeamKnownVcs = Veeam 을 읽은 vCenter 수(연동 없음은 빼고 veeamUnlinked 로) · vmVeeamKnown = 그 vCenter 들 + 연동 없음 vCenter('없음' 확정)의 VM 합
 *   · snapKnownVcs·vmSnapKnown = 스냅샷 기준을 아는 vCenter 수·그 VM 합 · veeamPartial·snapPartial = 일부만 읽은 행 수(수는 하한)
 *   · runningUnknown = '백업 중' 을 지운 서버가 있는 행 수(B-B1 — running·pending 은 하한) · vmUnknown = VM 목록을 모르는 행 수(C-B1)
 */
export function backupTotals(rows) {
  const t = { vcenters: 0, vm: 0, veeam: 0, snap: 0, both: 0, vOnly: 0, sOnly: 0, none: 0, running: 0, pending: 0, snapStale: 0,
    veeamUnknown: 0, veeamUnlinked: 0, snapUnknown: 0, splitUnknown: 0,
    rpo: { d1: 0, d3: 0, d7: 0, unknown: 0 }, failed: 0, warning: 0, excluded: 0, powerUnknown: 0,
    veeamKnownVcs: 0, snapKnownVcs: 0, vmVeeamKnown: 0, vmSnapKnown: 0, veeamPartial: 0, snapPartial: 0, runningUnknown: 0, vmUnknown: 0 };
  for (const r of Array.isArray(rows) ? rows : []) {
    const vm = isFin(r.vm) ? r.vm : null;
    t.vcenters++; t.vm += vm ?? 0; t.snapStale += r.snapStale || 0;
    if (vm == null) t.vmUnknown++;
    if (r.veeamState === 'unlinked') { t.veeamUnlinked++; t.vmVeeamKnown += vm ?? 0; }
    else if (isFin(r.veeam)) {
      t.veeamKnownVcs++; t.vmVeeamKnown += vm ?? 0;
      if (r.veeamState === 'partial') t.veeamPartial++;
      // null 을 0 으로 삼키지 않는다 — 수가 있는 것만 더하고, 지운 서버가 있으면 따로 센다(하한)
      if (isFin(r.running)) t.running += r.running;
      if (isFin(r.pending)) t.pending += r.pending;
      if (r.runningStale === true || !isFin(r.running)) t.runningUnknown++;
      t.veeam += r.veeam;
      if (r.rpo) for (const k of ['d1', 'd3', 'd7', 'unknown']) t.rpo[k] += r.rpo[k] || 0;
      if (r.results) { t.failed += r.results.failed || 0; t.warning += r.results.warning || 0; }
    } else t.veeamUnknown++;
    t.excluded += r.excluded || 0; t.powerUnknown += r.powerUnknown || 0;
    if (isFin(r.snap)) { t.snap += r.snap; t.snapKnownVcs++; t.vmSnapKnown += vm ?? 0; if (r.snapState === 'partial') t.snapPartial++; } else t.snapUnknown++;
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
    ...(ve.lr ? { lr: String(ve.lr).slice(0, 32) } : {}),   // v2.780: 그 VM 의 마지막 task 결과(작업 결과보다 먼저 본다)
  } : null;
  const ev = Array.isArray(evEntry) && isFin(evEntry[0]) ? { ts: evEntry[0], n: Number.isInteger(evEntry[1]) ? evEntry[1] : null } : null;
  return {
    id: vm.id, name: String(vm.name || ''), folder: String(vm.folder || ''), power: vm.powerState || '',
    v: veeamKnown ? v : undefined,
    s: { ev: snapKnown ? ev : undefined, now: currentSnapOf(vm, now) },
  };
}

/*
 * v2.780: 세부내용의 '보기' 필터(VM 한 대 — vmBackupView 모양) — 웹 views/tools/backupViewText.js vmMatches 와 같은 판정이다
 *   (CSV 가 화면과 같은 VM 을 내보내게 · 웹 테스트가 같은 입력으로 두 함수를 대조한다).
 *   v 키 없음 = Veeam 모름 · v null = 없음 / s.ev 키 없음 = 스냅샷 모름 · 잔존(하루 넘은 임시 스냅샷)은 스냅샷으로 치지 않는다.
 */
export const VIEW_FILTERS = Object.freeze(['all', 'veeam', 'snaponly', 'none', 'run', 'stale', 'rpo', 'fail']);
export function viewClass(vm, { rpoDays = 1, now = Date.now() } = {}) {
  const vKnown = !!vm && 'v' in vm && vm.v !== undefined;
  const v = vKnown ? vm.v : null;
  const sKnown = !!(vm && vm.s && 'ev' in vm.s && vm.s.ev !== undefined);
  const snapNow = vm?.s?.now || null;
  const snap = !!((sKnown && vm.s.ev) || (snapNow && !snapNow.stale));
  const r = v ? String(v.lr || v.lastResult || '') : '';
  const days = RPO_DAYS.includes(Number(rpoDays)) ? Number(rpoDays) : 1;
  return {
    vKnown, veeam: !!v, run: !!(v && (v.state === 'run' || v.state === 'wait')), sKnown, snap, stale: !!(snapNow && snapNow.stale),
    old: !!(v && isFin(v.lb) && now - v.lb > days * DAY), fail: /^(fail|warn)/i.test(r),
  };
}
export function vmViewMatches(vm, f, opts) {
  const c = viewClass(vm, opts);
  if (f === 'veeam') return c.veeam;
  if (f === 'snaponly') return !c.veeam && c.snap;
  if (f === 'none') return c.vKnown && c.sKnown && !c.veeam && !c.snap;
  if (f === 'run') return c.run;
  if (f === 'stale') return c.stale;
  if (f === 'rpo') return c.old;
  if (f === 'fail') return c.fail;
  return true;
}
