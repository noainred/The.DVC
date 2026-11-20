/**
 * insights/hwExport/rows.js — 통합 서버 인벤토리 행 + iDRAC 인벤토리 → 내보내기 모델(순수 · v2.967).
 *
 * 입력은 getFleetInventory 결과(bareMetal · virtualizationHosts — 물리/가상화 판정은 그 함수 하나다, 여기서 다시 하지 않는다)와
 * 인벤토리 찾기 함수(invOf)다. 출력 모델은 **함수 없는 평범한 값**이라 엑셀 워커로 그대로 보낼 수 있다.
 *
 *  · 서버마다 ctx { corpId, corpName, kind, name, hostName, serviceTag, inv, vc, sourceText, note } 를 만들고
 *    고른 값(fields)의 get 을 불러 칸 값을 미리 계산한다(null = 빈 칸 — 0 이 아니다).
 *  · 인벤토리가 없는 서버도 **한 줄**로 남긴다(대수가 화면과 같게) — 하드웨어 칸은 비우고 비고에 사유.
 *  · 관리자가 아니면 서버 이름 · Hostname 이 iDRAC 주소와 같을 때 가린다(routes/insights.js maskFleetPayload 와 같은 matcher).
 */
import { HW_FIELDS, HW_GROUPS, fieldAllowed } from './catalog.js';
import { numOrNull } from '../../util/numOrNull.js';
import { createYielder } from '../../util/timeSlice.js';

const t = (v) => (v == null ? '' : String(v).trim());
const low = (v) => t(v).toLowerCase();
export const UNASSIGNED = '__none__';
export const KINDS = Object.freeze(['bm', 'vh', 'both']);

/**
 * 행 → 인벤토리 찾기(순수 공장). 순서: 행의 서버 id(로컬 iDRAC) → `remote:<수집 서버>:<id>` 꼴이면 원격 인벤토리 →
 * 등록부의 같은 서비스태그 → 원격 인벤토리의 같은 서비스태그. routes/api/corpUsage.js makeCapOf 와 같은 순서다(그쪽은 용량만 본다).
 * @returns {(row:{serverId?:string, idracServerId?:string, serviceTag?:string}) => {inv:object|null, via:''|'local'|'remote'}}
 */
export function makeInvOf({ getInventory, registry = [], remoteServers = [] }) {
  const regByTag = new Map();
  for (const r of Array.isArray(registry) ? registry : []) if (r && r.type !== 'ome' && t(r.serviceTag)) regByTag.set(low(r.serviceTag), r);
  const remByTag = new Map(); const remById = new Map();
  for (const s of Array.isArray(remoteServers) ? remoteServers : []) {
    if (!s || typeof s !== 'object') continue;
    if (t(s.serviceTag) && !remByTag.has(low(s.serviceTag))) remByTag.set(low(s.serviceTag), s);
    remById.set(`remote:${t(s.collectorId)}:${t(s.id)}`, s);
  }
  const local = (id) => { if (!id) return null; try { const v = getInventory(id); return v && typeof v === 'object' ? v : null; } catch { return null; } };
  const okInv = (v) => (v && typeof v === 'object' ? v : null);
  return (row) => {
    const id = t(row?.idracServerId || row?.serverId);
    if (id.startsWith('remote:')) { const r = remById.get(id); if (okInv(r?.inv)) return { inv: r.inv, via: 'remote' }; }
    else { const v = local(id); if (v) return { inv: v, via: 'local' }; }
    const tag = low(row?.serviceTag);
    if (tag) {
      const reg = regByTag.get(tag);
      const v = reg ? local(t(reg.id)) : null;
      if (v) return { inv: v, via: 'local' };
      const r = remByTag.get(tag);
      if (okInv(r?.inv)) return { inv: r.inv, via: 'remote' };
    }
    return { inv: null, via: '' };
  };
}

