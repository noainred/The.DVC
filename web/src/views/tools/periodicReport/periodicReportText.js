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
