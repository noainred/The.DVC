/**
 * ipam/reportModel.js — IP 관리 정기 보고의 내용 · 메일 본문(순수 · v3.7.0 재설계 묶음 라 — 시안 ⑬ AlertMail.dc.html).
 *
 * 입력은 라우트 · 스케줄러가 모은다(대장 행 · 법인 할당 · IP 변화 기록 · 스캔 에이전트 · 마지막 보고 · 지난 보고의 대역 점유).
 * 법인 = DataCenter(법인 1 : 서비스 N — vCenter 여럿일 수 있다). 행의 법인: vCenter 행은 할당표(assign), 스캔 행은 스캔 귀속(datacenterId).
 * 법인 메일에는 그 법인 것만 싣는다(다른 법인 내역을 섞지 않는다). 스캔 보고가 끊긴 에이전트가 있으면 '변화 없음' 으로 세지 않고 메일에 밝힌다.
 * 대역 사용률의 '지난 보고 대비' 는 지난 보고 때 남긴 점유(prevOcc)와 견준다 — 첫 보고 · 새 대역은 비교 없음('—').
 */
import { SUBNET_HOSTS } from './instantAlerts.js';

const LIST_MAX = 20;
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const base24 = (ip) => String(ip || '').split('.').slice(0, 3).join('.');
const CHANGE_LABEL = { 'new-ip': '새 미등록 IP', 'mac-change': 'MAC 변경', rename: '호스트명 변경', 'reserved-up': '예약 · 폐기 IP 사용 시작', conflict: '충돌 의심', 'conflict-resolved': '충돌 해소', 'dns-mismatch': 'DNS 불일치' };

/**
 * @param {object} p
 * @param {object[]} p.rows  대장 행(전체 범위)
 * @param {Record<string,string>} p.assign  vcenterId → 법인 id
 * @param {Array<{id:string,name?:string}>} p.datacenters
 * @param {Record<string,string>} [p.vcName]
 * @param {object[]} [p.changes]  IP 변화 기록(listChanges entries)
 * @param {object[]} [p.agents]  스캔 에이전트(name · enabled · intervalMs · ranges)
 * @param {Record<string,{at?:number}>} [p.reports]
 * @param {(agent:string)=>string} [p.agentDc]  에이전트 → 법인 id
 * @param {Set<string>} [p.mockVc]  데모(mock) vCenter id
 * @param {Record<string,Record<string,number>>} [p.prevOcc]  법인 → 대역 → 지난 보고 점유
 * @param {{rsv:number,dhcp:number}} [p.policyOf]  (base) → 예약 · DHCP 수(대역 목록과 같은 값) — 없으면 0
 * @param {number} p.now
 * @param {number} p.periodMs
 * @param {number} [p.fullPct]
 */
