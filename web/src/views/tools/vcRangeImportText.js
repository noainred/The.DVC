/**
 * vcRangeImportText.js — vCenter별 스캔 대역 편집기의 '/24 대역 가져오기' 판정·문구(순수, v2.690).
 *
 * 서버(GET /admin/ipam/vc-ranges/suggest)는 /24 목록만 준다. 여기서는 **저장하지 않은 입력**까지 보고 각 /24 가
 *  · new     — 새 대역(텍스트 박스에 넣는다)
 *  · covered — 이 텍스트 박스에 이미 전부 있음
 *  · partial — 이 텍스트 박스의 다른 줄과 일부 겹침
 *  · other   — 다른 vCenter 에 저장된 대역과 겹침(같은 대역을 두 vCenter 가 주기 스캔하면 결과가 섞인다)
 * 인지 판정한다. new 가 아닌 것은 텍스트 박스에 넣지 않고 아래 '중복 대역' 칸으로 보낸다 — 사용자가 고쳐서 '반영' 한다.
 * 대역 문법·포함 판정은 ipScanDcText.js(rangesOf·coverageOf) → ipmsRangeText.js 한 벌을 쓴다(사본 금지).
 */
import { coverageOf, rangesOf } from './ipScanDcText.js';
import { checkRangeSpec } from './ipmsRangeText.js';

export const DUP_KINDS = ['covered', 'partial', 'other'];

