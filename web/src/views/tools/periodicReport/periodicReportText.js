/**
 * periodicReportText.js — 정기 점검 보고 화면의 순수 문구 · 판정 표기(v3.32 · 설계 docs/design/periodic-report).
 * 판정 · 조립은 서버(server/src/periodic/*)가 하고, 화면은 그리기만 한다. 판정 표기는 색만으로 구분하지 않는다 — 기호 + 글자.
 * 서버 rules.js 의 STATUS_LABEL · KIND_LABEL 과 같은 글자(테스트가 대조한다).
 */
export const KINDS = Object.freeze(['daily', 'weekly', 'monthly', 'quarterly']);
export const KIND_LABEL = Object.freeze({ daily: '일일', weekly: '주간', monthly: '월간', quarterly: '분기' });
export const STATUS_LABEL = Object.freeze({ ok: '정상', warn: '주의', crit: '이상', unknown: '확인 불가', info: '정보' });
export const STATUS_GLYPH = Object.freeze({ ok: '✓', warn: '!', crit: '×', unknown: '?', info: 'i' });
export const AXIS_LABEL = Object.freeze({ infra: '인프라', service: '서비스', facility: '설비' });
export const AXES = Object.freeze(['infra', 'service', 'facility']);
export const WEEKDAYS = Object.freeze([{ v: 1, l: '월' }, { v: 2, l: '화' }, { v: 3, l: '수' }, { v: 4, l: '목' }, { v: 5, l: '금' }, { v: 6, l: '토' }, { v: 0, l: '일' }]);
export const VIEWS = Object.freeze([{ key: 'archive', label: '보관함' }, { key: 'items', label: '점검 항목' }, { key: 'schedule', label: '일정 · 전달' }]);
export const CHANNEL_LABEL = Object.freeze({ mail: '메일', chat: '알림 채널', notice: '공지', issues: '이슈', all: '전체' });
export const DELIVERY_STATE = Object.freeze({ sent: '보냄', skipped: '건너뜀', failed: '실패', retry: '재시도 대기' });

