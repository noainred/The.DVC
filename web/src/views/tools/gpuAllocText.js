/**
 * gpuAllocText.js — GPU '할당 계층' 보기의 행 펼치기·정렬·글자(순수, v2.852 — 승인 시안 https://claude.ai/artifact/GQKnG775UijSAU7aUSFFeB '계층 표').
 *
 * 숫자와 판정(용량·할당·예비·슬롯·배치 정보 없음)은 서버 /tools/gpu/alloc(server/src/gpu/allocTree.js)이 만든다 — 여기서는
 * 계층을 화면 행으로 펼치고 글자·색만 고른다. 못 읽은 값은 '—'(단위를 붙이지 않는다).
 * 정렬은 **형제끼리만**(같은 부모 아래) — 표 전체를 한 줄로 정렬하면 계층이 깨진다. 값이 없는 형제는 항상 뒤.
 */
import { numOrNull } from '../../numOrNull.js';

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
export const SORT_KEYS = Object.freeze(['name', 'cap', 'alloc', 'spare', 'pct', 'off']);

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
  if (t.unplaced) notes.push(`미배치 VM ${t.unplaced}`);
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
  if (key === 'alloc') return numOrNull(t.allocGB ?? x.gb);
  if (key === 'spare') return numOrNull(t.spareGB);
  if (key === 'pct') return numOrNull(t.allocPct ?? (x.allocGB != null && x.capGB ? Math.round((x.allocGB / x.capGB) * 100) : null));
  if (key === 'off') return numOrNull(t.offGB);
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
export function flattenAlloc(tree, { open = new Set(), sort = null, query = '' } = {}) {
  const rows = [];
  const q = lc(query).trim();
  const isOpen = (id) => !!q || open.has(id);
  const agg = (id, depth, kind, name, sub, prof, t, hasKids) => {
    const n = totalsNote(t);
    rows.push({ id, depth, kind, name, sub, prof, cap: t.capGB, alloc: t.allocGB, spare: t.spareGB, pct: t.allocPct, off: t.offGB || null,
      vms: `${t.vmsOn} / ${t.vmsOff}`, note: n.note, tone: n.tone, hasKids, isOpen: hasKids && isOpen(id) });
  };
  const vmRow = (id, depth, v, { on = true, note = '', tone = '' } = {}) => rows.push({
    id, depth, kind: 'vm', name: v.name, sub: '', prof: v.mode === 'passthrough' ? '패스스루 1장' : v.profile || (v.passthroughDevices ? `패스스루 ${v.passthroughDevices}장` : ''),
    cap: null, alloc: on ? v.gb : null, spare: null, pct: null, off: on ? null : v.gb, vms: on ? '켜짐' : '꺼짐',
    note: note || (on && v.gb == null ? '프로파일 해석 불가 — 0 으로 넣지 않음' : on && v.gbEstimated ? 'GB 는 모델명 추정' : ''),
    tone: tone || (on && v.gb == null ? 'warn' : ''), hasKids: false, isOpen: false,
  });
  for (const vc of sortSiblings(tree?.vcenters || [], sort)) {
    const hostsOf = (cl) => cl.hosts.filter((h) => hostMatches(h, q));
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
              vms: g.mode === 'vsga' ? '' : `${g.vms.length} / 0`, note: tx.note + (g.capBasis === 'model' ? ' · GB 는 모델명 추정' : ''), tone: tx.tone,
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
