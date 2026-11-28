/**
 * periodic/render.js — 회차 문서 → 메일 본문 · 자급형 HTML 보고서(첨부 · 내려받기 — 브라우저에서 인쇄 › PDF) · 채널 글 · 공지 글(순수).
 * main 의 선례(SAN 스토리지 성능 월간 보고서 · PowerScale 주간 점검 보고서 — '자급형 HTML 첨부')를 따른다: 서버 PDF 엔진을 두지 않는다(설계 §5 ④ 갱신 — README §7).
 *
 *  · 판정은 색만으로 구분하지 않는다 — 기호(✓ ! × ?) + 글자(설계 §4.8 · 일일 헬스체크 규칙).
 *  · 값이 없으면 '—'(0 을 지어내지 않는다). 확인 불가는 따로 센다.
 *  · 공지 글(noticeText)에는 **판정 · 법인 이름을 싣지 않는다** — 공지는 범위와 무관하게 모든 계정에 보인다(범위 계정에 다른 법인 상태가 새지 않게).
 */
import { DAY_OFFSET_MIN } from '../util/dayKey.js';
import { STATUS_LABEL, KIND_LABEL, actionsOf, unknownsOf, worstOf } from './rules.js';
import { AXES } from './catalog.js';
import { backupSummary, backupCorpRow, prevComparable, PRODUCT_LABEL } from './backupLedger.js';

export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const GLYPH = { ok: '✓', warn: '!', crit: '×', unknown: '?', info: 'i' };
const COLOR = { ok: '#15803d', warn: '#b45309', crit: '#b91c1c', unknown: '#475569', info: '#1d4ed8' };
const BG = { ok: '#dcfce7', warn: '#fef3c7', crit: '#fee2e2', unknown: '#e2e8f0', info: '#dbeafe' };
const pad = (n) => String(n).padStart(2, '0');

