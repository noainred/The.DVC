/**
 * storage/usageMailRules.js — 스토리지 사용량 **예약 메일**의 순수 규칙·본문(v2.789). 파일·타이머·발송 없음.
 *
 * 사용자 요청(2026-10-26): "사용자가 지정한 시간에 전체 사용량을 사용자에게 이메일로 발송하는 기능 추가".
 *
 * ── 일정·받는 사람은 아이실론 종합 메일(v2.742)의 규칙을 **그대로 쓴다**(사본 금지 — '코어는 하나') ──────────
 *  · 일정: 정한 요일·시각(포탈 시각, 기본 한국 시각). '지금 이전의 가장 최근 회차' 하나만 보고, 30분 안이면 보내고 넘으면 놓침으로 남긴다
 *    (몰아서 보내지 않는다) — `isidu/digestRules.planDigestTick` 이 `enabled·days·time·since` 만 읽으므로 그 함수에 이 설정을 넘긴다.
 *  · 받는 사람: 통합 관리자(메일 설정의 기본 받는 사람 — 고르면) ∪ 추가 주소, 같은 주소는 한 번(`digestRecipients`).
 *  · 형식이 틀린 주소·켰는데 요일 없음·시각 형식 오류는 **저장하지 않고 400**(조용히 고치면 정한 값이 사라진다).
 *  · `since` 는 서버가 정한다(켜거나 요일·시각을 바꾼 시각) — 저장하자마자 오늘 지난 회차를 소급 발송하지 않는다.
 *
 * ── 본문 ────────────────────────────────────────────────────────────────────
 *  · 숫자는 화면(`/tools/storage-usage`)과 **같은 조회**(`usageData.loadUsageReport`)와 같은 합계(`usageReport.aggregateCells`)로 만든다.
 *  · 부분 합은 표지를 단다('값 있음 N/M대') · 기준일에 관측이 없어 이전 관측을 쓴 칸은 '≈' 와 관측일 · 값이 없으면 '—'(0 이 아니다).
 *  · 표 레이아웃 · 인라인 스타일 · 모든 값 이스케이프. 포탈 주소 설정이 없으므로 링크 대신 메뉴 경로를 글로 적는다(아이실론 메일과 같은 판단).
 *
 * ── v2.791(사용자 요청 "메일 발송을 Excel 형식으로 … 누적된 모든 주간 사용량 … 관리자가 실제로 사용할 수 있는 데이터를 첨부") ─────
 *  · 본문은 승인된 캔버스 시안(https://claude.ai/artifact/8CD6gZbSab7UBo1RZ6spTW ① 메일 본문)의 구성이다 — 첨부 안내 · 핵심 지표 ·
 *    조치가 필요한 항목 · 지난주 증가량 상위 5 · PowerScale 풀별 · 법인별 요약 · 이번 주 값을 못 읽은 장비. 판단은 `usageInsights.js` 하나.
 *  · 본문은 항상 **주간(ISO 주차)** 이다 — 예전 설정의 표 단위·추이 기간 수·장비별 표(gran·count·includeDevices)는 쓰지 않는다
 *    (저장 파일에 남아 있어도 읽지 않는다 — 전 주차와 장비별 값은 첨부 엑셀이 담는다).
 *  · 첨부(attachExcel, 기본 켬)는 누적된 전 주차 엑셀(`usageXlsx.js`)이다. 공용 SMTP 첨부 상한을 넘으면 데이터 시트만 최근 주로 줄이고,
 *    그래도 넘거나 만들지 못하면 첨부 없이 보내며 **본문이 그 사실을 밝힌다**(조용히 빼지 않는다).
 */
import { numOrNull } from '../util/numOrNull.js';
import { normalizeMailList, isEmail, MAIL_LIST_MAX } from '../isidu/mailRules.js';
import { TIME_RE, daysLabel, slotLabel } from '../isidu/digestRules.js';
import { buildInsights } from './usageInsights.js';

