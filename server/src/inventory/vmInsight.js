/**
 * inventory/vmInsight.js — VM 탭 '분석' 보기(v3.21.0 · 설계 docs/design/vm-insight · 사용자 확정 2026-11-18 기본값)의 집계. 순수(store · DB import 없음 —
 * 라우트가 범위 · 리전으로 거른 vcenters · vms 와 판정 문맥을 넘긴다). 라우트는 `routes/api/inventory.js GET /vms/insight`.
 *
 * 왜 법인별 줄인가: 바로가기에서 법인을 여럿 고르면(v3.20.0) 분석 화면의 모든 수 · 목록이 그 법인들의 합이어야 한다. 서버가 **법인(vCenter)마다 한 줄**을
 *   주고 화면이 고른 줄을 더하면 선택을 바꿀 때 서버 왕복이 없다. 그래서 줄의 값은 전부 **더할 수 있는 모양**이다 —
 *   평균은 값이 아니라 { sum, n }(+ 참고용 value), 분포는 칸별 수, 상위 목록은 법인마다 상위 N(합집합의 상위 N 은 법인별 상위 N 의 합집합 안에 있다).
 *
 * 판정을 새로 만들지 않는다(판정 코어는 하나):
 *  · 조치 필요 · 신호 분해 = `vmSignals.vmSignalsOf`(signalCounts 와 같은 판정 — 과부하 · 사용률 못 읽음 · Tools 오래됨 · 오래된 스냅샷).
 *  · 사용률 칸 = `vmDist.usageBinOf`(5% 칸) 를 10% 칸으로 접은 것 — 90%↑ 칸(over90)은 과부하 신호의 칸(`OVERLOAD_BIN`)과 같다.
 *  · 평균 = `vmTotals.usageAvg` 와 같은 규칙(구동 VM 중 numOrNull 로 읽은 값만 — 못 읽은 수는 usageUnknown).
 *  · 스냅샷 지난 일수 = 'VM 구성 점검' 의 `hygieneFindings` snap-age 사실(facts.days) — 기준 일수 · 예외는 그 도구 설정.
 *  · OS 계열 = `osKind`(Bareos 와 같은 판정 — 모름은 null), OS 종류 키 = `vmDist.osKeyOf`(목록의 OS 패널과 같은 키).
 *  · Tools 를 읽었는가 = `vmToolsDist.toolsRead` · 업그레이드 필요 = `reports/compliance.js TOOLS_NEED_UPGRADE`(toolsOld 신호와 같은 집합).
 *  · 개수를 모르는 법인(첫 수집 중 · 비활성 · 연결 실패 · 인증 정지이며 VM 0) = `hostCorp.corpUnknownOf` — 수는 전부 null('0대' 라는 거짓 금지).
 *  · 법인 신원 · 낡은 값(stale) = `hostCorp.corpIdentityOf`(/vms/by-vcenter 와 같은 칸).
 *
 * 못 읽은 값은 0 이 아니다: 사용률 · vCPU · 메모리 · 디스크 · 스냅샷 크기 · Tools · 하드웨어 버전 · 연결 상태를 못 읽은 VM 은 합 · 평균 · 칸에 넣지 않고 따로 센다.
 * 성능: VM 한 번 훑기(O(N)) · 상위 목록은 법인마다 N 칸 삽입(O(N · topN)) · 큰 반복 사이 시간 기준 양보(`yielder` — createYielder).
 */
import { numOrNull } from '../util/numOrNull.js';
import { corpIdentityOf, corpUnknownOf } from '../vcenter/hostCorp.js';
import { TOOLS_NEED_UPGRADE } from '../reports/compliance.js';
import { hygieneFindings } from '../vmhygiene/analyze.js';
import { vmSignalsOf, OVERLOAD_BIN, OVERLOAD_PCT, SIGNAL_KEYS } from './vmSignals.js';
import { usageBinOf, osKeyOf, powerKindOf, OS_UNKNOWN_KEY, VM_DIST_BIN_PCT } from './vmDist.js';
import { toolsRead } from './vmToolsDist.js';
import { osKind } from './osKind.js';

