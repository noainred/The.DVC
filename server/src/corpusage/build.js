/**
 * corpusage/build.js — 법인별 서버 CPU·메모리 사용량 합계(순수, v2.625).
 *
 * 사용자 요청(2026-09-27): "iDRAC 사용량을 ESXi 호스트까지 넓혀서 진행 · 법인별 전체/다빈치/IRS ·
 *   서버의 전체 CPU/메모리 사용량 · 물리서버 CPU/메모리 사용량 · 가상화 서버 CPU/메모리 사용량을 1페이지에".
 * 선택: 못 읽은 ESXi 는 **vCenter 값으로 채우고 출처 표시** · 합산은 **사용량 합 + 가중 사용률**.
 *
 * ── 무엇을 더하는가 ──────────────────────────────────────────────────────────
 *  · 퍼센트는 서로 더할 수 없다. 서버마다 `사용률 × 용량` 으로 절대량을 만들고 더한다:
 *      CPU  사용 코어(환산) = cpu% / 100 × 코어 수       — '코어 환산' 이다(실제 스케줄 단위가 아니다)
 *      메모리 사용 GB       = mem% / 100 × 설치 메모리 GB  — GB 는 vCenter 카드와 같은 이진 단위(GiB, v2.591 C6)
 *    법인 사용률 = Σ사용 ÷ Σ용량 (가중 평균 — 큰 서버가 크게 반영된다).
 *  · **지표마다 따로** 센다. CPU 만 읽은 서버는 CPU 합에만 들어가고 메모리 분모에는 들어가지 않는다 — 분자와 분모가 같은
 *    서버 집합이어야 사용률이 참이다(v2.546 `capacityCounted` 와 같은 규약).
 *
 * ── 정직성 규칙(이 저장소 공통) ──────────────────────────────────────────────
 *  · 못 읽은 서버를 0 으로 세지 않는다 — 합계에서 빼고 `unread` 로 센다. 용량을 모르면 `noCap`.
 *  · 값이 오래됐으면(`freshMs` 초과) 지금 값이 아니다 → `stale` 로 따로 세고 합계에서 뺀다.
 *  · 분모가 0 이면 사용률은 null('—')이다(0% 가 아니다).
 *  · 출처를 숨기지 않는다: `src` = idrac(iDRAC 텔레메트리·대체 경로) / os(OS SSH) / vcenter(가상화 호스트 대체).
 *  · 법인 구분(다빈치/IRS)은 **법인 이름**에 'IRS' 가 있는가로만 정한다 — V6 Overview `siteGroupOf` 와 같은 규칙(v2.624).
 */
import { numOrNull } from '../util/numOrNull.js';
import { idOf } from '../bmusage/targets.js';

const t = (v) => String(v ?? '').trim();
const posOrNull = (v) => { const n = numOrNull(v); return n != null && n > 0 ? n : null; };
/** 퍼센트는 0~100 만 받는다 — 밖의 값은 퍼센트가 아니다(v2.554 racadm 규약). */
const pctOrNull = (v) => { const n = numOrNull(v); return n != null && n >= 0 && n <= 100 ? n : null; };
const r1 = (v) => (v == null ? null : Math.round(v * 10) / 10);

export const ROLES = Object.freeze(['all', 'bm', 'virt']);
export const GROUPS = Object.freeze(['all', 'davinci', 'irs']);
/** 법인 구분 — 이름에 'IRS' 가 있으면 irs(대소문자 무시). V6 `siteGroupOf` 와 같은 판정이다(테스트가 대조). */
export function corpGroupOf(name) { return /irs/i.test(t(name)) ? 'irs' : 'davinci'; }