const SOURCE_TEXT = { idrac: 'iDRAC', ome: 'OME', remote: '엣지(원격 수집)', edge: '엣지 보고', vcenter: 'vCenter' };
function sourceTextOf(row, kind, via) {
  if (kind === 'vh') return via === 'remote' ? 'vCenter + iDRAC(엣지)' : via === 'local' ? 'vCenter + iDRAC' : 'vCenter';
  const base = SOURCE_TEXT[t(row.source)] || t(row.source) || '—';
  if (row.remoteAgent) return `${base} ${t(row.remoteAgent)}`.trim();
  return base;
}
function noInvReason(row, kind) {
  if (kind === 'vh') return 'iDRAC 받침 없음 — vCenter 의 모델 · 코어 · 메모리만';
  if (t(row.serverId).startsWith('host:')) return '수동으로 물리 분류한 ESXi 호스트 — iDRAC 등록이 없습니다';
  if (t(row.source) === 'ome') return 'OME 로만 수집 — 부품 인벤토리를 읽은 적이 없습니다';
  if (t(row.source) === 'edge') return '엣지가 보고한 목록에만 있음 — 부품 인벤토리를 받지 못했습니다';
  return '인벤토리를 아직 읽지 못했습니다';
}

/** 고른 법인 집합 → 판정 함수(법인 id — 미지정은 ''). null 이면 전부 · 빈 집합이면 없음. */
function corpFilter(corps) {
  if (!corps) return () => true;
  const set = new Set([...corps].map((c) => t(c)));
  if (!set.size) return () => false;
  return (corpId) => set.has(t(corpId) || UNASSIGNED);
}
/** 법인 판정을 주지 않았을 때(테스트 · 단독 사용)의 기본 — 행의 vCenter 를 법인으로 본다. 라우트는 corp.js makeCorpOf(법인 = DataCenter)를 준다. */
const corpByVcenter = (row) => ({ id: t(row?.vcenterId), name: t(row?.vcenter) || t(row?.vcenterId) || '미지정' });

/**
 * 대상 서버(ctx) 목록 — 법인(corpRank 가 있으면 그 순서, 없으면 이름) → 구분(물리 먼저) → 서버 이름 순.
 * @param {{bareMetal:object[], virtualizationHosts:object[]}} fleet
 * @param {{kind:'bm'|'vh'|'both', corps?:Set<string>|string[]|null, invOf:Function, match?:(v:string)=>boolean,
 *          corpOf?:(row:object, kind:string)=>{id:string,name:string}, corpRank?:Map<string,number>}} o
 */
export function selectServers(fleet, { kind = 'bm', corps = null, invOf, match = null, corpOf = corpByVcenter, corpRank = null } = {}) {
  const inCorp = corpFilter(corps);
  const mask = (v) => (match && v && match(v) ? '(주소 가림)' : v);
  const out = [];
  const add = (row, k) => {
    if (!row || typeof row !== 'object') return;
    const corp = corpOf(row, k) || { id: '', name: '미지정' };
    if (!inCorp(corp.id)) return;
    const { inv, via } = k === 'vh' && !row.idracBacked ? { inv: null, via: '' } : invOf(row);
    const hn = t(inv?.system?.hostName);
    const vc = k === 'vh' ? { cores: numOrNull(row.cpuCores), memGiB: numOrNull(row.memGB) } : null;
    const notes = [];
    if (!inv) notes.push(`인벤토리 없음 — ${noInvReason(row, k)}`);
    else if (!hn) notes.push('Hostname 미보고');
    if (inv && via === 'remote') notes.push('엣지 축약 인벤토리(시리얼 없음 · 구버전 엣지는 일부 값 없음)');
    out.push({
      corpId: t(corp.id), corpName: t(corp.name) || t(corp.id) || '미지정', vcenterName: t(row.vcenter) || t(row.vcenterId),
      kind: k, name: mask(t(row.name)), hostName: mask(hn), serviceTag: t(row.serviceTag), model: t(row.model),
      inv, vc, via, sourceText: sourceTextOf(row, k, via), note: notes.join(' · '),
    });
  };
  if (kind === 'bm' || kind === 'both') for (const b of fleet?.bareMetal || []) add(b, 'bm');
  if (kind === 'vh' || kind === 'both') for (const h of fleet?.virtualizationHosts || []) add(h, 'vh');
  const unassignedLast = (c) => (c.corpId ? 0 : 1);
  const rank = (c) => (corpRank && corpRank.has(c.corpId) ? corpRank.get(c.corpId) : Number.MAX_SAFE_INTEGER);
  out.sort((a, b) => unassignedLast(a) - unassignedLast(b) || rank(a) - rank(b) || a.corpName.localeCompare(b.corpName) || a.corpId.localeCompare(b.corpId) || (a.kind === b.kind ? 0 : a.kind === 'bm' ? -1 : 1) || a.name.localeCompare(b.name));
  return out;
}

