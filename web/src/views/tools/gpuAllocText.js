/**
 * gpuAllocText.js — GPU '할당 계층' 보기의 행 펼치기·정렬·글자(순수, v2.852 — 승인 시안 https://claude.ai/artifact/GQKnG775UijSAU7aUSFFeB '계층 표').
 *
 * 숫자와 판정(용량·할당·예비·슬롯·배치 정보 없음)은 서버 /tools/gpu-alloc(server/src/gpu/allocTree.js)이 만든다 — 여기서는
 * 계층을 화면 행으로 펼치고 글자·색만 고른다. 못 읽은 값은 '—'(단위를 붙이지 않는다).
 * 정렬은 **형제끼리만**(같은 부모 아래) — 표 전체를 한 줄로 정렬하면 계층이 깨진다. 값이 없는 형제는 항상 뒤.
 */
import { numOrNull } from '../../numOrNull.js';
import { dayStamp } from '../../dayStamp.js';

export const ALLOC_LEVELS = Object.freeze([
  { depth: 1, label: '법인' }, { depth: 2, label: '데이터센터' }, { depth: 3, label: '클러스터' },
  { depth: 4, label: '호스트' }, { depth: 5, label: 'GPU' }, { depth: 6, label: 'VM 까지 전부' },
]);
export const DEFAULT_LEVEL = 4;
export const KIND_TEXT = Object.freeze({ vc: '법인', dc: '데이터센터', cl: '클러스터', host: '호스트', gpu: 'GPU', pt: '패스스루', vsga: 'vSGA', unplaced: '미배치', off: '꺼짐', vm: 'VM' });
export const MODE_TEXT = Object.freeze({ vgpu: 'vGPU', passthrough: '패스스루', vsga: 'vSGA', mixed: 'vGPU+패스스루' });
export const UNPLACED_TEXT = Object.freeze({
  'no-placement': 'GPU 배치 정보 없음(수집기 갱신 전)',
  'not-listed': '켜져 있으나 어느 GPU 목록에도 없음',
});
export const SORT_KEYS = Object.freeze(['name', 'cap', 'alloc', 'spare', 'pct', 'off', 'cores', 'cpuPct', 'memGB', 'memPct']);

export function numText(v) {
  const n = numOrNull(v);
  return n == null ? '—' : n.toLocaleString('en-US', { maximumFractionDigits: 1 });
}
export const pctText = (v) => { const n = numOrNull(v); return n == null ? '—' : `${n}%`; };
export const dcLabel = (name) => (name ? name : '(데이터센터 모름)');
export const locationText = (vc) => [vc?.city, vc?.country].filter(Boolean).join(' · ');

/** 합계 → 비고·색. 넘침(예비 음수)은 '포화' 와 다르다 — 확인이 필요한 값이다. */
export function totalsNote(t) {
  if (!t) return { note: '', tone: '' };
  const notes = []; let tone = '';
  const spare = numOrNull(t.spareGB); const pct = numOrNull(t.allocPct);
  if (spare != null && spare < 0) { notes.push('할당이 용량을 넘음 — 확인 필요'); tone = 'warn'; } else if (pct != null && pct >= 90) { notes.push('포화'); tone = 'warn'; }
  if (t.allocUnknown) { notes.push(`할당 모르는 VM ${t.allocUnknown}`); tone = 'warn'; }
  if (t.capUnknown) { notes.push(`용량 모르는 GPU ${t.capUnknown}`); tone = 'warn'; }
  if (t.noPlacement) notes.push(`배치 정보 없는 GPU ${t.noPlacement}`);
  if (t.offUnknown) notes.push(`꺼진 VM 용량 모름 ${t.offUnknown}대`);   // v2.870 감사 A4-01: 꺼진 VM 합에서 빠진 수(엑셀 totalsCells 와 같은 말)
  if (t.unplaced) notes.push(`미배치 VM ${t.unplaced}`);
  if (t.hostUseUnknown && t.hosts > 1) notes.push(`CPU·메모리 사용률 ${t.hostUseUnknown}대 제외`);   // v2.868: 끊김·못 읽음 — 읽은 호스트 기준
  // v2.938 개선 5: 꺼진 VM 을 모두 켜면 예비보다 많이 필요(호스트 행만 — 서버 buildHostAlloc offOverGB · 엑셀 totalsCells 와 같은 말)
  if (numOrNull(t.offOverGB) > 0) { notes.push(`꺼진 VM 을 모두 켜면 ${numText(t.offOverGB)} GB 모자람`); if (!tone) tone = 'warn'; }
  if (!notes.length && t.vmsOn === 0 && t.gpus > 0) { notes.push('할당 VM 없음 — 전부 예비'); tone = 'free'; }
  if (!t.gpus && t.vsga) notes.push('vSGA 만 — 할당형 GPU 없음(합계 제외)');
  return { note: notes.join(' · '), tone };
}