/** epoch → 'YYYY-MM-DD HH:MM'(포탈 시각). 못 읽으면 '—'. */
export function stamp(ms, offsetMin = DAY_OFFSET_MIN) {
  const t = Number(ms);
  if (!Number.isFinite(t) || t <= 0) return '—';
  const d = new Date(t + offsetMin * 60_000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}
export const statusText = (s) => `${GLYPH[s] || '?'} ${STATUS_LABEL[s] || '확인 불가'}`;
const chip = (s) => `<span style="display:inline-block;padding:1px 8px;border-radius:10px;font-weight:700;font-size:12px;color:${COLOR[s] || COLOR.unknown};background:${BG[s] || BG.unknown};white-space:nowrap">${esc(statusText(s))}</span>`;
const num = (v) => (v == null || !Number.isFinite(Number(v)) ? '—' : Number(v).toLocaleString('ko-KR'));

/** vCenter id → 법인 이름(DataCenter 이름 우선 · 없으면 vCenter 이름). */
export function corpNamer(doc) {
  const m = new Map((doc?.corps || []).map((c) => [c.vc, c.dcName || c.name || c.vc]));
  return (vc) => (vc == null ? '법인 미지정' : (m.get(vc) || vc));
}
/** 법인 한 곳의 축별 최악 판정 · 확인 불가 행 수 · 조치 수. */
export function corpMatrix(doc) {
  const out = new Map();
  for (const c of doc?.corps || []) out.set(c.vc, { ...c, axes: {}, unknown: 0, actions: 0 });
  for (const it of doc?.items || []) {
    if (it.status === 'info') continue;
    for (const r of it.rows || []) {
      const c = out.get(r.vc);
      if (!c) continue;
      c.axes[it.axis] = worstOf([c.axes[it.axis], r.status].filter(Boolean)) || r.status;
      if (r.status === 'unknown') c.unknown += 1;
      if (r.status === 'crit' || r.status === 'warn') c.actions += 1;
    }
  }
  return [...out.values()].map((c) => ({ ...c, overall: worstOf(Object.values(c.axes)) }));
}

const TITLE = (doc, portal) => `[${portal}] ${KIND_LABEL[doc.kind] || ''} 점검 보고서 — ${doc.periodLabel || ''}`;
const CSS = 'body{margin:0;background:#f8fafc;color:#0f172a;font-family:"Pretendard","Noto Sans KR","Apple SD Gothic Neo","Malgun Gothic",sans-serif;font-size:13px;line-height:1.5}'
  + '.wrap{max-width:1100px;margin:0 auto;padding:24px}h1{font-size:20px;margin:0 0 6px}h2{font-size:15px;margin:22px 0 8px;padding-bottom:4px;border-bottom:2px solid #cbd5e1}'
  + '.meta{color:#475569;font-size:12px}table{border-collapse:collapse;width:100%;margin:6px 0;background:#fff}th,td{border:1px solid #e2e8f0;padding:5px 8px;text-align:left;vertical-align:top}'
  + 'th{background:#f1f5f9;font-size:12px;color:#334155}td.n{text-align:right;font-family:Consolas,monospace}.note{color:#475569;font-size:12px;margin:6px 0}'
  + '.cnt{display:inline-block;margin:0 10px 6px 0}.warnbox{border:1px solid #f59e0b;background:#fffbeb;padding:8px 10px;border-radius:6px;margin:8px 0}'
  + '@media print{body{background:#fff}.wrap{padding:0}h2{break-after:avoid}tr{break-inside:avoid}}';

function countsLine(doc) {
  const c = doc.counts || {};
  return ['ok', 'warn', 'crit', 'unknown'].map((s) => `<span class="cnt">${chip(s)} <b>${num(c[s])}</b></span>`).join('')
    + `<span class="cnt" style="color:#475569">정보 ${num(c.info)}</span>`;
}

function itemsTable(items, name) {
  const rows = items.map((it) => {
    const dist = (it.rows || []).filter((r) => r.status !== 'ok' && r.status !== 'info').slice(0, 6).map((r) => `${esc(name(r.vc))} ${esc(GLYPH[r.status] || '?')}`).join(' · ');
    const more = (it.rows || []).filter((r) => r.status !== 'ok' && r.status !== 'info').length - 6;
    return `<tr><td>${esc(it.label)}</td><td>${chip(it.status)}</td><td>${esc(it.basis || it.value || '')}${it.unknownReason ? `<div class="note">확인 불가: ${esc(it.unknownReason)}</div>` : ''}`
      + `${(it.detail || []).length ? `<div class="note">${it.detail.slice(0, 8).map(esc).join('<br>')}</div>` : ''}</td>`
      + `<td>${dist || '—'}${more > 0 ? ` 외 ${more}` : ''}</td><td>${it.prev ? esc(statusText(it.prev.status)) : '—'}</td><td style="font-size:11px;color:#475569">${esc(it.rule || '')}</td></tr>`;
  }).join('');
  return `<table><thead><tr><th>항목</th><th>판정</th><th>근거</th><th>법인 분포(정상 아닌 곳)</th><th>직전 회차</th><th>판정 기준</th></tr></thead><tbody>${rows || '<tr><td colspan="6">이 축에 실린 항목이 없습니다.</td></tr>'}</tbody></table>`;
}

const pct = (v) => (v == null || !Number.isFinite(Number(v)) ? '—' : `${Number(v).toFixed(2)}%`);
/** 알았음 줄(kd)이 없는 묶음의 수는 '—'(못 읽은 값을 0 으로 적지 않는다). */
const kn = (x, v) => (x && Number(x.kd) > 0 ? num(v) : '—');
const STRIP = { ok: ['✓', '#15803d'], warn: ['✓', '#b45309'], fail: ['×', '#b91c1c'], none: ['–', '#64748b'], unknown: ['?', '#475569'], pre: ['·', '#94a3b8'] };
/** 3절 합계 · 법인 줄(라우트가 붙였으면 그것 — 아니면 여기서 같은 함수로). */
export function backupParts(bk) {
  if (!bk || bk.off || bk.error || !Array.isArray(bk.corps)) return null;
  return { summary: bk.summary || backupSummary(bk), corpRows: bk.corpRows || bk.corps.map((c) => backupCorpRow(c, bk.products, bk.nowOk)) };
}
/** 앞 기간 글 — 두 기간 다 확정됐을 때만 수를 견주고, 아니면 '앞 기간 적재 n / m일' 로 말한다(부분 합끼리 견주지 않는다). */
function prevText(s, key = 'f') {
  if (!s.prev.days) return '';
  if (prevComparable(s)) return `(앞 기간 ${num(s.prev[key])})`;
  return s.prev.sealed ? `(앞 기간은 적재 ${num(s.prev.sealed)} / ${num(s.prev.days)}일이라 견주지 않음)` : '';
}
const failNowText = (s) => (s.failNow == null ? ' · 지금 실패 상태 모름(결과를 읽지 못함)' : `${s.failNow ? ` · 지금 실패 상태 ${num(s.failNow)}대` : ''}${s.nowPartial ? `(법인 ${num(s.nowPartial)}곳은 지금 결과를 못 읽어 뺌)` : ''}`);
/** 3절 한 줄 요약(메일). 실을 것이 없으면 ''. */
export function backupLine(bk, name = (vc) => vc) {
  const p = backupParts(bk);
  if (!p) return bk?.off ? `백업 성공 · 실패 — ${bk.reason || '하루 치 적재가 꺼져 있습니다'}` : bk?.error ? `백업 성공 · 실패 — ${bk.reason || '읽지 못했습니다'}` : '';
  const s = p.summary; const t = s.total; const cov = s.coverage;
  if (!(t.kd > 0)) return `백업 — 확정된 결과가 아직 없습니다(적재 ${num(cov.sealed)} / ${num(cov.days)}일${s.corpsWithUnknown ? ` · 확인 불가 법인 ${num(s.corpsWithUnknown)}곳` : ''})`;
  const worst = [...p.corpRows].filter((c) => c.kd > 0 && c.f > 0).sort((a, b) => b.f - a.f).slice(0, 7).map((c) => `${name(c.vc)} ${num(c.f)}`).join(' · ');
  return `백업 — 끝난 백업 ${num(t.e)} · 성공 ${num(t.ok)} · 경고 ${num(t.w)} · 실패 ${num(t.f)}${prevText(s)} · 성공률 ${pct(t.rate)}`
    + `${s.corpsWithUnknown ? ` · 확인 불가 법인 ${num(s.corpsWithUnknown)}곳` : ''}${cov.sealed < cov.days ? ` · 적재 ${num(cov.sealed)} / ${num(cov.days)}일` : ''}`
    + `${failNowText(s)}${worst ? `\n실패 — ${worst}` : ''}`;
}
/** 채널 한 줄 — '백업 실패 12(앞 기간 9) · 성공률 99.75% · 확인 불가 법인 1곳'(합계만 — 법인별 수는 메일 본문 · 보고서에 · 법인 이름이 실리는 것은 아래 조치 목록 줄). */
export function backupChat(bk) {
  const p = backupParts(bk);
  if (!p) return '';
  const s = p.summary; const t = s.total;
  if (!(t.kd > 0)) return `백업 — 확정된 결과 없음(적재 ${num(s.coverage.sealed)} / ${num(s.coverage.days)}일)`;
  return `백업 실패 ${num(t.f)}${prevText(s)} · 성공률 ${pct(t.rate)}${s.corpsWithUnknown ? ` · 확인 불가 법인 ${num(s.corpsWithUnknown)}곳` : ''}${s.failNow ? ` · 지금 실패 상태 ${num(s.failNow)}대` : ''}`;
}
/** HTML 보고서의 3절. */
function backupHtml(bk, name, no) {
  const head = `<h2>${no}. 백업 성공 · 실패 현황 <span class="meta">VM 단위 · 하루에 여러 번 돌았으면 그날 마지막 결과 · 경고는 성공률에 넣고 취소는 실패 · 판정은 서비스 축의 백업 항목 것</span></h2>`;
  if (bk.off || bk.error) return `${head}<div class="note">${esc(bk.reason || '백업 적재를 읽지 못했습니다')}</div>`;
  const { summary: s, corpRows } = backupParts(bk);
  const t = s.total;
  const cov = s.coverage;
  const cmp = prevComparable(s);
  const tiles = `<p><span class="cnt">끝난 백업 <b>${kn(t, t.e)}</b></span><span class="cnt">성공 <b>${kn(t, t.ok)}</b> · 성공률 <b>${pct(t.rate)}</b>${cmp ? ` (앞 기간 ${pct(s.prev.rate)})` : ''}</span>`
    + `<span class="cnt">경고 <b>${kn(t, t.w)}</b></span><span class="cnt">실패 <b>${kn(t, t.f)}</b>${cmp ? ` (앞 기간 ${num(s.prev.f)})` : ''}</span><span class="cnt">실행 없음 <b>${kn(t, t.n)}</b></span>`
    + `<span class="cnt">지금 실패 상태 <b>${s.failNow == null ? '—' : num(s.failNow)}</b>대${s.nowPartial ? `(법인 ${num(s.nowPartial)}곳 뺌)` : ''}</span><span class="cnt">확인 불가 <b>${num(t.ud)}</b>(법인 · 백업 · 날)</span></p>`
    + `<div class="note">적재 ${num(cov.sealed)} / ${num(cov.days)}일${cov.sealed < cov.days ? ' — 적재 전 · 아직 확정하지 않은 날은 성공으로도 실패로도 세지 않았습니다' : ''}${s.pending ? ` · 확정 대기 ${num(s.pending)}(그 법인을 날 끝 뒤 아직 보지 못함 — 확인 불가에 넣음)` : ''}.`
    + `${s.prev.days && !cmp ? ` 앞 기간은 적재 ${num(s.prev.sealed)} / ${num(s.prev.days)}일이라 수를 견주지 않았습니다.` : ''} ‘실행 없음’ 은 그날 대상인데 끝난 실행이 없는 VM 입니다(주 1회 잡이면 정상 — RPO 가 판정합니다).</div>`;
  const prod = `<table><thead><tr><th>백업</th><th>대상</th><th>끝난 백업</th><th>성공</th><th>경고</th><th>실패</th><th>성공률</th><th>실행 없음</th><th>확인 불가(법인 · 백업 · 날)</th></tr></thead><tbody>${(bk.products || []).map((p) => {
    const x = s.products[p] || {};
    return `<tr><td>${esc(PRODUCT_LABEL[p] || p)}</td><td class="n">${kn(x, x.t)}</td><td class="n">${kn(x, x.e)}</td><td class="n">${kn(x, x.ok)}</td><td class="n">${p === 'clone' ? '—' : kn(x, x.w)}</td><td class="n">${kn(x, x.f)}</td><td class="n">${pct(x.rate)}</td><td class="n">${kn(x, x.n)}</td><td class="n">${num(x.ud)}</td></tr>`;
  }).join('')}</tbody></table>`;
  const maxF = Math.max(1, ...s.days.map((d) => d.f));
  const dayRow = (d) => {
    if (!d.k && !d.u) return `<tr><td>${esc(d.label)}</td><td colspan="4" style="color:#64748b">적재 전 · 확정 전</td></tr>`;
    if (!d.k) return `<tr><td>${esc(d.label)}</td><td colspan="3" style="color:#64748b">전부 확인 불가</td><td class="n">${num(d.u)}</td></tr>`;
    return `<tr><td>${esc(d.label)}</td><td class="n">${num(d.e)}</td><td class="n">${num(d.f)}</td>`
      + `<td><span style="display:inline-block;height:8px;background:#ef4444;border-radius:3px;width:${Math.round((d.f / maxF) * 160)}px"></span></td><td class="n">${num(d.u)}</td></tr>`;
  };
  const daysT = s.days.length > 1 ? `<table><thead><tr><th>날</th><th>끝난 백업</th><th>실패</th><th></th><th>확인 불가(법인 · 백업)</th></tr></thead><tbody>${s.days.map(dayRow).join('')}</tbody></table>` : '';
  const multi = s.days.length > 1;
  const corps = `<table><thead><tr><th>법인</th><th>끝난 백업</th><th>성공</th><th>경고</th><th>실패</th><th>성공률</th><th>실행 없음</th><th>확인 불가(백업 · 날)</th>${multi ? '<th>실패한 날</th><th>되풀이 VM</th>' : ''}<th>지금 실패</th></tr></thead><tbody>${[...corpRows].sort((a, b) => ((b.kd > 0 ? b.f : -1) - (a.kd > 0 ? a.f : -1)) || (b.unknownDays - a.unknownDays)).map((c) => `<tr><td>${esc(name(c.vc))}</td><td class="n">${kn(c, c.e)}</td><td class="n">${kn(c, c.ok)}</td><td class="n">${kn(c, c.w)}</td><td class="n">${kn(c, c.f)}</td><td class="n">${pct(c.rate)}</td><td class="n">${kn(c, c.n)}</td><td class="n">${num(c.unknownDays)}</td>${multi ? `<td class="n">${num(c.failDays)}</td><td class="n">${num(c.repeatVms)}</td>` : ''}<td class="n">${c.failNow == null ? '—' : num(c.failNow)}</td></tr>`).join('') || `<tr><td colspan="${multi ? 11 : 9}">적재된 법인이 없습니다.</td></tr>`}</tbody></table>`;
  const failsTotal = bk.failsTotal ?? bk.fails.length;
  const fails = (bk.fails || []).length ? `<h3 style="font-size:13px;margin:12px 0 4px">실패한 백업 ${num(failsTotal)}${multi ? '대(백업 · VM 하나에 한 줄)' : '건'}${failsTotal > bk.fails.length ? ` — 상위 ${num(bk.fails.length)}` : ''}</h3>`
    + `<table><thead><tr><th>법인</th><th>백업</th><th>VM</th>${multi ? '<th>실패한 날</th>' : ''}<th>마지막 실패</th><th>연속 실패</th><th>마지막 성공</th><th>사유</th></tr></thead><tbody>${bk.fails.map((x) => `<tr><td>${esc(name(x.vc))}</td><td>${esc(PRODUCT_LABEL[x.product] || x.product)}</td><td>${esc(x.name || x.vm)}</td>${multi ? `<td class="n">${num(x.failDays)}</td>` : ''}<td>${esc(stamp(x.endedAt))}</td><td class="n">${x.streak == null ? '—' : `${num(x.streak)}회`}</td><td>${esc(stamp(x.lastOkAt))}</td><td>${esc(x.reason || '—')}</td></tr>`).join('')}</tbody></table>`
    : failsTotal > 0 ? `<div class="note">실패한 백업 ${num(failsTotal)}건 — 보고서 문서의 목록 상한 밖이라 줄은 싣지 못했습니다(포탈 › Backup 현황에서 봅니다).</div>`
      : t.kd > 0 ? '<div class="note">기간 안에 실패한 백업이 없습니다(확인 불가 법인-날은 빼고 센 것입니다).</div>' : '<div class="note">확정된 날이 없어 실패 목록이 비어 있습니다(실패가 없다는 뜻이 아닙니다).</div>';
  const rep = multi && (bk.repeat || []).length ? `<h3 style="font-size:13px;margin:12px 0 4px">되풀이되는 실패 ${num(bk.repeatTotal ?? bk.repeat.length)}대 <span class="meta">기간 안 2일 이상 실패</span></h3>`
    + `<table><thead><tr><th>VM</th><th>법인</th><th>백업</th><th>실패한 날</th>${bk.repeat[0]?.strip ? `<th>${s.days.map((d) => esc(d.label.slice(-2, -1) || d.label)).join(' ')}</th>` : ''}<th>마지막 성공</th><th>사유</th></tr></thead><tbody>${bk.repeat.map((x) => `<tr><td>${esc(x.name || x.vm)}</td><td>${esc(name(x.vc))}</td><td>${esc(PRODUCT_LABEL[x.product] || x.product)}</td><td class="n">${num(x.failDays)} / ${num(s.days.length)}</td>`
      + `${x.strip ? `<td style="font-family:Consolas,monospace;white-space:nowrap">${x.strip.map((k) => `<span style="color:${(STRIP[k] || STRIP.unknown)[1]}">${(STRIP[k] || STRIP.unknown)[0]}</span>`).join(' ')}</td>` : ''}<td>${esc(stamp(x.lastOkAt))}</td><td>${esc(x.reason || '—')}</td></tr>`).join('')}</tbody></table>`
      + (bk.repeat[0]?.strip ? '<div class="note">✓ 성공(경고 포함) · × 실패 · – 실행 없음 · ? 확인 불가 · · 적재 전</div>' : '') : '';
  return `${head}${tiles}${prod}${daysT}<h3 style="font-size:13px;margin:12px 0 4px">법인별</h3>${corps}${fails}${rep}`;
}

/**
 * 자급형 HTML 보고서(첨부 · 내려받기). corp 를 주면 그 법인판(이미 범위로 자른 문서를 넘길 것).
 * @param {object} doc 회차 문서(범위로 자른 것)
 * @param {{portal?:string, offsetMin?:number, preview?:boolean, scopedNote?:string}} [o]
 */
export function renderReportHtml(doc, { portal = 'VMware Portal', offsetMin = DAY_OFFSET_MIN, preview = false, scopedNote = '' } = {}) {
  const name = corpNamer(doc);
  const acts = actionsOf(doc, name);
  const unks = unknownsOf(doc, name);
  const matrix = corpMatrix(doc);
  const bk = doc.backup || null;
  const off = bk ? 1 : 0;   // v3.59 3절(백업)이 있으면 뒤 절 번호가 하나씩 밀린다
  const axisSec = AXES.map((ax, i) => {
    const its = (doc.items || []).filter((x) => x.axis === ax.key);
    const judged = its.filter((x) => x.status !== 'info').sort((a, b) => ['crit', 'warn', 'unknown', 'ok'].indexOf(a.status) - ['crit', 'warn', 'unknown', 'ok'].indexOf(b.status));
    const info = its.filter((x) => x.status === 'info');
    return `<h2>${4 + off + i}. ${esc(ax.label)} <span class="meta">${esc(ax.desc)} · ${its.length}항목</span></h2>${itemsTable([...judged, ...info], name)}`;
  }).join('');
  const html = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(TITLE(doc, portal))}</title><style>${CSS}</style></head><body><div class="wrap">`
    + `<h1>${esc(KIND_LABEL[doc.kind] || '')} 점검 보고서 — ${esc(doc.periodLabel || '')} ${chip(doc.overall)}</h1>`
    + `<div class="meta">회차 ${esc(doc.id || '미리보기')} · 기간 ${esc(stamp(doc.periodFrom, offsetMin))} ~ ${esc(stamp(doc.periodTo, offsetMin))} · 생성 ${esc(stamp(doc.generatedAt, offsetMin))}${doc.manual ? ` (수동 · ${esc(doc.by || '')})` : ' (예약)'} · 법인 ${num(doc.corpsReported)} / ${num(doc.corpsTotal)} 보고 · 항목 ${num((doc.items || []).length)}</div>`
    + (preview ? '<div class="warnbox">미리보기 — 보관하지 않았고 보내지 않았습니다.</div>' : '')
    + (doc.mock ? '<div class="warnbox">데모(목) 데이터로 만든 보고서입니다 — 실제 장비 상태가 아닙니다.</div>' : '')
    + (scopedNote ? `<div class="note">${esc(scopedNote)}</div>` : '')
    + '<div class="note">이 보고서는 새로 수집하지 않았습니다 — 포탈이 이미 저장한 최신값 · 이력 · 판정만 읽었습니다. 확인 불가는 정상에도 이상에도 넣지 않고 따로 셉니다.</div>'
    + `<h2>1. 종합</h2><div>${countsLine(doc)}</div>`
    + `<table><thead><tr><th>축</th><th>판정</th><th>정상</th><th>주의</th><th>이상</th><th>확인 불가</th><th>정보</th></tr></thead><tbody>${AXES.map((ax) => {
      const its = (doc.items || []).filter((x) => x.axis === ax.key);
      const c = (s) => its.filter((x) => x.status === s).length;
      return `<tr><td>${esc(ax.label)}</td><td>${chip(worstOf(its.filter((x) => x.status !== 'info').map((x) => x.status)) || 'unknown')}</td><td class="n">${c('ok')}</td><td class="n">${c('warn')}</td><td class="n">${c('crit')}</td><td class="n">${c('unknown')}</td><td class="n">${c('info')}</td></tr>`;
    }).join('')}</tbody></table>`
    + `<h2>2. 조치 필요 <span class="meta">${acts.length}건 · 이상 → 주의 순</span></h2>`
    + (acts.length ? `<table><thead><tr><th>#</th><th>판정</th><th>법인</th><th>축</th><th>항목</th><th>근거</th></tr></thead><tbody>${acts.slice(0, 200).map((x, i) => `<tr><td class="n">${i + 1}</td><td>${chip(x.status)}</td><td>${esc(x.corp)}</td><td>${esc(AXES.find((a) => a.key === x.axis)?.label || x.axis)}</td><td>${esc(x.label)}</td><td>${esc(x.basis)}</td></tr>`).join('')}</tbody></table>${acts.length > 200 ? `<div class="note">외 ${acts.length - 200}건 — 포탈 화면에서 전부 볼 수 있습니다.</div>` : ''}` : '<div class="note">조치가 필요한 항목이 없습니다.</div>')
    + (bk ? backupHtml(bk, name, 3) : '')
    + `<h2>${3 + off}. 법인별 현황 <span class="meta">칸은 그 축에서 가장 나쁜 판정</span></h2>`
    + `<table><thead><tr><th>법인</th><th>vCenter</th>${AXES.map((a) => `<th>${esc(a.label)}</th>`).join('')}<th>확인 불가</th><th>조치</th><th>데이터 기준</th><th>수집</th></tr></thead><tbody>${matrix.map((c) => `<tr><td>${esc(c.dcName || c.name)}</td><td>${esc(c.name)}</td>${AXES.map((a) => `<td>${c.axes[a.key] ? chip(c.axes[a.key]) : '—'}</td>`).join('')}<td class="n">${c.unknown}</td><td class="n">${c.actions}</td><td>${esc(stamp(c.asOf, offsetMin))}${c.reported ? '' : ' (보고 없음)'}</td><td>${c.mode === 'edge' ? '엣지' : '중앙'}</td></tr>`).join('') || '<tr><td colspan="9">법인이 없습니다.</td></tr>'}</tbody></table>`
    + axisSec
    + `<h2>${7 + off}. 확인하지 못한 것 <span class="meta">${unks.length}건</span></h2>`
    + (unks.length ? `<table><thead><tr><th>항목</th><th>범위</th><th>사유</th><th>확인하려면</th></tr></thead><tbody>${unks.map((u) => `<tr><td>${esc(u.label)}</td><td>${esc(u.where)}</td><td>${esc(u.reason)}</td><td>${esc(u.fix || '—')}</td></tr>`).join('')}</tbody></table>` : '<div class="note">없습니다.</div>')
    + `<h2>${8 + off}. 부록 — 생성 기록</h2><div class="note">회차 ${esc(doc.id || '미리보기')} · 조립 ${num(Math.round((doc.durationMs || 0) / 100) / 10)}초 · 직전 회차 ${esc(doc.prevId || '—')} · 시각은 포탈 시각입니다.</div>`
    + '</div></body></html>';
  return html;
}

