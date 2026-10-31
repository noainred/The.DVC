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
import { numOrNull } from '../util/numOrNull.js';
import { osKind } from '../inventory/osKind.js';
import { staleOf } from './backupPolicy.js';

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
  // v2.782(점검 K4 B-B3): 서버가 여러 대일 때 한 대라도 첫 수집 전(waiting)이거나 한 번도 성공하지 못했으면(failedNoLast) 그 서버가 맡은 VM 은
  //   대조 결과에 없다 — 대조에 없는 VM 의 '없음' 은 확정이 아니라 모름이다(나눔도 모름). 맞은 VM 의 수·결과는 사실(하한)이라 그대로 둔다.
  //   ⚠ 오래된(stale) 서버·실패했지만 마지막 성공이 있는 서버는 넣지 않는다 — 마지막 결과의 VM 목록이 있다.
  const absentUnknown = veeamKnown && ((Number(vcnt.failedNoLast) || 0) > 0 || (Number(vcnt.waiting) || 0) > 0);
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
  // 나눔 — 두 쪽을 다 알 때(연동 없는 vCenter 는 Veeam 이 '없음' 으로 확정이라 스냅샷만 알면 된다). v2.782 B-B3: 부재가 모름이면 나눔도 모름.
  let split = null;
  if (snapKnown && ((veeamKnown && !absentUnknown) || !linked)) {
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
    ...(absentUnknown ? { veeamAbsentUnknown: true } : {}),   // v2.782 B-B3: 대조에 없는 VM 은 '없음' 이 아니라 모름(세부내용 vmBackupView absentKnown:false)
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
    veeamKnownVcs: 0, snapKnownVcs: 0, vmVeeamKnown: 0, vmSnapKnown: 0, veeamPartial: 0, snapPartial: 0, runningUnknown: 0, vmUnknown: 0,
    // v2.784: 사람이 정한 표시(중요도·백업 필요) — needGap(백업 필요인데 Veeam 대상 아님)은 아는 vCenter 만 더하고 모르는 곳을 센다
    marks: { high: 0, mid: 0, low: 0, need: 0, needGap: 0, needGapUnknown: 0, method: { ...Object.fromEntries(Object.keys(METHOD_TEXT).map((k) => [k, 0])), unset: 0 } },   // v2.803 method = 백업 방식별 수 · v2.828 키는 METHOD_TEXT 에서(Bareos)
    // v2.785(GR R-B2): 표시 파일을 못 읽은 행(marks null) 수 — 하나라도 있으면 marks 합계 값은 null('—' · 부분 합을 합계로 내지 않는다)
    marksUnknown: 0 };
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
    const m = r.marks;
    if (m === null) t.marksUnknown++;
    else if (m) {
      for (const k of ['high', 'mid', 'low', 'need']) t.marks[k] += m[k] || 0;
      if (isFin(m.needGap)) t.marks.needGap += m.needGap; else if (m.need > 0) t.marks.needGapUnknown++;
      for (const k of Object.keys(t.marks.method)) t.marks.method[k] += m.method?.[k] || 0;
    }
  }
  if (t.marksUnknown > 0) { for (const k of ['high', 'mid', 'low', 'need', 'needGap']) t.marks[k] = null; t.marks.method = null; }
  return t;
}

/**
 * VM 한 대(세부내용) — Veeam 배지 근거(matchToVcenter 의 원소)와 스냅샷 근거만 싣는다.
 * @param {object} vm 인벤토리 VM @param {object|undefined} ve matchToVcenter byVm[vm.id] @param {Array|undefined} evEntry ev.byVm[vm.id]
 * v2.782(점검 K4 B-B3): absentKnown(기본 true) — 대조에 없는 VM 을 '없음'(v null)으로 확정해도 되는가. false 면(첫 수집 전·한 번도 성공 못 한 서버가 있음 —
 *   backupRow veeamAbsentUnknown) 대조에 없는 VM 만 v 모름(undefined — JSON 에서 키 없음)이고, 맞은 VM 은 값을 그대로 싣는다.
 */
/** v2.814 VM 디스크 사용 용량(GB) — 0 이상 유한수만, 소수 1자리. 그 밖(null·''·문자·음수)은 null(모름). */
export function gbOf(v) {
  const n = numOrNull(v);
  return n != null && n >= 0 ? Math.round(n * 10) / 10 : null;
}

