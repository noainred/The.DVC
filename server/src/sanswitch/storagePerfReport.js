/**
 * sanswitch/storagePerfReport.js — 월간 SAN 스토리지 성능 점검 **보고서**(순수 · v2.950 · 설계 §12.2-8).
 *
 * 무엇: 판정표(어레이 × 9항목) + 상위 어레이 처리량 + 편중 · 팹 비대칭 · 회선 포화 목록 + 어레이 측 값 범위 + 기준(임계값) 표를 **자급형 HTML**(인라인 CSS · 인쇄 CSS)로 만든다.
 * 왜 PDF 가 아닌가(정직): 이 저장소에는 PDF 생성 라이브러리가 없고(`pdfkit` 0건) 한글 글꼴을 번들에 동봉해야 하므로 이번 판은 **브라우저에서 PDF 로 저장할 수 있는 인쇄용 HTML** 이다.
 *   설계 §12.2-8 의 '월간 점검 PDF 인프라 재사용' 은 잘못된 전제였다(그런 인프라가 없다) — README §8.3 에 정정.
 * 월간 회차: `monthlySlot` — 매달 dayOfMonth(1~28) HH:MM(포탈 시각 · DAY_OFFSET_MIN)의 직전 회차. 놓친 회차는 몰아서 보내지 않는다(usageMail 규약).
 */
import { numOrNull } from '../util/numOrNull.js';
import { DAY_OFFSET_MIN } from '../util/dayKey.js';
import { CHECK_ITEMS } from './storagePerfCheck.js';

export const REPORT_DEFAULTS = Object.freeze({ enabled: false, dayOfMonth: 1, time: '09:00', to: [], topN: 10 });
export const REPORT_KIND = 'san-storage-report';
export const REPORT_LATE_MS = 30 * 60_000;
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const MARK = { ok: '●', warn: '▲', bad: '✕', unknown: '?', na: '—' };
const MARK_COLOR = { ok: '#199e70', warn: '#c98500', bad: '#d92d20', unknown: '#8b9bb4', na: '#b0b7c3' };
const STATUS_KO = { ok: '정상', warn: '주의', bad: '이상', unknown: '확인 불가', na: '해당 없음' };

/* ── 회차(순수) ─────────────────────────────────────────────────────── */
/** 설정 정규화(순수). to 는 이메일 모양만(최대 20). */
export function normalizeReportSettings(input, prev = REPORT_DEFAULTS) {
  const src = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const out = { ...REPORT_DEFAULTS, ...(prev || {}) };
  if (Object.hasOwn(src, 'enabled')) out.enabled = src.enabled === true || src.enabled === 'true';
  if (Object.hasOwn(src, 'dayOfMonth')) { const d = numOrNull(src.dayOfMonth); if (d == null || !Number.isInteger(d) || d < 1 || d > 28) return { issue: 'dayOfMonth 는 1~28 입니다(29~31 은 달마다 없다)' }; out.dayOfMonth = d; }
  if (Object.hasOwn(src, 'time')) { const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(src.time || '').trim()); if (!m) return { issue: 'time 은 HH:MM 입니다' }; out.time = `${m[1]}:${m[2]}`; }
  if (Object.hasOwn(src, 'to')) {
    const list = Array.isArray(src.to) ? src.to : String(src.to || '').split(/[,\s;]+/);
    const to = [...new Set(list.map((x) => String(x || '').trim()).filter(Boolean))];
    if (to.some((x) => !/^[^\s@]{1,64}@[^\s@]{1,190}$/.test(x))) return { issue: '받는 사람 이메일 형식이 틀렸습니다' };
    out.to = to.slice(0, 20);
  }
  if (Object.hasOwn(src, 'topN')) { const n = numOrNull(src.topN); if (n == null || n < 1 || n > 50) return { issue: 'topN 은 1~50 입니다' }; out.topN = Math.floor(n); }
  return { settings: out };
}
/** now 이전(포함)의 마지막 월간 회차 시각(포탈 시각 기준). */
export function monthlySlot({ dayOfMonth = 1, time = '09:00' } = {}, now = Date.now(), offsetMin = DAY_OFFSET_MIN) {
  const [hh, mm] = String(time).split(':').map(Number);
  const off = offsetMin * 60_000;
  const local = new Date(now + off);
  const at = (y, m) => Date.UTC(y, m, dayOfMonth, hh || 0, mm || 0) - off;
  let slot = at(local.getUTCFullYear(), local.getUTCMonth());
  if (slot > now) slot = at(local.getUTCFullYear(), local.getUTCMonth() - 1);
  return slot;
}
/** 틱 계획(순수): none · send(slot) · missed(slot, reason down|late). lastSlot 이 미래면 시계 되돌림 → rebase. */
export function planMonthlyTick({ cfg, state = {}, now = Date.now(), bootAt = 0, offsetMin = DAY_OFFSET_MIN } = {}) {
  if (!cfg?.enabled) return { action: 'none' };
  const last = numOrNull(state?.lastSlot);
  if (last != null && last > now + 60_000) return { action: 'rebase', lastSlot: now, reason: 'clock' };
  const slot = monthlySlot(cfg, now, offsetMin);
  if (last != null && slot <= last) return { action: 'none' };
  if (slot < bootAt - 60_000) return { action: 'missed', slot, reason: 'down' };   // 포탈이 꺼져 있던 회차
  if (now - slot > REPORT_LATE_MS) return { action: 'missed', slot, reason: 'late' };
  return { action: 'send', slot };
}
export function monthLabelOf(slot, offsetMin = DAY_OFFSET_MIN) {
  const d = new Date(slot + offsetMin * 60_000);
  // 회차 당일의 '지난달' — 1일 09:00 회차면 전달 보고서다.
  const m = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1));
  return `${m.getUTCFullYear()}-${String(m.getUTCMonth() + 1).padStart(2, '0')}`;
}