export const VIEW_PATH = '특수 기능 › 스토리지 사용량 보고서';
export const MAIL_KIND = 'storage-usage';
export const MAIL_HISTORY_MAX = 20;
/** 본문 '조치가 필요한 항목' 의 최대 줄 수 — 나머지는 첨부 엑셀 '요약' 시트에(본문이 그 수를 밝힌다). */
export const MAIL_ACTIONS_MAX = 12;
/** 보내지 않은 사유 — 웹 `storageUsageText.SKIP_TEXT` 와 1:1(웹 테스트가 이 소스에서 뽑아 대조). */
export const SKIP_CODES = Object.freeze(['no-recipients', 'no-devices', 'mail-off', 'auth-stopped', 'unreadable', 'db-off']);

export const MAIL_DEFAULTS = Object.freeze({
  enabled: false, days: Object.freeze([1]), time: '08:00', includeAdmin: true, to: Object.freeze([]),
  attachExcel: true, includeResources: true, since: null,
});

const intDays = (v) => [...new Set((Array.isArray(v) ? v : []).map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6))].sort((a, b) => a - b);

/** 저장된 설정(빈 값 보정). 순수. */
export function mailOf(raw) {
  const d = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const since = numOrNull(d.since);
  return {
    enabled: d.enabled === true,
    days: Array.isArray(d.days) ? intDays(d.days) : [...MAIL_DEFAULTS.days],
    time: TIME_RE.test(String(d.time || '')) ? String(d.time) : MAIL_DEFAULTS.time,
    includeAdmin: d.includeAdmin !== false,
    to: (Array.isArray(d.to) ? d.to : []).filter(isEmail).slice(0, MAIL_LIST_MAX),
    attachExcel: d.attachExcel !== false,
    includeResources: d.includeResources !== false,
    since: since != null && since > 0 ? since : null,
  };
}

/**
 * 저장 경로 정규화 — 문제가 있으면 `{error, field}`. 빠진 칸은 이전 값(부분 요청이 끄지 않게).
 * @param {unknown} input
 * @param {object|null} prev
 */
export function normalizeMail(input, prev, now = Date.now()) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { error: '메일 설정 형식이 잘못됐습니다.', field: 'mail' };
  const p = mailOf(prev);
  const enabled = typeof input.enabled === 'boolean' ? input.enabled : p.enabled;
  const days = Array.isArray(input.days) ? intDays(input.days) : p.days;
  if (enabled && !days.length) return { error: '메일을 보낼 요일을 하나 이상 고르세요.', field: 'mail.days' };
  const time = input.time == null ? p.time : String(input.time).trim();
  if (!TIME_RE.test(time)) return { error: '보내는 시각은 00:00~23:59 형식이어야 합니다.', field: 'mail.time' };
  const to = input.to == null ? { list: p.to, invalid: [], over: 0 } : normalizeMailList(input.to);
  if (to.invalid.length) return { error: `추가 받는 사람 주소 형식이 잘못됐습니다: ${to.invalid.slice(0, 3).join(', ')}${to.invalid.length > 3 ? ` 외 ${to.invalid.length - 3}개` : ''}`, field: 'mail.to' };
  if (to.over) return { error: `추가 받는 사람은 ${MAIL_LIST_MAX}명까지입니다(${to.over}명 초과).`, field: 'mail.to' };
  const flag = (k) => (typeof input[k] === 'boolean' ? input[k] : p[k]);
  const out = {
    enabled, days, time, includeAdmin: flag('includeAdmin'), to: to.list,
    attachExcel: flag('attachExcel'), includeResources: flag('includeResources'), since: p.since,
  };
  const sameDef = p.enabled && JSON.stringify(p.days) === JSON.stringify(out.days) && p.time === out.time;
  if (enabled && !(sameDef && p.since)) out.since = now;
  if (!enabled) out.since = null;
  return { mail: out };
}

/* ───────────────────────────── 본문 ───────────────────────────── */

