/**
 * ipScanDcText.js — IP 스캔 설정의 '데이터센터 귀속' 과 '/24 대역 제안' 문구·판정(순수, v2.638).
 *
 * 판정은 서버(ipam/scanDatacenter.js)가 하고 여기서는 문장만 만든다. 대역이 이미 입력돼 있는지(covered)는 화면이
 * 아직 저장하지 않은 입력까지 봐야 하므로 여기서 계산한다 — 대역 문법은 ipmsRangeText.js 하나를 쓴다(사본 금지).
 */
import { checkRangeSpec } from './ipmsRangeText.js';

/**
 * 서버 판정(datacenter) → { tone, text, detail }.
 * tone: 'ok'(귀속됨) | 'warn'(귀속 안 됨 — 조치 필요) | 'muted'(아직 모름).
 */
export function dcDecisionText(dc, { vcName = (id) => id } = {}) {
  if (!dc) return { tone: 'muted', text: '판정하지 못했습니다', detail: '서버가 판정 결과를 주지 않았습니다(구버전 서버이거나 판정 중 오류).' };
  const vcs = Array.isArray(dc.vcenters) ? dc.vcenters : [];
  const cands = Array.isArray(dc.candidates) ? dc.candidates : [];
  const evidence = (c) => {
    const parts = [];
    if (c?.vcenters?.length) parts.push(`vCenter ${c.vcenters.map(vcName).join(', ')}`);
    if (c?.collectors?.length) parts.push(`수집 서버 ${c.collectors.join(', ')}`);
    return parts.join(' · ');
  };
  if (dc.reason === 'manual') return { tone: 'ok', text: `${dc.datacenterName} (직접 지정)`, detail: '이 에이전트가 찾은 IP 는 이 데이터센터에 들어갑니다.' };
  if (dc.reason === 'auto') {
    const c = cands[0];
    return { tone: 'ok', text: `${dc.datacenterName} (자동)`, detail: `근거: ${evidence(c) || '—'}. 다른 데이터센터로 두려면 위에서 직접 고르세요.` };
  }
  if (dc.reason === 'manual-missing') return { tone: 'warn', text: '지정한 데이터센터가 없습니다', detail: `저장된 값 ‘${dc.manualId || ''}’ 이 등록 목록에 없습니다(삭제됨). 이 에이전트가 찾은 IP 는 어느 데이터센터에도 들어가지 않습니다 — 다시 고르거나 ‘자동’ 으로 두세요.` };
  if (dc.reason === 'multiple') return { tone: 'warn', text: `자동 판정 불가 — 후보 ${cands.length}곳`, detail: `이 에이전트가 수집하는 대상이 여러 데이터센터에 걸쳐 있습니다(${cands.map((c) => `${c.name}: ${evidence(c)}`).join(' / ')}). 하나를 직접 고르세요 — 고르기 전에는 어느 데이터센터에도 넣지 않습니다.` };
  // none
  const un = Array.isArray(dc.unassignedVcenters) ? dc.unassignedVcenters : [];
  if (vcs.length && un.length === vcs.length) {
    return { tone: 'warn', text: '자동 판정 불가 — 데이터센터 할당 없음', detail: `이 에이전트가 수집하는 vCenter(${un.map(vcName).join(', ')})가 어느 데이터센터에도 할당돼 있지 않습니다. 설정 › DataCenter 에서 vCenter 를 할당하거나 위에서 직접 고르세요.` };
  }
  return { tone: 'warn', text: '자동 판정 불가 — 근거 없음', detail: '이 에이전트가 수집하는 vCenter 도, 같은 이름의 수집 서버 등록도 없습니다. 위에서 데이터센터를 직접 고르세요 — 고르기 전에는 어느 데이터센터에도 넣지 않습니다.' };
}