/**
 * 메일 본문(요약) — 종합 · 축 요약 · 조치 필요 상위 10 · 확인 불가 수 · 첨부 안내.
 * @returns {{subject:string, html:string, text:string}}
 */
export function renderMail(doc, { portal = 'VMware Portal', offsetMin = DAY_OFFSET_MIN, corpLabel = '', attached = false, link = '' } = {}) {
  const name = corpNamer(doc);
  const acts = actionsOf(doc, name);
  const unks = unknownsOf(doc, name);
  const head = `${KIND_LABEL[doc.kind] || ''} 점검 보고서 — ${doc.periodLabel || ''}${corpLabel ? ` · ${corpLabel}` : ''}`;
  const subject = `[${portal}] ${head} · ${STATUS_LABEL[doc.overall] || '확인 불가'}${acts.length ? ` · 조치 ${acts.length}` : ''}`;
  const c = doc.counts || {};
  const html = `<div style="font-family:'Malgun Gothic','Apple SD Gothic Neo',sans-serif;font-size:13px;color:#0f172a">`
    + `<h2 style="font-size:16px;margin:0 0 6px">${esc(head)} ${chip(doc.overall)}</h2>`
    + `<div style="color:#475569;font-size:12px">회차 ${esc(doc.id)} · 기간 ${esc(stamp(doc.periodFrom, offsetMin))} ~ ${esc(stamp(doc.periodTo, offsetMin))} · 생성 ${esc(stamp(doc.generatedAt, offsetMin))} · 법인 ${num(doc.corpsReported)} / ${num(doc.corpsTotal)} 보고</div>`
    + (doc.mock ? '<p style="color:#b45309">데모(목) 데이터로 만든 보고서입니다.</p>' : '')
    + `<p>${countsLine(doc)}</p>`
    + `<table style="border-collapse:collapse">${AXES.map((ax) => {
      const its = (doc.items || []).filter((x) => x.axis === ax.key);
      const bad = its.filter((x) => x.status === 'crit' || x.status === 'warn').map((x) => x.label);
      return `<tr><td style="padding:3px 10px 3px 0"><b>${esc(ax.label)}</b></td><td style="padding:3px 10px 3px 0">${chip(worstOf(its.filter((x) => x.status !== 'info').map((x) => x.status)) || 'unknown')}</td><td style="padding:3px 0;color:#475569">${bad.length ? esc(bad.slice(0, 4).join(' · ')) + (bad.length > 4 ? ` 외 ${bad.length - 4}` : '') : '조치 필요 없음'}</td></tr>`;
    }).join('')}</table>`
    + (backupLine(doc.backup, name) ? `<p style="margin:10px 0 0;white-space:pre-line">${esc(backupLine(doc.backup, name))}</p>` : '')
    + (acts.length ? `<h3 style="font-size:14px;margin:14px 0 4px">조치 필요 ${acts.length}건${acts.length > 10 ? ' (상위 10)' : ''}</h3><ol style="margin:0;padding-left:20px">${acts.slice(0, 10).map((x) => `<li>${chip(x.status)} ${esc(x.corp)} — ${esc(x.label)}: ${esc(x.basis)}</li>`).join('')}</ol>` : '<p>조치가 필요한 항목이 없습니다.</p>')
    + (unks.length ? `<p style="color:#475569">확인하지 못한 것 ${unks.length}건 — 정상으로 세지 않았습니다(첨부 보고서 ${doc.backup ? 8 : 7}절).</p>` : '')
    + `<p style="color:#475569;font-size:12px">${attached ? '전체 보고서는 첨부한 HTML 파일입니다(브라우저에서 열어 인쇄 › PDF 로 저장할 수 있습니다). ' : ''}포탈 특수 기능 › 정기 점검 보고에서도 볼 수 있습니다${link ? `: ${esc(link)}` : ''}. 이 보고서는 포탈이 이미 저장한 값만 읽어 만들었습니다.</p></div>`;
  const text = [head, `종합 ${statusText(doc.overall)} · 정상 ${num(c.ok)} · 주의 ${num(c.warn)} · 이상 ${num(c.crit)} · 확인 불가 ${num(c.unknown)}`, backupLine(doc.backup, name),
    ...acts.slice(0, 10).map((x, i) => `${i + 1}. [${STATUS_LABEL[x.status]}] ${x.corp} — ${x.label}: ${x.basis}`),
    unks.length ? `확인하지 못한 것 ${unks.length}건` : ''].filter(Boolean).join('\n');
  return { subject, html, text };
}

