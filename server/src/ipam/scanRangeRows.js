/**
 * ipam/scanRangeRows.js — '스캔 대역·설정 › ① 등록된 스캔 대역' 표(대역 1줄 = 1행)와 줄 단위 수정(순수, v2.692).
 *
 * 사용자 요청: 등록된 스캔 대역을 보여 주고 수정/삭제 버튼. 판정은 전부 기존 코어를 쓴다 —
 *   · 대역 문법: rangeSyntax.checkRangeSpec(저장 PUT 과 같은 판정 — reversed:'error').
 *   · 공인/사설: IPMS ③ 분류기(settings.getClassifier().num) — 범위 안에서 갈리면 'mixed'.
 *   · 무시 대역: IPMS 전체 + 그 에이전트가 수집하는 vCenter 의 무시 목록(annotateSubnets 와 같은 출처).
 * 응답 IP 수는 스캔 결과(그 에이전트가 보고한 IP)가 그 줄 안에 드는 개수다 — 줄끼리 겹치면 각 줄에 센다.
 */
import { checkRangeSpec } from './rangeSyntax.js';
import { ipToNum } from '../util/ipv4.js';

const LOCAL = '__local__';
/** 분류 판정에서 훑는 최대 주소 수 — 넘으면 앞·끝·가운데 표본만 본다(대역 하나가 /8 일 수 있다). */
const CLS_SCAN_MAX = 65_536;

/** 범위 [lo,hi] 의 공인/사설 판정. classify 가 없으면 null. */
export function rangeClass(lo, hi, classify) {
  if (typeof classify !== 'function') return null;
  let pub = 0; let priv = 0;
  const visit = (n) => { if (classify(n) === 'public') pub += 1; else priv += 1; };
  if (hi - lo + 1 <= CLS_SCAN_MAX) { for (let n = lo; n <= hi; n += 1) { visit(n); if (pub && priv) break; } }
  else { for (let k = 0; k <= 64; k += 1) visit(lo + Math.floor(((hi - lo) * k) / 64)); }
  return pub && priv ? 'mixed' : pub ? 'public' : 'private';
}

/** 범위 [lo,hi] 가 무시 구간(tagged {lo,hi,src})에 얼마나 들어가나 — 'full' | 'partial' | null 과 출처. */
export function rangeIgnore(lo, hi, tagged) {
  const hits = (tagged || []).filter((r) => r.hi >= lo && r.lo <= hi);
  if (!hits.length) return { state: null, by: [] };
  const iv = hits.map((r) => [Math.max(r.lo, lo), Math.min(r.hi, hi)]).sort((a, b) => a[0] - b[0]);
  let covered = 0; let a0 = iv[0][0]; let b0 = iv[0][1];
  for (const [a, b] of iv.slice(1)) { if (a <= b0 + 1) b0 = Math.max(b0, b); else { covered += b0 - a0 + 1; a0 = a; b0 = b; } }
  covered += b0 - a0 + 1;
  return { state: covered >= hi - lo + 1 ? 'full' : 'partial', by: [...new Set(hits.map((r) => r.src))] };
}

/**
 * @param {{ agents: Array<{name, enabled, ranges, datacenterId}>, results?: Record<string,{agent?:string}>|Array, classify?: Function,
 *   ignore?: { global?: Array, vcenters?: Record<string,Array> }, vcenterIdsOf?: (agent)=>string[], datacenterOf?: (agent)=>{datacenterId?,datacenterName?}|null,
 *   reports?: Record<string,{at}> }} input
 * @returns {{ rows: Array<object>, agents: Array<object> }}
 */