export const INSIGHT_TOP_N = 5;
/** 사용률 칸 — 10% × 10칸(5% 칸 두 개를 하나로). */
export const INSIGHT_HIST_BIN_PCT = 10;
export const INSIGHT_HIST_BINS = 10;
const FOLD = INSIGHT_HIST_BIN_PCT / VM_DIST_BIN_PCT;
/** 할당 크기 칸의 위 끝(이하) — 키 '1' 은 1 이하, '4' 는 2 초과 4 이하 … 'more' 는 마지막 끝 초과. */
export const VCPU_SIZES = Object.freeze([1, 2, 4, 8, 16]);
export const MEM_SIZES_GB = Object.freeze([2, 4, 8, 16, 32, 64]);
/** 스냅샷 지난 일수 구간의 경계(일) — 첫 구간은 [기준 일수, 30), 다음 [30, 90), 마지막 90 이상. */
export const SNAP_AGE_EDGES_DAYS = Object.freeze([30, 90]);
/** 화면이 접어 보이는 OS 종류 수(넘치면 '그 밖'). 줄에는 OS_KINDS_MAX 까지 싣는다 — 법인별 상위 8 만 주면 여러 법인을 더한 상위 8 이 틀린다. */
export const OS_KINDS_SHOWN = 8;
export const OS_KINDS_MAX = 50;
export const HW_VERSIONS_MAX = 40;
const NAME_MAX = 200;
const SNAP_NAME_MAX = 80;
const TOOLS_OLD = new Set(TOOLS_NEED_UPGRADE);
const TOOLS_VER_KEY = Object.freeze({ guestToolsCurrent: 'current', guestToolsNotInstalled: 'notInstalled', guestToolsUnmanaged: 'unmanaged' });

/** 화면에 박지 않을 기준값 — 응답 thresholds. */
export function insightThresholds(ctx) {
  const h = ctx?.hygiene || null;
  return {
    snapAgeDays: numOrNull(h?.snapAgeDays),          // 오래된 스냅샷 기준(VM 구성 점검 설정) — 설정이 없으면 null(판정하지 않았다)
    hygieneUnreadable: h?.unreadable === true,        // 설정 파일을 못 읽어 기본값으로 판정 중
    snapAgeEdgesDays: [...SNAP_AGE_EDGES_DAYS],
    overloadPct: OVERLOAD_PCT,                         // 과부하 · over90 칸 하한
    histBinPct: INSIGHT_HIST_BIN_PCT, histBins: INSIGHT_HIST_BINS,
    vcpuSizes: [...VCPU_SIZES], memSizesGB: [...MEM_SIZES_GB],
    topN: INSIGHT_TOP_N, osKindsShown: OS_KINDS_SHOWN, osKindsMax: OS_KINDS_MAX,
    signalKeys: [...SIGNAL_KEYS],
  };
}

const sizeKey = (n, edges) => {
  for (const e of edges) if (n <= e) return String(e);
  return 'more';
};
const zeroSizes = (edges) => Object.fromEntries([...edges.map(String), 'more', 'unknown'].map((k) => [k, 0]));

function newAcc() {
  return {
    total: 0, on: 0, off: 0, templates: 0,
    attention: 0, signals: { overload: 0, usageUnknown: 0, toolsOld: 0, snapOld: 0, any: 0 },
    vcpu: 0, vcpuUnknown: 0, memMB: 0, memUnknown: 0, diskGB: 0, diskUnknown: 0,
    connection: { connected: 0, orphaned: 0, inaccessible: 0, other: 0, unknown: 0 },
    osFamily: { linux: 0, windows: 0, other: 0, unknown: 0 }, osKinds: new Map(),
    tools: { status: { running: 0, notRunning: 0, other: 0, unread: 0 }, version: { current: 0, needUpgrade: 0, notInstalled: 0, unmanaged: 0, other: 0, unread: 0 } },
    hw: new Map(), hwUnread: 0,
    cpuHist: new Array(INSIGHT_HIST_BINS).fill(0), memHist: new Array(INSIGHT_HIST_BINS).fill(0),
    usageUnknown: { cpu: 0, mem: 0 }, histOut: { cpu: 0, mem: 0 },
    cpuSum: 0, cpuN: 0, memSum: 0, memN: 0,
    over90: { cpu: 0, mem: 0 },
    vcpuSize: zeroSizes(VCPU_SIZES), memSize: zeroSizes(MEM_SIZES_GB),
    reclaim: { offCount: 0, offDiskGB: 0, offDiskUnknown: 0, snapVms: 0, snapCount: 0, snapGB: 0, snapGBUnknown: 0,
      snapOld: 0, snapOldGB: 0, snapOldGBUnknown: 0, snapOldSnaps: 0, snapAge: { d7_30: 0, d30_90: 0, d90p: 0 }, orphan: 0 },
    gpuVms: 0,
    top: { cpuTop: [], snapOldest: [], snapBiggest: [] },
  };
}

