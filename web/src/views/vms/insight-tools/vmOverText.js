/**
 * insight-tools/vmOverText.js — VM 탭 보기 ‘과할당’(v3.21.0 · docs/design/vm-insight §4-2 · host-insight §9 S2) 값 만들기(순수).
 *   특수 기능 ‘Optimization’(waste) 요약 모드(waste 경로 + summary=1)의 법인별 줄을 고른 법인만큼 더한다.
 *   판정(CPU · 메모리 줄일 후보 = 응답 thresholds.cpuIdlePct · memIdlePct 이하)과 정렬(미사용 큰 순 · 디스크 큰 순 · 스냅샷 큰 순 ·
 *   Tools 는 도구가 준 순서)은 도구 그대로다 — 다시 판정하지 않는다.
 *   할당 · 사용은 MHz · MB 원값으로 더한 뒤에 GHz · GB 로 바꾼다(반올림한 값을 더하면 합이 어긋난다 — 서버 주석).
 *   회수 가능 스토리지(추정)는 웹 wasteViewText.reclaimStorage 한 벌로 낸다(Optimization 화면과 같은 식).
 */
import { numOrNull } from '../../../numOrNull.js';
import { reclaimStorage } from '../../tools/wasteViewText.js';
import { pickRows, total, mergeTop, descNull, ascNull, byName, barPct, fmtU, TOP_N_DEFAULT } from './toolSumText.js';

/** 갈래 5개 — 키는 Optimization 화면의 하위 탭 키(#/tools/waste/<키>)와 같다. */
export const OVER_KINDS = Object.freeze([
  { key: 'mem', label: '메모리 과할당' },
  { key: 'cpu', label: 'CPU 과할당' },
  { key: 'off', label: '전원 꺼짐' },
  { key: 'snap', label: '스냅샷' },
  { key: 'tools', label: 'Tools 미실행' },
]);
export const OVER_KIND_KEYS = Object.freeze(OVER_KINDS.map((k) => k.key));

/** 모르는 갈래 키는 첫 갈래(메모리)로. */
export function normKind(k) {
  return OVER_KIND_KEYS.includes(k) ? k : OVER_KIND_KEYS[0];
}

/** waste 요약 응답 + 고른 법인 → 과할당 보기의 합. 응답이 없으면 null. */
export function overTotals(resp, vcIds) {
  if (!resp || !Array.isArray(resp.rows)) return null;
  const { rows, missing } = pickRows(resp.rows, vcIds);
  const T = (get) => total(rows, get);
  const off = { storageGB: T((r) => r.poweredOffGB), storageUnknown: T((r) => r.poweredOffStorageUnknown) || 0 };
  const thin = { reclaimableGB: T((r) => r.thinReclaimGB), count: T((r) => r.thinVms), uncommittedUnknown: T((r) => r.thinUncommittedUnknown) || 0 };
  const th = resp.thresholds && typeof resp.thresholds === 'object' ? resp.thresholds : {};
  return {
    rows, missing,
    empty: rows.length === 0,
    cpuIdlePct: numOrNull(th.cpuIdlePct), memIdlePct: numOrNull(th.memIdlePct),
    vms: T((r) => r.vms), poweredOnVms: T((r) => r.poweredOnVms),
    cpu: { allocMhz: T((r) => r.cpu?.allocMhz), usedMhz: T((r) => r.cpu?.usedMhz), idleMhz: T((r) => r.cpu?.idleMhz), candidates: T((r) => r.cpu?.candidates) },
    mem: { allocMB: T((r) => r.mem?.allocMB), usedMB: T((r) => r.mem?.usedMB), idleMB: T((r) => r.mem?.idleMB), candidates: T((r) => r.mem?.candidates) },
    usageUnknown: { cpu: T((r) => r.usageUnknown?.cpu) || 0, mem: T((r) => r.usageUnknown?.mem) || 0 },
    excludedNoHostMhz: T((r) => r.excludedNoHostMhz) || 0,
    poweredOff: T((r) => r.poweredOff), poweredOffGB: off.storageGB, poweredOffStorageUnknown: off.storageUnknown,
    snapshots: T((r) => r.snapshots), snapshotGB: T((r) => r.snapshotGB),
    noTools: T((r) => r.noTools),
    thinVms: thin.count, thinReclaimGB: thin.reclaimableGB, thinUncommittedUnknown: thin.uncommittedUnknown,
    reclaim: reclaimStorage({ poweredOff: off, thinReclaim: thin }),
  };
}

/**
 * 호스트 코어 clock(mhzPerCore)을 몰라 CPU 할당 · 사용 합에서 뺀 구동 VM 수의 안내(서버 overAllocatedReport excludedNoHostMhz).
 *   이 VM 들은 사용률을 읽었어도 합에서 빠져 usageUnknown 에 잡히지 않는다 — 따로 밝히지 않으면 부분 합이 전체 합처럼 보인다.
 *   도구 화면(CapacityTools) · 내보내기(wasteExport)와 같은 사실 · 같은 수. 0 · 결측이면 빈 글자.
 */
export function cpuNoClockText(n) {
  const v = numOrNull(n);
  return v != null && v > 0 ? `호스트 코어 clock 을 몰라 ${fmtU(v, '대')}는 CPU 합에서 뺐습니다(합은 하한).` : '';
}

