/**
 * isidu/mailHtml.js — 아이실론 디렉터리 사용량 메일 본문 세 가지(순수 — 파일·DB·발송 없음, v2.742).
 *   ① 종합 메일(전 법인 · 정한 요일·시각) ③ 대상별 결과 메일(조사가 끝날 때마다) ④ 대상별 실패 알림.
 * 모양은 Claude Design 시안(사용자 승인 — '아이실론 디렉터리 사용량 — 메일 시안' ①③④)을 메일 클라이언트에서 깨지지 않게 옮긴 것이다:
 *  · 레이아웃은 표(table)로 짓고 스타일은 전부 인라인이다(메일 클라이언트는 <style>·flex·외부 글꼴을 버리는 경우가 많다).
 *    글꼴은 시스템 글꼴(맑은 고딕 → Apple SD Gothic Neo → sans-serif) — 시안의 IBM Plex 는 메일에서 받아지지 않는다.
 *  · KPI 칸은 inline-block(폭 25% · 최소 150px)이라 좁은 화면에서 2칸씩 줄바꿈된다.
 *  · 값이 없으면 단위를 붙이지 않는다('—'). 반올림 범위 안의 차이는 '변화 없음' 이다. 실패·보고 늦음 대상의 값은 '직전 성공 값' 이라 칸이 말한다.
 *  · 포탈 주소를 설정에서 알 수 없어 '포탈에서 보기' 링크는 두지 않는다 — 대신 화면 위치(메뉴 경로)를 글로 적는다(지어낸 주소 금지).
 *  · 모든 값은 이스케이프한다(폴더 이름·경로·오류 원문은 장비가 준 문자열이다).
 */
import { localStamp } from '../util/dayKey.js';
import { numOrNull } from '../util/numOrNull.js';
import { slotLabel, daysLabel, failTitleOf, SURGE_MIN_BYTES, SURGE_MIN_RATIO } from './digestRules.js';

export const SETTINGS_PATH = '설정 › 수집 서버 › 아이실론 디렉터리 사용량';
export const VIEW_PATH = '특수 기능 › 아이실론 디렉터리 사용량';
const FONT = "'Malgun Gothic','맑은 고딕','Apple SD Gothic Neo','Noto Sans KR',sans-serif";
const MONO = "Consolas,'D2Coding','Courier New',monospace";
const C = Object.freeze({
  ink: '#1F2D3A', head: '#0F2233', dim: '#5B6B7A', faint: '#6B7A88', line: '#E3E8ED', border: '#D3DAE1', page: '#E9EDF1',
  up: '#B4410C', down: '#1D5FA8', same: '#5B6B7A', bar: '#0B6E78', barBg: '#E3E8ED', bandSub: '#B9C7D3', alert: '#9B1C14',
});
const TONE = Object.freeze({
  bad: { bg: '#FDECEA', fg: '#B42318' }, warn: { bg: '#FFF4D6', fg: '#8A5A00' }, run: { bg: '#E8F1FB', fg: '#1D5FA8' },
  muted: { bg: '#EEF1F4', fg: '#5B6B7A' }, ok: { bg: '#E7F6EC', fg: '#1E7A3D' }, surge: { bg: '#EEF5F6', fg: '#0B6E78' },
});

export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
/** 바이트 → '1.2 TiB'(1024 단위). 못 읽으면 '—'. */
export function bytesText(b) {
  if (b == null || !Number.isFinite(b)) return '—';
  let v = Math.abs(b); let i = 0;
  while (v >= 1024 && i < UNITS.length - 1) { v /= 1024; i++; }
  return `${b < 0 ? '−' : ''}${i === 0 ? v.toFixed(0) : v.toFixed(v >= 100 ? 0 : 1)} ${UNITS[i]}`;
}
/** 7일 변화(deltaOf 모양) → 글자. */
export function deltaText(d) {
  if (!d) return '—';
  if (d.withinRes) return '변화 없음(반올림 범위)';
  return `${d.bytes > 0 ? '+' : ''}${bytesText(d.bytes)}`;
}
export const pct = (x, digits = 1) => (x == null || !Number.isFinite(x) ? '—' : `${(x * 100).toFixed(digits)}%`);
const signedPct = (x) => (x == null || !Number.isFinite(x) ? '' : `${x > 0 ? '+' : x < 0 ? '−' : '±'}${Math.abs(x * 100).toFixed(1)}%`);

/** 'N분 전'·'N시간 전'·'N일 전'(포탈 시각과 무관 — 경과). 못 읽으면 '—'. */
export function agoText(ts, now = Date.now()) {
  const t = numOrNull(ts);
  if (t == null) return '—';
  const d = Math.max(0, now - t);
  if (d < 90_000) return '방금';
  if (d < 3_600_000) return `${Math.round(d / 60_000)}분 전`;
  if (d < 2 * 86_400_000) return `${Math.round(d / 3_600_000)}시간 전`;
  return `${Math.round(d / 86_400_000)}일 전`;
}
const short = (ts) => { const s = localStamp(ts); return s ? `${s.slice(5, 7)}/${s.slice(8, 10)} ${s.slice(11, 16)}` : '—'; };
const secText = (ms) => { const n = numOrNull(ms); if (n == null) return '—'; const s = Math.round(n / 1000); return s < 90 ? `${s}초` : s < 5400 ? `${Math.round(s / 60)}분` : `${(s / 3600).toFixed(1)}시간`; };