function emptyMetric() { return { used: 0, total: 0, n: 0 }; }
export function emptyAgg() {
  return {
    servers: 0,
    cpu: emptyMetric(), mem: emptyMetric(),
    // 합계 밖으로 뺀 이유 — 겹치지 않게 센다(한 서버는 한 사유만): 값 없음 / 오래됨 / 용량 모름
    unread: 0, stale: 0, noCap: 0,
    // v2.628(C2628-06): 판정은 ok 인데 **그 지표만** 값·용량이 없어 그 지표 합계에서 빠진 서버 — 분모가 서버 수보다 작은 이유다.
    cpuMissing: 0, memMissing: 0,
    // v2.628(C2628-03): 다른 vCenter 의 서버와 식별 키가 겹쳐 사용률 행을 쓰지 않은 서버(용량만 센다 — 남의 값을 붙이지 않는다).
    keyConflict: 0,
    // v2.629(A1-2629-01): 서비스태그가 같은 서버를 다른 vCenter 에서 다시 만나 **같은 물리 박스로 보고 뺀** 수(두 번 세지 않는다).
    dupSameBox: 0,
    // v2.629(A1-2629-03): 행 출처(src)로 센 서버 중 **일부 지표를 vCenter 값으로 채운** 수 — 출처가 섞였음을 밝힌다.
    filledCpu: 0, filledMem: 0,
    src: { idrac: 0, os: 0, mixed: 0, vcenter: 0 },
    // 용량만 알고 사용률을 못 읽은 서버까지 포함한 '전체 설치 용량'(참고 — 합계 분모와 다르다)
    capCores: 0, capMemGB: 0,
  };
}
function addMetric(m, pct, cap) {
  if (pct == null || cap == null) return false;
  m.used += (pct / 100) * cap; m.total += cap; m.n += 1;
  return true;
}
function addAgg(a, x) {
  a.servers += 1;
  if (x.cores != null) a.capCores += x.cores;
  if (x.memGB != null) a.capMemGB += x.memGB;
  if (x.keyConflict) a.keyConflict += 1;
  if (x.state === 'unread') { a.unread += 1; return; }
  if (x.state === 'stale') { a.stale += 1; return; }
  const c = addMetric(a.cpu, x.cpuPct, x.cores);
  const m = addMetric(a.mem, x.memPct, x.memGB);
  if (!c && !m) { a.noCap += 1; return; }
  if (!c) a.cpuMissing += 1;
  if (!m) a.memMissing += 1;
  if (x.src && a.src[x.src] != null) a.src[x.src] += 1;
  const filled = Array.isArray(x.filledFromVcenter) ? x.filledFromVcenter : [];
  if (c && filled.includes('cpu')) a.filledCpu += 1;
  if (m && filled.includes('mem')) a.filledMem += 1;
}
function mergeAgg(into, a) {
  into.servers += a.servers; into.unread += a.unread; into.stale += a.stale; into.noCap += a.noCap;
  into.cpuMissing += a.cpuMissing; into.memMissing += a.memMissing; into.keyConflict += a.keyConflict;
  into.dupSameBox += a.dupSameBox; into.filledCpu += a.filledCpu; into.filledMem += a.filledMem;
  into.capCores += a.capCores; into.capMemGB += a.capMemGB;
  for (const k of ['cpu', 'mem']) { into[k].used += a[k].used; into[k].total += a[k].total; into[k].n += a[k].n; }
  for (const k of Object.keys(into.src)) into.src[k] += a.src[k] || 0;
}
/** 화면용 마무리 — 사용률(가중), 반올림. 분모 0 이면 null. */
export function finishAgg(a) {
  const fin = (m) => ({ used: r1(m.used), total: r1(m.total), n: m.n, pct: m.total > 0 ? r1((m.used / m.total) * 100) : null });
  return { ...a, cpu: fin(a.cpu), mem: fin(a.mem), capCores: r1(a.capCores), capMemGB: r1(a.capMemGB) };
}

/** 최신값 행의 출처 표기를 셋으로 접는다(`os+idrac` 처럼 섞이면 os — OS 값이 있으면 iDRAC 이 덮지 않는다, v2.550). */
// v2.628(R2628-04 — 재현): 행의 src 는 **전 지표 출처의 합집합**이다(DB 는 지표별 출처를 저장하지 않는다). 예전엔 'os' 가 들어
//   있기만 하면 OS 로 셌다 — CPU·메모리는 iDRAC 이고 디스크만 OS 인 서버가 'OS' 로 보였다. 둘 다면 **섞임(mixed)** 으로 밝힌다.
export function srcOfRow(row) {
  const parts = new Set(t(row?.src).toLowerCase().split(/[^a-z-]+/).filter(Boolean).map((x) => (x.startsWith('idrac') ? 'idrac' : x)));
  const os = parts.has('os'); const idrac = parts.has('idrac');
  if (os && idrac) return 'mixed';
  if (os) return 'os';
  return 'idrac';
}

/**
 * 서버 한 대의 판정(순수).
 * @returns {{state:'ok'|'unread'|'stale', cpuPct, memPct, src, at}}
 */
