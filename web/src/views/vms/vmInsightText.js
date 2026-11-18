/**
 * views/vms/vmInsightText.js — VM 탭 ‘분석’ 보기(v3.21.0 · 설계 docs/design/vm-insight · 시안 VmInsight.dc.html)의 VM 전용 순수 계산(vitest 고정).
 *
 * 값은 서버 GET /api/vms/insight(inventory/vmInsight.js — 법인마다 한 줄 + 법인마다 상위 N)이고, 화면은 고른 법인의 줄을 더하기만 한다(insight/insightCore.js).
 *  · 새 판정을 만들지 않는다 — 과부하 · Tools · 스냅샷은 서버 신호(signals) 그대로, 기준값(과부하 % · 스냅샷 일수 · 칸 폭 · 크기 구간 · 상위 N)은 응답의 thresholds.
 *  · 못 읽은 값은 0 이 아니다 — 모르는 수는 null('—'), 못 읽은 VM 수는 ‘모름 N’ 으로 따로. 오래됨 · 모름 법인은 합에 넣지 않는다.
 */
import { numOrNull } from '../../numOrNull.js';
import { addVal, sumKeys, avgOf, mergeTopN, byName, shareOf, shareText, fmtN, fmtU, gbText, round1 } from '../insight/insightCore.js';
import { hostAvgMemGB as toolHostAvgMemGB, hostsEq } from './insight-tools/toolSumText.js';   // S2 환산 판정 한 벌

/** 서버 vmInsight.js finishRow 의 수 · 합 키(신원 키 제외) — 이 키만 더한다. os 는 kinds 를 이름으로 합쳐야 해서 따로. */
export const VM_STAT_KEYS = Object.freeze([
  'total', 'on', 'off', 'templates', 'attention', 'signals', 'vcpu', 'vcpuUnknown', 'memMB', 'memUnknown', 'diskGB', 'diskUnknown',
  'connection', 'tools', 'hw', 'cpuHist', 'memHist', 'usageUnknown', 'histOut', 'cpuAvg', 'memAvg', 'over90', 'vcpuSize', 'memSize', 'reclaim', 'gpuVms',
]);

/** OS 를 법인끼리 합친다 — 계열 · 접은 수는 더하고, 종류(kinds)는 이름(null = 모름)으로 합쳐 많은 순. */
export function sumOs(rows) {
  let family = null; let rest = null;
  const kinds = new Map();
  for (const r of Array.isArray(rows) ? rows : []) {
    const os = r?.os;
    if (!os || typeof os !== 'object') continue;
    family = addVal(family, os.family);
    rest = addVal(rest, os.kindsRest);
    for (const k of Array.isArray(os.kinds) ? os.kinds : []) {
      if (!k || typeof k !== 'object') continue;
      const key = k.name == null ? '\u0000모름' : String(k.name);
      const cur = kinds.get(key) || { name: k.name == null ? null : String(k.name), family: k.family ?? null, count: 0 };
      cur.count += numOrNull(k.count) ?? 0;
      kinds.set(key, cur);
    }
  }
  const list = [...kinds.values()].sort((a, b) => (b.count - a.count) || String(a.name ?? '').localeCompare(String(b.name ?? '')));
  return { family, kinds: list, kindsRest: rest };
}

/** 고른 법인 줄의 합 — 평균은 Σsum ÷ Σn 으로 다시. 줄이 없으면 수 키가 전부 null. */
export function sumVmRows(rows) {
  const s = sumKeys(rows, VM_STAT_KEYS);
  s.os = sumOs(rows);
  if (s.cpuAvg) s.cpuAvg = { ...s.cpuAvg, value: avgOf(s.cpuAvg) };
  if (s.memAvg) s.memAvg = { ...s.memAvg, value: avgOf(s.memAvg) };
  s.diskGB = round1(s.diskGB);
  return s;
}