/**
 * 내보내기 모델(평범한 값). fields 는 resolveFields 를 거친 key 목록(카탈로그 순서).
 * @returns {{ summary:{cols:object[], rows:{corpId:string,corpName:string,kind:string,cells:any[]}[]},
 *             details:{key:string, sheet:string, file:string, cols:object[], rows:{corpId:string,si:number,cells:any[]}[]}[],
 *             corps:{id:string,name:string,count:number,bm:number,vh:number,cores:number|null,memGiB:number|null}[],
 *             totals:object, specs:object[]|null }}
 */
export async function buildHwModel(servers, fields, { admin = false, spec = false } = {}) {
  // 반증 F6: 서버 수천 대 · 사양서면 수백 ms 동기 — 시간 기준으로 양보한다(perf-db '요청 경로의 큰 집계는 조각 + 시간 기준 양보').
  const maybeYield = createYielder();
  const keys = fields.filter((k) => HW_FIELDS.has(k));
  const sumDefs = keys.map((k) => HW_FIELDS.get(k)).filter((f) => f.part === 'sum');
  const noteCol = { key: 'note', label: '비고', kind: 'text' };
  const summary = { cols: [...sumDefs.map((f) => ({ key: `${f.group.key}.sum.${f.key}`, label: f.label, kind: f.kind })), noteCol], rows: [] };
  for (const c of servers) {
    summary.rows.push({ corpId: c.corpId, corpName: c.corpName, kind: c.kind, cells: [...sumDefs.map((f) => clean(f.get(c))), c.note] });
    await maybeYield();
  }
  const details = [];
  for (const g of HW_GROUPS) {
    const cols = keys.map((k) => HW_FIELDS.get(k)).filter((f) => f.part === 'det' && f.group.key === g.key);
    if (!cols.length || !g.det) continue;
    const rows = [];
    for (let si = 0; si < servers.length; si++) {
      const c = servers[si];
      if (!c.inv) continue;
      for (const item of g.det.items(c.inv)) rows.push({ corpId: c.corpId, si, cells: [c.corpName, c.name, c.serviceTag, ...cols.map((f) => clean(f.get(item, c)))] });
      await maybeYield();
    }
    details.push({
      key: g.key, sheet: g.sheet, file: g.file,
      cols: [{ label: '법인', kind: 'text' }, { label: '서버', kind: 'text' }, { label: '서비스태그', kind: 'mono' }, ...cols.map((f) => ({ label: f.label, kind: f.kind }))],
      rows,
    });
  }
  // 법인 소계(띠) — 코어 · 메모리는 값이 있는 서버(인벤토리 또는 가상화 호스트의 vCenter 값)만 더하고, **몇 대를 더했는지**(coresN · memN)를
  //   함께 싣는다(반증 F5 — 부분 합을 전체 합처럼 보이지 않게). 하나도 없으면 null('—').
  const coreF = HW_FIELDS.get('cpu.sum.cores'); const memF = HW_FIELDS.get('mem.sum.gib');
  const byCorp = new Map();
  for (const c of servers) {
    const k = c.corpId || UNASSIGNED;
    if (!byCorp.has(k)) byCorp.set(k, { id: c.corpId, name: c.corpName, count: 0, bm: 0, vh: 0, cores: null, coresN: 0, memGiB: null, memN: 0 });
    const e = byCorp.get(k);
    e.count++; e[c.kind]++;
    const co = coreF.get(c); const me = memF.get(c);
    if (co != null) { e.cores = (e.cores || 0) + co; e.coresN++; }
    if (me != null) { e.memGiB = (e.memGiB || 0) + me; e.memN++; }
  }
  const corps = [...byCorp.values()];
  const totals = { servers: servers.length, bm: servers.filter((c) => c.kind === 'bm').length, vh: servers.filter((c) => c.kind === 'vh').length,
    noInventory: servers.filter((c) => !c.inv).length, ...corpTotals(corps) };
  let specs = null;
  if (spec) { specs = []; for (const c of servers) { specs.push(specOf(c, admin)); await maybeYield(); } }
  return { summary, details, corps, totals, specs };
}