/** 입력칸의 대역 목록(한 줄에 하나) → 읽을 수 있는 줄의 [lo, hi] 목록. */
export function rangesOf(lines) {
  const out = [];
  for (const raw of Array.isArray(lines) ? lines : String(lines ?? '').split(/\r?\n/)) {
    const r = checkRangeSpec(String(raw ?? '').trim());
    if (r.ok) out.push([r.lo, r.hi]);
  }
  return out;
}

/** 이 /24 가 입력된 대역에 **전부** 들어 있으면 'full', 일부만이면 'partial', 아니면 ''. */
export function coverageOf(cidr, ranges) {
  const r = checkRangeSpec(cidr);
  if (!r.ok) return '';
  let covered = 0;
  // 겹치는 구간의 합(대역끼리 겹칠 수 있으므로 256칸을 직접 센다 — /24 하나라 상수 비용).
  const seen = new Uint8Array(256);
  for (const [lo, hi] of ranges || []) {
    const a = Math.max(lo, r.lo); const b = Math.min(hi, r.hi);
    for (let n = a; n <= b; n++) { const i = n - r.lo; if (!seen[i]) { seen[i] = 1; covered += 1; } }
  }
  if (covered >= 256) return 'full';
  return covered > 0 ? 'partial' : '';
}

/** 체크한 /24 를 입력칸 끝에 붙인다 — 이미 전부 들어 있는 것은 넣지 않는다. 결과: { lines, added, skipped }. */
export function appendSubnets(lines, cidrs) {
  const cur = Array.isArray(lines) ? lines.slice() : String(lines ?? '').split(/\r?\n/);
  while (cur.length && !String(cur[cur.length - 1]).trim()) cur.pop();
  const ranges = rangesOf(cur);
  let added = 0; let skipped = 0;
  for (const c of cidrs || []) {
    if (coverageOf(c, ranges) === 'full') { skipped += 1; continue; }
    cur.push(c); added += 1;
    const r = checkRangeSpec(c); if (r.ok) ranges.push([r.lo, r.hi]);
  }
  return { lines: cur, added, skipped };
}

/** 제안 요약 한 줄. */
export function suggestSummaryText(s) {
  if (!s) return '';
  const t = s.totals || {};
  const parts = [`/24 대역 ${t.subnets ?? 0}개`, `VM IP ${t.vmIps ?? 0}`, `ESXi 호스트 IP ${t.hostIps ?? 0}`, `iDRAC IP ${t.idracIps ?? 0}`];
  const notes = [];
  if (s.skipped?.hostsNoIp) notes.push(`이름으로 등록된 ESXi 호스트 ${s.skipped.hostsNoIp}대는 주소를 몰라 뺐습니다`);
  if (s.skipped?.idracNoIp) notes.push(`IP 가 아닌 주소로 등록된 iDRAC ${s.skipped.idracNoIp}대는 뺐습니다`);
  if (s.omitted) notes.push(`상위 ${s.subnets?.length ?? 0}개만 보여 줍니다(나머지 ${s.omitted}개)`);
  return `${parts.join(' · ')}${notes.length ? ` — ${notes.join(' · ')}` : ''}`;
}

/** 제안 목록이 비었을 때의 이유. */
export function suggestEmptyText(s, isLocal) {
  if (!s) return '';
  const vcN = (s.vcenters || []).length;
  if (!vcN && !s.idracServers) {
    return isLocal
      ? '이 포탈이 직접 수집하는 vCenter 와 등록된 iDRAC 이 없습니다.'
      : '이 에이전트가 수집하는 vCenter(수집 방식 ‘엣지 위임’ + 담당 엣지가 이 이름)와 이 에이전트가 보고한 iDRAC 이 없습니다. 에이전트 이름이 수집 서버 등록의 id·이름과 같은지 확인하세요.';
  }
  return '대상은 있지만 IPv4 주소를 하나도 찾지 못했습니다(VM 에 IP 가 수집되지 않았거나 전부 이름으로 등록돼 있습니다).';
}