// ── 상위 목록 — 서버 vmInsight.js 의 CMP_CPU · CMP_OLD · CMP_BIG 과 같은 비교 순서 ──
export const CMP_CPU = (a, b) => ((numOrNull(b.cpu) ?? -1) - (numOrNull(a.cpu) ?? -1)) || ((numOrNull(b.mem) ?? -1) - (numOrNull(a.mem) ?? -1)) || byName(a, b);
export const CMP_OLD = (a, b) => ((numOrNull(b.days) ?? -1) - (numOrNull(a.days) ?? -1)) || ((numOrNull(b.snapGB) ?? -1) - (numOrNull(a.snapGB) ?? -1)) || byName(a, b);
export const CMP_BIG = (a, b) => ((numOrNull(b.snapGB) ?? -1) - (numOrNull(a.snapGB) ?? -1)) || ((numOrNull(b.days) ?? -1) - (numOrNull(a.days) ?? -1)) || byName(a, b);

/** 고른(합에 넣은) 법인의 상위 목록을 합쳐 다시 n 개 — top 은 응답의 top[](rows 와 같은 id). */
export function mergedTops(top, usedIds, n) {
  const set = new Set((usedIds || []).map(String));
  const mine = (Array.isArray(top) ? top : []).filter((t) => t && set.has(String(t.id)));
  return {
    cpuTop: mergeTopN(mine.map((t) => t.cpuTop), CMP_CPU, n),
    snapOldest: mergeTopN(mine.map((t) => t.snapOldest), CMP_OLD, n),
    snapBiggest: mergeTopN(mine.map((t) => t.snapBiggest), CMP_BIG, n),
  };
}

/** 지역 이름 — 비면 ‘리전 미지정’. */
export const regionName = (r) => { const v = String(r ?? '').trim(); return !v || v === 'Unknown' ? '리전 미지정' : v; };
/** 법인 표시 이름 — 이름이 없으면 id. */
export const corpName = (r) => String(r?.name || r?.id || '');

/** MB → GB(소수 1자리) — 모르면 null. */
export const mbToGb = (mb) => { const n = numOrNull(mb); return n == null ? null : Math.round((n / 1024) * 10) / 10; };

/** 요약 6장. s = sumVmRows 결과, corpN = 합에 넣은 법인 수. */
export function kpiView(s, corpN) {
  const total = numOrNull(s?.total); const on = numOrNull(s?.on); const off = numOrNull(s?.off);
  const sig = s?.signals || {};
  const vcpuKnown = total == null ? null : total - (numOrNull(s?.vcpuUnknown) ?? 0);
  const memKnown = total == null ? null : total - (numOrNull(s?.memUnknown) ?? 0);
  const memGB = mbToGb(s?.memMB);
  const unk = (n) => ((numOrNull(n) ?? 0) > 0 ? ` · 모름 ${fmtU(n, '대')}` : '');
  return [
    { key: 'total', label: '전체 VM', value: fmtN(total), sub: `템플릿 ${fmtN(s?.templates)} 포함 · 법인 ${fmtU(corpN, '곳')}`, tip: '지금 범위의 VM 수(템플릿 포함)' },
    { key: 'on', label: '구동', value: fmtN(on), meter: shareOf(on, total), sub: `${shareText(on, total)} · 정지 ${fmtN(off)}(템플릿 포함)`, tip: '전원이 켜진 VM' },
    { key: 'attention', label: '조치 필요', value: fmtN(s?.attention), tone: (numOrNull(s?.attention) ?? 0) > 0 ? 'crit' : '',
      sub: `${shareText(s?.attention, total)} · 과부하 ${fmtN(sig.overload)} · Tools ${fmtN(sig.toolsOld)} · 스냅샷 ${fmtN(sig.snapOld)} · 사용률 미수집 ${fmtN(sig.usageUnknown)}`,
      tip: '신호가 하나라도 있는 VM — ‘조치 필요’ 보기와 같은 판정' },
    { key: 'vcpu', label: '할당 vCPU', value: fmtN(s?.vcpu), sub: `VM 한 대 평균 ${vcpuKnown > 0 && numOrNull(s?.vcpu) != null ? (s.vcpu / vcpuKnown).toFixed(1) : '—'}${unk(s?.vcpuUnknown)}`, tip: 'VM 에 준 vCPU 의 합(읽은 VM 만)' },
    { key: 'mem', label: '할당 메모리', value: gbText(memGB), sub: `VM 한 대 평균 ${memKnown > 0 && memGB != null ? `${(memGB / memKnown).toFixed(1)} GB` : '—'}${unk(s?.memUnknown)}`, tip: 'VM 에 준 메모리의 합(읽은 VM 만)' },
    { key: 'disk', label: '할당 디스크', value: gbText(s?.diskGB), sub: `그중 정지 VM 이 ${gbText(s?.reclaim?.offDiskGB)}${unk(s?.diskUnknown)}`, tip: 'VM 에 준 디스크의 합(읽은 VM 만)' },
  ];
}