/** 법인 소계들 → 코어 · 메모리 합과 더한 대수(render.js 가 부분집합에서도 같은 함수로 다시 센다). */
export function corpTotals(corps) {
  const out = { cores: null, coresN: 0, memGiB: null, memN: 0 };
  for (const e of corps) {
    if (e.cores != null) out.cores = (out.cores || 0) + e.cores;
    if (e.memGiB != null) out.memGiB = (out.memGiB || 0) + e.memGiB;
    out.coresN += e.coresN || 0; out.memN += e.memN || 0;
  }
  return out;
}

const clean = (v) => {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v);
  return s === '' ? null : s.slice(0, 2000);
};

/**
 * 서버 한 대의 사양서(시트 한 장) — 고른 값과 무관하게 **수집된 사양 전부**(사용자 승인 기본안 2 · 관리자 전용 값은 관리자만).
 * 구역마다 { title, kind:'kv'|'table', rows, cols? } — 장착 없음은 '없음', 그 컬렉션을 읽지 못했으면 '읽지 못함'.
 */
export function specOf(c, admin = false) {
  const head = { corpName: c.corpName, kind: c.kind === 'vh' ? '가상화 서버' : '물리서버(베어메탈)', name: c.name, model: [t(c.inv?.system?.manufacturer), t(c.inv?.system?.model) || c.model].filter(Boolean).join(' '),
    serviceTag: c.serviceTag, at: HW_FIELDS.get('id.sum.collectedAt').get(c) || '', note: c.note };
  const sections = [];
  const sumKv = (g, extra = []) => {
    const rows = (g.sum || []).filter((f) => !f.locked && fieldAllowed(f, admin)).map((f) => [f.label, clean(f.get(c))]);
    return [...extra, ...rows];
  };
  const coll = c.inv?.collections && typeof c.inv.collections === 'object' ? c.inv.collections : null;
  const COLL = { cpu: 'cpus', mem: 'memoryDimms', disk: 'disks', ctrl: 'storageControllers', gpu: 'gpus', psu: 'psus', pcie: 'pcie' };
  for (const g of HW_GROUPS) {
    if (g.key === 'id') {
      // v2.973 C1: vCenter 는 카탈로그 값(id.sum.vcenter — v2.968)이 이미 한 줄 넣는다. 여기 고정 줄에도 넣어 사양서에 두 번 나왔다.
      sections.push({ title: '기본 식별', kind: 'kv', rows: sumKv(g, [['법인', c.corpName], ['서버(등록 이름)', c.name], ['Hostname(OS)', c.hostName || null], ['서비스태그', c.serviceTag || null]]) });
      continue;
    }
    const sumRows = sumKv(g);
    let table = null;
    if (g.det && c.inv) {
      const cols = g.det.cols.filter((f) => fieldAllowed(f, admin));
      const items = g.det.items(c.inv);
      const failed = coll && COLL[g.key] && coll[COLL[g.key]] === 'failed';
      // 빈 표의 말: 'failed' 표식 → 읽지 못함 · 표식이 없는 컬렉션(NIC — 0개 서버는 없다)은 읽지 못함 · 펌웨어 · BIOS · iDRAC 관리는 수집기가 실패도 빈 값으로
      //   남겨 구분할 수 없다 → '보고된 값 없음' · 나머지(읽었고 0개) → 없음.
      const emptyWord = failed || g.key === 'nic' ? '읽지 못함' : ['fw', 'bios', 'mgmt'].includes(g.key) ? '보고된 값 없음' : '없음';
      if (cols.length) table = { cols: cols.map((f) => ({ label: f.label, kind: f.kind })), rows: items.map((x) => cols.map((f) => clean(f.get(x, c)))), empty: items.length ? '' : emptyWord };
    }
    if (!sumRows.length && !table) continue;
    sections.push({ title: g.name, kind: 'mixed', rows: sumRows, table });
  }
  return { head, sections, hasInv: !!c.inv };
}
