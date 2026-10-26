/**
 * storage/usageMailRules.js — 스토리지 사용량 **예약 메일**의 순수 규칙·본문(v2.788). 파일·타이머·발송 없음.
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
 *  · 메일에는 CSV 를 붙이지 않는다(공용 SMTP 모듈에 첨부 기능이 없다) — 본문이 화면의 CSV 내려받기 위치를 알려 준다.
 */
import { numOrNull } from '../util/numOrNull.js';
import { normalizeMailList, isEmail, MAIL_LIST_MAX } from '../isidu/mailRules.js';
import { TIME_RE, daysLabel, slotLabel } from '../isidu/digestRules.js';
import { GRANS, aggregateCells, deltaOf } from './usageReport.js';
import { RESOURCE_KINDS } from './resources.js';

export const VIEW_PATH = '특수 기능 › 스토리지 사용량 보고서';
export const MAIL_KIND = 'storage-usage';
export const MAIL_HISTORY_MAX = 20;
/** 추이 표의 기간 수 범위 — 웹 설정 폼이 이 값으로 고른다. */
export const TREND_RANGE = Object.freeze({ min: 2, max: 12, def: 5 });
/** 보내지 않은 사유 — 웹 `storageUsageText.SKIP_TEXT` 와 1:1(웹 테스트가 이 소스에서 뽑아 대조). */
export const SKIP_CODES = Object.freeze(['no-recipients', 'no-devices', 'mail-off', 'auth-stopped', 'unreadable', 'db-off']);

export const MAIL_DEFAULTS = Object.freeze({
  enabled: false, days: Object.freeze([1]), time: '08:00', includeAdmin: true, to: Object.freeze([]),
  gran: 'weekly', count: TREND_RANGE.def, includeDevices: true, includeResources: false, since: null,
});