/** 확인할 것 — VM 집계 쪽 칸(도구 쪽 칸은 insight-tools/vmToolChecks.js 가 준다). 순서는 시안대로 과부하 → (도구 칸) → 스냅샷 → Tools → 고아 → 정지. */
export function checkBase(s, { snapAgeDays = null, wasteHref = null } = {}) {
  const sig = s?.signals || {};
  const r = s?.reclaim || {};
  const d = numOrNull(snapAgeDays);
  return {
    head: [
      { key: 'overload', label: '과부하 VM', value: sig.overload ?? null, tone: 'crit', sub: 'CPU 또는 메모리 사용률 높음', href: '#/vms/attention', tip: '‘조치 필요’ 의 과부하 신호(구동 VM)' },
    ],
    tail: [
      { key: 'snapOld', label: '오래된 스냅샷', value: sig.snapOld ?? null, tone: 'warn', sub: d != null ? `${d}일 넘긴 VM` : '기준 일수를 넘긴 VM', href: '#/vms/attention', tip: '가장 오래된 스냅샷이 기준 일수를 넘긴 VM — 기준은 ‘VM 구성 점검’ 설정' },
      { key: 'toolsOld', label: 'Tools 업그레이드 필요', value: sig.toolsOld ?? null, tone: 'warn', sub: 'VMware Tools 버전', href: '#/vms/attention', tip: 'Tools 버전 상태가 업그레이드 필요 · 너무 오래됨 · 차단 판' },
      { key: 'orphan', label: '고아 · 접근 불가', value: r.orphan ?? null, tone: 'warn', sub: '연결 상태', tip: 'vCenter 가 고아(orphaned) · 접근 불가(inaccessible)로 보는 VM' },
      { key: 'off', label: '정지 VM', value: r.offCount ?? null, tone: '', sub: `디스크 ${gbText(r.offDiskGB)}(템플릿 제외)`, ...(wasteHref ? { href: wasteHref } : {}), tip: '전원이 꺼진 VM(템플릿 제외)' },
    ],
  };
}

/**
 * 확인할 것 한 줄 — VM 집계 칸(checkBase) + 도구 칸(insight-tools/vmToolChecks.js checkItems — { key, label, value(표시 글자), tone, href, sub, title }).
 * 순서(시안 S1): 과부하 → 도구 칸(디스크가 차 가는 VM …) → 오래된 스냅샷 → Tools → 고아 · 접근 불가 → 정지 VM.
 * 도구가 ‘꺼진 VM’(powered-off — Optimization 패널의 수 · 템플릿 제외)을 주면 VM 집계의 ‘정지 VM’ 칸 자리를 그것으로 바꾼다(§8 — 칸과 패널의 수가 같게 · 한 줄에 두 번 세지 않는다).
 */
