/**
 * excelExtra.js — IP 대장 엑셀의 덧붙임 시트 값(순수 · v3.5.0 재설계 묶음 나 · 시안 docs/design/ipam-redesign ⑨ ⑩).
 * 라우트가 만든 시트(buildSubnetSheets) · 원장 행(buildIpamRows) · 대역 용도(subnetNotes)를 받아 요약 · 대역 목록 · 조치 필요 · 안내 값을 만든다.
 * 판정은 새로 만들지 않는다 — 시트 행의 status · mgmtStatus, 원장 행의 reconcile · duplicate · 예약 만료 · 충돌 의심 · dnsFwd 를 그대로 읽는다.
 */
import { pushAll } from '../util/pushAll.js';

/** 내보내기에서 고를 수 있는 시트(웹 내보내기 창과 1:1). 기본은 전부. */
export const EXPORT_SHEETS = Object.freeze(['summary', 'nets', 'ledger', 'issues', 'info']);
/** 조치 필요 시트 행 상한 — 넘으면 자르고 그 사실을 시트 머리에 적는다. */
export const ISSUES_MAX = 20_000;

/** ?sheets=summary,ledger → { summary:true, nets:false, … }. 비었거나 아는 값이 하나도 없으면 전부. */
export function parseExportSheets(q) {
  const want = new Set(String(q ?? '').split(',').map((x) => x.trim()).filter((x) => EXPORT_SHEETS.includes(x)));
  const all = want.size === 0;
  return Object.fromEntries(EXPORT_SHEETS.map((k) => [k, all || want.has(k)]));
}

const pctText = (n, d) => (d > 0 ? `${Math.round((n / d) * 1000) / 10}%` : '—');
const isHost = (r) => r && r.last >= 1 && r.last <= 254;

/** 시트 하나 → 대장 주소 · 예약 · DHCP · 빈 주소(호스트 주소 .1~.254 기준 · 대장 주소는 시트의 used). */
export function sheetCounts(s) {
  let rsv = 0; let dhcp = 0; let dup = 0;
  for (const r of s?.rows || []) {
    if (r?.status === 'duplicate') dup += 1;
    if (!isHost(r) || !(r.status === 'empty' || r.status === 'released')) continue;
    if (r.mgmtStatus === 'dhcp') dhcp += 1;
    else if (r.mgmtStatus === 'reserved' || r.mgmtStatus === 'deprecated') rsv += 1;
  }
  const used = Math.max(0, Math.min(254, Number(s?.used) || 0));
  return { used, rsv, dhcp, free: Math.max(0, 254 - used - rsv - dhcp), dup };
}

/** 원장 행 하나의 조치 필요 항목들(없으면 빈 배열). */
export function issuesOfRow(r) {
  const out = [];
  if (!r) return out;
  const base = { ip: r.ip, vcenter: r.vcenterName || '', owner: r.label || r.ownerName || '', purpose: r.ipPurpose || '', requester: r.requester || '' };
  if (r.reconcile === 'conflict') out.push({ ...base, kind: '충돌', detail: `다른 vCenter 와 같은 주소 — ${(r.conflictVcenters || []).join(', ')}` });
  if (r.duplicate) out.push({ ...base, kind: '중복', detail: '같은 vCenter 안에서 둘 이상이 이 주소를 씁니다' });
  if (r.macConflict) out.push({ ...base, kind: '충돌 의심', detail: `VM 의 NIC 이 아닌 MAC ${r.macConflict.mac || ''} 이 응답` });
  if (r.reservedExpired) out.push({ ...base, kind: '예약 만료', detail: '예약 만료일이 지났습니다' });
  else if (r.reservedExpiringSoon) out.push({ ...base, kind: '예약 임박', detail: '예약 만료가 가깝습니다' });
  if (r.dnsFwd === 'other') out.push({ ...base, kind: 'DNS 불일치', detail: `역DNS 이름 ${r.dnsPtr || ''} 이 다른 IP(${(r.dnsFwdAddrs || []).join(', ')})를 가리킵니다` });
  else if (r.dnsFwd === 'none') out.push({ ...base, kind: 'DNS 불일치', detail: `역DNS 이름 ${r.dnsPtr || ''} 의 정방향 레코드가 없습니다` });
  return out;
}