export function vmBackupView(vm, ve, evEntry, { veeamKnown = true, snapKnown = true, absentKnown = true, now = Date.now(), mark, clone } = {}) {
  const v = ve ? {
    state: ve.run === 1 ? 'run' : ve.run === 2 ? 'wait' : 'ok', pg: ve.run === 1 && isFin(ve.pg) ? ve.pg : null, by: ve.by || '',
    jobs: Array.isArray(ve.jobs) ? ve.jobs.slice(0, 5) : [], rp: isFin(ve.rp) ? ve.rp : null,
    lb: isFin(ve.lb) ? ve.lb : null, lbSrc: ve.lbSrc || '', lastResult: ve.lastResult || '', ag: ve.ag === 1,
    ...(ve.lr ? { lr: String(ve.lr).slice(0, 32) } : {}),   // v2.780: 그 VM 의 마지막 task 결과(작업 결과보다 먼저 본다)
    ...(ve.lr && isFin(ve.lrt) ? { lrt: ve.lrt } : {}),   // v2.835: 그 결과가 끝난 시각(backupPolicy.recentErrorsOf — 24시간 창)
    ...(ve.lr && isFin(ve.lrs) ? { lrs: ve.lrs } : {}),   // v2.837 그 결과의 시작 시각(Summary '백업 기간')
    ...(isFin(ve.sz) && ve.sz >= 0 ? { sz: ve.sz } : {}),   // v2.837 복원 지점 크기 합(바이트 — 모르면 키 없음, 0 으로 두지 않는다)
    ...(isFin(ve.nr) ? { nr: ve.nr } : {}),   // v2.837 Veeam 잡 다음 실행(가장 이른 것)
  } : null;
  const ev = Array.isArray(evEntry) && isFin(evEntry[0]) ? { ts: evEntry[0], n: Number.isInteger(evEntry[1]) ? evEntry[1] : null } : null;
  return {
    id: vm.id, name: String(vm.name || ''), folder: String(vm.folder || ''), power: vm.powerState || '',
    v: veeamKnown ? (v ?? (absentKnown ? null : undefined)) : undefined,
    s: { ev: snapKnown ? ev : undefined, now: currentSnapOf(vm, now) },
    // v2.814: 디스크 사용 용량(GB, vCenter 인벤토리 storageGB — 엑셀·CSV '스토리지 사용(GB)' 과 같은 값). 못 읽으면 null(0 으로 두지 않는다)
    gb: gbOf(vm.storageGB),
    os: osKind(vm.guestOS),   // v2.835 게스트 OS(windows·linux·other·null — inventory/osKind.js) · Detail 의 Windows·Linux 거르기
    ...(mark ? { m: mark } : {}),   // v2.784: 사람이 정한 표시(backupMarks.markView — 있을 때만)
    // v2.803 Clone 칸 — 백업 방식을 Clone 으로 정한 VM 에만(사용자 요청 'Clone 이라고 표시된 항목이면 여기에'). cloneView 결과 그대로:
    //   { job:false }(포탈 복제 잡 없음) | { job:true, on, at, ok, skipped? } | null(잡 목록을 못 읽음 — 모름). 그 밖의 VM 은 키 없음.
    ...(mark?.method === 'clone' && clone !== undefined ? { c: clone } : {}),
  };
}

/** v2.803 백업 방식 글자(화면·CSV·엑셀 공용 — 웹 backupViewText.METHODS 와 같은 글자, 테스트 대조). v2.828 Bareos(사용자 요청 — Clone 다음). 키 순서 = 화면 순서. */
export const METHOD_TEXT = Object.freeze({ veeam: 'Veeam', clone: 'Clone', bareos: 'Bareos', ssh: 'SSH', config: 'Config 백업', none: '백업 안함', check: '확인 필요' });   // v2.835 SSH(정책 값 — 사용자 요청) · clone·config 는 예전 저장값 글자(읽기·내보내기)
const METHOD_KEYS = Object.freeze(Object.keys(METHOD_TEXT));
const methodOf = (v) => (METHOD_KEYS.includes(v) ? v : '');
/**
 * v2.806 · v2.828: 이 방식이면 Veeam 이 없어도 '미백업' 이 아니다 — 백업 안함(의도) · Clone(포탈 복제) · Bareos(Bareos 잡 — 잡이 없으면 Bareos 화면의 '미등록' 이 따로 센다).
 *   우선순위 VM(priorityCandidates) · 보기 필터 needgap · 표시 집계(backupMarks.markCounts needGap) · 웹 vmMatches 가 이 한 규칙을 쓴다.
 */