/* ── 모델(순수) ─────────────────────────────────────────────────────── */
const gbps = (b) => (b == null ? null : Math.round((b * 8) / 1e8) / 10);
const rate = (b) => (b == null ? '—' : `${gbps(b).toFixed(1)} Gb/s`);
const pct = (p) => (p == null ? '—' : `${Math.round(p * 10) / 10}%`);
/**
 * @param {{rows:Array, total:object, now:number}} list buildListCore 결과(rows · total · now)
 * @param {{results:Array, summary:object, settings:object, items:Array}} check runCheck 결과
 */
export function buildReportModel(list, check, { now = Date.now(), monthLabel = '', topN = 10, portal = '' } = {}) {
  const rows = list?.rows || [];
  const results = check?.results || [];
  const sev = { bad: 0, warn: 1, unknown: 2, ok: 3, na: 4 };
  const sorted = [...results].sort((a, b) => (sev[a.overall] ?? 9) - (sev[b.overall] ?? 9) || String(a.datacenterName).localeCompare(String(b.datacenterName)) || String(a.name).localeCompare(String(b.name)));
  const byKey = new Map(rows.map((r) => [`${r.datacenterId}|${r.key}`, r]));
  const top = [...rows].filter((r) => r.avg24 != null).sort((a, b) => b.avg24 - a.avg24).slice(0, Math.max(1, topN))
    .map((r) => ({ name: r.name, dc: r.datacenterName, avg24: r.avg24, peak24: r.peak24, utilPct: r.utilPct, delta7d: r.delta7d, now: r.now?.bps ?? null }));
  const findings = [];
  for (const r of sorted) for (const [k, v] of Object.entries(r.items || {})) if (v.status === 'bad' || v.status === 'warn') findings.push({ name: r.name, dc: r.datacenterName, item: k, status: v.status, text: v.text });
  const arraySide = { withValues: results.filter((r) => r.arraySide?.keys?.length).length, total: results.length };
  const dcs = new Map();
  for (const r of sorted) { const g = dcs.get(r.datacenterName) || { dc: r.datacenterName, arrays: 0, bad: 0, warn: 0, ok: 0, unknown: 0 }; g.arrays += 1; g[r.overall] = (g[r.overall] || 0) + 1; dcs.set(r.datacenterName, g); }
  return {
    generatedAt: now, monthLabel, portal,
    totals: { arrays: rows.length, nowBps: list?.total?.nowBps ?? list?.total?.now?.bps ?? null, imbalance: rows.filter((r) => r.imbalance).length, unmeasured: rows.filter((r) => r.state !== 'ok' && r.state !== 'stale').length },
    summary: check?.summary || {}, items: (check?.items || CHECK_ITEMS).map((i) => ({ k: i.k, label: i.label, side: i.side })),
    results: sorted.map((r) => ({ key: r.key, name: r.name, dc: r.datacenterName, vendor: r.vendorLabel, overall: r.overall, uncheckedCount: r.uncheckedCount, items: r.items, row: byKey.get(`${r.datacenterId}|${r.key}`) ? { avg24: byKey.get(`${r.datacenterId}|${r.key}`).avg24, utilPct: byKey.get(`${r.datacenterId}|${r.key}`).utilPct } : null })),
    top, findings, arraySide, byDc: [...dcs.values()],
    thresholds: (check?.settings?.items || []).map((t) => ({ label: t.label, value: check.settings.values?.[t.k] ?? null, unit: t.unit, source: t.source, userSet: (check.settings.userSet || []).includes(t.k) })),   // 값은 settings.values(기본값 포함 · null = 비움) — items 에는 정의만 있다
  };
}