export function judgeServer({ role, row = null, host = null, now, freshMs, vcUnread = null }) {
  const rowAt = numOrNull(row?.ts);
  const rowCpu = pctOrNull(row?.cpu_pct);
  const rowMem = pctOrNull(row?.mem_pct);
  const hasRow = row && (rowCpu != null || rowMem != null);
  // v2.628(R2628-02 — 재현): 엣지 보관분 행은 **그 엣지의 수집 주기**로 신선도를 본다(라우트가 `_freshMs` 를 붙인다) — 중앙
  //   주기로 재면 주기가 긴 엣지의 정상 값이 '오래됨' 으로 빠진다.
  const lim = numOrNull(row?._freshMs) ?? freshMs;
  const fresh = hasRow && rowAt != null && now - rowAt <= lim;
  // 가상화 호스트는 vCenter 값으로 채운다(사용자 선택) — 연결이 끊긴 호스트의 값은 쓰지 않는다(store.usageReadable 과 같은 기준).
  // v2.628(C2628-04 — 재현): **그 vCenter 가 지금 읽히는가** 도 본다. 점검중·수집 실패 이월·위임 push 낡음(sampler
  //   unreadVcenterReasons)이면 스냅샷의 호스트 값은 몇 시간 전 것이다 — 그것을 '지금 값' 으로 세지 않는다.
  const hostUsable = role === 'virt' && host && !vcUnread
    && host.connectionState !== 'DISCONNECTED' && host.connectionState !== 'NOT_RESPONDING';
  const hc = hostUsable ? pctOrNull(host.cpuUsagePct) : null;
  const hm = hostUsable ? pctOrNull(host.memUsagePct) : null;
  if (fresh) {
    // v2.628(C2628-06): 행에 없는 지표만 vCenter 값으로 채운다(지표별 대체). 출처는 행의 것이고 채운 지표는 filled 로 밝힌다.
    const cpuPct = rowCpu != null ? rowCpu : hc;
    const memPct = rowMem != null ? rowMem : hm;
    const filled = [rowCpu == null && hc != null ? 'cpu' : null, rowMem == null && hm != null ? 'mem' : null].filter(Boolean);
    return { state: 'ok', cpuPct, memPct, src: srcOfRow(row), at: rowAt, ...(filled.length ? { filledFromVcenter: filled } : {}) };
  }
  if (hc != null || hm != null) return { state: 'ok', cpuPct: hc, memPct: hm, src: 'vcenter', at: null };
  if (hasRow) return { state: 'stale', cpuPct: null, memPct: null, src: srcOfRow(row), at: rowAt };
  // 연결은 됐는데 vCenter 가 읽히지 않는 호스트는 '못 읽음' 이 아니라 '오래됨' 이다(마지막 값이 있을 뿐 지금 값이 아니다).
  if (role === 'virt' && host && vcUnread && (pctOrNull(host.cpuUsagePct) != null || pctOrNull(host.memUsagePct) != null)) {
    return { state: 'stale', cpuPct: null, memPct: null, src: 'vcenter', at: null, vcUnread };
  }
  return { state: 'unread', cpuPct: null, memPct: null, src: null, at: null };
}

/**
 * v2.629(A6-03 = C2628-05): 엣지가 보고한 **서비스태그 없는** 물리 서버는 중앙 키(`edge:<agent>:<엣지 fleetId>`)와 엣지 사용률
 *   행 키(엣지의 fleetId)가 달라 늘 '못 읽음' 이었다. 엣지가 이미 자기 fleetId 를 push 하고 중앙이 serverId 에 그대로 싣으므로
 *   계약 변경 없이 되찾는다 — `에이전트|fleetId` 로 그 엣지의 행만 찾는다(다른 엣지의 같은 fleetId 행이 섞이지 않게).
 *   서비스태그가 있으면 기존대로 key(태그)로 찾는다. 순수.
 */
export function edgeRowOf(b, rowsByAgentKey) {
  if (!(rowsByAgentKey instanceof Map) || !rowsByAgentKey.size || !b || typeof b !== 'object') return null;
  if (t(b.serviceTag)) return null;
  const agent = t(b.remoteAgent);
  const sid = t(b.serverId);
  const pre = `edge:${agent}:`;
  if (!agent || !sid.toLowerCase().startsWith(pre.toLowerCase())) return null;
  const fid = sid.slice(pre.length);
  if (!fid) return null;
  return rowsByAgentKey.get(`${agent.toLowerCase()}|${fid.toLowerCase()}`) || null;
}