export const NOT_VEEAM_GAP = Object.freeze(['none', 'clone', 'bareos', 'ssh']);   // v2.835 SSH 도(Veeam 이 아니라 SSH 스크립트로 백업한다고 정한 VM)

/*
 * v2.780: 세부내용의 '보기' 필터(VM 한 대 — vmBackupView 모양) — 웹 views/tools/backupViewText.js vmMatches 와 같은 판정이다
 *   (CSV 가 화면과 같은 VM 을 내보내게 · 웹 테스트가 같은 입력으로 두 함수를 대조한다).
 *   v 키 없음 = Veeam 모름 · v null = 없음 / s.ev 키 없음 = 스냅샷 모름 · 잔존(하루 넘은 임시 스냅샷)은 스냅샷으로 치지 않는다.
 */
// v2.784: need(백업 필요 표시) · needgap(백업 필요인데 Veeam 대상이 아님 — Veeam 을 모르는 VM 은 넣지 않는다) · crit-*(중요도)
// v2.803: method-*(백업 방식 — unset = 정하지 않음)
export const VIEW_FILTERS = Object.freeze(['all', 'veeam', 'snaponly', 'none', 'run', 'stale', 'rpo', 'fail', 'need', 'needgap', 'bareos', 'bareos-missing', 'crit-high', 'crit-mid', 'crit-low',
  'method-veeam', 'method-clone', 'method-bareos', 'method-ssh', 'method-config', 'method-none', 'method-check', 'method-unset',   // v2.828 bareos(잡 있음)·bareos-missing(방식 Bareos 인데 잡 없음 — b 칸)
  // v2.835(백업 메뉴 개편 1차): 실제 백업(a) · 정책≠실제(mm) · 정책 범주(p — 미설정·clone·config 는 check) · RPO 미달(마지막 성공이 기준 일수를 넘음 — staleOf) · 게스트 OS
  'act-veeam', 'act-bareos', 'act-none', 'mismatch', 'policy-veeam', 'policy-bareos', 'policy-ssh', 'policy-none', 'policy-check', 'rpo-miss', 'os-windows', 'os-linux']);
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
    crit: ['high', 'mid', 'low'].includes(vm?.m?.crit) ? vm.m.crit : '', need: vm?.m?.need === true,
    method: methodOf(vm?.m?.method),   // v2.803 백업 방식(사람이 정한 값)
    // v2.828 Bareos 칸(b — bareos/vmView.bareosVmView): 잡 있음 · 미등록(방식 Bareos 인데 잡 없음). b null(원장 못 읽음)은 둘 다 아니다(모름)
    bareos: vm?.b?.job === true, bareosMissing: !!vm?.b && vm.b.job === false,
  };
}
/** v2.803 백업 방식 글자(화면·CSV·엑셀 공용 — 웹 backupViewText.METHODS 와 같은 글자, 테스트 대조). */

/**
 * v2.803 Clone 결과 한 마디(CSV·엑셀·내보내기 창 공용). c = vmBackupView 의 c(백업 방식이 Clone 인 VM 에만 있다).
 *   키 없음(Clone 이 아님) '' · null(잡 목록을 못 읽음)·unknown(실행 노드 보고 없음) '모름' · 잡 없음 · 아직 실행 안 함 · 성공 · 실패 · 건너뜀 + 잡이 꺼졌으면 '(잡 꺼짐)'.
 */
export function cloneResultText(c) {
  if (c === undefined) return '';
  if (c === null || c.unknown) return '모름';
  if (!c.job) return '잡 없음';
  const off = c.on === false ? ' (잡 꺼짐)' : '';
  if (!isFin(c.at)) return `아직 실행 안 함${off}`;
  return `${c.skipped ? '건너뜀·중단' : c.ok ? '성공' : '실패'}${off}`;
}

/**
 * v2.803 Clone 칸 자료 — 포탈 복제 잡 한 개 + 그 마지막 실행(vmclone/jobState.js cloneStateByVm 의 원소) → 화면·CSV 가 쓰는 작은 모양.
 *   잡 이름·대상 경로·이력 원문은 싣지 않는다. lastRun undefined = 실행 노드(엣지)의 보고가 없어 모름 · null = 아직 실행 안 함.
 * @param {{job:object, lastRun:object|null|undefined}|undefined} st 그 VM 의 상태(잡이 없으면 undefined)
 */