/** 정렬된 길이 n 배열에 넣는다(cmp 가 음수면 a 가 앞) — 법인마다 N 칸이라 삽입이 정렬보다 싸다. v3.22.0 Hypervisor 분석(vcenter/hostInsight.js)도 이것을 쓴다(한 벌). */
export function pushTop(arr, item, cmp, n) {
  if (arr.length >= n && cmp(item, arr[arr.length - 1]) >= 0) return;
  let i = arr.length;
  while (i > 0 && cmp(item, arr[i - 1]) < 0) i -= 1;
  arr.splice(i, 0, item);
  if (arr.length > n) arr.pop();
}
const byName = (a, b) => String(a.name).localeCompare(String(b.name)) || String(a.id).localeCompare(String(b.id));
const CMP_CPU = (a, b) => (b.cpu - a.cpu) || ((b.mem ?? -1) - (a.mem ?? -1)) || byName(a, b);
const CMP_OLD = (a, b) => (b.days - a.days) || ((b.snapGB ?? -1) - (a.snapGB ?? -1)) || byName(a, b);
const CMP_BIG = (a, b) => (b.snapGB - a.snapGB) || (b.days - a.days) || byName(a, b);

const textOrNull = (s, max) => (typeof s === 'string' && s.trim() ? s.trim().slice(0, max) : null);

/** 스냅샷 트리에서 생성 시각이 가장 이른 노드의 이름 — 트리가 없거나 시각을 못 읽으면 null(이름을 짐작하지 않는다). */
export function oldestSnapshotName(v) {
  const tree = Array.isArray(v?.snapshotTree) ? v.snapshotTree : null;
  if (!tree) return null;
  let best = null;
  for (const n of tree) {
    const ts = numOrNull(n?.ts);
    if (ts == null) continue;
    if (!best || ts < best.ts) best = { ts, name: n.name };
  }
  return best ? textOrNull(best.name, SNAP_NAME_MAX) : null;
}