export function arrangeChecks(base, toolItems) {
  const tools = (Array.isArray(toolItems) ? toolItems : []).filter((x) => x && typeof x === 'object' && x.key)
    .map((x) => ({ ...x, tip: x.tip ?? x.title }));
  const off = tools.find((x) => x.key === 'powered-off') || null;
  const mid = tools.filter((x) => x !== off);
  const head = Array.isArray(base?.head) ? base.head : [];
  const tail = (Array.isArray(base?.tail) ? base.tail : []).map((x) => (x.key === 'off' && off ? off : x));
  return [...head, ...mid, ...tail];
}

/** 지도 색 기준 — 경계(crit)는 응답의 과부하 %(overloadPct). ‘디스크 초과 VM 비율’ 은 게스트 파티션 요약이 있을 때만(gpByVc). */
export function fillDefs(thresholds, gpByVc = null) {
  const crit = numOrNull(thresholds?.overloadPct);
  const defs = [
    { key: 'att', label: '조치 필요 비율', short: '조치', steps: [10, 20, 30, 40], crit: null, val: (r) => shareOf(r?.attention, r?.total) },
    { key: 'cpu', label: '평균 CPU', short: 'CPU', steps: [20, 40, 60, 80], crit, val: (r) => numOrNull(r?.cpuAvg?.value) },
    { key: 'mem', label: '평균 메모리', short: '메모리', steps: [20, 40, 60, 80], crit, val: (r) => numOrNull(r?.memAvg?.value) },
  ];
  if (gpByVc) {
    defs.push({ key: 'disk', label: '디스크 초과 VM 비율', short: '디스크', steps: [5, 10, 15, 20], crit: null,
      val: (r) => { const g = gpByVc.get(String(r?.id)); return g ? shareOf(g.overVms, g.reported) : null; } });
  }
  return defs;
}
/** 지도 크기 기준. */
export const SIZE_DEFS = Object.freeze([
  { key: 'n', label: 'VM 수', val: (r) => numOrNull(r?.total), text: (v) => `${fmtN(v)} VM` },
  { key: 'vcpu', label: 'vCPU', val: (r) => numOrNull(r?.vcpu), text: (v) => `${fmtN(v)} vCPU` },
  { key: 'disk', label: '디스크', val: (r) => numOrNull(r?.diskGB), text: (v) => gbText(v) },
]);

/** 지도 묶음 — 지역마다 법인 칸(크기 = size.val). 모름 법인은 크기 null(칸 없음으로 밝힌다). */
export function mapGroups(rows, size) {
  const by = new Map();
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r || typeof r !== 'object') continue;
    const key = regionName(r.region);
    if (!by.has(key)) by.set(key, []);
    by.get(key).push({ id: String(r.id), label: corpName(r), size: r.unknown === true ? null : size.val(r), row: r });
  }
  return [...by.entries()].map(([key, items]) => ({ key, label: key, items }));
}

/** 지역별 분포 — 합에 넣은 법인(used)만. 많은 순. */
export function regionRows(used, total) {
  const by = new Map();
  for (const r of Array.isArray(used) ? used : []) {
    const key = regionName(r.region);
    const cur = by.get(key) || { key, n: null, on: null, att: null, vcpu: null, memMB: null, corps: [] };
    cur.n = addVal(cur.n, r.total); cur.on = addVal(cur.on, r.on); cur.att = addVal(cur.att, r.attention);
    cur.vcpu = addVal(cur.vcpu, r.vcpu); cur.memMB = addVal(cur.memMB, r.memMB);
    cur.corps.push(r);
    by.set(key, cur);
  }
  return [...by.values()].sort((a, b) => ((b.n ?? -1) - (a.n ?? -1)) || a.key.localeCompare(b.key)).map((g) => ({
    ...g, share: shareText(g.n, total), w: shareOf(g.n, total) ?? 0,
    sub: `구동 ${fmtN(g.on)} · 조치 필요 ${fmtN(g.att)} · vCPU ${fmtN(g.vcpu)} · 메모리 ${gbText(mbToGb(g.memMB))}`,
    cities: g.corps.slice().sort((a, b) => (numOrNull(b.total) ?? -1) - (numOrNull(a.total) ?? -1)).map((c) => `${c.city || corpName(c)} ${fmtN(c.total)}`).join(' · '),
  }));
}