// ── 조각 ─────────────────────────────────────────────────────────────────
function tag(text, tone = 'muted') {
  const t = TONE[tone] || TONE.muted;
  return `<span style="display:inline-block;font-size:11.5px;font-weight:700;line-height:1.4;color:${t.fg};background:${t.bg};border-radius:3px;padding:2px 7px;white-space:nowrap;">${esc(text)}</span>`;
}
function bar(frac) {
  const f = Number.isFinite(frac) ? Math.max(0, Math.min(1, frac)) : 0;
  const w = Math.round(f * 100);
  const fill = w > 0 ? `<td width="${w}%" style="width:${w}%;background:${C.bar};height:6px;font-size:0;line-height:0;">&nbsp;</td>` : '';
  const rest = w < 100 ? `<td style="background:${C.barBg};height:6px;font-size:0;line-height:0;">&nbsp;</td>` : '';
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-top:5px;"><tr>${fill}${rest}</tr></table>`;
}
/** 변화 칸 — 증가는 주황, 감소는 파랑, 반올림 범위 안은 회색 '변화 없음', 기준 없음은 '기준 없음'. */
function deltaCell(d, { hasBase = true, isNew = false, partial = false } = {}) {
  if (isNew) return tag('7일 신규', 'surge');
  if (!d || numOrNull(d.bytes) == null) return `<span style="color:${C.faint};">${hasBase ? '—' : '기준 없음'}</span>`;
  if (d.within || d.withinRes) return `<span style="color:${C.same};">변화 없음</span>`;
  const b = d.bytes;
  const col = b > 0 ? C.up : b < 0 ? C.down : C.same;
  return `<span style="color:${col};font-weight:600;white-space:nowrap;">${b > 0 ? '+' : ''}${esc(bytesText(b))}</span>${partial ? `<span style="color:${C.faint};font-size:11.5px;"> (일부)</span>` : ''}`;
}
function th(label, align = 'left', w = '') {
  return `<th align="${align}" style="text-align:${align};padding:8px 8px;border-bottom:1px solid ${C.border};font-size:12px;font-weight:600;color:${C.dim};white-space:nowrap;"${w ? ` width="${w}"` : ''}>${esc(label)}</th>`;
}
function td(html, align = 'left', extra = '') {
  return `<td align="${align}" style="text-align:${align};padding:9px 8px;border-bottom:1px solid ${C.line};font-size:13px;color:${C.ink};vertical-align:top;${extra}">${html}</td>`;
}
function table(head, rowsHtml) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-family:${FONT};"><tr>${head.join('')}</tr>${rowsHtml.join('')}</table>`;
}
function sectionTitle(title, sub = '') {
  return `<div style="font-size:16px;font-weight:700;color:${C.head};margin:0 0 10px 0;">${esc(title)}${sub ? ` <span style="font-size:12.5px;font-weight:400;color:${C.faint};">${esc(sub)}</span>` : ''}</div>`;
}
const section = (inner, pad = '26px 32px 4px 32px') => `<tr><td style="padding:${pad};font-family:${FONT};">${inner}</td></tr>`;
function kpis(cards) {
  const cell = (k) => `<div style="display:inline-block;vertical-align:top;width:25%;min-width:150px;box-sizing:border-box;padding:6px;">`
    + `<div style="border:1px solid ${C.line};border-radius:6px;padding:12px 14px;background:#FFFFFF;">`
    + `<div style="font-size:12px;color:${C.dim};font-family:${FONT};">${esc(k.label)}</div>`
    + `<div style="font-size:21px;font-weight:700;color:${k.color || C.head};margin-top:4px;font-family:${FONT};word-break:break-all;">${k.valueHtml ?? esc(k.value)}</div>`
    + `<div style="font-size:11.5px;color:${C.faint};margin-top:4px;line-height:1.5;font-family:${FONT};">${k.subHtml ?? esc(k.sub || '')}</div>`
    + `</div></div>`;
  return `<div style="font-size:0;line-height:0;margin:0 -6px;">${cards.map(cell).join('')}</div>`;
}
function band({ label = 'ISILON · DIRECTORY USAGE', title, titleMono = false, chips = [], sub = '', bg = C.head, subColor = C.bandSub }) {
  return `<tr><td style="background:${bg};padding:26px 32px 22px 32px;font-family:${FONT};color:#FFFFFF;">`
    + `<div style="font-size:11px;font-weight:700;letter-spacing:1.5px;color:${subColor};">${esc(label)}</div>`
    + (chips.length ? `<div style="margin-top:10px;">${chips.join(' ')}</div>` : '')
    + `<div style="font-size:${titleMono ? 24 : 26}px;font-weight:700;line-height:1.3;margin-top:8px;${titleMono ? `font-family:${MONO};word-break:break-all;` : ''}">${esc(title)}</div>`
    + (sub ? `<div style="font-size:13.5px;color:${subColor};line-height:1.6;margin-top:6px;">${esc(sub)}</div>` : '')
    + `</td></tr>`;
}
const chip = (text, { solid = false, color = '#FFFFFF', bg = 'rgba(255,255,255,0.18)' } = {}) => `<span style="display:inline-block;font-size:12px;font-weight:700;color:${solid ? bg : color};background:${solid ? '#FFFFFF' : bg};border-radius:3px;padding:3px 8px;">${esc(text)}</span>`;
function footer(lines) {
  return `<tr><td style="padding:22px 32px 26px 32px;border-top:1px solid ${C.line};font-family:${FONT};font-size:12.5px;line-height:1.7;color:${C.dim};">${lines.map((l) => `<div>${l}</div>`).join('')}</td></tr>`;
}
function readHow(lines) {
  if (!lines.length) return '';
  return section(`${sectionTitle('숫자를 읽는 법')}<ul style="margin:0;padding-left:18px;font-size:12.5px;line-height:1.7;color:${C.dim};">${lines.map((l) => `<li>${l}</li>`).join('')}</ul>`);
}
function doc(title, preheader, rowsHtml) {
  return '<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + `<title>${esc(title)}</title></head><body style="margin:0;padding:0;background:${C.page};">`
    + `<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(preheader)}</div>`
    + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.page};border-collapse:collapse;"><tr><td align="center" style="padding:24px 10px;">`
    + `<table role="presentation" width="720" cellpadding="0" cellspacing="0" style="width:100%;max-width:720px;background:#FFFFFF;border:1px solid ${C.border};border-radius:6px;border-collapse:separate;overflow:hidden;">`
    + rowsHtml.join('')
    + '</table></td></tr></table></body></html>';
}
const metaLine = (parts) => parts.filter(Boolean).map((p) => esc(p)).join(' · ');