function addVm(a, v, ctx, topN) {
  const template = v.template === true;
  const on = v.powerState === 'POWERED_ON';
  a.total += 1;
  if (on) a.on += 1; else a.off += 1;
  if (template) a.templates += 1;

  // 신호 — signalCounts 와 같은 판정(vmSignalsOf 한 번)
  const sig = vmSignalsOf(v, ctx);
  if (sig.length) { a.attention += 1; a.signals.any += 1; for (const k of sig) a.signals[k] += 1; }

  // 할당 — 못 읽은 값은 합에서 빼고 센다(크기 칸도 unknown)
  const vcpu = numOrNull(v.cpuCount);
  if (vcpu == null) { a.vcpuUnknown += 1; a.vcpuSize.unknown += 1; } else { a.vcpu += vcpu; a.vcpuSize[sizeKey(vcpu, VCPU_SIZES)] += 1; }
  const memMB = numOrNull(v.memMB);
  if (memMB == null) { a.memUnknown += 1; a.memSize.unknown += 1; } else { a.memMB += memMB; a.memSize[sizeKey(memMB / 1024, MEM_SIZES_GB)] += 1; }
  const disk = numOrNull(v.storageGB);
  if (disk == null) a.diskUnknown += 1; else a.diskGB += disk;

  // 연결 상태(SOAP runtime.connectionState — 값이 없으면 모름)
  const conn = typeof v.connectionState === 'string' ? v.connectionState.toLowerCase() : '';
  if (!conn) a.connection.unknown += 1;
  else if (conn === 'connected' || conn === 'orphaned' || conn === 'inaccessible') a.connection[conn] += 1;
  else a.connection.other += 1;
  if (conn === 'orphaned' || conn === 'inaccessible') a.reclaim.orphan += 1;

  // OS
  const fam = osKind(v.guestOS);
  a.osFamily[fam || 'unknown'] += 1;
  const ok = osKeyOf(v);
  a.osKinds.set(ok, (a.osKinds.get(ok) || 0) + 1);

  // Tools — 템플릿은 Tools 가 돌지 않으므로 세지 않는다(toolsOld 신호와 같은 범위). 못 읽음은 unread.
  if (!template) {
    if (!toolsRead(v)) { a.tools.status.unread += 1; a.tools.version.unread += 1; }
    else {
      const st = v.toolsStatus;
      if (st === 'RUNNING') a.tools.status.running += 1; else if (st === 'NOT_RUNNING') a.tools.status.notRunning += 1;
      else if (st == null || st === '') a.tools.status.unread += 1; else a.tools.status.other += 1;
      const vs = v.toolsVersionStatus;
      if (vs == null || vs === '') a.tools.version.unread += 1;
      else if (TOOLS_OLD.has(vs)) a.tools.version.needUpgrade += 1;
      else a.tools.version[TOOLS_VER_KEY[vs] || 'other'] += 1;
    }
  }

  // 하드웨어 버전
  const hw = textOrNull(v.hwVersion, 40);
  if (hw == null) a.hwUnread += 1; else a.hw.set(hw, (a.hw.get(hw) || 0) + 1);

  // 사용률 — 구동 VM 만(꺼진 VM 의 값은 낡은 값). 못 읽음은 칸 · 평균에서 빼고 usageUnknown.
  if (on) {
    const c = numOrNull(v.cpuUsagePct);
    const m = numOrNull(v.memUsagePct);
    if (c == null) a.usageUnknown.cpu += 1;
    else {
      a.cpuSum += c; a.cpuN += 1;
      const b = usageBinOf(c);
      if (b == null) a.histOut.cpu += 1; else { a.cpuHist[Math.floor(b / FOLD)] += 1; if (b >= OVERLOAD_BIN) a.over90.cpu += 1; }
    }
    if (m == null) a.usageUnknown.mem += 1;
    else {
      a.memSum += m; a.memN += 1;
      const b = usageBinOf(m);
      if (b == null) a.histOut.mem += 1; else { a.memHist[Math.floor(b / FOLD)] += 1; if (b >= OVERLOAD_BIN) a.over90.mem += 1; }
    }
    if (c != null && c >= 0 && !template) {
      pushTop(a.top.cpuTop, {
        id: v.id, name: v.name, vcenterId: v.vcenterId,
        guestOS: textOrNull(v.guestOS, NAME_MAX), os: fam,
        vcpu, memMB, cpu: c, mem: m,
      }, CMP_CPU, topN);
    }
  }

  // 회수 · 정리 후보
  const r = a.reclaim;
  if (!on && !template) {
    r.offCount += 1;
    if (disk == null) r.offDiskUnknown += 1; else r.offDiskGB += disk;
  }
  const snapN = numOrNull(v.snapshotCount);
  const snapGB = numOrNull(v.snapshotSizeGB);
  if (snapN != null && snapN > 0) {
    r.snapVms += 1; r.snapCount += snapN;
    if (snapGB == null) r.snapGBUnknown += 1; else r.snapGB += snapGB;
  }
  if (sig.includes('snapOld')) {
    // 지난 일수는 판정한 쪽(hygieneFindings snap-age)의 사실을 그대로 — 신호가 있는 VM 만 다시 부른다
    const f = hygieneFindings(v, ctx.hygiene, ctx.now).findings.find((x) => x.code === 'snap-age');
    const days = numOrNull(f?.facts?.days);
    r.snapOld += 1;
    r.snapOldSnaps += snapN || 0;
    if (snapGB == null) r.snapOldGBUnknown += 1; else r.snapOldGB += snapGB;
    if (days != null) {
      if (days < SNAP_AGE_EDGES_DAYS[0]) r.snapAge.d7_30 += 1;
      else if (days < SNAP_AGE_EDGES_DAYS[1]) r.snapAge.d30_90 += 1;
      else r.snapAge.d90p += 1;
      const item = {
        id: v.id, name: v.name, vcenterId: v.vcenterId, power: powerKindOf(v),
        days, snapCount: snapN, oldestName: oldestSnapshotName(v), snapGB,
      };
      pushTop(a.top.snapOldest, item, CMP_OLD, topN);
      if (snapGB != null) pushTop(a.top.snapBiggest, item, CMP_BIG, topN);
    }
  }

  if (v.gpu) a.gpuVms += 1;
}

const round1 = (x) => Math.round(x * 10) / 10;