/** GPU 한 장 → 프로파일·슬롯 글자와 비고(서버 gpuNoteText 와 같은 말). */
export function gpuTexts(g) {
  if (g.mode === 'vsga') return { prof: 'vSGA', note: 'vSGA — 할당형 아님(합계 제외)', tone: '' };
  if (!g.placement) return { prof: '배치 정보 없음', note: 'GPU 배치 정보 없음 — 할당·예비 모름', tone: '' };
  if (g.mode === 'passthrough') return g.vms.length ? { prof: '패스스루 · 1장 할당', note: '한 장 통째 할당', tone: '' } : { prof: '패스스루 · 미할당', note: '1장 예비 — VM 에 연결 가능', tone: 'free' };
  if (!g.vms.length) return { prof: '비어 있음', note: '모든 프로파일 가능', tone: 'free' };
  const s = g.slots || {};
  const prof = s.profile ? `${s.profile} · ${s.used}/${s.total ?? '?'} 슬롯` : '여러 프로파일';
  if (g.allocGB == null) return { prof, note: '프로파일 해석 불가 VM 포함 — 할당·예비 모름', tone: 'warn' };
  if (s.mixed) return { prof, note: '혼합 크기 — 슬롯 계산 안 함', tone: '' };
  if (s.free > 0) return { prof, note: `같은 프로파일 ${s.free}대 더 가능`, tone: 'free' };
  if (s.free === 0) return { prof, note: '슬롯 모두 사용', tone: '' };
  return { prof, note: '', tone: '' };
}

const keyVal = (x, key) => {
  if (key === 'name') return x.name || '';
  const t = x.totals || x;
  if (key === 'cap') return numOrNull(t.capGB);
  // v2.871(버그 점검): VM 행은 켜진 VM 만 할당 칸에, 꺼진 VM 만 '꺼진 VM GB' 칸에 값이 보인다 — 정렬도 보이는 값으로(예전에는 꺼진 VM 을
  //   보이지 않는 할당 값으로 정렬하고, 꺼진 VM GB 정렬은 값이 늘 비어 움직이지 않았다).
  if (key === 'alloc') return numOrNull(x.totals ? t.allocGB : x.powerState && x.powerState !== 'POWERED_ON' ? null : (t.allocGB ?? x.gb));
  if (key === 'spare') return numOrNull(t.spareGB);
  if (key === 'pct') return numOrNull(t.allocPct ?? (x.allocGB != null && x.capGB ? Math.round((x.allocGB / x.capGB) * 100) : null));
  if (key === 'off') return numOrNull(x.totals ? t.offGB : x.powerState && x.powerState !== 'POWERED_ON' ? x.gb : null);
  // v2.868: CPU/메모리 — 법인~호스트는 합계, VM 은 그 VM(res)
  if (key === 'cores') return numOrNull(x.totals ? t.hostCores : x.res?.vcpu);
  if (key === 'cpuPct') return numOrNull(x.totals ? t.hostCpuPct : x.res?.cpuPct);
  if (key === 'memGB') return numOrNull(x.totals ? t.hostMemGB : x.res?.memGB);
  if (key === 'memPct') return numOrNull(x.totals ? t.hostMemPct : x.res?.memPct);
  return null;
};
/** 형제 정렬 — 값이 없으면 방향과 무관하게 뒤. sort 가 없으면 원래 순서(서버가 이름순). */
export function sortSiblings(list, sort) {
  if (!sort || !SORT_KEYS.includes(sort.key)) return list;
  const dir = sort.dir === 'desc' ? -1 : 1;
  return list.slice().sort((a, b) => {
    const va = keyVal(a, sort.key); const vb = keyVal(b, sort.key);
    if (va == null && vb == null) return 0;
    if (va == null) return 1;
    if (vb == null) return -1;
    if (typeof va === 'string') return va.localeCompare(vb) * dir;
    return (va - vb) * dir;
  });
}

const lc = (s) => String(s || '').toLowerCase();
/** v2.868: CPU/메모리 칸 — 법인~호스트 행은 호스트 합(코어·GB, 사용률은 MHz·MB 가중), VM 행은 그 VM. GPU·묶음 행은 빈 칸. */
const resCells = (cores, cpuPct, memGB, memPct) => ({ cores: cores ?? null, cpuPct: cpuPct ?? null, memGB: memGB ?? null, memPct: memPct ?? null });

/** v2.853: 법인 칩 선택(빈 Set·null = 전체)으로 vCenter 를 고른다. */
export function pickVcenters(tree, vcSel) {
  const all = tree?.vcenters || [];
  return vcSel && vcSel.size ? all.filter((vc) => vcSel.has(vc.id)) : all;
}