/** 알림 채널(Slack · Teams · 웹훅) 글 — 종합 · 4종 수 · 조치 필요 상위 5. */
export function renderChat(doc, { portal = 'VMware Portal' } = {}) {
  const name = corpNamer(doc);
  const acts = actionsOf(doc, name);
  const c = doc.counts || {};
  return [`[${portal}] ${KIND_LABEL[doc.kind] || ''} 점검 보고서 ${doc.periodLabel || ''} — ${statusText(doc.overall)}`,
    `정상 ${num(c.ok)} · 주의 ${num(c.warn)} · 이상 ${num(c.crit)} · 확인 불가 ${num(c.unknown)} · 법인 ${num(doc.corpsReported)}/${num(doc.corpsTotal)} 보고`,
    backupChat(doc.backup),
    ...acts.slice(0, 5).map((x) => `• [${STATUS_LABEL[x.status]}] ${x.corp} — ${x.label}: ${x.basis}`),
    acts.length > 5 ? `… 조치 필요 ${acts.length}건 중 5건` : '', `회차 ${doc.id} — 특수 기능 › 정기 점검 보고`].filter(Boolean).join('\n');
}

/** 공지 글 — **판정 · 법인 이름 없음**(공지는 모든 계정에 보인다). */
export function renderNotice(doc) {
  return {
    title: `${KIND_LABEL[doc.kind] || ''} 점검 보고서가 만들어졌습니다 — ${doc.periodLabel || ''}`.slice(0, 200),
    body: `정기 점검 보고 ${doc.id} 이(가) 만들어졌습니다. 특수 기능 › 리포트 · 점검 › 정기 점검 보고에서 볼 수 있습니다(볼 수 있는 법인 범위만 보입니다).`,
  };
}

/** 첨부 파일 이름(영문 · 숫자 · ._- 만 — util/smtp.js 규칙). */
export const attachmentName = (doc, corpVc = '') => `periodic-report-${String(doc.id || 'preview').replace(/[^A-Za-z0-9._-]/g, '-')}${corpVc ? `-${String(corpVc).replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 40)}` : ''}.html`;