/* ── HTML(순수) ─────────────────────────────────────────────────────── */
export function renderReportHtml(m) {
  const dt = (ts) => (ts ? new Date(ts + DAY_OFFSET_MIN * 60_000).toISOString().replace('T', ' ').slice(0, 16) : '—');
  const mark = (s) => `<span style="color:${MARK_COLOR[s] || '#888'};font-weight:700" title="${STATUS_KO[s] || s}">${MARK[s] || '?'}</span>`;
  const th = (t, align = 'left') => `<th style="text-align:${align};padding:6px 8px;border-bottom:2px solid #d0d5dd;font-size:12px;color:#475467;white-space:nowrap">${esc(t)}</th>`;
  const td = (t, align = 'left', extra = '') => `<td style="text-align:${align};padding:6px 8px;border-bottom:1px solid #eaecf0;font-size:12.5px;${extra}">${t}</td>`;
  const s = m.summary || {};
  const items = m.items || [];
  const head = `<div style="display:flex;justify-content:space-between;align-items:flex-end;gap:16px;flex-wrap:wrap">
    <div><div style="font-size:12px;color:#667085">SAN 스토리지 성능 — 월간 점검 보고서${m.portal ? ` · ${esc(m.portal)}` : ''}</div>
    <h1 style="margin:4px 0 0;font-size:22px">${esc(m.monthLabel || '')} 월간 성능 점검</h1></div>
    <div style="font-size:12px;color:#667085">생성 ${dt(m.generatedAt)} (포탈 시각) · 어레이 ${m.totals?.arrays ?? 0}대 · 판정 기준 = 스위치 측 24시간 평균 + 어레이 측 최근 표본</div></div>`;
  const pills = [['정상', s.ok, '#199e70'], ['주의', s.warn, '#c98500'], ['이상', s.bad, '#d92d20'], ['확인 불가', s.unknown, '#8b9bb4'], ['정상(일부 미확인)', s.partiallyUnchecked, '#667085']]
    .map(([l, n, c]) => `<span style="display:inline-block;margin:0 8px 8px 0;padding:4px 10px;border-radius:999px;border:1px solid ${c};color:${c};font-size:12px;font-weight:600">${l} ${n ?? 0}</span>`).join('');
  const dcTable = `<table style="border-collapse:collapse;width:100%;margin:8px 0 16px"><thead><tr>${th('법인')}${th('어레이', 'right')}${th('이상', 'right')}${th('주의', 'right')}${th('정상', 'right')}${th('확인 불가', 'right')}</tr></thead><tbody>${
    (m.byDc || []).map((g) => `<tr>${td(esc(g.dc))}${td(g.arrays, 'right')}${td(g.bad || 0, 'right', g.bad ? 'color:#d92d20;font-weight:700' : '')}${td(g.warn || 0, 'right', g.warn ? 'color:#c98500;font-weight:700' : '')}${td(g.ok || 0, 'right')}${td(g.unknown || 0, 'right')}</tr>`).join('')}</tbody></table>`;
  const judge = `<table style="border-collapse:collapse;width:100%"><thead><tr>${th('법인')}${th('스토리지')}${items.map((i) => th(i.label, 'center')).join('')}${th('종합')}</tr></thead><tbody>${
    (m.results || []).map((r) => `<tr>${td(esc(r.dc))}${td(`<b>${esc(r.name)}</b><div style="font-size:11px;color:#667085">${esc(r.vendor || '')}</div>`)}${items.map((i) => td(mark(r.items?.[i.k]?.status || 'na'), 'center')).join('')}${td(`${mark(r.overall)} ${STATUS_KO[r.overall] || r.overall}${r.uncheckedCount ? `<span style="color:#667085"> (미확인 ${r.uncheckedCount})</span>` : ''}`)}</tr>`).join('')}</tbody></table>
    <div style="font-size:11px;color:#667085;margin-top:6px">● 정상 · ▲ 주의 · ✕ 이상 · ? 확인 불가(값은 보이되 기준이 없거나 표본이 없음) · — 해당 없음. 확인 불가는 정상이 아니다.</div>`;
  const findings = (m.findings || []).length ? `<table style="border-collapse:collapse;width:100%"><thead><tr>${th('상태')}${th('법인')}${th('스토리지')}${th('항목')}${th('내용')}</tr></thead><tbody>${
    m.findings.map((f) => `<tr>${td(`${mark(f.status)} ${STATUS_KO[f.status]}`)}${td(esc(f.dc))}${td(esc(f.name))}${td(esc((items.find((i) => i.k === f.item) || {}).label || f.item))}${td(esc(f.text))}</tr>`).join('')}</tbody></table>` : '<div style="color:#667085;font-size:12.5px">주의 · 이상 항목이 없습니다.</div>';
  const top = `<table style="border-collapse:collapse;width:100%"><thead><tr>${th('#', 'right')}${th('스토리지')}${th('법인')}${th('24시간 평균', 'right')}${th('24시간 피크', 'right')}${th('회선 사용률', 'right')}${th('7일 대비', 'right')}</tr></thead><tbody>${
    (m.top || []).map((t, i) => `<tr>${td(i + 1, 'right')}${td(`<b>${esc(t.name)}</b>`)}${td(esc(t.dc))}${td(rate(t.avg24), 'right')}${td(rate(t.peak24), 'right')}${td(pct(t.utilPct), 'right')}${td(t.delta7d == null ? '—' : `${t.delta7d > 0 ? '+' : ''}${t.delta7d}%`, 'right')}</tr>`).join('')}</tbody></table>`;
  const thr = `<table style="border-collapse:collapse;width:100%"><thead><tr>${th('기준')}${th('값', 'right')}${th('출처')}</tr></thead><tbody>${
    (m.thresholds || []).map((t) => `<tr>${td(esc(t.label))}${td(t.value == null ? '비움(판정 안 함)' : `${esc(t.value)}${esc(t.unit || '')}${t.userSet ? ' <span style="color:#2e90fa">(사용자 설정)</span>' : ''}`, 'right')}${td(`<span style="font-size:11.5px;color:#667085">${esc(t.source || '')}</span>`)}</tr>`).join('')}</tbody></table>`;
  const sec = (title, body, sub = '') => `<section style="margin:22px 0;break-inside:avoid"><h2 style="font-size:15px;margin:0 0 6px">${esc(title)}</h2>${sub ? `<div style="font-size:12px;color:#667085;margin-bottom:8px">${esc(sub)}</div>` : ''}<div style="overflow-x:auto">${body}</div></section>`;   // 좁은 화면(메일 앱)에서는 표가 절 안에서 가로 스크롤 — 페이지가 넘치지 않는다
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>SAN 스토리지 성능 월간 점검 ${esc(m.monthLabel || '')}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Malgun Gothic','Apple SD Gothic Neo',sans-serif;color:#101828;margin:0;padding:24px;background:#fff;max-width:1100px}
@media print{body{padding:0} section{break-inside:avoid} .noprint{display:none}}
table{page-break-inside:auto} tr{page-break-inside:avoid}</style></head><body>
${head}
<div class="noprint" style="margin:10px 0 0;font-size:12px;color:#667085">브라우저 인쇄(Ctrl+P) → 'PDF 로 저장' 으로 PDF 를 만들 수 있습니다. 이 파일은 자급형(이미지 · 외부 자원 없음)입니다.</div>
${sec('요약', `<div style="margin:8px 0 4px">${pills}</div><div style="font-size:12.5px;color:#475467">지금 합계 ${rate(m.totals?.nowBps)} · 편중 ${m.totals?.imbalance ?? 0}건 · 측정 없음 · 미보고 ${m.totals?.unmeasured ?? 0}대 · 어레이 측 값이 붙은 어레이 ${m.arraySide?.withValues ?? 0}/${m.arraySide?.total ?? 0}</div>${dcTable}`)}
${sec('주의 · 이상 항목', findings, '상태가 정상이 아닌 항목만 — 원인은 단정하지 않습니다(화면의 도움말 · 디렉터별 보기로 확인).')}
${sec('판정표', judge, '스위치 측 4항목(편중 · 팹 비대칭 · 회선 포화 · 수집 상태) + 어레이 측 5항목(디렉터 busy · 응답 시간 · 큐 깊이 · 노드/SP CPU · 보고 대조)')}
${sec(`상위 어레이 처리량 ${(m.top || []).length}`, top, '24시간 평균 기준(어레이 포트 송수신 합 · 팹 A/B 합산 · 부분 합 제외)')}
${sec('판정 기준', thr, '기본값은 벤더 문서 값만 — 못 찾은 항목은 비움(판정 안 함).')}
<div style="margin-top:28px;font-size:11px;color:#98a2b3">생성: VMware Global Monitoring Portal · SAN 스토리지 성능(san-storage) · 값이 없으면 '—'(0 이 아닙니다).</div>
</body></html>`;
}
/** 메일 본문(짧은 요약 HTML) · 첨부 파일 이름. */
export function reportMailParts(m) {
  const s = m.summary || {};
  const subject = `[SAN 스토리지 성능] ${m.monthLabel} 월간 점검 — 이상 ${s.bad ?? 0} · 주의 ${s.warn ?? 0} · 확인 불가 ${s.unknown ?? 0} (어레이 ${m.totals?.arrays ?? 0})`;
  const text = `${m.monthLabel} 월간 SAN 스토리지 성능 점검 보고서입니다.\n어레이 ${m.totals?.arrays ?? 0} · 정상 ${s.ok ?? 0} · 주의 ${s.warn ?? 0} · 이상 ${s.bad ?? 0} · 확인 불가 ${s.unknown ?? 0}\n첨부한 HTML 을 브라우저로 열고 인쇄 → PDF 로 저장하면 PDF 가 됩니다.`;
  const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Malgun Gothic',sans-serif;font-size:14px;color:#101828"><p>${esc(m.monthLabel)} 월간 SAN 스토리지 성능 점검 보고서입니다.</p>
<p>어레이 <b>${m.totals?.arrays ?? 0}</b> · 정상 ${s.ok ?? 0} · 주의 <b style="color:#c98500">${s.warn ?? 0}</b> · 이상 <b style="color:#d92d20">${s.bad ?? 0}</b> · 확인 불가 ${s.unknown ?? 0}</p>
${(m.findings || []).slice(0, 12).map((f) => `<div style="font-size:13px">${MARK[f.status]} ${esc(f.dc)} · <b>${esc(f.name)}</b> · ${esc(f.text)}</div>`).join('')}
<p style="color:#667085;font-size:12px">첨부한 HTML 보고서를 브라우저로 열고 인쇄(Ctrl+P) → 'PDF 로 저장' 하면 PDF 가 됩니다(이번 판은 PDF 를 직접 만들지 않습니다 — 한글 글꼴 동봉이 필요).</p></div>`;
  return { subject, text, html, filename: `san-storage-report_${m.monthLabel || 'now'}.html` };
}