/**
 * @param {object} p
 * @param {Array} p.sheets 시트(buildSubnetSheets)
 * @param {Array} p.rows 원장 행(buildIpamRows().rows)
 * @param {object} p.notes 대역 용도 맵 { base: {purpose, desc} }
 * @param {object} p.include parseExportSheets 결과
 * @param {string} p.scopeText 범위 글자
 * @param {string} p.createdText 만든 시각 글자
 */
export function buildExportExtra({ sheets = [], rows = [], notes = {}, include = parseExportSheets(''), scopeText = '', createdText = '' } = {}) {
  const nets = sheets.map((s) => {
    const c = sheetCounts(s);
    const n = notes?.[s.base] || {};
    return { subnet: s.subnet, base: s.base, purpose: n.purpose || '', desc: n.desc || '', ...c, pctText: pctText(c.used + c.rsv + c.dhcp, 254) };
  });
  const tot = nets.reduce((a, n) => ({ used: a.used + n.used, rsv: a.rsv + n.rsv, dhcp: a.dhcp + n.dhcp, free: a.free + n.free }), { used: 0, rsv: 0, dhcp: 0, free: 0 });
  const cap = nets.length * 254;
  const st = { 사용: 0, 복수IP: 0, 중복: 0, '스캔 확인': 0, '해제(이력)': 0 };
  for (const s of sheets) for (const r of s.rows || []) {
    if (r.status === 'used') st.사용 += 1; else if (r.status === 'multihomed') st.복수IP += 1; else if (r.status === 'duplicate') st.중복 += 1;
    else if (r.status === 'scanned') st['스캔 확인'] += 1; else if (r.status === 'released') st['해제(이력)'] += 1;
  }
  let issues = [];
  for (const r of rows) { pushAll(issues, issuesOfRow(r)); if (issues.length > ISSUES_MAX) break; } // 인벤토리 규모 배열 — spread push 금지(audit2603a)
  const issuesTruncated = issues.length > ISSUES_MAX;
  if (issuesTruncated) issues = issues.slice(0, ISSUES_MAX);
  return {
    include, scopeText, createdText, nets, issues, issuesTruncated,
    summary: { cap, ...tot, pctText: pctText(tot.used + tot.rsv + tot.dhcp, cap), byStatus: Object.entries(st), nets: nets.length, issues: issues.length },
    info: [
      ['범위', scopeText],
      ['만든 시각', createdText],
      ['뺀 것', "'숨길 대역' 에 든 주소 · 만든 계정의 범위 밖 vCenter"],
      ['대장 시트', '대역마다 시트 하나(전체 법인도 같다). 주소 하나가 한 행이고 앞 열(.X ~ 상태)은 예전 순서 그대로, 뒤에 용도 · 요청자 · 할당자'],
      ['Purpose', '포탈이 채운 값(서버종류 · vCenter · 정책 이름). 사람이 넣은 용도는 맨 뒤 ‘용도’ 열'],
      ['상태', '사용 · 복수IP(장비 한 대가 주소를 둘 이상 — 장애 아님) · 중복 · 스캔 확인(vCenter 가 모르는 주소) · 해제(이력) · 빈 칸은 빈 주소'],
      ['예약 · DHCP', '대역 정책이 대장에 없는 주소를 예약 · 폐기예정 · DHCP 로 잡은 수. 사용률은 (대장 주소 + 예약 + DHCP) / 254'],
      ['조치 필요', '충돌 · 중복 · 충돌 의심 · 예약 만료/임박 · DNS 불일치(역DNS 이름이 이 IP 를 가리키지 않음)'],
    ],
  };
}