// ── ① 종합 메일 ───────────────────────────────────────────────────────────
const STATUS_TAG = (st) => tag(st.text, st.tone);
function corpStatusTag(c) {
  const bad = c.items.filter((x) => x.st.tone === 'bad').length;
  const warn = c.items.filter((x) => x.st.tone === 'warn').length;
  if (bad) return tag(`실패 ${bad}`, 'bad');
  if (warn) return tag(`주의 ${warn}`, 'warn');
  const run = c.items.find((x) => x.st.tone === 'run');
  if (run) return tag(run.st.text, 'run');
  const mut = c.items.find((x) => x.st.tone === 'muted');
  if (mut) return tag(mut.st.text, 'muted');
  return tag('정상', 'ok');
}
export function scheduleText(digest) {
  const lab = daysLabel(digest?.days || []);
  const time = digest?.time || '—';
  return lab === '매일' || lab === '평일' ? `${lab} ${time}` : `매주 ${lab} ${time}`;
}

/**
 * 종합 메일 본문(순수).
 * @param {object} m buildDigestModel 결과
 * @param {{digest:object, slot:number, manual?:boolean, preview?:boolean, recipients?:number, generatedMs?:number, now?:number, includeWatch?:boolean, includeTargets?:boolean}} o
 */
export function renderDigestMail(m, o = {}) {
  const now = o.now ?? m.now ?? Date.now();
  const T = m.totals;
  const when = slotLabel(o.slot ?? now);
  const kindWord = o.preview ? '미리보기' : o.manual ? '지금 보내기' : '정기 발송';
  const sched = scheduleText(o.digest || {});
  const subject = `[아이실론 디렉터리 사용량] 종합 보고 — ${when} · 법인 ${T.corps}곳 · 대상 ${T.targets}개 · 합계 ${bytesText(T.bytes)}`.slice(0, 200);
  const includeWatch = o.includeWatch !== false;
  const includeTargets = o.includeTargets !== false;
  const rows = [];
  rows.push(band({ title: '디렉터리 사용량 종합 보고', sub: `${when} ${kindWord} · ${sched}` }));

  // KPI
  const d7Color = T.d7 == null || T.d7Within ? C.head : T.d7 > 0 ? C.up : T.d7 < 0 ? C.down : C.head;
  const d7Value = T.d7 == null ? '—' : T.d7Within ? '변화 없음' : `${T.d7 > 0 ? '+' : ''}${bytesText(T.d7)}`;
  const big = m.biggest;
  rows.push(section(kpis([
    { label: '전체 사용량', value: bytesText(T.bytes), sub: T.unmeasured ? `대상 ${T.measured}/${T.targets}개 기준(결과 없는 ${T.unmeasured}개 제외)` : `법인 ${T.corps}곳 · 대상 ${T.targets}개` },
    { label: '7일 변화', value: d7Value, color: d7Color, sub: T.d7 == null ? '7일 전 조사가 있는 대상이 없습니다' : `${T.d7Within ? '반올림 범위 안' : signedPct(T.d7Pct)} · 기준 있는 대상 ${T.d7Targets}개` },
    { label: '수집 상태', value: `${m.counts.ok}/${m.counts.total}`, sub: [`보고 늦음 ${m.counts.stale}`, `실패 ${m.counts.failed}`, m.counts.running ? `진행 중 ${m.counts.running}` : '', m.counts.never ? `수집 전 ${m.counts.never}` : '', m.counts.off ? `꺼짐 ${m.counts.off}` : ''].filter(Boolean).join(' · ') },
    { label: '가장 큰 폴더', value: big ? big.name : '—', sub: big ? `${bytesText(big.bytes)} · ${big.corpLabel}` : '성공한 수집이 없습니다' },
  ]), '22px 26px 4px 26px'));

  // 먼저 볼 것
  if (includeWatch) {
    const W = m.watch || [];
    const shown = W.slice(0, 12);
    const line = (w) => {
      if (w.kind === 'surge') {
        const f = w.folder;
        return `<tr><td width="88" style="padding:9px 0;vertical-align:top;border-bottom:1px solid ${C.line};">${tag('급증', 'surge')}</td>`
          + `<td style="padding:9px 0 9px 8px;border-bottom:1px solid ${C.line};font-size:13px;line-height:1.55;color:${C.ink};"><b>${esc(f.name)}</b> — 7일 ${deltaCell(f.d7)} (지금 ${esc(bytesText(f.bytes))})`
          + `<div style="font-size:11.5px;color:${C.faint};">${metaLine([f.corpLabel, f.device])} · <span style="font-family:${MONO};">${esc(f.path)}</span></div></td></tr>`;
      }
      const x = w.item;
      const why = w.kind === 'bad'
        ? `${x.st.text}${x.failStreak > 1 ? ` · ${x.failStreak}회 연속` : ''} · 마지막 성공 ${x.okTs ? agoText(x.okTs, now) : '없음'}`
        : x.st.key === 'stale' ? `보고 늦음 · 마지막 성공 ${agoText(x.okTs, now)}` : `권한 오류 ${(x.t.okScan?.errLines || 0).toLocaleString('ko-KR')}줄 — 일부 폴더 크기가 작을 수 있습니다`;
      const err = w.kind === 'bad' && x.t.lastTry?.error ? `<div style="font-size:11.5px;color:${C.faint};font-family:${MONO};word-break:break-all;">${esc(String(x.t.lastTry.error).slice(0, 160))}</div>` : '';
      return `<tr><td width="88" style="padding:9px 0;vertical-align:top;border-bottom:1px solid ${C.line};">${tag(w.kind === 'bad' ? '실패' : x.st.key === 'stale' ? '보고 늦음' : '권한 오류', w.kind)}</td>`
        + `<td style="padding:9px 0 9px 8px;border-bottom:1px solid ${C.line};font-size:13px;line-height:1.55;color:${C.ink};"><b>${esc(x.corpLabel)} · ${esc(x.device)}</b> <span style="font-family:${MONO};font-size:12px;">${esc(x.path)}</span>`
        + `<div style="font-size:12px;color:${C.dim};">${esc(why)}</div>${err}</td></tr>`;
    };
    const inner = shown.length
      ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">${shown.map(line).join('')}</table>${W.length > shown.length ? `<div style="font-size:12px;color:${C.faint};margin-top:6px;">외 ${W.length - shown.length}건 — 포탈 ${esc(VIEW_PATH)} › 수집 상태에서 전부 봅니다.</div>` : ''}`
      : `<div style="font-size:13px;color:${C.dim};">먼저 볼 것이 없습니다 — 실패·보고 늦음·권한 오류·7일 급증 폴더가 없습니다.</div>`;
    rows.push(section(`${sectionTitle(`먼저 볼 것 ${W.length}건`)}${inner}`));
  }

  // 법인별 사용량
  const corpRows = m.corps.map((c) => `<tr>`
    + td(`<b>${esc(c.label)}</b>${c.unmeasured ? `<div style="font-size:11.5px;color:${C.faint};">결과 없음 ${c.unmeasured}개</div>` : ''}`)
    + td(String(c.targets), 'right')
    + td(`<span style="white-space:nowrap;">${esc(bytesText(c.bytes))}</span>${c.share != null ? `${bar(c.share)}<div style="font-size:11px;color:${C.faint};">${esc(pct(c.share))}</div>` : ''}`, 'right', 'min-width:96px;')
    + td(c.bytes == null ? `<span style="color:${C.faint};">—</span>` : c.d7 == null ? `<span style="color:${C.faint};">기준 없음</span>` : deltaCell({ bytes: c.d7, within: c.d7Within }, { partial: c.d7Partial }), 'right')
    + td(corpStatusTag(c), 'left')
    + `</tr>`);
  corpRows.push(`<tr>${td('<b>합계</b>', 'left', 'border-bottom:none;')}${td(String(T.targets), 'right', 'border-bottom:none;')}${td(`<b style="white-space:nowrap;">${esc(bytesText(T.bytes))}</b>`, 'right', 'border-bottom:none;')}${td(T.d7 == null ? '—' : deltaCell({ bytes: T.d7, within: T.d7Within }), 'right', 'border-bottom:none;')}${td('', 'left', 'border-bottom:none;')}</tr>`);
  rows.push(section(`${sectionTitle('법인별 사용량', '사용량 많은 순')}${table([th('법인'), th('대상', 'right'), th('사용량', 'right'), th('7일 변화', 'right'), th('상태')], corpRows)}`));

  // 전 법인 폴더 Top N
  const topRows = m.top.map((r) => `<tr>`
    + td(`<span style="color:${C.faint};">${r.rank}</span>`, 'right', 'width:24px;')
    + td(`<b style="word-break:break-all;">${esc(r.name)}</b> ${r.lastValue ? tag('직전 성공 값', 'warn') : ''}<div style="font-size:11.5px;color:${C.faint};">${metaLine([r.corpLabel, r.device])} · <span style="font-family:${MONO};word-break:break-all;">${esc(r.path)}</span></div>`)
    + td(`<span style="white-space:nowrap;">${esc(bytesText(r.bytes))}</span>`, 'right')
    + td(deltaCell(r.d7, { hasBase: r.hasBase, isNew: r.new7 }), 'right')
    + `</tr>`);
  rows.push(section(`${sectionTitle(`전 법인 폴더 Top ${m.topN}`)}${topRows.length ? table([th('#', 'right', '24'), th('폴더'), th('크기', 'right'), th('7일 변화', 'right')], topRows) : `<div style="font-size:13px;color:${C.dim};">성공한 수집이 있는 대상이 없어 순위를 만들 수 없습니다.</div>`}`));

  // 수집 대상별
  if (includeTargets) {
    const trs = [];
    for (const c of m.corps) {
      trs.push(`<tr><td colspan="4" style="padding:12px 8px 6px 8px;font-size:12.5px;font-weight:700;color:${C.head};border-bottom:1px solid ${C.border};font-family:${FONT};">${esc(c.label)}</td></tr>`);
      for (const x of c.items) {
        trs.push(`<tr>`
          + td(`<b>${esc(x.device)}</b>${x.label ? ` <span style="color:${C.faint};">${esc(x.label)}</span>` : ''}<div style="font-family:${MONO};font-size:12px;word-break:break-all;color:${C.dim};">${esc(x.path)}</div>`)
          + td(`<span style="white-space:nowrap;">${esc(bytesText(x.bytes))}</span>${x.lastValue && x.bytes != null ? `<div style="font-size:11px;color:#8A5A00;">직전 성공 값</div>` : ''}`, 'right')
          + td(x.bytes == null ? `<span style="color:${C.faint};">—</span>` : deltaCell(x.d7, { hasBase: !!x.ov?.base7 }), 'right')
          + td(`${STATUS_TAG(x.st)}<div style="font-size:11.5px;color:${C.faint};margin-top:3px;">마지막 성공 ${x.okTs ? esc(short(x.okTs)) : '없음'}</div>`)
          + `</tr>`);
      }
    }
    rows.push(section(`${sectionTitle('수집 대상별', `${T.targets}개`)}${trs.length ? table([th('장비·경로'), th('사용량', 'right'), th('7일 변화', 'right'), th('마지막 성공 · 상태')], trs) : `<div style="font-size:13px;color:${C.dim};">수집 대상이 없습니다.</div>`}`));
  }

  // 숫자를 읽는 법
  const how = [];
  if (m.approx) how.push('크기는 du -h 반올림 값입니다 — 두 조사의 차이가 반올림 범위 안이면 ‘변화 없음’ 으로 셉니다.');
  how.push('실패·보고 늦음 대상의 값은 직전 성공 조사 값입니다(칸에 ‘직전 성공 값’ 이라 적었습니다).');
  if (T.d7 != null) how.push(`7일 변화는 7일 이전 성공 조사가 있는 대상만 더했습니다(${T.d7Targets}/${T.measured}개).`);
  if (T.unmeasured) how.push(`전체 사용량은 성공한 수집이 있는 대상만 더했습니다(결과가 없는 ${T.unmeasured}개는 뺐습니다).`);
  if (includeWatch) how.push(`급증: 7일 증가가 ${esc(bytesText(SURGE_MIN_BYTES))} 이상이면서 7일 전 크기의 ${Math.round(SURGE_MIN_RATIO * 100)}% 이상인 폴더.`);
  if (m.oldestOk && m.newestOk && m.newestOk - m.oldestOk > 3_600_000) how.push(`대상마다 조사 시각이 다릅니다 — 가장 이른 성공 조사 ${esc(short(m.oldestOk))}, 가장 늦은 조사 ${esc(short(m.newestOk))}.`);
  rows.push(readHow(how));

  const foot = [
    `발송 일정: <b style="color:${C.ink};">${esc(sched)}</b>(포탈 시각). 정한 시각에 그때까지 모인 마지막 성공 조사로 만들었습니다 — 조사를 새로 돌리지 않습니다.`,
    `받는 사람 ${o.recipients != null ? `${o.recipients}명` : '—'} · 바꾸는 곳: ${esc(SETTINGS_PATH)} › 종합 메일 · 화면: ${esc(VIEW_PATH)}`,
  ];
  if (m.demoExcluded) foot.push(`데모 대상 ${m.demoExcluded}개는 넣지 않았습니다.`);
  if (m.demoIncluded) foot.push(`미리보기 — 데모 대상 ${m.demoIncluded}개가 들어 있습니다(실제 발송에서는 빠집니다).`);
  foot.push(`만든 시각 ${esc(localStamp(now) || '—')}${o.generatedMs != null ? ` · 만드는 데 ${Math.max(0, Math.round(o.generatedMs))}ms` : ''}`);
  rows.push(footer(foot));
  const html = doc(subject, `법인 ${T.corps}곳 · 대상 ${T.targets}개 · 합계 ${bytesText(T.bytes)} · 7일 ${d7Value}`, rows);

  const text = [
    `디렉터리 사용량 종합 보고 — ${when} ${kindWord} · ${sched}`,
    `전체 사용량: ${bytesText(T.bytes)}${T.unmeasured ? ` (대상 ${T.measured}/${T.targets}개 기준)` : ''}`,
    `7일 변화: ${d7Value}${T.d7 != null && !T.d7Within ? ` ${signedPct(T.d7Pct)}` : ''}`,
    `수집 상태: 정상 ${m.counts.ok}/${m.counts.total} · 보고 늦음 ${m.counts.stale} · 실패 ${m.counts.failed}`,
    '',
    ...(includeWatch ? [`먼저 볼 것 ${(m.watch || []).length}건:`, ...(m.watch || []).slice(0, 12).map((w) => (w.kind === 'surge'
      ? `- [급증] ${w.folder.name} 7일 ${deltaText({ bytes: w.folder.d7.bytes, withinRes: w.folder.d7.within })} (${w.folder.corpLabel} · ${w.folder.path})`
      : `- [${w.kind === 'bad' ? '실패' : w.item.st.text}] ${w.item.corpLabel} · ${w.item.device} ${w.item.path}`)), ''] : []),
    '법인별 사용량:',
    ...m.corps.map((c) => `- ${c.label}: ${bytesText(c.bytes)} (${pct(c.share)}) · 7일 ${c.d7 == null ? '기준 없음' : deltaText({ bytes: c.d7, withinRes: c.d7Within })} · 대상 ${c.targets}개`),
    '',
    `전 법인 폴더 Top ${m.topN}:`,
    ...m.top.map((r) => `${String(r.rank).padStart(2)}. ${r.name} — ${bytesText(r.bytes)} · 7일 ${r.new7 ? '신규' : r.d7 ? deltaText({ bytes: r.d7.bytes, withinRes: r.d7.within }) : '—'} (${r.corpLabel} · ${r.path})${r.lastValue ? ' [직전 성공 값]' : ''}`),
    '',
    `발송 일정: ${sched} · 설정: ${SETTINGS_PATH} › 종합 메일`,
  ].join('\n');
  return { subject, html, text };
}