const intDays = (v) => [...new Set((Array.isArray(v) ? v : []).map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6))].sort((a, b) => a - b);
const intIn = (v, r) => { const n = numOrNull(v); return n != null && Number.isInteger(n) && n >= r.min && n <= r.max ? n : null; };

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
    gran: Object.hasOwn(GRANS, String(d.gran || '')) ? String(d.gran) : MAIL_DEFAULTS.gran,
    count: intIn(d.count, TREND_RANGE) ?? TREND_RANGE.def,
    includeDevices: d.includeDevices !== false,
    includeResources: d.includeResources === true,
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
  let gran = p.gran;
  if (input.gran != null) {
    if (!Object.hasOwn(GRANS, String(input.gran))) return { error: '표 단위는 일간·주간·월간 중 하나여야 합니다.', field: 'mail.gran' };
    gran = String(input.gran);
  }
  let count = p.count;
  if (input.count != null && String(input.count).trim() !== '') {
    const n = intIn(input.count, TREND_RANGE);
    if (n == null) return { error: `추이 기간 수는 ${TREND_RANGE.min}~${TREND_RANGE.max} 사이의 정수여야 합니다.`, field: 'mail.count' };
    count = n;
  }
  const to = input.to == null ? { list: p.to, invalid: [], over: 0 } : normalizeMailList(input.to);
  if (to.invalid.length) return { error: `추가 받는 사람 주소 형식이 잘못됐습니다: ${to.invalid.slice(0, 3).join(', ')}${to.invalid.length > 3 ? ` 외 ${to.invalid.length - 3}개` : ''}`, field: 'mail.to' };
  if (to.over) return { error: `추가 받는 사람은 ${MAIL_LIST_MAX}명까지입니다(${to.over}명 초과).`, field: 'mail.to' };
  const flag = (k) => (typeof input[k] === 'boolean' ? input[k] : p[k]);
  const out = {
    enabled, days, time, includeAdmin: flag('includeAdmin'), to: to.list, gran, count,
    includeDevices: flag('includeDevices'), includeResources: flag('includeResources'), since: p.since,
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
 * 메일 모델(순수) — 보고표 응답(loadUsageReport 의 ok 결과)에서 만든다.
 * 묶음 키는 화면과 같은 라벨이다(법인 표시명 · 종류 라벨). 장비 행은 마지막 기간 값과 직전 기간 대비 변화.
 */
export function buildMailModel(rep, { includeResources = false } = {}) {
  const periods = rep.periods || [];
  const last = periods.length - 1;
  const typeLabel = new Map((rep.types || []).map((t) => [t.type, t.label]));
  const dcName = new Map((rep.datacenters || []).map((d) => [d.id, d.name || d.id]));
  const corpOf = (d) => (d.datacenterId ? (dcName.get(d.datacenterId) || d.datacenterId) : '미지정');
  const devs = (rep.devices || []).filter((d) => d.cells.some(Boolean));
  const groupBy = (keyFn) => {
    const m = new Map();
    for (const d of devs) { const k = keyFn(d); if (!m.has(k)) m.set(k, []); m.get(k).push(d); }
    return [...m.entries()].map(([key, list]) => {
      const cells = aggregateCells(list, periods);
      return { key, devices: list.length, cells, cur: cells[last] || null, delta: last > 0 ? deltaOf(cells[last - 1], cells[last]) : null,
        deltaPartial: last > 0 && !!(cells[last - 1]?.partial || cells[last]?.partial) };
    }).sort((a, b) => (numOrNull(b.cur?.usedBytes) ?? -1) - (numOrNull(a.cur?.usedBytes) ?? -1));
  };
  const totalCells = aggregateCells(devs, periods);
  const rows = devs.map((d) => ({
    corp: corpOf(d), type: typeLabel.get(d.type) || d.type, name: d.name, cur: d.cells[last] || null,
    delta: last > 0 ? deltaOf(d.cells[last - 1], d.cells[last]) : null,
    resources: includeResources ? d.resources.map((r) => ({ group: RESOURCE_KINDS[r.kind]?.group || r.kind, name: r.name, cur: r.cells[last] || null })).filter((r) => r.cur) : [],
  })).sort((a, b) => a.corp.localeCompare(b.corp) || a.type.localeCompare(b.type) || String(a.name).localeCompare(String(b.name), 'en', { numeric: true }));
  return {
    gran: rep.gran, asOfLabel: rep.asOfLabel, periods,
    total: { cells: totalCells, cur: totalCells[last] || null, delta: last > 0 ? deltaOf(totalCells[last - 1], totalCells[last]) : null },
    byCorp: groupBy(corpOf), byType: groupBy((d) => typeLabel.get(d.type) || d.type),
    rows, devices: devs.length, registered: (rep.devices || []).length,
  };
}

const TD = 'padding:6px 8px;border-bottom:1px solid #e5e7eb;font-size:13px;';
const TH = 'padding:6px 8px;border-bottom:2px solid #cbd5e1;font-size:12px;color:#475569;text-align:left;background:#f8fafc;';
/*
 * 좁은 화면(모바일 메일) — 520px 이하에서 여백·글자를 줄이고 표를 셀 단위로 줄인다(아이실론 종합 메일 v2.742 와 같은 판단:
 * Outlook 데스크톱은 @media 를 무시하지만 그쪽은 폭이 넓다). 장비별 표는 법인·종류를 한 칸에 쌓아 열 수를 줄였다.
 */
const MOBILE_CSS = '<style>@media only screen and (max-width:520px){.su-wrap{padding:10px!important}.su-body{padding:12px!important}'
  + '.su-t td,.su-t th{padding:4px 3px!important;font-size:11px!important}.su-t th{white-space:normal!important}.su-kpi td{display:block!important;width:auto!important;margin-bottom:6px}}</style>';
const NUM = 'text-align:right;white-space:nowrap;';

function cellTxt(c) {
  if (!c) return '—';
  return c.exact === false && c.day != null ? `≈ ${esc(bytesText(c.usedBytes))}` : esc(bytesText(c.usedBytes));
}
const partialMark = (c) => (c?.partial ? ` <span style="color:#b45309">(값 있음 ${c.counted}/${c.expected}대)</span>` : '');

function groupTable(title, list, deltaHead) {
  if (!list.length) return '';
  const head = `<tr><th style="${TH}">${esc(title)}</th><th style="${TH}${NUM}">장비</th><th style="${TH}${NUM}">전체</th><th style="${TH}${NUM}">사용</th><th style="${TH}${NUM}">사용률</th><th style="${TH}${NUM}">${esc(deltaHead)}</th></tr>`;
  const body = list.map((g) => `<tr><td style="${TD}">${esc(g.key)}${partialMark(g.cur)}</td><td style="${TD}${NUM}">${g.devices}</td>`
    + `<td style="${TD}${NUM}">${esc(bytesText(g.cur?.totalBytes))}</td><td style="${TD}${NUM}">${esc(bytesText(g.cur?.usedBytes))}</td>`
    + `<td style="${TD}${NUM}">${esc(pctText(g.cur?.pct))}</td><td style="${TD}${NUM}">${esc(deltaText(g.delta))}${g.deltaPartial ? ' *' : ''}</td></tr>`).join('');
  return `<h3 style="font-size:15px;margin:20px 0 6px">${esc(title)}별</h3><table class="su-t" role="presentation" cellspacing="0" cellpadding="0" style="border-collapse:collapse;width:100%">${head}${body}</table>`;
}

/**
 * 본문(순수). @returns {{subject:string, html:string, text:string}}
 * @param {object} m buildMailModel 결과
 * @param {{mail?:object, slot?:number, manual?:boolean, preview?:boolean, recipients?:number}} o
 */
export function renderUsageMail(m, o = {}) {
  const g = mailOf(o.mail);
  const granLabel = GRANS[m.gran]?.label || '';
  const p = m.periods || [];
  const prevLabel = p.length > 1 ? p[p.length - 2].label : null;
  const deltaHead = prevLabel ? `${prevLabel} 대비` : '변화';
  const subject = `${o.preview ? '[미리보기] ' : ''}스토리지 사용량 ${granLabel} 보고 — ${m.asOfLabel}`;
  const t = m.total.cur;
  const kpi = (label, value, sub = '') => `<td style="padding:10px 12px;border:1px solid #e5e7eb;border-radius:6px;vertical-align:top">`
    + `<div style="font-size:12px;color:#64748b">${esc(label)}</div><div style="font-size:20px;font-weight:700;margin-top:2px">${esc(value)}</div>`
    + `${sub ? `<div style="font-size:11px;color:#64748b;margin-top:2px">${esc(sub)}</div>` : ''}</td>`;
  const trendHead = `<tr><th style="${TH}">기간</th><th style="${TH}${NUM}">전체</th><th style="${TH}${NUM}">사용</th><th style="${TH}${NUM}">사용률</th><th style="${TH}${NUM}">값 있음</th></tr>`;
  const trendBody = p.map((pp, i) => {
    const c = m.total.cells[i];
    return `<tr><td style="${TD}">${esc(pp.label)}${pp.current ? ' (오늘까지)' : ''}</td><td style="${TD}${NUM}">${esc(bytesText(c?.totalBytes))}</td>`
      + `<td style="${TD}${NUM}">${esc(bytesText(c?.usedBytes))}</td><td style="${TD}${NUM}">${esc(pctText(c?.pct))}</td>`
      + `<td style="${TD}${NUM}${c?.partial ? 'color:#b45309;' : ''}">${c ? `${c.counted}/${c.expected}` : '—'}</td></tr>`;
  }).join('');
  const devRows = g.includeDevices && m.rows.length
    ? `<h3 style="font-size:15px;margin:20px 0 6px">장비별(${esc(p[p.length - 1]?.label || '')})</h3><table class="su-t" role="presentation" cellspacing="0" cellpadding="0" style="border-collapse:collapse;width:100%">`
      + `<tr><th style="${TH}">법인 · 종류</th><th style="${TH}">장비</th><th style="${TH}${NUM}">전체</th><th style="${TH}${NUM}">사용</th><th style="${TH}${NUM}">사용률</th><th style="${TH}${NUM}">${esc(deltaHead)}</th></tr>`
      + m.rows.map((r) => `<tr><td style="${TD}">${esc(r.corp)}<br><span style="color:#64748b;font-size:11px">${esc(r.type)}</span></td><td style="${TD}">${esc(r.name)}</td>`
        + `<td style="${TD}${NUM}">${esc(bytesText(r.cur?.totalBytes))}</td><td style="${TD}${NUM}">${cellTxt(r.cur)}</td><td style="${TD}${NUM}">${esc(pctText(r.cur?.pct))}</td>`
        + `<td style="${TD}${NUM}">${esc(deltaText(r.delta))}</td></tr>`
        + r.resources.map((x) => `<tr><td style="${TD}color:#64748b">${esc(x.group)}</td><td style="${TD}color:#475569">└ ${esc(x.name)}</td>`
          + `<td style="${TD}${NUM}">${esc(bytesText(x.cur?.totalBytes))}</td><td style="${TD}${NUM}">${cellTxt(x.cur)}</td><td style="${TD}${NUM}">${esc(pctText(x.cur?.pct))}</td><td style="${TD}"></td></tr>`).join('')).join('')
      + '</table>'
    : '';
  const notes = [
    '합계는 크기와 사용량을 둘 다 읽은 장비만 더합니다 — 값이 없는 장비가 있으면 \'값 있음 N/M대\' 로 표시합니다(0 으로 채우지 않습니다).',
    '‘≈’ 는 기준일에 수집이 없어 그 기간 안의 가장 최근 관측을 쓴 값입니다.',
    `${esc(deltaHead)} 의 * 는 두 시점 중 하나가 부분 합이라는 뜻입니다.`,
    `CSV 내려받기·법인별/종류별 비교는 포탈 ${esc(VIEW_PATH)} 에 있습니다.`,
  ];
  const sched = g.enabled ? `${daysLabel(g.days)} ${g.time}` : '꺼짐';
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${MOBILE_CSS}</head>`
    + `<body class="su-wrap" style="margin:0;padding:16px;background:#f1f5f9;font-family:-apple-system,'Segoe UI','Malgun Gothic',sans-serif;color:#0f172a">`
    + `<div class="su-body" style="max-width:880px;margin:0 auto;background:#fff;border-radius:8px;padding:20px">`
    + `<div style="font-size:12px;color:#64748b">${esc(o.preview ? '미리보기 — 보내지 않았습니다' : (o.manual ? '지금 보내기' : `예약 발송 · ${slotLabel(o.slot)}`))}</div>`
    + `<h2 style="font-size:20px;margin:4px 0 12px">스토리지 사용량 ${esc(granLabel)} 보고 — ${esc(m.asOfLabel)}</h2>`
    + `<table class="su-kpi" role="presentation" cellspacing="6" cellpadding="0" style="width:100%"><tr>`
    + kpi('전체 용량', bytesText(t?.totalBytes), t ? `값 있음 ${t.counted}/${t.expected}대` : '')
    + kpi('사용', bytesText(t?.usedBytes), pctText(t?.pct))
    + kpi(deltaHead, deltaText(m.total.delta))
    + kpi('장비', `${m.devices}대`, m.registered > m.devices ? `등록 ${m.registered}대 중 이력 있는 장비` : '')
    + '</tr></table>'
    + `<h3 style="font-size:15px;margin:20px 0 6px">전체 추이(${esc(granLabel)})</h3><table class="su-t" role="presentation" cellspacing="0" cellpadding="0" style="border-collapse:collapse;width:100%">${trendHead}${trendBody}</table>`
    + groupTable('법인', m.byCorp, deltaHead) + groupTable('종류', m.byType, deltaHead) + devRows
    + `<ul style="font-size:12px;color:#475569;padding-left:18px;margin-top:20px">${notes.map((n) => `<li>${n}</li>`).join('')}</ul>`
    + `<div style="font-size:11px;color:#94a3b8;margin-top:12px">보내는 때: ${esc(sched)} · 받는 사람 ${numOrNull(o.recipients) == null ? '—' : `${numOrNull(o.recipients)}명`} · 설정: ${esc(VIEW_PATH)} › 메일 발송</div>`
    + '</div></body></html>';
  const lines = [subject, '', `전체 ${bytesText(t?.totalBytes)} · 사용 ${bytesText(t?.usedBytes)} (${pctText(t?.pct)}) · ${deltaHead} ${deltaText(m.total.delta)}`];
  for (const gg of m.byCorp) lines.push(`- ${gg.key}: ${bytesText(gg.cur?.usedBytes)} / ${bytesText(gg.cur?.totalBytes)} (${pctText(gg.cur?.pct)})`);
  lines.push('', `자세한 표·CSV: ${VIEW_PATH}`);
  return { subject, html, text: lines.join('\n') };
}