function finishRow(a) {
  const kinds = [...a.osKinds.entries()].sort((x, y) => (y[1] - x[1]) || String(x[0]).localeCompare(String(y[0])));
  const shown = kinds.slice(0, OS_KINDS_MAX);
  const hw = [...a.hw.entries()].sort((x, y) => (y[1] - x[1]) || String(x[0]).localeCompare(String(y[0])));
  const hwShown = hw.slice(0, HW_VERSIONS_MAX);
  return {
    total: a.total, on: a.on, off: a.off, templates: a.templates,
    attention: a.attention, signals: a.signals,
    vcpu: a.vcpu, vcpuUnknown: a.vcpuUnknown, memMB: a.memMB, memUnknown: a.memUnknown,
    diskGB: round1(a.diskGB), diskUnknown: a.diskUnknown,
    connection: a.connection,
    os: {
      family: a.osFamily,
      kinds: shown.map(([k, n]) => (k === OS_UNKNOWN_KEY ? { name: null, family: null, count: n } : { name: k, family: osKind(k), count: n })),
      kindsRest: kinds.slice(OS_KINDS_MAX).reduce((s, [, n]) => s + n, 0),   // OS_KINDS_MAX 를 넘는 종류의 VM 수(접은 것 — 숨기지 않는다)
    },
    tools: a.tools,
    hw: { versions: Object.fromEntries(hwShown), rest: hw.slice(HW_VERSIONS_MAX).reduce((s, [, n]) => s + n, 0), unread: a.hwUnread },
    cpuHist: a.cpuHist, memHist: a.memHist,
    usageUnknown: a.usageUnknown, histOut: a.histOut,
    cpuAvg: { value: a.cpuN ? round1(a.cpuSum / a.cpuN) : null, sum: a.cpuSum, n: a.cpuN },
    memAvg: { value: a.memN ? round1(a.memSum / a.memN) : null, sum: a.memSum, n: a.memN },
    over90: a.over90,
    vcpuSize: a.vcpuSize, memSize: a.memSize,
    reclaim: { ...a.reclaim, offDiskGB: round1(a.reclaim.offDiskGB), snapGB: round1(a.reclaim.snapGB), snapOldGB: round1(a.reclaim.snapOldGB) },
    gpuVms: a.gpuVms,
  };
}

const STAT_KEYS = Object.freeze(Object.keys(finishRow(newAcc())));
const NULL_STATS = Object.freeze(Object.fromEntries(STAT_KEYS.map((k) => [k, null])));

/**
 * @param {object} p
 * @param {object[]} p.vcenters  범위(· 리전)를 먼저 적용한 vCenter(법인) 목록 — 범위 밖은 이름도 싣지 않는다
 * @param {object[]} p.vms       범위(· 리전)를 먼저 적용한 VM
 * @param {object} p.ctx         vmSignals.signalContext(VM 구성 점검 설정 · 기준 시각)
 * @param {boolean} [p.unlisted=true] 목록에 없는 vCenter 의 VM(이월 · 경합)을 그 id 의 줄(unlisted:true)로 싣는다 — /vms totals 와 합이 맞게
 * @param {() => Promise<boolean>} [p.yielder] createYielder — VM 사이에서 시간 기준 양보
 * @param {number} [p.topN]
 * @returns {Promise<{ rows: object[], top: object[], thresholds: object }>}
 */
export async function vmInsightOf({ vcenters = [], vms = [], ctx, unlisted = true, yielder = null, topN = INSIGHT_TOP_N } = {}) {
  const acc = new Map();
  for (const v of vms) {
    if (yielder) await yielder();
    if (!v || typeof v !== 'object') continue;
    let a = acc.get(v.vcenterId);
    if (!a) { a = newAcc(); acc.set(v.vcenterId, a); }
    addVm(a, v, ctx, topN);
  }
  const rows = [];
  const top = [];
  const listed = new Set();
  const emit = (identity, a, extra = {}) => {
    const n = a ? a.total : 0;
    const unknown = !extra.unlisted && corpUnknownOf(identity.vc, n);
    rows.push({ ...identity.row, ...extra, unknown, ...(unknown ? NULL_STATS : finishRow(a || newAcc())) });
    top.push({ id: identity.row.id, cpuTop: unknown || !a ? [] : a.top.cpuTop, snapOldest: unknown || !a ? [] : a.top.snapOldest, snapBiggest: unknown || !a ? [] : a.top.snapBiggest });
  };
  for (const vc of vcenters) {
    if (!vc || typeof vc !== 'object' || listed.has(vc.id)) continue;
    listed.add(vc.id);
    emit({ vc, row: corpIdentityOf(vc) }, acc.get(vc.id));
  }
  if (unlisted) {
    for (const [id, a] of acc) {
      if (listed.has(id)) continue;
      emit({ vc: { id }, row: corpIdentityOf({ id }) }, a, { unlisted: true });
    }
  }
  rows.sort((x, y) => String(x.name).localeCompare(String(y.name)) || String(x.id).localeCompare(String(y.id)));
  // top 은 rows 와 같은 순서(같은 id)
  const rank = new Map(rows.map((r, i) => [r.id, i]));
  top.sort((x, y) => rank.get(x.id) - rank.get(y.id));
  return { rows, top, thresholds: insightThresholds(ctx) };
}