/**
 * 법인별 집계(순수).
 * @param {object} p
 * @param {Array} p.vcenters       [{id, name}] — 법인 = vCenter(이 저장소의 법인 축)
 * @param {Array} p.bareMetal      classifyFleet().bareMetal
 * @param {Array} p.virtHosts      classifyFleet().virtualizationHosts (cpuCores·memGB 포함)
 * @param {Map}   p.rowsByKey      key → 최신 사용률 행(중앙 DB + 엣지 보관분)
 * @param {Map}   p.rowsByAgentKey `에이전트소문자|key소문자` → 엣지 보관분 행(v2.629 A6-03 — 서비스태그 없는 엣지 서버 매칭)
 * @param {Map}   p.hostByKey      `vcenterId|이름소문자` → 스냅샷 ESXi 호스트(가상화 대체값·용량)
 * @param {function} p.capOf       (베어메탈 항목) → {cores, memGB} | null
 * @param {Set|null} p.allowed     범위 계정의 허용 vCenter(null = 전체)
 */
export function buildCorpUsage({ vcenters = [], bareMetal = [], virtHosts = [], rowsByKey = new Map(), rowsByAgentKey = new Map(), hostByKey = new Map(), capOf = () => null, allowed = null, now = Date.now(), freshMs = 30 * 60_000, unreadVcenters = null } = {}) {
  const names = new Map((vcenters || []).filter((v) => v && t(v.id)).map((v) => [t(v.id), t(v.name) || t(v.id)]));
  const corps = new Map();
  const corpOf = (vc) => {
    if (!corps.has(vc)) {
      const name = names.get(vc) || vc;
      corps.set(vc, { vcenterId: vc, name, group: corpGroupOf(name), bm: emptyAgg(), virt: emptyAgg(), servers: [] });
    }
    return corps.get(vc);
  };
  const unassigned = { bm: emptyAgg() };
  const inScope = (vc) => !allowed || allowed.has(vc);
  const seen = new Map();   // key → 처음 센 서버의 vCenter
  const vcUnreadOf = (vc) => (unreadVcenters instanceof Map ? unreadVcenters.get(vc) || null : null);

  for (const b of bareMetal || []) {
    if (!b || typeof b !== 'object') continue;
    const vc = t(b.vcenterId);
    const { key } = idOf(b);
    if (!key || seen.has(key)) continue;
    seen.set(key, vc);
    const hostRow = t(b.serverId).startsWith('host:') ? hostByKey.get(`${vc}|${t(b.name).toLowerCase()}`) : null;
    const cap = hostRow
      ? { cores: posOrNull(hostRow.cpuCores), memGB: posOrNull(hostRow.memTotalMB) != null ? hostRow.memTotalMB / 1024 : null }
      : (capOf(b) || {});
    const j = judgeServer({ role: 'bm', row: edgeRowOf(b, rowsByAgentKey) || rowsByKey.get(key), now, freshMs });
    const x = { key, name: t(b.name), role: 'bm', cores: posOrNull(cap.cores), memGB: posOrNull(cap.memGB), ...j };
    if (!vc) { if (!allowed) addAgg(unassigned.bm, x); continue; }
    if (!inScope(vc)) continue;
    const c = corpOf(vc);
    addAgg(c.bm, x); c.servers.push(x);
  }
  // v2.629(A1-2629-01 — 재현): 서비스태그가 같으면 **같은 물리 박스**다(호스트를 새 vCenter 로 옮겼는데 옛 vCenter 가 끊긴 항목을
  //   들고 있거나 LASTGOOD_HOLD 로 이월 중). v2.628 keyConflict 는 그것을 두 번 셌다(서버 수·설치 용량 중복). 이제 한 대만 남긴다 —
  //   고르는 기준은 연결됨 → 그 vCenter 가 읽힘 → 반복 순서(안정). 뺀 쪽은 그 법인에 `dupSameBox` 로 센다(조용히 빼지 않는다).
  //   ⚠ 범위와 무관하게 전 vCenter 에서 고른다 — 범위마다 다른 쪽을 고르면 같은 서버가 두 법인에서 동시에 세인다.
  const tagWinner = new Map();   // 서비스태그 key → 남길 가상화 호스트
  const rankOf = (h, vc) => {
    const host = hostByKey.get(`${vc}|${t(h.name).toLowerCase()}`) || null;
    const conn = host && host.connectionState !== 'DISCONNECTED' && host.connectionState !== 'NOT_RESPONDING' ? 2 : 0;
    return conn + (vcUnreadOf(vc) ? 0 : 1);
  };
  const bmTagVc = new Map();
  for (const [k, v] of seen) bmTagVc.set(k, v);
  for (const h of virtHosts || []) {
    if (!h || typeof h !== 'object' || h.synthetic) continue;
    const vc = t(h.vcenterId);
    if (!vc) continue;
    const id = idOf({ serverId: h.idracServerId, fleetId: h.fleetId, name: h.name, serviceTag: h.serviceTag });
    if (!id.key || id.keyKind !== 'serviceTag') continue;
    const prev = tagWinner.get(id.key);
    if (!prev || rankOf(h, vc) > rankOf(prev, t(prev.vcenterId))) tagWinner.set(id.key, h);
  }
  for (const h of virtHosts || []) {
    if (!h || typeof h !== 'object' || h.synthetic) continue;   // 합성 행(ESXi 에 매칭 안 된 강제 가상화)은 용량·사용률이 없다
    const vc = t(h.vcenterId);
    if (!vc || !inScope(vc)) continue;
    const { key, keyKind } = idOf({ serverId: h.idracServerId, fleetId: h.fleetId, name: h.name, serviceTag: h.serviceTag });
    if (!key) continue;
    if (keyKind === 'serviceTag') {
      // 베어메탈로 이미 센 같은 박스(같은 vCenter 는 예전 규칙대로 조용히 합친다 — 한 서버의 두 분류다).
      if (bmTagVc.has(key)) {
        if (bmTagVc.get(key) !== vc) corpOf(vc).virt.dupSameBox += 1;
        continue;
      }
      const w = tagWinner.get(key);
      if (w && w !== h) {
        if (t(w.vcenterId) !== vc) corpOf(vc).virt.dupSameBox += 1;
        continue;
      }
    }
    // v2.628(C2628-03 — 재현): 같은 key 를 **같은 vCenter** 에서 다시 만나면 같은 박스(베어메탈로도 잡힌 ESXi 등)라 한 번만 센다.
    //   **다른 vCenter** 의 서버가 같은 key(서비스태그 없이 짧은 이름 'esxi-01' 로 떨어진 경우)를 쓰면 다른 서버다 — 예전엔 조용히
    //   빠져 그 법인 행이 통째로 사라졌다. 세되 사용률 행은 붙이지 않는다(어느 서버의 값인지 알 수 없다 — vCenter 값만 쓴다).
    let keyConflict = false;
    if (seen.has(key)) {
      if (seen.get(key) === vc) continue;
      keyConflict = true;
    } else seen.set(key, vc);
    const host = hostByKey.get(`${vc}|${t(h.name).toLowerCase()}`) || null;
    const j = judgeServer({ role: 'virt', row: keyConflict ? null : rowsByKey.get(key), host, now, freshMs, vcUnread: vcUnreadOf(vc) });
    const x = { key, name: t(h.name), role: 'virt', cores: posOrNull(h.cpuCores), memGB: posOrNull(h.memGB), ...j, ...(keyConflict ? { keyConflict: true } : {}) };
    const c = corpOf(vc);
    addAgg(c.virt, x); c.servers.push(x);
  }

  // 켠 법인이 아니어도 서버가 없는 법인은 행을 만들지 않는다(빈 행은 '0대' 라는 정보가 아니라 잡음이다).
  const rows = [...corps.values()].map((c) => {
    const all = emptyAgg(); mergeAgg(all, c.bm); mergeAgg(all, c.virt);
    return { vcenterId: c.vcenterId, name: c.name, group: c.group, all: finishAgg(all), bm: finishAgg(c.bm), virt: finishAgg(c.virt), serverCount: c.servers.length };
  }).sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true, sensitivity: 'base' }) || a.vcenterId.localeCompare(b.vcenterId));

  const totals = {};
  for (const g of GROUPS) {
    const acc = { all: emptyAgg(), bm: emptyAgg(), virt: emptyAgg() };
    for (const c of corps.values()) {
      if (g !== 'all' && c.group !== g) continue;
      mergeAgg(acc.bm, c.bm); mergeAgg(acc.virt, c.virt);
      mergeAgg(acc.all, c.bm); mergeAgg(acc.all, c.virt);
    }
    totals[g] = { all: finishAgg(acc.all), bm: finishAgg(acc.bm), virt: finishAgg(acc.virt), corps: [...corps.values()].filter((c) => g === 'all' || c.group === g).length };
  }
  return {
    corps: rows,
    totals,
    // 법인 귀속이 없는 물리 서버 — 어느 법인 합계에도 넣지 않는다(범위 계정에는 null — 귀속 없는 데이터 미노출).
    unassigned: allowed ? null : { bm: finishAgg(unassigned.bm) },
    freshMs,
  };
}