export function buildReportModel(p) {
  const { rows = [], assign = {}, datacenters = [], vcName = {}, changes = [], agents = [], reports = {}, agentDc = () => '', mockVc = new Set(), prevOcc = {},
    policyOf = () => ({ rsv: 0, dhcp: 0 }), now, periodMs, fullPct = 90 } = p;
  const from = now - periodMs;
  const dcName = new Map(datacenters.map((d) => [String(d.id), d.name || d.id]));
  const corpOfRow = (r) => (r.ownerType === 'vm' || r.ownerType === 'host' ? String(assign[r.vcenterId] || '') : String(r.datacenterId || ''));
  const corps = new Map();
  const corp = (id) => {
    let c = corps.get(id);
    if (!c) {
      c = { id, name: id ? (dcName.get(id) || id) : '법인 미지정', vcenters: new Set(), mock: true, real: false, ips: 0, vmIps: 0, scanIps: 0, dup: new Set(), dnsBad: [],
        subnets: new Map(), ipCorp: null, changes: Object.fromEntries(Object.keys(CHANGE_LABEL).map((k) => [k, 0])), newIps: [], lines: [], conflicts: [], scan: [] };
      corps.set(id, c);
    }
    return c;
  };
  const ipCorp = new Map();
  for (const r of rows) {
    const c = corp(corpOfRow(r));
    c.ips += 1;
    if (r.ownerType === 'vm' || r.ownerType === 'host') { c.vmIps += 1; c.vcenters.add(vcName[r.vcenterId] || r.vcenterId); if (!mockVc.has(String(r.vcenterId))) c.real = true; }
    else { c.scanIps += 1; c.real = true; }
    if (r.duplicate) c.dup.add(r.ip);
    if ((r.dnsFwd === 'other' || r.dnsFwd === 'none') && c.dnsBad.length < LIST_MAX) c.dnsBad.push({ ip: r.ip, ptr: r.dnsPtr || '' });
    const b = base24(r.ip);
    c.subnets.set(b, (c.subnets.get(b) || new Set()).add(r.ip));
    if (!ipCorp.has(r.ip)) ipCorp.set(r.ip, c.id);
  }
  for (const c of corps.values()) c.mock = !c.real;
  for (const e of changes) {
    const ts = Number(e?.ts);
    if (!(ts > from && ts <= now) || e.type === 'baseline') continue;
    const id = agentDc(e.agent) || ipCorp.get(e.ip) || '';
    const c = corp(id);
    if (c.changes[e.type] != null) c.changes[e.type] += 1;
    if (e.type === 'new-ip' && c.newIps.length < LIST_MAX) c.newIps.push({ ip: e.ip, at: ts, name: e.name || '', services: e.services || [] });
    else if (e.type === 'conflict' && c.conflicts.length < 10) c.conflicts.push({ ip: e.ip, at: ts, mac: e.mac || '', vm: e.vm || '' });
    else if ((e.type === 'mac-change' || e.type === 'rename' || e.type === 'reserved-up') && c.lines.length < LIST_MAX) {
      c.lines.push({ type: e.type, ip: e.ip, at: ts, text: e.type === 'mac-change' ? `${e.from || '?'} → ${e.to || e.mac || '?'}` : e.type === 'rename' ? `${e.from || '?'} → ${e.to || '?'}` : (e.status || '') });
    }
  }
  for (const a of agents) {
    const id = agentDc(a.name) || '';
    const rep = Object.entries(reports || {}).find(([k]) => k.toLowerCase() === String(a.name).toLowerCase())?.[1];
    const at = Number(rep?.at) > 0 ? Number(rep.at) : null;
    const iv = Number(a.intervalMs) > 0 ? Number(a.intervalMs) : null;
    const state = !a.enabled || !(a.ranges || []).length ? 'off' : at == null ? 'none' : iv && now - at > 2 * iv ? 'late' : 'ok';
    corp(id).scan.push({ agent: a.name, state, lastAt: at });
  }
  const out = [];
  for (const c of corps.values()) {
    const prev = prevOcc?.[c.id] || {};
    const subnets = [...c.subnets.entries()].map(([b, set]) => {
      const pol = policyOf(b) || { rsv: 0, dhcp: 0 };
      const occ = Math.min(SUBNET_HOSTS, set.size + (Number(pol.rsv) || 0) + (Number(pol.dhcp) || 0));
      const pv = Number.isFinite(prev[b]) ? prev[b] : null;
      return { base: b, subnet: `${b}.0/24`, occ, pct: Math.round((occ / SUBNET_HOSTS) * 1000) / 10, prevOcc: pv, delta: pv == null ? null : occ - pv };
    }).sort((x, y) => y.occ - x.occ || (x.base < y.base ? -1 : 1));
    const scanGap = c.scan.some((s) => s.state === 'late' || s.state === 'none');
    out.push({
      id: c.id, name: c.name, mock: c.mock, vcenters: [...c.vcenters].sort(),
      totals: { ips: c.ips, vmIps: c.vmIps, scanIps: c.scanIps, dup: c.dup.size, dnsBad: c.dnsBad.length, subnets: subnets.length, full: subnets.filter((s) => s.pct >= fullPct).length },
      changes: c.changes, newIps: c.newIps, lines: c.lines, conflicts: c.conflicts,
      subnets: subnets.slice(0, 10), full: subnets.filter((s) => s.pct >= fullPct).slice(0, LIST_MAX), occMap: Object.fromEntries(subnets.map((s) => [s.base, s.occ])),
      dupList: [...c.dup].slice(0, 10), dnsBad: c.dnsBad.slice(0, 10), scan: c.scan, scanGap,
    });
  }
  out.sort((a, b) => (a.id === '' ? 1 : b.id === '' ? -1 : String(a.name).localeCompare(String(b.name))));
  return { from, to: now, periodMs, fullPct, corps: out };
}