export function buildScanRangeRows({ agents = [], results = {}, classify = null, ignore = {}, vcenterIdsOf = () => [], datacenterOf = () => null } = {}) {
  const rows = [];
  const byAgent = new Map(); // agent(lower) → [{row, lo, hi}]
  for (const a of Array.isArray(agents) ? agents : []) {
    if (!a || typeof a !== 'object') continue;
    const name = String(a.name || LOCAL);
    const vcIds = (() => { try { return vcenterIdsOf(name) || []; } catch { return []; } })();
    const tagged = [];
    for (const r of ignore.global || []) if (r) tagged.push({ ...r, src: 'global' });
    for (const id of vcIds) for (const r of (ignore.vcenters || {})[id] || []) if (r) tagged.push({ ...r, src: `vc:${id}` });
    let dc = null; try { dc = datacenterOf(name); } catch { dc = null; }
    const list = (Array.isArray(a.ranges) ? a.ranges : []).map((x) => String(x ?? '').trim());
    list.forEach((spec, index) => {
      if (!spec) return;
      const c = checkRangeSpec(spec, { reversed: 'error' });
      const row = {
        agent: name, index, range: spec, valid: !!c.ok, ...(c.ok ? {} : { reason: c.reason }),
        size: c.ok ? c.size : null, agentEnabled: a.enabled !== false,
        datacenterId: dc?.datacenterId || '', datacenterName: dc?.datacenterName || dc?.datacenterId || '',
        cls: c.ok ? rangeClass(c.lo, c.hi, classify) : null, ignore: null, ignoreBy: [], overlaps: [], alive: 0,
      };
      if (c.ok) { const ig = rangeIgnore(c.lo, c.hi, tagged); row.ignore = ig.state; row.ignoreBy = ig.by; }
      rows.push(row);
      if (c.ok) { const k = name.toLowerCase(); if (!byAgent.has(k)) byAgent.set(k, []); byAgent.get(k).push({ row, lo: c.lo, hi: c.hi }); }
    });
  }
  // 다른 에이전트 대역과 겹침(같은 대역을 둘이 스캔하면 결과가 섞인다)
  const all = [...byAgent.values()].flat();
  for (const x of all) {
    for (const y of all) {
      if (x === y || x.row.agent.toLowerCase() === y.row.agent.toLowerCase()) continue;
      if (y.hi >= x.lo && y.lo <= x.hi && !x.row.overlaps.includes(y.row.agent)) x.row.overlaps.push(y.row.agent);
    }
  }
  // 응답 IP 수 — 결과의 agent 가 그 줄의 에이전트이고 주소가 줄 안에 들 때
  const list = Array.isArray(results) ? results : Object.entries(results || {}).map(([ip, r]) => ({ ...r, ip }));
  for (const r of list) {
    const k = String(r?.agent || LOCAL).toLowerCase();
    const mine = byAgent.get(k);
    if (!mine) continue;
    const n = ipToNum(r.ip);
    if (n == null) continue;
    for (const x of mine) if (n >= x.lo && n <= x.hi) x.row.alive += 1;
  }
  return { rows };
}

/**
 * 줄 단위 변경(추가·수정·삭제) — 저장 직전 목록을 만든다(순수). `old` 가 지금 그 자리의 값과 다르면 거부한다
 * (다른 관리자가 그 사이에 바꿨다 — 엉뚱한 줄을 고치지 않게).
 * @returns {{ ok:true, ranges:string[] } | { ok:false, reason:string, code:string }}
 */
export function applyRangeLineOp(current, { op, index, old, value } = {}) {
  const cur = (Array.isArray(current) ? current : []).map((x) => String(x ?? '').trim()).filter(Boolean);
  const v = String(value ?? '').trim();
  if (op === 'add') {
    if (!v) return { ok: false, code: 'empty', reason: '추가할 대역이 비어 있습니다.' };
    if (cur.includes(v)) return { ok: false, code: 'exists', reason: `이미 있는 줄입니다: ${v}` };
    return { ok: true, ranges: [...cur, v] };
  }
  const i = Number.isInteger(index) ? index : Number.parseInt(index, 10);
  if (!Number.isInteger(i) || i < 0 || i >= cur.length) return { ok: false, code: 'stale', reason: '그 줄이 더 이상 없습니다 — 목록을 새로 고친 뒤 다시 시도하세요.' };
  if (String(old ?? '').trim() !== cur[i]) return { ok: false, code: 'stale', reason: `그 사이에 대역이 바뀌었습니다(지금 값: ${cur[i]}) — 목록을 새로 고친 뒤 다시 시도하세요.` };
  if (op === 'delete') return { ok: true, ranges: cur.filter((_, k) => k !== i) };
  if (op === 'edit') {
    if (!v) return { ok: false, code: 'empty', reason: '대역이 비어 있습니다 — 지우려면 삭제를 누르세요.' };
    if (v !== cur[i] && cur.includes(v)) return { ok: false, code: 'exists', reason: `이미 있는 줄입니다: ${v}` };
    const next = [...cur]; next[i] = v;
    return { ok: true, ranges: next };
  }
  return { ok: false, code: 'bad-op', reason: 'op 는 add·edit·delete 중 하나입니다.' };
}