/** OS 종류 — 많은 순 shown 종 + ‘그 밖’(접은 종류 + 서버가 접은 kindsRest) + ‘모름’(OS 를 모르는 VM — 따로). */
export function osRows(os, shown) {
  const n = Math.max(1, numOrNull(shown) ?? 8);
  const kinds = Array.isArray(os?.kinds) ? os.kinds : [];
  const known = kinds.filter((k) => k.name != null);
  const unknown = kinds.filter((k) => k.name == null).reduce((a, k) => a + (numOrNull(k.count) ?? 0), 0);
  const head = known.slice(0, n);
  const restKinds = known.slice(n);
  const rest = restKinds.reduce((a, k) => a + (numOrNull(k.count) ?? 0), 0) + (numOrNull(os?.kindsRest) ?? 0);
  const out = head.map((k) => ({ key: `k:${k.name}`, name: k.name, family: k.family, n: numOrNull(k.count) ?? 0 }));
  if (rest > 0) out.push({ key: 'rest', name: `그 밖${restKinds.length ? ` ${fmtU(restKinds.length, '종')}` : ''}`, family: null, n: rest, rest: true });
  if (unknown > 0) out.push({ key: 'unknown', name: 'OS 모름', family: null, n: unknown, unknown: true });
  return out;
}

/** 크기 구간 이름 — 서버 키 k 는 ‘앞 키 초과 k 이하’. edges [1,2,4,8,16] → ['1','2','3–4','5–8','9–16','17 이상'] (단위는 호출부). */
export function sizeBinRows(bins, edges, unit) {
  const e = (Array.isArray(edges) ? edges : []).map((x) => numOrNull(x)).filter((x) => x != null);
  const b = bins && typeof bins === 'object' ? bins : {};
  const out = e.map((k, i) => {
    const lo = i === 0 ? null : e[i - 1];
    const intLo = lo == null ? null : lo + 1;
    let name;
    if (unit === 'GB') name = lo == null ? `${k} GB 이하` : `${lo}–${k} GB`;
    else name = lo == null || intLo === k ? `${k} ${unit}` : `${intLo}–${k} ${unit}`;
    return { key: String(k), name, n: numOrNull(b[String(k)]) };
  });
  const last = e[e.length - 1];
  if (last != null) out.push({ key: 'more', name: unit === 'GB' ? `${last} GB 초과` : `${last + 1} ${unit} 이상`, n: numOrNull(b.more) });
  return { rows: out, unknown: numOrNull(b.unknown) };
}

/** 하드웨어 버전 — 많은 순 limit 개 + 나머지(접힘 + 서버 rest) · 못 읽음은 따로. */
export function hwRows(hw, limit = 6) {
  const v = hw?.versions && typeof hw.versions === 'object' ? hw.versions : {};
  const list = Object.entries(v).map(([k, n]) => ({ key: k, name: k, n: numOrNull(n) ?? 0 })).sort((a, b) => (b.n - a.n) || a.name.localeCompare(b.name));
  const head = list.slice(0, limit);
  const rest = list.slice(limit).reduce((a, x) => a + x.n, 0) + (numOrNull(hw?.rest) ?? 0);
  if (rest > 0) head.push({ key: 'rest', name: '그 밖', n: rest });
  return { rows: head, unread: numOrNull(hw?.unread) };
}

/**
 * 오래된 스냅샷 구간 — 서버(inventory/vmInsight.js)는 고정 경계로 나눈다: days < edges[0] → d7_30 · < edges[1] → d30_90 · 나머지 d90p.
 * 판정 대상은 기준 일수 이상이므로 각 구간의 실제 아래 끝은 max(기준, 경계)다(기준 45 · 경계 30 이면 둘째 칸은 45–90일).
 * 위 끝이 기준 이하인 구간은 비어 있을 수밖에 없으므로 이름을 만들지 않는다(‘45–30일’ 같은 거꾸로 된 범위를 그리지 않는다).
 */