const TOT_KEYS = ['hosts', 'gpus', 'vsga', 'capGB', 'capUnknown', 'allocGB', 'allocUnknown', 'offGB', 'offUnknown', 'vmsOn', 'vmsOff', 'unplaced', 'freeGpus', 'noPlacement'];
const r1 = (n) => Math.round(n * 10) / 10;
/**
 * v2.853: 고른 법인들의 합계 — 서버 합계(allocTree.js finishTotals)와 같은 규칙: 용량·할당 중 모르는 것이 섞이면 예비·할당률은 null
 * (부분 합을 예비로 보이지 않는다). 하나도 안 고르면 서버 전체 합계를 그대로 쓴다.
 */
export function sumTotals(tree, vcSel) {
  if (!vcSel || !vcSel.size) return tree?.totals || null;
  const t = Object.fromEntries(TOT_KEYS.map((k) => [k, 0]));
  for (const vc of pickVcenters(tree, vcSel)) for (const k of TOT_KEYS) t[k] += numOrNull(vc.totals?.[k]) || 0;
  const known = t.capUnknown === 0 && t.allocUnknown === 0;
  return { ...t, capGB: r1(t.capGB), allocGB: r1(t.allocGB), offGB: r1(t.offGB),
    spareGB: known ? r1(t.capGB - t.allocGB) : null, allocPct: known && t.capGB > 0 ? Math.round((t.allocGB / t.capGB) * 100) : null };
}

/**
 * v2.853: 법인 칩(사용자 요청 '바로가기 칩처럼 법인을 고르게') — 조회 범위의 vCenter 전부(GPU 호스트가 없으면 0 · 흐리게).
 * 상태 점은 호출부가 vcCardText.vcQuickDot 으로 칠한다(vCenter 화면과 같은 판정). 순서는 vCenter id 순.
 * @param {object[]} vcs /vcenters 응답(없거나 못 읽으면 계층의 법인만)
 */
/**
 * v2.871 감사 A4-02: 계층에 노드가 없는 법인이 'GPU 호스트 0대' 인지 '모름' 인지 — 서버 allocTree.js corpUnknownOf 와 같은 판정
 *   (server/test/gpuAllocRoster2871 가 같은 입력으로 대조). 인벤토리 없이 status 만 있는 vCenter(첫 수집 전 · 보존 창을 넘긴 장애 ·
 *   수집 꺼짐 · 점검 중)와 상한으로 잘린 계층은 모른다. stale(직전 인벤토리 보존)이면 노드가 없는 것은 실제 0대.
 * @returns {''|'pending'|'unreachable'|'disabled'|'maintenance'|'truncated'}
 */
export const CORP_INV_EMPTY = Object.freeze(['pending', 'unreachable', 'disabled', 'maintenance']);
export function corpUnknownOf(meta, hasNode, truncated = 0) {
  if (hasNode) return '';
  const st = typeof meta?.status === 'string' ? meta.status : '';
  if (!meta?.stale && CORP_INV_EMPTY.includes(st)) return st;
  return truncated > 0 ? 'truncated' : '';
}
export const CORP_UNKNOWN_TEXT = Object.freeze({
  pending: '수집 전', unreachable: '접속 불가', disabled: '수집 꺼짐', maintenance: '점검 중', truncated: '상한으로 잘림',
});

/** 칩 글자(제목 · 개수) — 모르면 0 이 아니라 '—'(v2.871 A4-02). */
export function corpChipText(c) {
  if (c?.unknown) return { count: '—', title: `GPU 호스트 수 모름(${CORP_UNKNOWN_TEXT[c.unknown] || '모름'} — 0 이 아님)` };
  return { count: String(c?.hosts ?? 0), title: `GPU 호스트 ${c?.hosts ?? 0}대 · GPU ${c?.gpus ?? 0}장` };
}

export function corpChips(tree, vcs) {
  const byId = new Map((tree?.vcenters || []).map((vc) => [vc.id, vc]));
  const list = Array.isArray(vcs) && vcs.length ? vcs.map((v) => ({ id: String(v.id), name: v.name || String(v.id), site: v })) : [...byId.values()].map((vc) => ({ id: vc.id, name: vc.name, site: null }));
  for (const vc of byId.values()) if (!list.some((x) => x.id === vc.id)) list.push({ id: vc.id, name: vc.name, site: null });
  const truncated = Number(tree?.truncated) || 0;
  return list.map((x) => {
    const node = byId.get(x.id);
    const unknown = corpUnknownOf(x.site, !!node, truncated);
    // 모르면 hosts·gpus 는 null(0 이 아니다 — 소비처는 corpChipText 로 글자를 만든다)
    return { ...x, unknown, hosts: unknown ? null : node?.totals?.hosts || 0, gpus: unknown ? null : node?.totals?.gpus || 0 };
  }).sort((a, b) => a.id.localeCompare(b.id));
}
/** 찾기 — 호스트 이름 또는 그 호스트의 VM 이름이 맞으면 그 호스트를 남긴다. */
function hostMatches(h, q) {
  if (!q) return true;
  if (lc(h.name).includes(q)) return true;
  return h.gpus.some((g) => g.vms.some((v) => lc(v.name).includes(q))) || h.unplaced.some((v) => lc(v.name).includes(q)) || h.off.some((v) => lc(v.name).includes(q));
}