// ── ③ 대상별 결과 메일 ────────────────────────────────────────────────────
/**
 * @param {{label:string, corp?:string, report:object, change?:object|null, recipients?:{fromCommon:number, fromTarget:number}|null, onlyOnChange?:boolean, now?:number}} a
 */
export function renderResultMail({ label, corp = '', report, change = null, recipients = null, onlyOnChange = false, now = Date.now() }) {
  const s = report.scan || {};
  const k = report.kpi || {};
  const when = localStamp(s.ts) || '—';
  const d7 = k.totalDelta7 || null;
  const subject = `[아이실론 디렉터리 사용량] ${label}${corp ? ` · ${corp}` : ''} — ${when} · 전체 ${bytesText(k.denomBytes)}${d7 ? ` · 7일 ${deltaText(d7)}` : ''}`.slice(0, 200);
  const rows = [];
  const chips = [corp ? chip(corp) : '', s.sizeMode === 'k' ? chip('정확(-k)') : chip('반올림(-h)')].filter(Boolean);
  rows.push(band({ title: s.path || '—', titleMono: true, chips, sub: metaLine([s.host || '—', `${when} 조사`, `소요 ${secText(s.durationMs)}`, s.node ? `엣지 ${s.node}` : '메인']) }));
  const base7Bytes = d7 && numOrNull(k.denomBytes) != null ? k.denomBytes - d7.bytes : null;
  const d7Pct = d7 && !d7.withinRes && base7Bytes > 0 ? d7.bytes / base7Bytes : null;
  rows.push(section(kpis([
    { label: '전체 사용량', value: bytesText(k.denomBytes), sub: label },
    { label: '7일 변화', valueHtml: d7 ? deltaCell(d7) : `<span style="color:${C.faint};">—</span>`, sub: report.base7 ? `${d7Pct != null ? `${signedPct(d7Pct)} · ` : ''}기준 ${short(report.base7.ts)} 조사` : '7일 이전 조사가 없어 비교하지 않았습니다' },
    { label: '폴더 수', value: (numOrNull(k.users) ?? 0).toLocaleString('ko-KR'), sub: k.new7 != null ? `7일 신규 ${k.new7} · 사라짐 ${k.removed7 ?? 0}` : '신규·사라짐: 7일 전 조사 없음' },
    { label: `상위 ${k.topN ?? 0}개 비중`, value: pct(k.topShare), sub: `${bytesText(k.topBytes)} / ${bytesText(k.denomBytes)}` },
  ]), '22px 26px 4px 26px'));
  const notes = [];
  if (change && !change.first && change.reasons?.length) notes.push({ tone: 'surge', text: `직전 조사 대비: ${change.reasons.join(' · ')}` });
  if (change && change.first) notes.push({ tone: 'surge', text: '이 대상의 첫 결과입니다.' });
  if (s.errLines) notes.push({ tone: 'warn', text: `du 가 권한 오류 ${Number(s.errLines).toLocaleString('ko-KR')}줄을 냈습니다 — 일부 폴더 크기가 실제보다 작을 수 있습니다.` });
  if (s.truncated) notes.push({ tone: 'warn', text: '폴더가 많아 일부만 저장했습니다(상한).' });
  if (notes.length) {
    rows.push(section(notes.map((n) => { const t = TONE[n.tone] || TONE.muted; return `<div style="background:${t.bg};color:${t.fg};border-radius:6px;padding:10px 14px;font-size:13px;line-height:1.55;margin-bottom:8px;">${esc(n.text)}</div>`; }).join(''), '18px 32px 0 32px'));
  }
  const top = report.top || [];
  const topRows = top.map((r) => `<tr>`
    + td(`<span style="color:${C.faint};">${r.rank}</span>`, 'right', 'width:24px;')
    + td(`<b style="word-break:break-all;">${esc(r.name)}</b>${bar(numOrNull(r.share) ?? 0)}`)
    + td(`<span style="white-space:nowrap;">${esc(bytesText(r.bytes))}</span><div style="font-size:11px;color:${C.faint};">${esc(pct(r.share))}</div>`, 'right')
    + td(deltaCell(r.d7, { hasBase: !!report.base7, isNew: r.new7 === true }), 'right')
    + `</tr>`);
  const restN = (numOrNull(k.users) ?? 0) - top.length;
  if (restN > 0) {
    const restB = numOrNull(k.denomBytes) != null && numOrNull(k.topBytes) != null ? k.denomBytes - k.topBytes : null;
    topRows.push(`<tr>${td('', 'right')}${td(`<span style="color:${C.dim};">나머지 ${restN.toLocaleString('ko-KR')}개</span>`)}${td(`<span style="color:${C.dim};white-space:nowrap;">${esc(bytesText(restB))}</span>`, 'right')}${td('', 'right')}</tr>`);
  }
  rows.push(section(`${sectionTitle(`폴더 Top ${k.topN ?? top.length}`)}${table([th('#', 'right', '24'), th('폴더'), th('크기', 'right'), th('7일 변화', 'right')], topRows)}`));
  const growth = (report.growth || []).slice(0, 3);
  if (growth.length) {
    const cell = (g) => `<div style="display:inline-block;vertical-align:top;width:33.33%;min-width:150px;box-sizing:border-box;padding:6px;"><div style="border:1px solid ${C.line};border-radius:6px;padding:12px 14px;">`
      + `<div style="font-size:13px;font-weight:700;color:${C.head};word-break:break-all;font-family:${FONT};">${esc(g.name)}</div>`
      + `<div style="font-size:18px;font-weight:700;margin-top:4px;font-family:${FONT};">${deltaCell(g.d7)}</div>`
      + `<div style="font-size:11.5px;color:${C.faint};margin-top:2px;font-family:${FONT};">지금 ${esc(bytesText(g.bytes))}</div></div></div>`;
    rows.push(section(`${sectionTitle('7일 증가 상위')}<div style="font-size:0;line-height:0;margin:0 -6px;">${growth.map(cell).join('')}</div>`));
  }
  const how = [];
  if (s.sizeMode !== 'k') how.push('크기는 du -h 반올림 값입니다 — 반올림 범위 안의 차이는 ‘변화 없음’ 으로 셉니다.');
  how.push(report.base7 ? `7일 변화는 ${esc(short(report.base7.ts))} 조사(${report.base7.spanDays}일 전)와 비교했습니다.` : '7일 변화: 7일 이전 성공 조사가 없어 비교하지 않았습니다.');
  rows.push(readHow(how));
  const rc = recipients ? `받는 사람: 공통 ${recipients.fromCommon}명 + 이 대상 ${recipients.fromTarget}명` : '';
  rows.push(footer([
    `조사가 끝날 때마다 보냅니다${onlyOnChange ? '(직전 조사와 상위 폴더·전체 합계가 반올림 범위 안에서 같으면 보내지 않습니다)' : ''}.`,
    `${rc ? `${esc(rc)} · ` : ''}바꾸는 곳: ${esc(SETTINGS_PATH)} › 대상 › 결과 메일`,
    `화면: ${esc(VIEW_PATH)} · 보낸 시각 ${esc(localStamp(now) || '—')}`,
  ]));
  const html = doc(subject, `${label} — 전체 ${bytesText(k.denomBytes)}${d7 ? ` · 7일 ${deltaText(d7)}` : ''}`, rows);
  const text = [
    `${label}${corp ? ` · ${corp}` : ''} — 디렉터리 사용량 상위 ${k.topN ?? 0}개`,
    `경로: ${s.path}`, `장비: ${s.host || '—'}`, `조사 노드: ${s.node || '메인'}`, `조사 시각: ${when}`, `소요: ${secText(s.durationMs)}`,
    `전체 합계: ${bytesText(k.denomBytes)}${d7 ? ` (7일 ${deltaText(d7)})` : ''}`,
    `폴더 수: ${(numOrNull(k.users) ?? 0).toLocaleString()}개${k.new7 != null ? ` · 7일 신규 ${k.new7}개` : ''}${k.removed7 != null ? ` · 사라짐 ${k.removed7}개` : ''}`,
    '',
    ...top.map((r) => `${String(r.rank).padStart(2)}. ${r.name} — ${bytesText(r.bytes)} (${pct(r.share)}, 7일 ${r.new7 === true ? '신규' : deltaText(r.d7)})`),
    ...(growth.length ? ['', '7일 증가 상위:', ...growth.map((g) => `- ${g.name} ${deltaText(g.d7)} (지금 ${bytesText(g.bytes)})`)] : []),
    ...notes.map((n) => `* ${n.text}`),
    '', `바꾸는 곳: ${SETTINGS_PATH} › 대상 › 결과 메일`,
  ].join('\n');
  return { subject, html, text };
}