export function cloneView(st) {
  if (!st?.job) return { job: false };
  const on = st.job.enabled !== false;
  if (st.lastRun === undefined) return { job: true, on, unknown: true };
  const lr = st.lastRun && typeof st.lastRun === 'object' ? st.lastRun : null;
  return {
    job: true, on,
    at: lr && isFin(lr.at) ? lr.at : null, ok: lr ? lr.ok === true : null,
    ...(lr?.skipped ? { skipped: String(lr.skipped).slice(0, 40) } : {}),
  };
}
/*
 * v2.792(사용자 요청 "vCenter 화면 VM 폴더에서 VM list export 할 때 Veeam 백업여부, 백업여부 판단할 수 있는 snapshot 포함여부"):
 *   VM 한 대의 **백업 판단 한 칸**(순수). 새 판정이 아니다 — viewClass(세부내용 '보기' 필터와 같은 분류)를 사람이 읽는 말로 옮긴다.
 *   · veeam    = Veeam 백업 대상(작업에 들었거나 복원 지점 있음 — VM 화면 Veeam 배지와 같은 기준)
 *   · snap     = Veeam 대상은 아니라고 확인됐는데 vCenter 스냅샷·이벤트로 백업 흔적이 있다(세부내용 'snaponly')
 *   · snap-unlinked = Veeam 서버가 연결돼 있지 않아 스냅샷·이벤트로만 본 흔적
 *   · snap-vunknown = 스냅샷 흔적은 있는데 Veeam 쪽을 모른다(읽기 실패·첫 수집 전)
 *   · none     = Veeam·스냅샷 둘 다 확인했고 둘 다 흔적이 없다(세부내용 'none' — 백업이 없다는 단정이 아니라 '확인 안 됨')
 *   · unknown  = 어느 한쪽을 몰라 판단할 수 없다(0·없음으로 쓰지 않는다)
 *   하루 넘게 남은 Veeam 임시 스냅샷(잔존)은 viewClass 가 백업 흔적으로 치지 않는다 — 판단에 넣지 않고 따로 표시한다.
 */
export const VERDICT_TEXT = Object.freeze({
  veeam: 'Veeam 백업', snap: '스냅샷 흔적만(Veeam 대상 아님)', 'snap-unlinked': '스냅샷 흔적(Veeam 연동 없음)',
  'snap-vunknown': '스냅샷 흔적(Veeam 모름)', none: '확인 안 됨', unknown: '모름',
});
export function backupVerdict(vm, { linked = true } = {}) {
  const c = viewClass(vm);
  let code;
  if (c.veeam) code = 'veeam';
  else if (c.snap) code = !linked ? 'snap-unlinked' : c.vKnown ? 'snap' : 'snap-vunknown';
  else code = c.vKnown && c.sKnown ? 'none' : 'unknown';
  return { code, text: VERDICT_TEXT[code] };
}

/*
 * v2.801(사용자 요청 "선택 항목에 veeam 마지막 백업 여부 / 백업용 snapshot 최근 생성 여부도"): VM 한 대의 '여부' 두 칸(순수 — vmBackupView 모양).
 *   VM 목록(vmListCatalog)과 VM 전체 정보(vmExportCatalog) 두 카탈로그가 이 함수 하나를 쓴다(판정 코어 하나). 값은 '예' · '아니오' · '모름' —
 *   모르는 것을 '아니오' 로 쓰지 않는다(못 읽은 값은 0 이 아니다).
 *   · 백업: Veeam 연동이 없거나 Veeam 쪽을 모르면(v 키 없음 — 읽기 실패·첫 수집 전) 모름. 대조에 없음(v null — 확정)은 아니오.
 *     마지막 백업 완료(lb)가 N일 안이면 예, 그보다 오래면 아니오. lb 를 모르는데 복원 지점이 0 이면 아니오(한 번도 없음), 그 밖은 모름.
 *   · 백업용 스냅샷: 지금 있는 Veeam 임시 스냅샷이 N일 안에 생겼으면 예. 아니면 스냅샷 이벤트(s.ev — 최근 LOOKBACK 일)의 마지막 생성이 N일 안이면 예,
 *     이벤트를 못 읽었으면(s.ev 키 없음) 모름, 읽었는데 없거나 오래면 아니오. N 은 YN_DAYS 안(이벤트 창 7일을 넘지 않는다).
 */