const lines = (text) => String(text ?? '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);

/**
 * 다른 vCenter 에 저장된 대역 → [{ name, ranges:[[lo,hi]] }]. 지금 고른 vCenter 는 뺀다(그 vCenter 의 저장분은 텍스트 박스가 대신한다).
 * @param {Array<{vcenterId, vcenterName?, ranges?}>} saved  GET /tools/ipam/vc-ranges 의 ranges
 */
export function otherSavedRanges(saved, vc) {
  const out = [];
  for (const e of Array.isArray(saved) ? saved : []) {
    if (!e || e.vcenterId === vc) continue;
    const r = rangesOf(Array.isArray(e.ranges) ? e.ranges : []);
    if (r.length) out.push({ name: e.vcenterName || e.vcenterId, ranges: r });
  }
  return out;
}

/** 한 대역 줄의 판정 — { kind, with?: string[] }. 읽을 수 없는 줄은 kind 'invalid'. */
export function classifyLine(spec, { text = '', others = [] } = {}) {
  const s = String(spec ?? '').trim();
  if (!checkRangeSpec(s).ok) return { kind: 'invalid' };
  const mine = rangesOf(lines(text));
  const cov = coverageOf(s, mine);
  if (cov === 'full') return { kind: 'covered' };
  const hit = others.filter((o) => coverageOf(s, o.ranges) !== '').map((o) => o.name);
  if (hit.length) return { kind: 'other', with: hit };
  if (cov === 'partial') return { kind: 'partial' };
  return { kind: 'new' };
}

/**
 * 서버 /24 목록 → 확인 창의 행. 같은 창 안에서 앞 줄과 겹치는 것도 '이미 입력됨' 이 되도록 순서대로 누적해 판정한다.
 * @returns {Array<{cidr, kind, with?:string[], ...원본}>}
 */
export function classifySubnets(subnets, { text = '', saved = [], vc = '' } = {}) {
  const others = otherSavedRanges(saved, vc);
  let acc = lines(text).join('\n');
  const out = [];
  for (const s of Array.isArray(subnets) ? subnets : []) {
    if (!s?.cidr) continue;
    const c = classifyLine(s.cidr, { text: acc, others });
    out.push({ ...s, ...c });
    if (c.kind === 'new') acc = acc ? `${acc}\n${s.cidr}` : s.cidr;
  }
  return out;
}

export function countKinds(rows) {
  const n = { new: 0, covered: 0, partial: 0, other: 0, invalid: 0 };
  for (const r of rows || []) if (r && n[r.kind] != null) n[r.kind] += 1;
  return n;
}

/**
 * 확인 창에서 '추가' — 고른 행 중 new 는 텍스트 박스 끝에, 나머지는 중복 칸 끝에(이미 있는 줄은 두 번 넣지 않는다).
 * 넣기 직전에 **다시 판정**한다(창을 연 뒤 텍스트 박스를 고쳤을 수 있다).
 * @returns {{ text, dupText, added:number, toDup:number }}
 */
export function applyImport({ text = '', dupText = '', rows = [], chosen, saved = [], vc = '' } = {}) {
  const pick = (r) => (chosen instanceof Set ? chosen.has(r.cidr) : true);
  const cidrs = (rows || []).filter((r) => r && pick(r)).map((r) => r.cidr);
  const again = classifySubnets(cidrs.map((cidr) => ({ cidr })), { text, saved, vc });
  const main = lines(text);
  const dup = lines(dupText);
  let added = 0; let toDup = 0;
  for (const r of again) {
    if (r.kind === 'new') { main.push(r.cidr); added += 1; } else if (r.kind !== 'invalid' && !dup.includes(r.cidr)) { dup.push(r.cidr); toDup += 1; }
  }
  return { text: main.join('\n'), dupText: dup.join('\n'), added, toDup };
}

/**
 * 중복 칸의 '반영' — 고친 줄을 다시 판정해 new 만 텍스트 박스에 붙이고, 여전히 겹치거나 형식이 틀린 줄은 칸에 남긴다.
 * @returns {{ text, dupText, added:number, kept: Array<{line, kind, with?}> }}
 */
export function reflectDups({ text = '', dupText = '', saved = [], vc = '' } = {}) {
  const others = otherSavedRanges(saved, vc);
  const main = lines(text);
  const kept = [];
  let added = 0;
  for (const l of lines(dupText)) {
    const c = classifyLine(l, { text: main.join('\n'), others });
    if (c.kind === 'new') { main.push(l); added += 1; } else kept.push({ line: l, ...c });
  }
  return { text: main.join('\n'), dupText: kept.map((k) => k.line).join('\n'), added, kept };
}

/** 중복 칸 각 줄의 사유 문구. */
export function dupReasonText(c) {
  if (!c) return '';
  if (c.kind === 'covered') return '이 vCenter 대역에 이미 있습니다';
  if (c.kind === 'partial') return '이 vCenter 의 다른 줄과 일부 겹칩니다';
  if (c.kind === 'other') return `다른 vCenter(${(c.with || []).join(', ')})에 저장된 대역과 겹칩니다`;
  if (c.kind === 'invalid') return '대역 형식이 아닙니다';
  return '';
}

export const KIND_LABEL = { new: '새 대역', covered: '이미 입력됨', partial: '일부 겹침', other: '다른 vCenter 와 겹침', invalid: '형식 오류' };

/** 확인 창 머리 요약(VM). */
export function vmSummaryText(r) {
  if (!r) return '';
  const t = r.totals || {};
  const ex = t.excluded || {};
  const exN = Object.values(ex).reduce((a, b) => a + (Number(b) || 0), 0);
  const parts = [`VM ${t.vms ?? 0}대 중 IPv4 가 있는 VM ${t.vmsWithIp ?? 0}대 · 주소 ${t.ips ?? 0}개 → /24 ${(r.subnets || []).length}개`];
  if (t.vmsNoIp) parts.push(`IPv4 가 수집되지 않은 VM ${t.vmsNoIp}대는 뺐습니다`);
  if (exN) parts.push(`루프백·링크로컬(169.254)·멀티캐스트 등 ${exN}개 주소는 뺐습니다`);
  if (t.ipv6) parts.push(`IPv6 ${t.ipv6}개는 대상이 아닙니다`);
  if (r.omitted) parts.push(`상한 ${r.cap ?? ''}개를 넘어 ${r.omitted}개는 목록에 없습니다`);
  return parts.join(' · ');
}

/** 확인 창 머리 요약(iDRAC). 빈 이유를 단정하지 않고 근거로 말한다. */
export function idracSummaryText(r) {
  if (!r) return '';
  if (!r.datacenterId) return '이 vCenter 는 어느 DataCenter 에도 할당돼 있지 않습니다 — 아래에서 DataCenter 를 고르세요(임의로 고르지 않습니다).';
  const name = r.datacenterName || r.datacenterId;
  const src = r.datacenterSource === 'assigned' ? '(이 vCenter 가 속한 DataCenter)' : r.datacenterSource === 'chosen' ? '(직접 고름)' : '';
  if (r.datacenterMissing) return `DataCenter ‘${name}’ 이 등록 목록에 없습니다(삭제됨) — 다른 DataCenter 를 고르세요.`;
  const ents = r.entries || [];
  if (!ents.length) return `DataCenter ${name}${src} 에 등록된 iDRAC 스캔 대역이 없습니다.`;
  const parts = [`DataCenter ${name}${src} · iDRAC 스캔 대역 ${ents.length}건 → /24 ${(r.subnets || []).length}개`];
  const off = ents.filter((e) => !e.enabled).length;
  if (off) parts.push(`꺼진 스캔 대역 ${off}건도 포함했습니다(입력된 대역이라서)`);
  if ((r.invalid || []).length) parts.push(`읽을 수 없는 대역 ${r.invalid.length}줄은 뺐습니다`);
  if (r.omitted) parts.push(`상한 ${r.cap ?? ''}개를 넘어 ${r.omitted}개는 목록에 없습니다`);
  return parts.join(' · ');
}