// ── ④ 대상별 실패 알림 ────────────────────────────────────────────────────
/** 실패 종류별 '확인할 것'(순서 있는 단계). 서버 `collect.js FAIL_KINDS` 와 키가 같다(테스트 대조). */
export const FAIL_STEPS = Object.freeze({
  'no-key': ['조사하는 노드에 SSH 키가 없습니다 — 수집 대상 설정의 ‘키 만들기’ 를 누릅니다.', '엣지 담당이면 그 엣지가 다음 설정 pull(최대 5분)에 키를 만듭니다 — 엣지 로그의 [isidu] 줄을 확인합니다.'],
  'device-missing': ['설정 › 스토리지에서 그 아이실론이 등록돼 있는지 확인합니다 — 지워졌으면 대상의 장비를 다시 고릅니다.', '엣지 담당이면 그 엣지가 스토리지 설정을 받았는지 엣지 로그에서 확인합니다.'],
  'device-not-isilon': ['대상 설정에서 아이실론(PowerScale) 장비를 다시 고릅니다.'],
  auth: ['장비의 그 계정 authorized_keys 에 포탈 공개키가 그대로 있는지 — 수집 대상 설정의 공개키와 대조합니다.', '계정이 잠기거나 비밀번호·키 정책이 바뀌지 않았는지 확인합니다.', '키·계정을 고치면 자동으로 다시 시도합니다. 고쳤는지는 ‘연결 시험’ 으로 먼저 확인할 수 있습니다.'],
  hostkey: ['처음 보거나 바뀐 SSH 호스트키라 접속하지 않았습니다 — 설정 › 보안 › 장비 신뢰에서 지문을 확인하고 승인합니다.', '장비를 교체하거나 다시 설치하지 않았다면 키가 바뀐 이유를 먼저 확인합니다.'],
  timeout: ['du 가 시한 안에 끝나지 않았습니다 — 대상의 시한을 늘리거나(최대 180분) 더 아래 경로로 나눠 등록합니다.', '장비 부하가 높은 시간대를 피해 주기를 조정합니다.'],
  unreachable: ['조사하는 노드에서 아이실론 SSH(22번)에 닿는지 확인합니다 — 주소·방화벽·회선.', '엣지 담당이면 그 엣지에서 확인합니다.'],
  exec: ['경로가 있는지, 그 계정에 읽기 권한이 있는지 확인합니다 — ‘연결 시험’ 이 경로를 확인합니다.'],
  parse: ['du 출력에서 폴더를 읽지 못했습니다 — 경로가 비어 있지 않은지, 위 오류 원문을 확인합니다.'],
  'output-cap': ['하위 폴더가 너무 많아 출력이 상한을 넘었습니다 — 더 아래 경로로 나눠 등록합니다.'],
  db: ['조사는 끝났지만 결과를 저장하지 못했습니다 — 포탈 서버의 디스크 여유와 서버 로그의 [isidu-db] 줄을 확인합니다.'],
});
const DEFAULT_STEPS = ['위 오류 원문을 확인하고, 포탈에서 ‘연결 시험’ 으로 경로·접속을 확인합니다.'];
export const stepsOf = (kind) => FAIL_STEPS[kind] || DEFAULT_STEPS;