/**
 * 계층 → 화면 행. open = 펼친 노드 id 집합(찾기 중이면 맞는 경로를 모두 펼친다).
 * @returns {object[]} { id, depth, kind, name, sub, prof, cap, alloc, spare, pct, off, vms, note, tone, hasKids, isOpen }
 */
export function flattenAlloc(tree, { open = new Set(), sort = null, query = '', vcSel = null } = {}) {
  const rows = [];
  const q = lc(query).trim();
  const isOpen = (id) => !!q || open.has(id);
  const agg = (id, depth, kind, name, sub, prof, t, hasKids) => {
    const n = totalsNote(t);
    rows.push({ id, depth, kind, name, sub, prof, cap: t.capGB, alloc: t.allocGB, spare: t.spareGB, pct: t.allocPct, off: t.offGB || null,
      vms: `${t.vmsOn} / ${t.vmsOff}`, note: n.note, tone: n.tone, hasKids, isOpen: hasKids && isOpen(id),
      ...resCells(t.hostCores, t.hostCpuPct, t.hostMemGB, t.hostMemPct), gvmVcpu: t.vmVcpu ?? null, gvmMemGB: t.vmMemGB ?? null });
  };
  const vmRow = (id, depth, v, { on = true, note = '', tone = '' } = {}) => rows.push({
    id, depth, kind: 'vm', name: v.name, sub: '', prof: v.mode === 'passthrough' ? '패스스루 1장' : v.profile || (v.passthroughDevices ? `패스스루 ${v.passthroughDevices}장` : ''),
    cap: null, alloc: on ? v.gb : null, spare: null, pct: null, off: on ? null : v.gb, vms: on ? '켜짐' : '꺼짐',
    note: note || (on && v.gb == null ? '프로파일 해석 불가 — 0 으로 넣지 않음' : on && v.gbEstimated ? 'GB 는 모델명 추정' : ''),
    tone: tone || (on && v.gb == null ? 'warn' : ''), hasKids: false, isOpen: false,
    ...resCells(v.res?.vcpu, v.res?.cpuPct, v.res?.memGB, v.res?.memPct), gvmVcpu: null, gvmMemGB: null,
  });
  for (const vc of sortSiblings(pickVcenters(tree, vcSel), sort)) {
    // v2.853: 찾기 글자가 법인(vCenter) id·이름에 맞으면 그 법인을 통째로 보인다(바로가기 찾기 상자와 같은 뜻).
    const vcHit = !!q && (lc(vc.id).includes(q) || lc(vc.name).includes(q));
    const hostsOf = (cl) => cl.hosts.filter((h) => vcHit || hostMatches(h, q));
    const dcs = vc.datacenters.filter((dc) => dc.clusters.some((cl) => hostsOf(cl).length));
    if (!dcs.length) continue;
    const vid = `v:${vc.id}`;
    agg(vid, 0, 'vc', vc.name, locationText(vc), `GPU ${vc.totals.gpus}장 · 호스트 ${vc.totals.hosts}대`, vc.totals, true);
    if (!isOpen(vid)) continue;
    for (const dc of sortSiblings(dcs, sort)) {
      const did = `d:${vc.id}|${dc.name}`;
      agg(did, 1, 'dc', dcLabel(dc.name), '', `GPU ${dc.totals.gpus}장 · 호스트 ${dc.totals.hosts}대`, dc.totals, true);
      if (!isOpen(did)) continue;
      for (const cl of sortSiblings(dc.clusters.filter((c) => hostsOf(c).length), sort)) {
        const cid = `c:${vc.id}|${dc.name}|${cl.key}`;
        agg(cid, 2, 'cl', cl.name, '', `GPU ${cl.totals.gpus}장 · 호스트 ${cl.totals.hosts}대`, cl.totals, true);
        if (!isOpen(cid)) continue;
        for (const h of sortSiblings(hostsOf(cl), sort)) {
          const hid = `h:${h.id || h.name}`;
          const modes = [...new Set(h.gpus.map((g) => MODE_TEXT[g.mode] || g.mode))].join('·');
          agg(hid, 3, 'host', h.name, '', `${h.models.join(', ')} ×${h.gpus.length} · ${modes}`, h.totals, true);
          if (!isOpen(hid)) continue;
          for (const g of sortSiblings(h.gpus, sort)) {
            const gid = `g:${h.id || h.name}|${g.idx}`;
            const tx = gpuTexts(g);
            const pct = g.allocGB != null && g.capGB ? Math.round((g.allocGB / g.capGB) * 100) : null;
            rows.push({ id: gid, depth: 4, kind: g.mode === 'passthrough' ? 'pt' : g.mode === 'vsga' ? 'vsga' : 'gpu', name: `GPU #${g.idx} · ${g.model}`, sub: '',
              prof: tx.prof, cap: g.capGB, alloc: g.allocGB, spare: g.spareGB, pct, off: null,
              vms: g.mode === 'vsga' ? '' : !g.placement ? '—' : `${g.vms.length} / 0`, note: tx.note + (g.capBasis === 'model' ? ' · GB 는 모델명 추정' : ''), tone: tx.tone,
              hasKids: g.vms.length > 0, isOpen: g.vms.length > 0 && isOpen(gid) });
            if (g.vms.length && isOpen(gid)) for (const v of sortSiblings(g.vms, sort)) vmRow(`m:${gid}|${v.id}`, 5, v);
          }
          if (h.unplaced.length) {
            const uid = `u:${h.id || h.name}`;
            rows.push({ id: uid, depth: 4, kind: 'unplaced', name: '배치 안 된 켜진 VM', sub: '', prof: '', cap: null, alloc: null, spare: null, pct: null, off: null,
              vms: `${h.unplaced.length} / 0`, note: '할당은 호스트 합계에 들어감 — 어느 GPU 인지 모름', tone: '', hasKids: true, isOpen: isOpen(uid) });
            if (isOpen(uid)) for (const v of sortSiblings(h.unplaced, sort)) vmRow(`m:${uid}|${v.id}`, 5, v, { note: UNPLACED_TEXT[v.reason] || '' });
          }
          if (h.off.length) {
            const oid = `o:${h.id || h.name}`;
            rows.push({ id: oid, depth: 4, kind: 'off', name: '꺼진 VM', sub: '', prof: '', cap: null, alloc: null, spare: null, pct: null, off: h.totals.offGB || null,
              vms: `0 / ${h.off.length}`, note: 'GPU 에 올라가 있지 않음 — 할당에서 제외', tone: '', hasKids: true, isOpen: isOpen(oid) });
            if (isOpen(oid)) for (const v of sortSiblings(h.off, sort)) vmRow(`m:${oid}|${v.id}`, 5, v, { on: false, note: `켜면 ${v.gb == null ? '?' : numText(v.gb)} GB 필요` });
          }
        }
      }
    }
  }
  return rows;
}