export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** 바이트 → '282.8 TB' · '6.1 PB' · '600.0 GB'(1024 단위 — 장비 표기와 같다). 못 읽으면 '—'. */
export function bytesText(b) {
  const n = numOrNull(b);
  if (n == null) return '—';
  const TB = 1024 ** 4;
  if (Math.abs(n) >= 1024 * TB) return `${(n / (1024 * TB)).toFixed(1)} PB`;
  if (Math.abs(n) >= TB) return `${(n / TB).toFixed(1)} TB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}
export function deltaText(d) {
  const n = numOrNull(d);
  if (n == null) return '—';
  if (n === 0) return '0';
  return `${n > 0 ? '+' : '−'}${bytesText(Math.abs(n))}`;
}
export const pctText = (p) => (numOrNull(p) == null ? '—' : `${Number(p).toFixed(1)}%`);

/**
 * 메일 모델(순수) — 주간 보고표(loadUsageReport 의 ok 결과 · 전체 누적)에서 만든다. 판단은 `usageInsights.buildInsights` 하나(첨부 엑셀과 같은 숫자).
 */
export function buildMailModel(rep, { includeResources = true } = {}) {
  const ins = buildInsights(rep, { includeResources });
  return { ...ins, asOfLabel: rep.asOfLabel, devices: ins.kpi.devices, registered: ins.kpi.registered };
}

const FONT = "'Malgun Gothic','Apple SD Gothic Neo',-apple-system,'Segoe UI',sans-serif";
const TD = 'padding:7px 8px;border-bottom:1px solid #e2e8f0;font-size:13px;vertical-align:top;';
const TH = 'padding:7px 8px;border-bottom:1px solid #cbd5e1;font-size:12px;color:#334155;text-align:left;background:#f8fafc;';
const NUM = 'text-align:right;white-space:nowrap;';
const MUTED = 'color:#475569;';
const TONE = { crit: { bg: '#fee2e2', fg: '#991b1b' }, warn: { bg: '#fef3c7', fg: '#92400e' } };
/*
 * 좁은 화면(모바일 메일) — 520px 이하에서 여백·글자를 줄이고 지표 칸을 세로로 쌓는다(아이실론 종합 메일 v2.742 와 같은 판단:
 * Outlook 데스크톱은 @media 를 무시하지만 그쪽은 폭이 넓다).
 */
// ⚠ v2.791 Chromium 확인: 셀의 nowrap 이 좁은 폭에서 표를 카드보다 넓게 만들어(풀별 표 411px · 400px 화면에서 SSD 풀 열 잘림)
//   — 좁은 화면에서는 줄바꿈을 허용한다(인라인 nowrap 을 !important 로 덮는다). 카드는 overflow 를 숨기지 않는다(잘림을 숨기지 않게).
const MOBILE_CSS = '<style>@media only screen and (max-width:520px){.su-wrap{padding:8px!important}.su-body{padding:12px!important}'
  + '.su-t td,.su-t th{padding:4px 3px!important;font-size:11px!important;white-space:normal!important;word-break:break-word}'
  + '.su-kpi td{display:block!important;width:auto!important;margin-bottom:6px}}</style>';

function pctBadge(p, rule) {
  const n = numOrNull(p);
  if (n == null) return '—';
  const t = n >= rule.critPct ? TONE.crit : n >= rule.warnPct ? TONE.warn : null;
  // 배지는 쪼개지지 않게(좁은 화면의 줄바꿈 허용이 '84.0' / '%' 로 나누지 않게 — v2.791 Chromium)
  return t ? `<span style="display:inline-block;white-space:nowrap;padding:1px 6px;border-radius:4px;background:${t.bg};color:${t.fg};font-weight:700">${esc(pctText(n))}</span>` : `<span style="white-space:nowrap">${esc(pctText(n))}</span>`;
}
const table = (head, body) => `<table class="su-t" role="presentation" cellspacing="0" cellpadding="0" style="border-collapse:collapse;width:100%">${head}${body}</table>`;
const h2 = (t) => `<h2 style="margin:22px 0 6px;font-size:16px">${esc(t)}</h2>`;
const note = (t, color = '#475569') => `<div style="font-size:12px;color:${color};margin:0 0 6px">${t}</div>`;
const usedOf = (c) => (c ? `${bytesText(c.usedBytes)} / ${bytesText(c.totalBytes)}` : '—');

/**
 * 본문(순수). @returns {{subject:string, html:string, text:string}}
 * @param {object} m buildMailModel 결과
 * @param {{mail?:object, slot?:number, manual?:boolean, preview?:boolean, recipients?:number,
 *   attach?:{state:'attached'|'trimmed'|'failed'|'off'|'preview', filename?:string, reason?:string, fromLabel?:string}}} o
 */
export function renderUsageMail(m, o = {}) {
  const g = mailOf(o.mail);
  const rule = m.rule;
  const k = m.kpi;
  const t = m.total.cur;
  const subject = `${o.preview ? '[미리보기] ' : ''}스토리지 사용량 주간 보고 — ${m.weekLabel} (${m.dayLabel})`;
  const at = o.attach || { state: g.attachExcel ? 'preview' : 'off' };
  const sheets = ['요약', `주간 사용량 (${m.firstLabel} ~ ${m.weekLabel})`, '법인별 · 종류별', '데이터 (행 단위)', '읽는 법'];
  const chips = sheets.map((x) => `<span style="display:inline-block;font-size:12px;padding:2px 8px;margin:2px 4px 2px 0;border-radius:4px;background:#ffffff;border:1px solid #cbd5e1;color:#1e293b">${esc(x)}</span>`).join('');
  let attachBox = '';
  if (at.state === 'attached' || at.state === 'trimmed' || at.state === 'preview') {
    attachBox = `<table role="presentation" cellspacing="0" cellpadding="0" style="width:100%;border:1px solid #bfdbfe;background:#eff6ff;border-radius:8px"><tr><td style="padding:14px 16px">`
      + `<div style="font-weight:700;font-size:14px">${at.state === 'preview' ? '보낼 때 붙이는 엑셀' : '첨부 엑셀'} — ${esc(at.filename || '')}</div>`
      + `<div style="font-size:13px;color:#334155;margin-top:4px">누적된 전 주차(${esc(m.firstLabel)} ~ ${esc(m.weekLabel)})를 포탈 표와 같은 모양으로 담았습니다.</div>`
      + `<div style="margin-top:6px">${chips}</div>`
      + (at.state === 'trimmed' ? `<div style="font-size:12px;color:#92400e;margin-top:6px">${esc(at.reason || '')}</div>` : '')
      + (at.state === 'preview' ? '<div style="font-size:12px;color:#475569;margin-top:6px">미리보기에는 첨부를 만들지 않습니다.</div>' : '')
      + '</td></tr></table>';
  } else if (at.state === 'failed') {
    attachBox = `<table role="presentation" cellspacing="0" cellpadding="0" style="width:100%;border:1px solid #fde68a;background:#fffbeb;border-radius:8px"><tr><td style="padding:12px 16px;font-size:13px">`
      + `<b>엑셀을 붙이지 못했습니다</b> — ${esc(at.reason || '알 수 없는 오류')}. 포탈 › ${esc(VIEW_PATH)} 의 ‘엑셀 내려받기’ 로 같은 파일을 받을 수 있습니다.</td></tr></table>`;
  }
  const kpi = (label, value, sub, color = '#0f172a') => `<td style="width:25%;padding:12px;border:1px solid #e2e8f0;border-radius:8px;vertical-align:top">`
    + `<div style="font-size:12px;${MUTED}">${esc(label)}</div><div style="font-size:20px;font-weight:700;color:${color};margin-top:2px">${esc(value)}</div>`
    + `<div style="font-size:12px;${MUTED}margin-top:2px">${esc(sub)}</div></td>`;
  const deltaSub = m.total.delta == null
    ? (m.total.deltaWhy === 'partial' ? '부분 합이라 내지 않음' : '값 없음')
    : (m.total.avg != null ? `${rule.avgWeeks}주 평균 ${deltaText(m.total.avg)}/주` : `${rule.avgWeeks}주 평균은 이력 부족`);
  const kpis = `<table class="su-kpi" role="presentation" cellspacing="8" cellpadding="0" style="width:100%;margin:6px -8px 0"><tr>`
    + kpi('전체 사용률', pctText(t?.pct), t ? `${usedOf(t)}${t.partial ? ` · 값 있음 ${t.counted}/${t.expected}대` : ''}` : '값 없음')
    + kpi('직전 주 대비', deltaText(m.total.delta), deltaSub, '#9a3412')
    + kpi(`${rule.warnPct}% 이상`, `${k.warnDevices}대`, `그중 ${rule.critPct}% 이상 ${k.critDevices}대 · 풀·LUN 포함 ${k.warnItems}항목`, k.warnDevices ? '#991b1b' : '#0f172a')
    + kpi('못 읽음', `${k.missing}대`, k.missing ? '합계에서 뺐습니다' : '이번 주 모두 읽음', k.missing ? '#92400e' : '#0f172a')
    + '</tr></table>';

  const actRows = m.actions.slice(0, MAIL_ACTIONS_MAX).map((e) => {
    const c = e.trend.cur;
    const free = c && c.usedBytes != null ? c.totalBytes - c.usedBytes : null;
    return `<tr><td style="${TD}font-weight:600">${esc(e.name)}</td><td style="${TD}${MUTED}">${esc(e.corp)} · ${esc(e.typeLabel)}</td>`
      + `<td style="${TD}${NUM}">${pctBadge(c?.pct, rule)}</td><td style="${TD}${NUM}">${esc(deltaText(e.trend.delta))}</td>`
      + `<td style="${TD}${NUM}">${esc(bytesText(free))}</td><td style="${TD}">${esc(e.eta90)}</td></tr>`;
  }).join('');
  const actions = h2('조치가 필요한 항목')
    + note(`사용률 ${rule.warnPct}% 이상이거나, 최근 ${rule.avgWeeks}주 증가 추세로 ${rule.horizonWeeks}주 안에 ${rule.critPct}%에 닿는 장비·풀·LUN·파일시스템(급한 순). 도달 예상은 완전한 주만으로 계산한 직선 추정입니다.`)
    + (m.actions.length
      ? table(`<tr><th style="${TH}">장비 · 항목</th><th style="${TH}">법인 · 종류</th><th style="${TH}${NUM}">사용률</th><th style="${TH}${NUM}">지난주 증가</th><th style="${TH}${NUM}">남은 용량</th><th style="${TH}">${rule.critPct}% 도달 예상</th></tr>`, actRows)
        + (m.actions.length > MAIL_ACTIONS_MAX ? note(`외 ${m.actions.length - MAIL_ACTIONS_MAX}개는 첨부 엑셀 ‘요약’ 시트에 있습니다.`) : '')
      : note('없습니다.'));

  const growth = h2(`지난주 증가량 상위 ${m.growthTop.length || ''}`.trim())
    + (m.growthTop.length
      ? table(`<tr><th style="${TH}">장비</th><th style="${TH}">법인</th><th style="${TH}${NUM}">${esc(m.prevLabel.replace(/^\d{4}년 /, ''))} 사용</th><th style="${TH}${NUM}">${esc(m.weekLabel.replace(/^\d{4}년 /, ''))} 사용</th><th style="${TH}${NUM}">증가</th><th style="${TH}${NUM}">${rule.avgWeeks}주 평균</th></tr>`,
        m.growthTop.map((e) => `<tr><td style="${TD}font-weight:600">${esc(e.name)}</td><td style="${TD}${MUTED}">${esc(e.corp)}</td>`
          + `<td style="${TD}${NUM}">${esc(bytesText(e.trend.prev?.usedBytes))}</td><td style="${TD}${NUM}">${esc(bytesText(e.trend.cur?.usedBytes))}</td>`
          + `<td style="${TD}${NUM}font-weight:700;color:#9a3412">${esc(deltaText(e.trend.delta))}</td><td style="${TD}${NUM}${MUTED}">${esc(deltaText(e.trend.avg))}</td></tr>`).join(''))
      : note('지난주보다 늘어난 장비가 없거나, 두 주 값이 다 있는 장비가 없습니다.'));

  const poolCell = (pe, missingNote) => {
    if (!pe) return `<div style="font-weight:600;color:#475569">${esc(missingNote)}</div><div style="font-size:12px;${MUTED}">—</div>`;
    const c = pe.trend.cur;
    return `<div style="font-weight:600">${pctBadge(c?.pct, rule)}</div><div style="font-size:12px;${MUTED}">${c ? esc(usedOf(c)) : '풀 사용량 못 읽음'}</div>`;
  };
  const pools = m.poolRows.length
    ? h2('PowerScale(아이실론) 풀별 사용량')
      + note('HDD 풀과 SSD 풀을 따로 셉니다. 한 매체의 풀만 있는 장비(올플래시, 또는 SSD 를 L3 캐시로만 쓰는 구성)는 다른 쪽을 0 이 아니라 ‘풀 없음’ 으로 적습니다.')
      + table(`<tr><th style="${TH}">장비</th><th style="${TH}${NUM}">전체</th><th style="${TH}${NUM}">HDD 풀</th><th style="${TH}${NUM}">SSD 풀</th></tr>`,
        m.poolRows.map((r) => {
          const a = r.device.trend.cur;
          return `<tr><td style="${TD}"><div style="font-weight:600">${esc(r.device.name)}</div><div style="font-size:12px;${MUTED}">${esc(r.device.corp)}${r.note ? ` · ${esc(r.note)}` : ''}</div></td>`
            + `<td style="${TD}${NUM}"><div>${pctBadge(a?.pct, rule)}</div><div style="font-size:12px;${MUTED}">${esc(usedOf(a))}</div></td>`
            + `<td style="${TD}${NUM}">${poolCell(r.hdd, r.note === 'SSD 풀만' ? '풀 없음' : '—')}</td>`
            + `<td style="${TD}${NUM}">${poolCell(r.ssd, r.note === 'HDD 풀만' ? '풀 없음' : '—')}</td></tr>`;
        }).join(''))
    : '';

  const partials = m.byCorp.filter((x) => x.cur?.partial);
  const corps = h2('법인별 요약')
    + table(`<tr><th style="${TH}">법인</th><th style="${TH}${NUM}">장비</th><th style="${TH}${NUM}">사용 / 전체</th><th style="${TH}${NUM}">사용률</th><th style="${TH}${NUM}">직전 주 대비</th></tr>`,
      m.byCorp.map((x) => `<tr><td style="${TD}font-weight:600">${esc(x.key)}</td><td style="${TD}${NUM}">${x.devices}대</td>`
        + `<td style="${TD}${NUM}">${esc(usedOf(x.cur))}${x.cur?.partial ? ` <span style="color:#b45309">(값 있음 ${x.cur.counted}/${x.cur.expected}대)</span>` : ''}</td>`
        + `<td style="${TD}${NUM}">${pctBadge(x.cur?.pct, rule)}</td><td style="${TD}${NUM}">${x.delta == null && x.deltaWhy === 'partial' ? '— (부분 합)' : esc(deltaText(x.delta))}</td></tr>`).join(''))
    + (partials.length ? note(`${partials.map((x) => esc(x.key)).join(', ')} 는 이번 주에 값을 읽지 못한 장비가 있어 부분 합입니다 — 직전 주 대비를 내지 않았습니다.`, '#92400e') : '');

  const missing = m.missing.length
    ? h2('이번 주 값을 읽지 못한 장비')
      + `<table role="presentation" cellspacing="0" cellpadding="0" style="width:100%;border:1px solid #fde68a;background:#fffbeb;border-radius:8px"><tr><td style="padding:10px 14px">`
      + m.missing.map((x) => `<div style="font-size:13px;margin:2px 0"><b>${esc(x.name)}</b> · ${esc(x.corp)} · ${esc(x.typeLabel)} — ${esc(x.why)}</div>`).join('')
      + '</td></tr></table>'
    : '';

  const sched = g.enabled ? `${daysLabel(g.days)} ${g.time}` : '꺼짐';
  const top = o.preview ? '미리보기 — 보내지 않았습니다' : (o.manual ? '지금 보내기' : `예약 발송 · ${slotLabel(o.slot)}`);
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${MOBILE_CSS}</head>`
    + `<body class="su-wrap" style="margin:0;padding:24px;background:#f1f5f9;font-family:${FONT};color:#0f172a;line-height:1.5">`
    + '<div style="max-width:720px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:10px">'
    + `<div class="su-body" style="padding:22px 26px 18px;border-bottom:1px solid #e2e8f0">`
    + `<div style="font-size:12px;${MUTED}">VMware Global Monitoring Portal · 스토리지 사용량 예약 메일 · ${esc(top)}</div>`
    + `<h1 style="margin:4px 0;font-size:22px">스토리지 사용량 주간 보고 — ${esc(m.weekLabel)}</h1>`
    + `<div style="font-size:13px;${MUTED}">기준 ${esc(m.dayLabel)} · ISO 주차(월요일 시작) · 장비 ${m.devices}대 · 법인 ${k.corps}곳${m.registered > m.devices ? ` · 등록 ${m.registered}대 중 이력 있는 장비` : ''}</div>`
    + '</div>'
    + `<div class="su-body" style="padding:20px 26px">${attachBox}${kpis}${actions}${growth}${pools}${corps}${missing}</div>`
    + `<div class="su-body" style="padding:14px 26px;background:#f8fafc;border-top:1px solid #e2e8f0;border-radius:0 0 10px 10px;font-size:12px;${MUTED}">`
    + '<div>— 는 값을 못 읽은 칸입니다(0 이 아닙니다). 부분 합(값 있음 N/M대)은 직전 주 대비·추세 계산에서 뺍니다. 단위는 1024 기준(TB = 1024⁴ 바이트)입니다.</div>'
    + `<div style="margin-top:4px">포탈 › ${esc(VIEW_PATH)} 에서 같은 표·CSV·엑셀을 볼 수 있습니다. 보내는 때: ${esc(sched)} · 받는 사람 ${numOrNull(o.recipients) == null ? '—' : `${numOrNull(o.recipients)}명`} · 설정: ${esc(VIEW_PATH)} › 메일 발송</div>`
    + '</div></div></body></html>';

  const lines = [subject, '',
    `전체 ${usedOf(t)} (${pctText(t?.pct)}) · 직전 주 대비 ${deltaText(m.total.delta)} · ${rule.warnPct}% 이상 ${k.warnDevices}대 · 못 읽음 ${k.missing}대`];
  if (at.state === 'attached' || at.state === 'trimmed') lines.push(`첨부: ${at.filename}`);
  if (at.state === 'failed') lines.push(`엑셀을 붙이지 못했습니다 — ${at.reason || ''}`);
  if (m.actions.length) {
    lines.push('', '조치가 필요한 항목:');
    for (const e of m.actions.slice(0, MAIL_ACTIONS_MAX)) lines.push(`- ${e.name} (${e.corp}) ${pctText(e.trend.cur?.pct)} · ${rule.critPct}% 도달 ${e.eta90}`);
  }
  lines.push('', ...m.byCorp.map((x) => `- ${x.key}: ${usedOf(x.cur)} (${pctText(x.cur?.pct)})`), '', `자세한 표·엑셀: ${VIEW_PATH}`);
  return { subject, html, text: lines.join('\n') };
}