/** 판정 표기 '✓ 정상'. 모르는 값은 확인 불가. */
export const statusText = (s) => `${STATUS_GLYPH[s] || '?'} ${STATUS_LABEL[s] || STATUS_LABEL.unknown}`;
/** 정수 표기(못 읽으면 '—' — 0 을 지어내지 않는다). */
export function numText(v) {
  if (v == null || v === '') return '—';
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('ko-KR') : '—';
}
/** epoch → 'MM-DD HH:MM'(포탈 시각 — 기본 KST). 못 읽으면 '—'. */
export function kstText(ms, { offsetMin = 540, withYear = false } = {}) {
  const n = Number(ms);
  if (ms == null || !Number.isFinite(n) || n <= 0) return '—';
  const d = new Date(n + offsetMin * 60_000);
  const p = (x) => String(x).padStart(2, '0');
  return `${withYear ? `${d.getUTCFullYear()}-` : ''}${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}
/** 주기 일정 한 줄 — '매일 08:00' · '매주 월 08:30' · '매월 1일 09:00' · '1·4·7·10월 1일 09:30' · '꺼짐'. */
export function scheduleLine(kind, def) {
  if (!def || !def.enabled) return '꺼짐';
  if (kind === 'daily') return `매일${def.skipWeekend ? '(주말 제외)' : ''} ${def.time}`;
  if (kind === 'weekly') return `매주 ${WEEKDAYS.find((w) => w.v === Number(def.weekday))?.l || '?'}요일 ${def.time}`;
  if (kind === 'monthly') return `매월 ${def.monthDay}일 ${def.time}${Number(def.monthDay) > 28 ? '(없는 날은 말일)' : ''}`;
  if (kind === 'quarterly') return `1 · 4 · 7 · 10월 ${def.monthDay}일 ${def.time}`;
  return '—';
}
/** 판정별 개수 한 줄 — 확인 불가 · 정보를 따로 적는다. */
export function countsLine(c) {
  if (!c) return '—';
  return `정상 ${numText(c.ok)} · 주의 ${numText(c.warn)} · 이상 ${numText(c.crit)} · 확인 불가 ${numText(c.unknown)} · 정보 ${numText(c.info)}`;
}
/** 전달 기록 묶음 — '메일 보냄 2 · 공지 보냄 1 · 메일 실패 1'. */
export function deliveriesSummary(list) {
  const m = new Map();
  for (const d of list || []) { const k = `${CHANNEL_LABEL[d.channel] || d.channel} ${DELIVERY_STATE[d.state] || d.state}`; m.set(k, (m.get(k) || 0) + 1); }
  return [...m.entries()].map(([k, v]) => `${k} ${v}`).join(' · ') || '기록 없음';
}
/** 항목을 축별로 묶는다(판정 있는 항목 먼저 — 나쁜 순 · 정보는 뒤). */
const ORDER = { crit: 0, warn: 1, unknown: 2, ok: 3, info: 4 };
export function itemsByAxis(items) {
  const out = Object.fromEntries(AXES.map((a) => [a, []]));
  for (const it of items || []) (out[it.axis] || (out[it.axis] = [])).push(it);
  for (const a of Object.keys(out)) out[a].sort((x, y) => (ORDER[x.status] ?? 9) - (ORDER[y.status] ?? 9) || String(x.label).localeCompare(String(y.label), 'ko'));
  return out;
}
/** 축의 종합(판정 항목만 — crit > warn > unknown > ok). 판정 항목이 없으면 null. */
export function axisWorst(items) {
  const rank = { ok: 0, unknown: 1, warn: 2, crit: 3 };
  let w = null;
  for (const it of items || []) if (it.status in rank && (w == null || rank[it.status] > rank[w])) w = it.status;
  return w;
}
/** 법인 표기 — DataCenter 이름이 있으면 그것, 아니면 vCenter 이름. */
export const corpLabel = (c) => (c ? (c.dcName || c.name || c.vc || '—') : '—');
/** 다음 회차 글 — 꺼져 있으면 '꺼짐'. */
export const nextText = (k) => (k?.enabled ? (k.next?.[0] ? kstText(k.next[0], { withYear: true }) : '—') : '꺼짐');
/** 진행 글 — '월간 M-2026-10 만드는 중 — 12/47'. */
export const busyText = (b) => (b ? `${KIND_LABEL[b.kind] || ''} ${b.id || ''} 만드는 중 — ${numText(b.done)}/${numText(b.total)}` : '');
/** 주소 문자열 → 목록(쉼표 · 공백 · 줄바꿈). 형식 검사는 서버가 한다(400). */
export const mailList = (s) => String(s || '').split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean);

/* ── v3.59 백업 성공 · 실패 현황(보고서 3절) — 판정 · 합계는 서버(backupLedger.js)가 낸다 ── */
/** 서버 backupLedger.js PRODUCTS · PRODUCT_LABEL 과 같은 글자(테스트가 대조한다). */
export const BK_PRODUCTS = Object.freeze(['veeam', 'bareos', 'clone']);
export const BK_PRODUCT_LABEL = Object.freeze({ veeam: 'Veeam', bareos: 'Bareos', clone: 'VM 백업(복제)' });
/** 백업 → 판정을 내는 서비스 축 항목 키(3절은 새 판정을 만들지 않는다 — 판정 칸은 이 항목 것). */
export const BK_ITEM_KEY = Object.freeze({ veeam: 'veeam', bareos: 'bareos', clone: 'vm-clone' });
/** 날마다의 결과 기호(되풀이 실패 줄) — 서버 render.js STRIP 과 같은 기호. 경고는 복원 지점이 생긴 실행이라 성공 기호. */
export const BK_STRIP = Object.freeze({ ok: '✓', warn: '✓', fail: '×', none: '–', unknown: '?', pre: '·' });
export const BK_STRIP_LABEL = Object.freeze({ ok: '성공', warn: '경고(성공으로 셈)', fail: '실패', none: '실행 없음', unknown: '확인 불가', pre: '적재 전' });
/** 성공률 '99.75%'(소수 둘째 자리) · 끝난 백업이 없으면 '—'. */
export function pctText(v) {
  if (v == null || v === '') return '—';
  const n = Number(v);
  return Number.isFinite(n) ? `${n.toFixed(2)}%` : '—';
}
/** 확정된 날(kd)이 없는 묶음의 수는 '—' — 못 읽은 값을 0 으로 적지 않는다(합계 · 법인 줄 · 백업 줄 공통). */
export const bkNum = (c, v) => (c && Number(c.kd) > 0 ? numText(v) : '—');
/** 앞 기간과의 차이 '+3' · '−43' · '±0'. 앞 기간을 모르면 ''. */
export function deltaText(cur, prev, known = true) {
  if (!known || cur == null || prev == null) return '';
  const d = Number(cur) - Number(prev);
  if (!Number.isFinite(d)) return '';
  return d > 0 ? `+${numText(d)}` : d < 0 ? `−${numText(-d)}` : '±0';
}
/** 확정 범위 한 줄 — '적재 18 / 31일'. 다 확정됐으면 '적재 7 / 7일'. */
export const coverageText = (cov) => (cov ? `적재 ${numText(cov.sealed)} / ${numText(cov.days)}일` : '');
/** 보관함 '백업 실패' 칸 — 알았음 줄이 없으면(적재 전 · 전부 확인 불가) '—' · 확인 불가가 있으면 '· ? n' · 꺼짐 · 오류는 그 글자. */
export function backupCellText(b) {
  if (!b) return '—';
  if (b.off) return '꺼짐';
  if (b.error) return '오류';
  if (!(Number(b.known) > 0)) return Number(b.unknown) > 0 ? `— · ? ${numText(b.unknown)}` : '—';
  return `${numText(b.fail)}${Number(b.unknown) > 0 ? ` · ? ${numText(b.unknown)}` : ''}`;
}
/** 앞 기간과 견줄 수 있는가 — 서버 backupLedger.js prevComparable 과 같은 조건(두 기간 다 확정 · 알았음 줄 있음 · 확인 불가 줄 없음 — 부분 합끼리 견주지 않는다). */
export const prevComparable = (s) => !!(s && s.prev?.full && s.prev?.known && s.coverage?.full && s.total?.kd > 0 && !(s.prev?.ud > 0) && !(s.total?.ud > 0));
/** 백업 항목들(run.items)에서 법인(vc) 하나의 가장 나쁜 판정 — 항목이 없거나 그 법인 행이 없으면 null. */
export function backupCorpStatus(items, vc, products = BK_PRODUCTS) {
  const rank = { ok: 0, unknown: 1, warn: 2, crit: 3 };
  const keys = new Set(products.map((p) => BK_ITEM_KEY[p]).filter(Boolean));
  let w = null;
  for (const it of items || []) {
    if (!keys.has(it.key)) continue;
    for (const r of it.rows || []) if (r.vc === vc && r.status in rank && (w == null || rank[r.status] > rank[w])) w = r.status;
  }
  return w;
}