/** 펼침 단계 → 펼칠 노드 id(그 단계 위의 노드 전부). depth 6 = VM 까지 전부. */
export function openForLevel(tree, level) {
  const open = new Set();
  for (const vc of tree?.vcenters || []) {
    if (level > 1) open.add(`v:${vc.id}`);
    for (const dc of vc.datacenters) {
      if (level > 2) open.add(`d:${vc.id}|${dc.name}`);
      for (const cl of dc.clusters) {
        if (level > 3) open.add(`c:${vc.id}|${dc.name}|${cl.key}`);
        for (const h of cl.hosts) {
          const hk = h.id || h.name;
          if (level > 4) open.add(`h:${hk}`);
          if (level > 5) { for (const g of h.gpus) open.add(`g:${hk}|${g.idx}`); open.add(`u:${hk}`); open.add(`o:${hk}`); }
        }
      }
    }
  }
  return open;
}

/* ── v2.855 내보내기 창(승인 시안 '계층 표 엑셀 내보내기') ──────────────────── */
export const EXPORT_DEPTHS = Object.freeze([
  { key: 'host', label: '호스트까지' }, { key: 'gpu', label: 'GPU 까지' }, { key: 'vm', label: 'VM 까지(전부)' },
]);
export const EXPORT_SHEETS = Object.freeze([
  { key: 'tree', label: '계층 표', sub: '읽기용 — 들여쓰기 · 행 그룹 · 단계 색' },
  { key: 'flat', label: '평면 표', sub: '필터·피벗용 — GPU·VM 한 줄마다 계층 열을 모두 채움' },
  { key: 'info', label: '안내', sub: '용어 · 기준 · 빈 칸의 뜻' },
  // v2.869(승인 시안 docs/design/gpu-alloc-corp-sheets): 기본 켬 — 끄면 지금까지와 같은 3시트 파일
  { key: 'corp', label: '법인별 시트', sub: '법인(vCenter)마다 계층 표를 시트 한 장으로 + 목차 시트' },
]);
/**
 * v2.869: 내보내기 창의 법인 선택 → 쿼리의 vcSel. 창은 '모든 법인' 으로 시작한다(sel = null — 사용자 지시 "기본적으로 모든 vcenter 를 선택").
 * 모든 칩을 골랐으면 null(= 범위 전부 — 서버가 조회 범위로 자른다), 아니면 고른 집합. 빈 집합은 '고른 법인 없음' 이라 내려받기를 잠근다(호출 쪽).
 */