/**
 * @param {{label:string, corp?:string, scan:object, target?:object, failStreak?:number, firstFailTs?:number|null, lastOk?:{ts:number, bytes:number|null}|null, authStopped?:boolean|null, failAlertHours?:number, now?:number}} a
 */
export function renderFailureMail({ label, corp = '', scan, target = {}, failStreak = 0, firstFailTs = null, lastOk = null, authStopped = null, failAlertHours = 6, now = Date.now() }) {
  const when = localStamp(scan?.ts) || '—';
  const kind = scan?.kind || 'error';
  const title = failTitleOf(kind);
  const streak = Math.max(1, numOrNull(failStreak) || 1);
  const subject = `[아이실론 디렉터리 사용량] 조사 실패 — ${label}${corp ? ` · ${corp}` : ''} (${when})`.slice(0, 200);
  const host = scan?.host || target.host || '—';
  const path = scan?.path || target.path || '—';
  const node = scan?.node ? `엣지 ${scan.node}` : '메인';
  const rows = [];
  rows.push(band({ label: 'ISILON · DIRECTORY USAGE', title: path, titleMono: true, bg: C.alert, subColor: '#FBDAD6', chips: [chip('조사 실패', { solid: true, bg: C.alert }), corp ? chip(corp) : ''].filter(Boolean), sub: metaLine([host, `${when}`, `${streak}회 연속 실패`]) }));
  const kv = (k, v) => `<tr><td width="150" style="padding:9px 6px;border-bottom:1px solid ${C.line};color:${C.dim};font-size:13px;font-family:${FONT};vertical-align:top;">${esc(k)}</td><td style="padding:9px 6px;border-bottom:1px solid ${C.line};font-size:13px;color:${C.ink};font-family:${FONT};">${v}</td></tr>`;
  const kvs = [
    kv('장비', `<span style="font-family:${MONO};">${esc(host)}</span>`),
    kv('조사 노드', esc(node)),
    kv('연속 실패', `<b>${streak}회</b>${firstFailTs ? ` · 처음 실패 ${esc(short(firstFailTs))}` : ''}`),
    kv('마지막 성공', lastOk?.ts ? `${esc(short(lastOk.ts))}${lastOk.bytes != null ? ` · 그때 전체 ${esc(bytesText(lastOk.bytes))}` : ''}` : '없음'),
  ];
  if (kind === 'auth') kvs.push(kv('주기 수집', authStopped === false ? '계속 — 아직 멈추지 않았습니다' : `<b style="color:#8A5A00;">멈춤</b> — 계정 잠금을 막으려고 인증 거부 뒤 자동 조사를 멈췄습니다${scan?.node ? '(그 엣지에서)' : ''}`));
  rows.push(section(`${sectionTitle('무슨 일이 있었나')}`
    + `<div style="background:${TONE.bad.bg};border-radius:6px;padding:14px 16px;"><div style="font-size:14px;font-weight:700;color:#7A1A12;">${esc(title)}</div>`
    + `<div style="font-family:${MONO};font-size:12.5px;color:#3A1712;line-height:1.6;word-break:break-all;margin-top:4px;">${esc(String(scan?.error || '사유를 읽지 못했습니다').slice(0, 600))}</div></div>`
    + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-top:6px;">${kvs.join('')}</table>`));
  const steps = stepsOf(kind);
  rows.push(section(`${sectionTitle('확인할 것')}${steps.map((st, i) => `<table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-bottom:8px;"><tr>`
    + `<td width="24" style="vertical-align:top;"><div style="width:24px;height:24px;border-radius:12px;background:${C.head};color:#FFFFFF;font-size:12.5px;font-weight:700;text-align:center;line-height:24px;font-family:${FONT};">${i + 1}</div></td>`
    + `<td style="padding-left:12px;font-size:13.5px;line-height:1.6;color:${C.ink};font-family:${FONT};">${esc(st)}</td></tr></table>`).join('')}`));
  rows.push(footer([
    `같은 대상의 다음 실패 알림은 <b style="color:${C.ink};">${failAlertHours}시간 뒤</b>에야 보냅니다. 성공하면 결과 메일이 다시 갑니다(결과 메일을 고른 경우).`,
    `실패 알림 끄기·받는 사람 바꾸기: ${esc(SETTINGS_PATH)} › 대상 › 결과 메일 · 화면: ${esc(VIEW_PATH)}`,
  ]));
  const html = doc(subject, `${label} — ${title}`, rows);
  const text = [
    `${label}${corp ? ` · ${corp}` : ''} — 디렉터리 사용량 조사 실패`,
    `경로: ${path}`, `장비: ${host}`, `조사 노드: ${node}`, `시각: ${when}`,
    `종류: ${title}(${kind})`, `사유: ${scan?.error || '—'}`, `연속 실패: ${streak}회${firstFailTs ? ` · 처음 실패 ${short(firstFailTs)}` : ''}`,
    `마지막 성공: ${lastOk?.ts ? localStamp(lastOk.ts) : '없음'}`,
    '', '확인할 것:', ...steps.map((st, i) => `${i + 1}. ${st}`),
    '', `다음 실패 알림은 ${failAlertHours}시간 뒤에야 보냅니다(같은 대상).`,
  ].join('\n');
  return { subject, html, text };
}