const fmt = (ms, offsetMin) => { const d = new Date(ms + offsetMin * 60_000); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`; };
const deltaText = (d) => (d == null ? '—' : d === 0 ? '0' : d > 0 ? `+${d}` : String(d));
const SCAN_STATE = { ok: '정상', late: '늦음(보고 끊김)', none: '완료 기록 없음', off: '꺼짐' };
const TH = 'style="text-align:left;padding:4px 8px;border-bottom:1px solid #ccc;background:#f3f5f8"';
const TD = 'style="padding:4px 8px;border-bottom:1px solid #eee"';
const table = (head, rows) => `<table style="border-collapse:collapse;font-size:13px;margin:6px 0 14px">${`<tr>${head.map((h) => `<th ${TH}>${esc(h)}</th>`).join('')}</tr>`}${rows.map((r) => `<tr>${r.map((v) => `<td ${TD}>${v}</td>`).join('')}</tr>`).join('')}</table>`;

/** 법인 한 곳의 메일 본문(HTML · 텍스트). sections 는 reportRules.reportOf().sections. */
export function renderCorpMail(c, { model, sections, offsetMin, freqLabel, preview = false }) {
  const h = []; const t = [];
  const period = `${fmt(model.from, offsetMin)} ~ ${fmt(model.to, offsetMin)}`;
  const ch = c.changes;
  const changeN = Object.values(ch).reduce((a, b) => a + b, 0);
  h.push(`<h2 style="margin:0 0 4px;font-size:18px">IP 관리 ${esc(freqLabel)} 보고 — ${esc(c.name)}</h2><div style="color:#666;font-size:12px">${esc(period)} · vCenter ${esc(c.vcenters.join(', ') || '없음')}${preview ? ' · 미리 보기' : ''}</div>`);
  t.push(`IP 관리 ${freqLabel} 보고 — ${c.name} (${period})`);
  if (c.scanGap) { h.push('<p style="color:#b45309;font-size:13px">⚠ 스캔 보고가 끊기거나 완료 기록이 없는 에이전트가 있습니다 — 그 대역의 변화가 빠졌을 수 있습니다(변화 없음이 아닙니다).</p>'); t.push('⚠ 스캔 보고가 끊긴 에이전트가 있어 변화가 빠졌을 수 있습니다.'); }
  if (sections.summary) {
    const line = `IP ${c.totals.ips.toLocaleString()}개 · 이번 구간 변화 ${changeN}건(새 미등록 ${ch['new-ip']} · MAC 변경 ${ch['mac-change']} · 충돌 의심 ${ch.conflict}) · 가득 찬 대역 ${c.totals.full}개 · 중복 ${c.totals.dup}`;
    h.push(`<p style="font-size:14px"><b>${esc(line)}</b></p>`); t.push(line);
  }
  if (sections.subnets && c.subnets.length) {
    h.push('<h3 style="font-size:14px;margin:10px 0 2px">대역 사용률(점유 = 대장 + 예약 + DHCP · 지난 보고 대비)</h3>');
    h.push(table(['대역', '점유', '사용률', '지난 보고 대비'], c.subnets.map((s) => [esc(s.subnet), `${s.occ}/254`, `${s.pct}%`, esc(deltaText(s.delta))])));
  }
  if (sections.full && c.full.length) { h.push(`<h3 style="font-size:14px;margin:10px 0 2px">가득 찬 대역(${model.fullPct}% 이상)</h3>`); h.push(table(['대역', '사용률', '남은 주소'], c.full.map((s) => [esc(s.subnet), `${s.pct}%`, String(254 - s.occ)]))); t.push(`가득 찬 대역: ${c.full.map((s) => s.subnet).join(', ')}`); }
  if (sections.newIp && c.newIps.length) { h.push(`<h3 style="font-size:14px;margin:10px 0 2px">새로 응답한 미등록 IP(${ch['new-ip']}건${ch['new-ip'] > c.newIps.length ? ` 중 ${c.newIps.length}` : ''})</h3>`); h.push(table(['IP', '처음 본 시각', '이름', '열린 서비스'], c.newIps.map((x) => [esc(x.ip), esc(fmt(x.at, offsetMin)), esc(x.name || '—'), esc(x.services.join(', ') || '—')]))); }
  if (sections.changes && c.lines.length) { h.push('<h3 style="font-size:14px;margin:10px 0 2px">MAC · 호스트명 · 예약 IP 변화</h3>'); h.push(table(['종류', 'IP', '시각', '내용'], c.lines.map((x) => [esc(CHANGE_LABEL[x.type]), esc(x.ip), esc(fmt(x.at, offsetMin)), esc(x.text)]))); }
  if (sections.conflict && c.conflicts.length) { h.push('<h3 style="font-size:14px;margin:10px 0 2px">충돌 의심</h3>'); h.push(table(['IP', '시각', 'VM', '응답한 MAC'], c.conflicts.map((x) => [esc(x.ip), esc(fmt(x.at, offsetMin)), esc(x.vm || '—'), esc(x.mac || '—')]))); }
  if (sections.issues && (c.dupList.length || c.dnsBad.length)) {
    h.push('<h3 style="font-size:14px;margin:10px 0 2px">조치 필요</h3>');
    if (c.dupList.length) h.push(`<p style="font-size:13px">중복 IP ${c.totals.dup}개: ${esc(c.dupList.join(', '))}${c.totals.dup > c.dupList.length ? ' …' : ''}</p>`);
    if (c.dnsBad.length) h.push(`<p style="font-size:13px">DNS 불일치 ${c.totals.dnsBad}개: ${esc(c.dnsBad.map((x) => `${x.ip}${x.ptr ? `(${x.ptr})` : ''}`).join(', '))}</p>`);
  }
  if (sections.scan && c.scan.length) { h.push('<h3 style="font-size:14px;margin:10px 0 2px">수집 상태(스캔 에이전트)</h3>'); h.push(table(['에이전트', '상태', '마지막 완료'], c.scan.map((s) => [esc(s.agent === '__local__' ? '이 포탈' : s.agent), esc(SCAN_STATE[s.state] || s.state), esc(s.lastAt ? fmt(s.lastAt, offsetMin) : '—')]))); }
  h.push('<p style="color:#888;font-size:11px">이 메일은 IP 관리 › 설정 › 정기 보고에서 보냅니다. 시각은 보고 기준 시각(메인 서버 또는 법인 현지)입니다.</p>');
  return { subject: `[IP 관리] ${freqLabel} 보고 — ${c.name} (${fmt(model.to, offsetMin).slice(0, 10)})`, html: `<div style="font-family:sans-serif;color:#222">${h.join('')}</div>`, text: t.join('\n') };
}

/** 종합 표의 수집 상태 칸 — 켠 에이전트가 없으면 '스캔 꺼짐'(정상이라고 쓰지 않는다). */
export function scanCell(c) {
  const on = (c.scan || []).filter((s) => s.state !== 'off');
  if (!(c.scan || []).length) return '스캔 없음';
  if (!on.length) return '스캔 꺼짐';
  return c.scanGap ? '⚠ 끊김 있음' : '정상';
}
/** 전체 종합 — 법인별 표 + 가득 찬 대역. */
export function renderOverallMail(model, { sections, offsetMin, freqLabel, preview = false, corps }) {
  const list = corps || model.corps;
  const period = `${fmt(model.from, offsetMin)} ~ ${fmt(model.to, offsetMin)}`;
  const h = [`<h2 style="margin:0 0 4px;font-size:18px">IP 관리 ${esc(freqLabel)} 보고 — 전체 종합</h2><div style="color:#666;font-size:12px">${esc(period)} · 법인 ${list.length}곳${preview ? ' · 미리 보기' : ''}</div>`];
  h.push(table(['법인', 'IP', '새 미등록', 'MAC 변경', '충돌 의심', '중복', '가득 찬 대역', '수집 상태'], list.map((c) => [
    esc(c.name), c.totals.ips.toLocaleString(), String(c.changes['new-ip']), String(c.changes['mac-change']), String(c.changes.conflict), String(c.totals.dup), String(c.totals.full),
    esc(scanCell(c))])));
  const full = list.flatMap((c) => c.full.map((s) => ({ ...s, corp: c.name }))).sort((a, b) => b.pct - a.pct).slice(0, 30);
  if (sections.full && full.length) { h.push(`<h3 style="font-size:14px;margin:10px 0 2px">가득 찬 대역(${model.fullPct}% 이상)</h3>`); h.push(table(['법인', '대역', '사용률', '남은 주소'], full.map((s) => [esc(s.corp), esc(s.subnet), `${s.pct}%`, String(254 - s.occ)]))); }
  if (list.some((c) => c.scanGap)) h.push('<p style="color:#b45309;font-size:13px">⚠ 스캔 보고가 끊긴 법인은 변화가 빠졌을 수 있습니다(변화 없음이 아닙니다).</p>');
  h.push('<p style="color:#888;font-size:11px">법인별 자세한 내용은 법인 메일(받는 사람을 정한 법인)과 IP 관리 화면에 있습니다.</p>');
  const text = [`IP 관리 ${freqLabel} 보고 — 전체 종합 (${period})`, ...list.map((c) => `${c.name}: IP ${c.totals.ips} · 새 미등록 ${c.changes['new-ip']} · 충돌 의심 ${c.changes.conflict} · 가득 찬 대역 ${c.totals.full}${c.scanGap ? ' · ⚠ 스캔 끊김' : ''}`)].join('\n');
  return { subject: `[IP 관리] ${freqLabel} 보고 — 전체 종합 (${fmt(model.to, offsetMin).slice(0, 10)})`, html: `<div style="font-family:sans-serif;color:#222">${h.join('')}</div>`, text };
}