export function exportPick(sel, chips) {
  if (sel == null) return null;
  const ids = (chips || []).map((c) => c.id);
  if (ids.length && ids.every((id) => sel.has(id))) return null;
  return sel;
}
/** v2.869: 창의 파일 이름 — 서버 export-meta 가 준 이름(법인별 시트가 들어가면 _percorp 판)을 고른다. 지어내지 않는다. */
export const exportFileName = (meta, depth, percorp) => (percorp ? meta?.fileNamesPercorp?.[depth] : meta?.fileNames?.[depth]) || '';
/**
 * 내보내기·창 미리보기의 쿼리 — 화면 범위(scope · 고른 법인)를 그대로 싣는다. 단계는 VM 까지(기본)면 싣지 않고,
 * 시트는 넷 다(기본 — v2.869 법인별 시트 포함)면 싣지 않는다(서버 allocExportOpts 의 기본과 같다).
 * @returns {string} '' 또는 '?…'
 */
export function allocExportQuery({ scope = '', vcSel = null, depth = 'vm', sheets = null } = {}) {
  const p = new URLSearchParams();
  if (scope) p.set('vcenterId', scope);
  if (vcSel && vcSel.size) p.set('vcenterIds', [...vcSel].join(','));
  if (depth && depth !== 'vm') p.set('depth', depth);
  if (sheets && sheets.length && sheets.length < EXPORT_SHEETS.length) p.set('sheets', EXPORT_SHEETS.map((s) => s.key).filter((k) => sheets.includes(k)).join(','));
  const q = p.toString();
  return q ? `?${q}` : '';
}

/* ── v2.938 개선 4 · 배치 추천('어디에 놓을 수 있나') ───────────────────────────────────────────────── */
/** 프로파일 이름 → 할당 GB(서버 gpu/vgpuProfile.js vgpuProfileGB 와 같은 규칙 — 시험이 같은 입력으로 대조). 못 읽으면 null. */
export function profileGB(profile) {
  const s = String(profile ?? '').trim();
  if (!s || s.length > 128) return null;
  const m = /-(\d{1,3})([a-z]{1,2})$/i.exec(s);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? (n === 0 ? 0.5 : n) : null;
}
/** 프로파일의 GPU 계열(nvidia_l4-12q → l4 · grid_a100-3-40c → a100)과 MIG 여부(가운데 슬라이스 숫자가 있으면). 형식 밖이면 null. */
export function profileFamily(profile) {
  const m = /^[a-z0-9]+_([a-z0-9]+)-(?:(\d{1,2})-)?\d{1,3}[a-z]{1,2}$/i.exec(String(profile ?? '').trim());
  return m ? { family: m[1].toLowerCase(), mig: m[2] != null } : null;
}
/** GPU 모델 이름이 그 계열인가 — 낱말 단위(L4 가 L40S 에 맞지 않게). 'NVIDIA A100 80GB PCIe' · 'GA102GL [A40]' 모두 낱말로 자른다. */
export const modelHasFamily = (model, family) => !!family && String(model || '').toLowerCase().split(/[^a-z0-9]+/).includes(family);
/** 화면 고르기 목록 — 계층에서 쓰이는 vGPU 프로파일(켜진·꺼진 VM 모두)과 그 VM 수, 많이 쓰는 순. */
export function profileOptions(tree, vcSel = null) {
  const m = new Map();
  for (const vc of pickVcenters(tree, vcSel)) for (const dc of vc.datacenters) for (const cl of dc.clusters) for (const h of cl.hosts) {
    for (const v of [...h.gpus.flatMap((g) => g.vms), ...h.unplaced, ...h.off]) if (v.profile && v.vgpuDevices > 0) m.set(v.profile, (m.get(v.profile) || 0) + 1);
  }
  return [...m.entries()].map(([profile, vms]) => ({ profile, vms })).sort((a, b) => b.vms - a.vms || a.profile.localeCompare(b.profile));
}
/**
 * 그 프로파일 VM 을 하나 더 놓을 수 있는 GPU(순수). 판정은 서버가 계산한 슬롯(gpu.slots)과 용량만 쓴다:
 *   · 같은 프로파일이 올라간 vGPU GPU 의 남은 슬롯(slots.free > 0) — 먼저(빈 GPU 를 아껴 두는 쪽 · 남은 슬롯이 적은 것부터)
 *   · 비어 있는 vGPU GPU 중 모델이 프로파일 계열과 같고 용량 ≥ 프로파일 GB — 용량 ÷ 프로파일 GB 장
 *   뺀다: 끊긴 호스트 · 배치 정보 없는 GPU(모름) · 혼합 크기 · 다른 프로파일 GPU · 패스스루 · vSGA · 용량 모름.
 *   MIG 프로파일은 빈 GPU 의 장 수가 MIG 구성에 달려 있어 '추정' 으로 표시한다.
 * @returns {{ per: number|null, mig: boolean, family: string|null, rows: object[], same: number, empty: number, skipped: object }}
 */