export function snapBands(reclaim, thresholds) {
  const a = reclaim?.snapAge || {};
  const d = numOrNull(thresholds?.snapAgeDays);
  const e = Array.isArray(thresholds?.snapAgeEdgesDays) ? thresholds.snapAgeEdgesDays : [];
  const e1 = numOrNull(e[0]); const e2 = numOrNull(e[1]);
  const lo = (edge) => (d != null && edge != null ? Math.max(d, edge) : edge);
  const dead = (hi, n) => d != null && hi != null && hi <= d && !((n ?? 0) > 0);
  const n1 = numOrNull(a.d7_30); const n2 = numOrNull(a.d30_90); const n3 = numOrNull(a.d90p);
  const lo2 = lo(e1); const lo3 = lo(e2);
  return [
    dead(e1, n1) ? null : { key: 'd7_30', label: `${d != null ? d : '기준'}–${e1 ?? '—'}일`, n: n1, bg: '#f59e0b', ink: '#0b0b0b' },
    dead(e2, n2) ? null : { key: 'd30_90', label: `${lo2 ?? '—'}–${e2 ?? '—'}일`, n: n2, bg: '#ec835a', ink: '#0b0b0b' },
    { key: 'd90p', label: `${lo3 ?? '—'}일 이상`, n: n3, bg: '#ef4444', ink: '#ffffff' },
  ].filter(Boolean);
}

/**
 * S2 환산 기준 — 고른 법인 호스트 한 대의 평균 메모리(GB). 판정은 insight-tools/toolSumText.hostAvgMemGB 하나(‘과할당’ 보기와 같은 값 —
 * 용량을 읽은 호스트만 · 오래됨 제외). 여기서는 평균 수만 돌려준다. 모르면 null(환산을 생략한다).
 */
export function hostAvgMemGB(corps, ids) {
  const a = toolHostAvgMemGB(corps, ids);
  return a && a.avgGB > 0 ? a.avgGB : null;
}
/** 메모리(GB)가 호스트 몇 대분인가 — toolSumText.hostsEq 그대로. 기준이 없으면 null(문구를 생략). */
export const hostsEquivalent = (memGB, avgGB) => hostsEq(memGB, avgGB);

/** 사용률 칸이 경고 칸인가 — 칸 하한 ≥ 과부하 %. */
export const histCritFrom = (thresholds) => numOrNull(thresholds?.overloadPct);

/** Optimization 요약(waste?summary=1)의 고른 법인 합 — CPU · 메모리 후보 수 · 미사용 메모리(MB). 줄이 없으면 null. */
export function wasteSum(rows, ids) {
  const want = Array.isArray(ids) && ids.length ? new Set(ids.map(String)) : null;
  const mine = (Array.isArray(rows) ? rows : []).filter((r) => r && (!want || want.has(String(r.vcenterId))));
  if (!mine.length) return null;
  const s = sumKeys(mine.map((r) => ({ cpu: r.cpu, mem: r.mem, usageUnknown: r.usageUnknown })), ['cpu', 'mem', 'usageUnknown']);
  return { cpuCand: s.cpu?.candidates ?? null, memCand: s.mem?.candidates ?? null, memIdleMB: s.mem?.idleMB ?? null, usageUnknown: s.usageUnknown };
}

/** 묶음 키 · 이름(접힘 기억 키의 값 — 바꾸지 말 것). */
export const VM_FOLD_GROUPS = Object.freeze([
  ['now', '지금 볼 것'], ['capacity', '용량과 정리'], ['perf', '성능'], ['config', '구성 점검'], ['dist', '분포'],
]);
export const VM_FOLD_KEYS = Object.freeze(VM_FOLD_GROUPS.map(([k]) => k));
export const VM_MAP_PREF_KEY = 'vmInsight.map';
export const VM_FOLD_PREF_KEY = 'vmInsight.fold';