/** 갈래 줄의 수 — 메모리 · CPU 는 줄일 후보 수, 나머지는 해당 VM 수. */
export function kindCounts(t) {
  if (!t) return {};
  return { mem: t.mem.candidates, cpu: t.cpu.candidates, off: t.poweredOff, snap: t.snapshots, tools: t.noTools };
}

/**
 * 법인별 막대 — 과할당(mem · cpu): 길이 = 할당(가장 큰 법인 대비) · 조각 = 사용 / 미사용 · 미사용 큰 순.
 * 그 밖: 재는 값 하나(꺼짐 = 점유 디스크 · 스냅샷 = 크기 · Tools = 대수) · 큰 순.
 * @returns {{vcenterId, name, w, used, idle, value, n, rest}[]}  used/idle 은 조각 몫(flex) · value 는 큰 글자에 쓸 원값
 */
export function corpBars(t, kind) {
  if (!t) return [];
  const k = normKind(kind);
  const rows = t.rows;
  if (k === 'mem' || k === 'cpu') {
    const pick = (r) => (k === 'mem'
      ? { alloc: numOrNull(r.mem?.allocMB), used: numOrNull(r.mem?.usedMB), idle: numOrNull(r.mem?.idleMB), cand: numOrNull(r.mem?.candidates) }
      : { alloc: numOrNull(r.cpu?.allocMhz), used: numOrNull(r.cpu?.usedMhz), idle: numOrNull(r.cpu?.idleMhz), cand: numOrNull(r.cpu?.candidates) });
    const xs = rows.map((r) => ({ r, ...pick(r) })).filter((x) => (x.alloc || 0) > 0);
    const max = xs.reduce((a, x) => Math.max(a, x.alloc), 0);
    return xs.sort((a, b) => descNull(a.idle, b.idle) || String(a.r.vcenterId).localeCompare(String(b.r.vcenterId)))
      .map((x) => ({ vcenterId: x.r.vcenterId, name: x.r.name, w: barPct(x.alloc, max), used: Math.max(0, x.used || 0), idle: Math.max(0, x.idle || 0),
        alloc: x.alloc, value: x.idle, n: x.cand, poweredOn: numOrNull(x.r.poweredOnVms),
        noClock: k === 'cpu' ? (numOrNull(x.r.excludedNoHostMhz) || 0) : 0 }));
  }
  const get = { off: (r) => ({ v: numOrNull(r.poweredOffGB), n: numOrNull(r.poweredOff) }),
    snap: (r) => ({ v: numOrNull(r.snapshotGB), n: numOrNull(r.snapshots) }),
    tools: (r) => ({ v: numOrNull(r.noTools), n: numOrNull(r.noTools) }) }[k];
  const xs = rows.map((r) => ({ r, ...get(r) })).filter((x) => (x.v || 0) > 0);
  const max = xs.reduce((a, x) => Math.max(a, x.v), 0);
  return xs.sort((a, b) => descNull(a.v, b.v) || String(a.r.vcenterId).localeCompare(String(b.r.vcenterId)))
    .map((x) => ({ vcenterId: x.r.vcenterId, name: x.r.name, w: barPct(x.v, max), used: 0, idle: 1, value: x.v, n: x.n, poweredOn: numOrNull(x.r.poweredOnVms) }));
}

/**
 * VM 5대 — 법인별 상위 5 를 합쳐 도구의 순서로 다시 5대.
 *   mem: 미사용 메모리 큰 순 → 메모리 사용률 낮은 순 · cpu: 미사용 MHz 큰 순 → CPU 사용률 낮은 순 ·
 *   off: 디스크 큰 순 · snap: 스냅샷 크기 큰 순 · tools: 도구가 준 순서(순위가 아니다 — 비교하지 않는다).
 */
export function topVms(t, kind, n = TOP_N_DEFAULT) {
  if (!t) return [];
  const k = normKind(kind);
  const rows = t.rows;
  if (k === 'mem') return mergeTop(rows, (r) => r.top?.mem, (a, b) => descNull(a.memIdleGB, b.memIdleGB) || ascNull(a.memUsagePct, b.memUsagePct) || byName(a, b), n);
  if (k === 'cpu') return mergeTop(rows, (r) => r.top?.cpu, (a, b) => descNull(a.cpuIdleMhz, b.cpuIdleMhz) || ascNull(a.cpuUsagePct, b.cpuUsagePct) || byName(a, b), n);
  if (k === 'off') return mergeTop(rows, (r) => r.top?.poweredOff, (a, b) => descNull(a.storageGB, b.storageGB) || byName(a, b), n);
  if (k === 'snap') return mergeTop(rows, (r) => r.top?.snapshots, (a, b) => descNull(a.snapshotSizeGB, b.snapshotSizeGB) || descNull(a.snapshotCount, b.snapshotCount) || byName(a, b), n);
  return mergeTop(rows, (r) => r.top?.noTools, null, n);
}

/** 두 조각 막대 색 — 사용(회색) · 미사용(주황 강조) · Thin 여유(보라). 시안 보드와 같은 값. */
export const OVER_COLORS = Object.freeze({
  used: Object.freeze({ bg: '#4b5873', ink: '#ffffff' }),
  idle: Object.freeze({ bg: '#f59e0b', ink: '#0b0b0b' }),
  thin: Object.freeze({ bg: '#9085e9', ink: '#0b0b0b' }),
});

/** 법인별 목록은 이만큼만 그리고 나머지는 ‘그 밖 N곳’ 으로 말한다(도구에 전체가 있다). */
export const OVER_CORP_ROWS = 12;
