/**
 * diskbad/notify.js — 점검에서 **새로** 나온 배드 섹터 기록을 법인별 메일 한 통으로 알린다(v3.8.0).
 *
 * 사용자 결정(README §10 · §15):
 *  · 새 기록이 생기면 메일 — 점검 한 번에 **법인별 1통 요약**(건별로 보내면 메일 경로의 시간당 상한에 막혀 조용히 유실된다).
 *  · 받는 사람: 그 법인 담당자(설정 corpTo) + 전체 관리자(메일 종류 'disk-bad' 수신자).
 *  · 첫 점검(그 서버의 기준선)에서 나온 과거 기록은 메일 없이 화면에만 — db.js 가 baseline 으로 걸러서 여기 오지 않는다.
 *  · PDR54 만 새로 생겨도 보낸다. 고장 예측(PDR16)은 배드 섹터와 다른 뜻이라 이 메일에 넣지 않는다.
 *  · 데모(mock) 모드는 보내지 않는다(합성 기록이 실제 메일 채널로 나가지 않게 — partfault v2.708 과 같은 규칙).
 */
import { sendPortalMail } from '../mail/service.js';
import { load as loadMail } from '../mail/settings.js';
import { resolveRecipients } from '../mail/kinds.js';
import { loadDiskBadSettings } from './settings.js';
import { ID_TABLE, COUNTED, classOf, labelOfKey } from './classify.js';

export const MAIL_KIND = 'disk-bad';
const PER_MAIL_MAX = 200;
let _last = null;

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (ms) => { const d = new Date(ms); const p = (n) => String(n).padStart(2, '0'); return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`; };

/** 메일에 넣을 기록만(세는 분류). */
export function mailable(records) {
  return (records || []).filter((r) => COUNTED.has(classOf(r.code)));
}

/** 법인별 묶음(순수 — 테스트 고정). corpOf 가 null 이면 '법인 귀속 없음' 묶음. */
export function groupByCorp(records, corpOf) {
  const out = new Map();
  for (const r of mailable(records)) {
    const c = corpOf(r.agent, r.serverId) || { id: '', name: '법인 귀속 없음' };
    if (!out.has(c.id)) out.set(c.id, { corp: c, records: [] });
    out.get(c.id).records.push(r);
  }
  return [...out.values()];
}

/** 한 법인의 메일(순수). */
export function buildMail(corp, records) {
  const list = [...records].sort((a, b) => b.created - a.created).slice(0, PER_MAIL_MAX);
  const servers = new Set(records.map((r) => `${r.agent}|${r.serverId}`)).size;
  const subject = `[디스크 배드 섹터] ${corp.name} — 새 기록 ${records.length}건 · 서버 ${servers}대`;
  const rows = list.map((r) => {
    const meta = ID_TABLE[r.code] || null;
    return `<tr><td style="padding:4px 8px;border-bottom:1px solid #eaecf0">${esc(r.serverName || r.serverId)}</td>`
      + `<td style="padding:4px 8px;border-bottom:1px solid #eaecf0">${esc(labelOfKey(r.slotKey))}</td>`
      + `<td style="padding:4px 8px;border-bottom:1px solid #eaecf0"><b>${esc(r.code)}</b>${meta ? ` — ${esc(meta.note)}` : ''}</td>`
      + `<td style="padding:4px 8px;border-bottom:1px solid #eaecf0;white-space:nowrap">${esc(fmt(r.created))}</td></tr>`;
  }).join('');
  const html = `<div style="font-family:-apple-system,'Segoe UI','Malgun Gothic',sans-serif;max-width:760px;color:#101828">
<h2 style="font-size:16px;margin:0 0 8px">${esc(corp.name)} — 디스크 배드 섹터 새 기록 ${records.length}건</h2>
<p style="font-size:13px;color:#344054;margin:0 0 10px">iDRAC Lifecycle 로그에서 지난 점검 뒤로 새로 찾은 기록입니다. 디스크가 아직 쓰이는지 · 판단 근거는 포탈 <b>특수 기능 › 디스크 배드 섹터 분석</b>에서 봅니다.</p>
<table style="border-collapse:collapse;font-size:12.5px;width:100%"><thead><tr style="background:#f2f4f7">
<th style="text-align:left;padding:4px 8px">서버</th><th style="text-align:left;padding:4px 8px">위치</th><th style="text-align:left;padding:4px 8px">기록 ID · 주석</th><th style="text-align:left;padding:4px 8px">시각</th></tr></thead>
<tbody>${rows}</tbody></table>
${records.length > list.length ? `<p style="font-size:12px;color:#667085">그 밖에 ${records.length - list.length}건은 포탈에서 봅니다.</p>` : ''}
<p style="font-size:11.5px;color:#667085;margin-top:12px">기록 ID 의 뜻은 Dell 문서(검색 요약으로 확인 — 원문 · 실장비 대조 전)를 따릅니다. 이 메일은 디스크를 판정하지 않습니다.</p></div>`;
  const text = `${subject}\n\n${list.map((r) => `${r.serverName || r.serverId}\t${labelOfKey(r.slotKey)}\t${r.code}\t${fmt(r.created)}`).join('\n')}`;
  return { subject, html, text };
}

export async function notifyNewRecords(records, { corpOf = () => null, job = null } = {}) {
  const st = loadDiskBadSettings();
  if (!st.mailEnabled) { _last = { at: Date.now(), skipped: 'off' }; return _last; }
  try { if ((await import('../mock/demo/flags.js')).isMockMode()) { _last = { at: Date.now(), skipped: 'demo' }; return _last; } } catch { /* */ }
  const groups = groupByCorp(records, corpOf);
  if (!groups.length) return null;
  const cfg = loadMail();
  const base = resolveRecipients(cfg, MAIL_KIND);
  const results = [];
  for (const g of groups) {
    const corpTo = (g.corp.id && st.corpTo[g.corp.id]) || [];
    const to = [...new Set([...(base.ok ? base.to : []), ...corpTo])];
    const m = buildMail(g.corp, g.records);
    // 받는 사람을 명시하면 종류별 참조가 빠지므로(mail/kinds.js) 합친 목록을 준다. 둘 다 없으면 공용 경로가 '받는 사람 없음' 으로 기록한다.
    // eslint-disable-next-line no-await-in-loop
    const r = await sendPortalMail({ kind: MAIL_KIND, subject: m.subject, html: m.html, text: m.text, ...(to.length ? { to } : {}) });
    results.push({ corp: g.corp.id, records: g.records.length, ok: !!r?.ok, reason: r?.reason || '' });
  }
  _last = { at: Date.now(), job: job?.id || null, results };
  console.log(`[diskbad] 새 기록 메일 ${results.filter((x) => x.ok).length}/${results.length}통${results.some((x) => !x.ok) ? ` — 못 보낸 이유: ${results.filter((x) => !x.ok).map((x) => x.reason).join(' · ').slice(0, 200)}` : ''}`);
  return _last;
}

export function diskBadMailStatus() { return _last; }