export function placementCandidates(tree, profile, vcSel = null) {
  const per = profileGB(profile);
  const fam = profileFamily(profile);
  const out = { per, mig: !!fam?.mig, family: fam?.family || null, rows: [], same: 0, empty: 0, skipped: { down: 0, noPlacement: 0, mixed: 0, otherProfile: 0, capUnknown: 0, small: 0 } };
  if (per == null || !fam) return out;
  for (const vc of pickVcenters(tree, vcSel)) for (const dc of vc.datacenters) for (const cl of dc.clusters) for (const h of cl.hosts) {
    const down = h.connectionState === 'DISCONNECTED' || h.connectionState === 'NOT_RESPONDING';
    for (const g of h.gpus) {
      if (g.mode !== 'vgpu') continue;
      const base = { id: `${h.id || h.name}|${g.idx}`, vc: vc.id, vcName: vc.name, cluster: cl.name, host: h.name, gpu: g.idx, model: g.model };
      if (g.vms.length && g.slots?.profile === profile) {
        if (!(g.slots.free > 0)) continue;
        if (down) { out.skipped.down += 1; continue; }
        out.rows.push({ ...base, kind: 'same', fit: g.slots.free, now: `${profile} · ${g.slots.used}/${g.slots.total} 슬롯`, note: '같은 프로파일 GPU 의 남은 슬롯' });
        out.same += g.slots.free;
        continue;
      }
      if (!modelHasFamily(g.model, fam.family)) continue;
      if (down) { out.skipped.down += 1; continue; }
      if (!g.placement) { out.skipped.noPlacement += 1; continue; }
      if (g.vms.length) { if (g.slots?.mixed) out.skipped.mixed += 1; else out.skipped.otherProfile += 1; continue; }
      if (g.capGB == null) { out.skipped.capUnknown += 1; continue; }
      if (g.capGB < per) { out.skipped.small += 1; continue; }
      const fit = Math.floor(g.capGB / per);
      out.rows.push({ ...base, kind: 'empty', fit, now: '비어 있음', note: fam.mig ? `빈 GPU — ${fit}장은 용량 기준 추정(MIG 구성에 따라 다름)` : '빈 GPU — 이 프로파일을 올리면 다른 프로파일은 못 올림' });
      out.empty += fit;
    }
  }
  out.rows.sort((a, b) => (a.kind === b.kind ? (a.kind === 'same' ? a.fit - b.fit : b.fit - a.fit) || a.host.localeCompare(b.host) : a.kind === 'same' ? -1 : 1));
  return out;
}

/* ── v2.938 개선 10 · 새로 고침 뒤 펼침 ─────────────────────────────────────────────────────────────── */
/**
 * 새로 고침으로 새로 생긴 노드(법인 · 데이터센터 · 클러스터 · 호스트 · GPU)를 지금 펼침 단계대로 펼친다(순수). 이미 있던 노드는 사용자가
 * 접고 편 그대로 둔다. 예전에는 펼침 목록을 그대로 두어 새로 생긴 법인·호스트가 접힌 채로 보였다.
 */
export function openAfterRefresh(open, oldTree, newTree, level) {
  if (!open) return open;
  const known = openForLevel(oldTree, 7);
  const next = new Set(open);
  for (const id of openForLevel(newTree, level)) if (!known.has(id)) next.add(id);
  return next;
}