export const YN_DAYS = Object.freeze([1, 2, 3, 7]);
export const YN_DEFAULT_DAYS = 1;   // 사용자 결정(2026-10-27): 매일 백업 기준 — '어제부터 지금까지'
export const ynDaysOf = (v) => (YN_DAYS.includes(Number(v)) ? Number(v) : YN_DEFAULT_DAYS);
export function recentBackupYn(vm, { linked = true, days = YN_DEFAULT_DAYS, now = Date.now() } = {}) {
  if (!vm || !linked || !('v' in vm) || vm.v === undefined) return '모름';
  const v = vm.v;
  if (!v) return '아니오';
  if (isFin(v.lb) && v.lb > 0) return now - v.lb <= ynDaysOf(days) * DAY ? '예' : '아니오';
  return v.rp === 0 ? '아니오' : '모름';
}
export function recentBackupSnapYn(vm, { days = YN_DEFAULT_DAYS, now = Date.now() } = {}) {
  if (!vm || !vm.s) return '모름';
  const win = ynDaysOf(days) * DAY;
  const cur = vm.s.now;
  if (cur && isFin(cur.ts) && now - cur.ts <= win) return '예';
  if (!('ev' in vm.s) || vm.s.ev === undefined) return '모름';
  const ev = vm.s.ev;
  return ev && isFin(ev.ts) && now - ev.ts <= win ? '예' : '아니오';
}

export function vmViewMatches(vm, f, opts) {
  const c = viewClass(vm, opts);
  if (f === 'veeam') return c.veeam;
  // v2.783(점검 Q3 L-B3): Veeam 을 아는 VM 만 — 'Veeam 모름'(v 키 없음 · 첫 수집 전 서버 · 읽기 실패)인 스냅샷 VM 은 '스냅샷만'(요약 sOnly 와 같은 뜻 —
  //   Veeam 에 없다고 확인됨)이 아니다. 'none' 과 같은 규칙 · 서버 veeam/backupStatus.js vmViewMatches 와 웹 backupViewText.js vmMatches 는 한 쌍(대조 테스트).
  if (f === 'snaponly') return c.vKnown && !c.veeam && c.snap;
  if (f === 'none') return c.vKnown && c.sKnown && !c.veeam && !c.snap;
  if (f === 'run') return c.run;
  if (f === 'stale') return c.stale;
  if (f === 'rpo') return c.old;
  if (f === 'fail') return c.fail;
  if (f === 'need') return c.need;
  if (f === 'needgap') return c.need && c.vKnown && !c.veeam && !NOT_VEEAM_GAP.includes(c.method);   // v2.806 백업 안함·Clone · v2.828 Bareos 는 미백업 아님
  if (f === 'bareos') return c.bareos;   // v2.828
  if (f === 'bareos-missing') return c.bareosMissing;
  if (f === 'crit-high' || f === 'crit-mid' || f === 'crit-low') return c.crit === f.slice(5);
  if (f.startsWith('method-')) return f === 'method-unset' ? !c.method : c.method === f.slice(7);
  // v2.835: 서버가 행에 실은 결과 필드(backupPolicy.policyFields)를 읽기만 한다 — 웹 vmMatches 와 한 쌍(대조 테스트)
  if (f === 'act-veeam') return vm?.a?.v === true;
  if (f === 'act-bareos') return vm?.a?.b === true;
  if (f === 'act-none') return vm?.a?.v === false && vm?.a?.b === false;
  if (f === 'mismatch') return vm?.mm === true;
  if (f.startsWith('policy-')) return vm?.p === f.slice(7);
  if (f === 'rpo-miss') { const k = staleOf(vm, { windowMs: (RPO_DAYS.includes(Number(opts?.rpoDays)) ? Number(opts.rpoDays) : 1) * DAY, now: opts?.now ?? Date.now(), onlyOn: false }); return !!k && k.kind !== 'unknown'; }
  if (f === 'os-windows' || f === 'os-linux') return vm?.os === f.slice(3);
  return true;
}

/*
 * v2.787(사용자 요청 + 시안 'Summary 아래 — 우선순위 VM, 먼저 볼 것'): 전 법인에서 먼저 볼 VM 후보(순수).
 *  · gap   = 사람이 중요도 상 또는 백업 필요로 표시했는데 Veeam 대상이 아님 — Veeam 을 모르면(읽기 실패·첫 수집 전 서버) 넣지 않는다(지어내지 않는다)
 *  · fail  = 그 VM 마지막 결과가 실패(resultOf — 서머리 results.failed 와 같은 판정)
 *  · stale = 하루 넘게 남은 Veeam 임시 스냅샷(currentSnapOf — 서머리 snapStale 과 같은 판정)
 *  · lb    = 마지막 백업 완료 — '오래된 백업' 은 화면이 고른 기준 일수로 거른다(그래서 하루 넘은 것만 후보로 싣는다)
 *  범위는 호출부가 정한다(scope 교집합 vCenter · 전원·제외를 거친 목록). 표시(m)가 없고 문제도 없는 VM 은 싣지 않는다.
 *  v2.806(사용자 요청 'Summary 우선순위 VM 에도 백업 방식 반영' — 엑셀 먼저 볼 VM(vmListXlsx.watchList)과 같은 규칙):
 *   · method  = 사람이 정한 백업 방식 · 백업 안함이면 gap 아님 · Clone 이면 Veeam 부재가 아니라 복제 잡 상태로 본다(cloneOf — cloneView)
 *   · cloneBad = 방식 Clone 인데 잡 없음 · 마지막 실패 · 건너뜀(모름은 넣지 않는다 — 지어내지 않는다) — Veeam '마지막 실패' 처럼 표시와 무관하게 후보
 *   · Config 백업은 포탈이 확인할 수 없어 gap 을 유지한다(화면 태그 글자로 구분)
 * @param {{cloneOf?:(vmId:string)=>object|null|undefined}} o cloneOf 가 없거나 null 을 돌려주면 Clone 상태 모름
 * @returns {Array<{id,name,folder,crit,need,method,gap,fail,cloneBad,stale,lb}>}
 */
export function cloneBadOf(c) {
  if (!c || c.unknown) return false;
  if (!c.job) return true;
  return isFin(c.at) && (c.ok === false || !!c.skipped);
}
export function priorityCandidates(vms, { byVm = null, marks = {}, veeamKnown = false, absentKnown = true, now = Date.now(), cloneOf = null } = {}) {
  const out = [];
  const gapKnown = !!veeamKnown && absentKnown !== false;
  for (const vm of Array.isArray(vms) ? vms : []) {
    const m = marks?.[vm.id] || null;
    const ve = byVm ? byVm[vm.id] : undefined;
    const crit = m && ['high', 'mid', 'low'].includes(m.crit) ? m.crit : '';
    const need = m?.need === true;
    const method = m ? methodOf(m.method) : '';
    const c = method === 'clone' && typeof cloneOf === 'function' ? cloneOf(vm.id) : undefined;
    const cloneBad = method === 'clone' && cloneBadOf(c);
    const gap = gapKnown && (need || crit === 'high') && !ve && !NOT_VEEAM_GAP.includes(method);
    const fail = !!ve && /^fail/i.test(resultOf(ve));
    const cs = currentSnapOf(vm, now);
    const stale = !!(cs && cs.stale);
    const lb = ve && isFin(ve.lb) ? ve.lb : null;
    const old = lb != null && now - lb > DAY;
    if (!gap && !fail && !cloneBad && !stale && !old) continue;
    out.push({ id: vm.id, name: String(vm.name || ''), folder: String(vm.folder || ''), crit, need, method, gap, fail, cloneBad, stale, lb });
  }
  return out;
}

/** 우선순위 — 중요도 상 → 백업 필요 → 나머지, 같은 단계에서는 미백업 → 실패 → 잔존 → 오래된(마지막 백업이 이른 순). 서버 상한 자르기용(웹은 기준 일수로 다시 매긴다). */
export function priorityRank(a, b) {
  const tier = (x) => (x.crit === 'high' ? 0 : x.need ? 1 : 2);
  const prob = (x) => (x.gap ? 0 : (x.fail || x.cloneBad) ? 1 : x.stale ? 2 : 3);   // v2.806 Clone 실패·잡 없음은 실패와 같은 단계
  return (tier(a) - tier(b)) || (prob(a) - prob(b)) || ((a.lb ?? Infinity) - (b.lb ?? Infinity)) || String(a.name).localeCompare(String(b.name));
}
export const PRIORITY_MAX = 500;