/* ── v2.938 개선 2 · 수집 점검 글자 ─────────────────────────────────────────────────────────────────── */
/** 판정 → 글자·색(서버 allocDiag verdicts). 관측할 대상이 없으면 '판단 불가' — 없다고 단정하지 않는다. */
export function diagVerdicts(d) {
  if (!d || !d.totals) return [];
  const t = d.totals; const v = d.verdicts || {};
  const tone = (x) => (x === 'yes' ? 'ok' : x === 'unknown' ? '' : 'warn');
  return [
    { key: 'placement', title: 'GPU 별 VM 배치 정보', tone: tone(v.placement),
      text: v.placement === 'unknown' ? '판단 불가 — vGPU GPU 가 없습니다'
        : v.placement === 'yes' ? `읽힘 — vGPU GPU ${t.vgpuGpus}장 모두`
          : `vGPU GPU ${t.vgpuGpus}장 중 ${t.vgpuNoPlacement}장은 배치 정보가 없습니다 — 그 법인의 수집 서버(엣지)가 구버전일 수 있습니다(업그레이드하면 채워짐)` },
    { key: 'offListed', title: '꺼진 VM 이 GPU 별 목록에 오는가', tone: '',
      text: v.offListed === 'yes' ? `온다 — 꺼진 vGPU VM ${t.offVgpuVms}대 중 ${t.offListed}대가 목록에 있음(할당에는 넣지 않음 — 결과는 같습니다)`
        : v.offListed === 'no' ? `오지 않는다 — 꺼진 vGPU VM ${t.offVgpuVms}대 모두 목록에 없음`
          : '판단 불가 — 배치 정보가 있는 호스트에 꺼진 vGPU VM 이 없습니다' },
    { key: 'ptPciRead', title: '켜진 패스스루 VM 의 장치 주소', tone: tone(v.ptPciRead),
      text: v.ptPciRead === 'unknown' ? '판단 불가 — 켜진 패스스루 VM 이 없습니다'
        : v.ptPciRead === 'yes' ? `읽힘 — ${t.ptOnVms}대 모두(GPU 와 NIC · HBA 를 주소로 가릅니다)`
          : `${t.ptOnVms}대 중 ${t.ptOnPciRead}대만 읽힘 — 나머지는 장치를 모두 GPU 로 셉니다(구버전 수집기 또는 주소를 주지 않는 vCenter)` },
    { key: 'profiles', title: 'vGPU 프로파일 이름 → GB', tone: tone(v.profiles),
      text: v.profiles === 'unknown' ? '판단 불가 — vGPU GPU 가 없습니다'
        : v.profiles === 'yes' ? '모두 읽힘'
          : `못 읽은 VM ${t.unparsedVms}대 — 아래 이름이 규칙(…-<GB><문자>)과 다릅니다. 그 VM 의 할당은 ‘모름’ 으로 셉니다` },
    { key: 'nonGpu', title: 'GPU 가 아닌 패스스루(NIC · HBA)', tone: '',
      text: t.nonGpuPtVms ? `${t.nonGpuPtVms}대가 가짐 — ${t.nonGpuOnlyVms}대는 GPU 장치가 없어 GPU VM 에서 뺐습니다` : '없음(또는 주소를 몰라 가르지 못함)' },
    { key: 'cap', title: 'GPU 용량', tone: t.capUnknown ? 'warn' : '',
      text: `${t.capUnknown ? `모름 ${t.capUnknown}장 · ` : ''}${t.capModel ? `모델명 추정 ${t.capModel}장(패스스루 — PCI 정보에 메모리 없음)` : '모델명 추정 없음'}` },
  ];
}

/* ── v2.938 개선 7 · 추이 ───────────────────────────────────────────────────────────────────────────── */
/** 추이 조회 쿼리 — 화면 범위(scope = 법인 하나로 연 화면 · 고른 법인 칩)를 vcenterIds 로. 서버가 조회 범위와 먼저 교집합을 낸다. */
export function historyQuery({ days = 90, vcSel = null, scope = '' } = {}) {
  const p = new URLSearchParams();
  p.set('days', String(days));
  const ids = scope ? [scope] : vcSel && vcSel.size ? [...vcSel] : [];
  if (ids.length) p.set('vcenterIds', ids.join(','));
  return `?${p.toString()}`;
}
const signed = (v, unit) => (v == null ? '—' : `${v > 0 ? '+' : ''}${numText(v)} ${unit}`);
/** 추세 → 글자. 소진 예상이 없으면 '—' 와 그 이유(점 부족 · 늘지 않음 · 들쭉날쭉) — '소진 안 함' 으로 단정하지 않는다. */
export function trendText(t, now = Date.now()) {
  if (!t) return { change: '—', perDay: '—', left: '—', why: '이력 없음' };
  if (t.over) return { change: signed(t.change30, 'GB'), perDay: t.gbPerDay == null ? '—' : `${signed(Math.round(t.gbPerDay * 10) / 10, 'GB')}/일`, left: '이미 넘음', why: '마지막 날 할당이 용량보다 큽니다 — 확인이 필요합니다' };
  const why = t.daysLeft != null ? '최근 30일 할당 증가 기울기로 낸 추정' : t.points < 7 ? `최근 30일 점이 ${t.points}개 — 7개 이상이어야 냅니다`
    : !(t.gbPerDay > 0) ? '최근 30일 할당이 늘지 않았습니다' : '증가가 들쭉날쭉해(결정계수 0.3 미만) 내지 않습니다';
  const left = t.daysLeft == null ? '—' : t.daysLeft === 0 ? '지금(예비 없음)'
    : `${t.daysLeft}일 뒤 (${dayStamp(now + t.daysLeft * 86_400_000)})`;   // 포탈 날짜(UTC 자르기 금지 — dayStamp 스윕)
  return { change: signed(t.change30, 'GB'), perDay: t.gbPerDay == null ? '—' : `${signed(Math.round(t.gbPerDay * 10) / 10, 'GB')}/일`, left, why };
}
