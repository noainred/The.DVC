/**
 * views/tools/focusMonHistoryText.js — 서버 집중 모니터링 ‘긴 구간 · 사건 · 가장 변했나 · 링크’(v3.13.0 ⑭ — 시안 History · 사용자 "기본값대로 모두 구현해줘")의
 * 순수 함수(문구 · 좌표 · 주소). 판정은 서버가 한다 — 여기는 응답을 글자 · 좌표로 바꾼다. 값이 없으면 ‘—’(0 아님) · 문구에 백틱을 쓰지 않는다.
 */
import { numOrNull } from '../../numOrNull.js';
import { DASH, clockText, isLongWin, winText } from './focusMonText.js';

const n = numOrNull;

/** 긴 구간 화면의 조회 주기 — 서버가 60초 기억하므로 2초마다 묻지 않는다. 30초인 까닭: 잠깐 보기의 ‘보는 화면’ 심박(60초)을 놓치지 않게. */
export const HISTORY_POLL_MS = 30_000;
/** 조회 주기 — 과거 구간은 한 번(0) · 긴 구간은 HISTORY_POLL_MS · 그 밖은 화면 기본값. */
export function pollMsFor(win, end, shortMs) { if (end != null) return 0; return isLongWin(win) ? HISTORY_POLL_MS : shortMs; }

/** 원본 구간만 되는 화면(프로세스 · iostat · 수집 부하)의 안내. */
export function rawOnlyText(what, windows = []) {
  const list = (windows || []).map(winText).join(' · ') || '30분 이하';
  return `${what}은(는) 원본 표본이 있는 구간(${list})에서만 봅니다 — 긴 구간(1시간부터)은 요약(최저 · 평균 · 최고)만 남기기 때문입니다. 위 시간 띠에서 짧은 구간을 고르세요.`;
}

/** 축 글자 — 하루 넘는 구간은 날짜를 붙인다. */
export function axisTime(ts, win) {
  if (n(ts) == null) return DASH;
  if ((n(win) ?? 0) >= 1440) { const t = clockText(ts, true); return t.slice(0, t.length - 3); }
  return clockText(ts);
}

/* ── 링크(컨펌 — 해시에 구간 · 겹쳐 보기 · 서버 id 만) ──────────────────────
 * 앱이 해시의 첫 두 칸(tools · focus-mon)으로 화면을 고르므로 물음표 쿼리를 붙이지 않고 끝에 ‘@’ 로 시작하는 칸 하나를 덧붙인다.
 * 서버 이름 · 주소는 싣지 않는다(id 만 — 링크가 대화방에 붙어도 서버 주소가 새지 않게). */
export const CMP_KEYS = Object.freeze(['1d', '7d']);
export const CMP_TEXT = Object.freeze({ '': '없음', '1d': '어제 같은 시간', '7d': '지난주 같은 시간' });
/** 링크 칸 만들기 → '@w=1440&e=1794700000000&c=1d'(빈 값은 뺀다). */
export function linkSeg({ win, end, cmp } = {}) {
  const parts = [];
  if (n(win) != null) parts.push(`w=${n(win)}`);
  if (n(end) != null && n(end) > 0) parts.push(`e=${Math.round(n(end))}`);
  if (CMP_KEYS.includes(cmp)) parts.push(`c=${cmp}`);
  return parts.length ? `@${parts.join('&')}` : '';
}
/** 링크 칸 읽기 — 아는 칸 · 아는 값만(구간은 허용 목록 안 · 끝 시각은 양의 정수 · 겹쳐 보기는 1d | 7d). 아니면 그 칸은 null. */
export function parseLinkSeg(seg, allowedWins = []) {
  const out = { win: null, end: null, cmp: null };
  const s = String(seg || '');
  if (!s.startsWith('@')) return out;
  for (const part of s.slice(1, 200).split('&')) {
    const i = part.indexOf('='); if (i <= 0) continue;
    const k = part.slice(0, i); const v = part.slice(i + 1);
    if (k === 'w' && /^\d{1,6}$/.test(v) && allowedWins.includes(Number(v))) out.win = Number(v);
    else if (k === 'e' && /^\d{10,15}$/.test(v)) out.end = Number(v);
    else if (k === 'c' && CMP_KEYS.includes(v)) out.cmp = v;
  }
  return out;
}
/** 화면 주소(해시) — 탭 · 서버 id · 링크 칸. */
export function linkHash({ base = ['tools', 'focus-mon'], tab = 'overview', server = '', win, end, cmp } = {}) {
  const seg = linkSeg({ win, end, cmp });
  const head = tab === 'server' && server ? `#/${base.join('/')}/server/${encodeURIComponent(server)}` : tab === 'overview' || !tab ? `#/${base.join('/')}` : `#/${base.join('/')}/${tab}`;
  return seg ? `${head}/${seg}` : head;
}

/* ── 사건 ───────────────────────────────────────────────────────────────── */
/** 사건 종류 → 색조 · 낱말(색만으로 말하지 않는다 — 번호와 낱말을 같이). 서버 events.EVENT_TEXT 와 1:1(테스트가 대조). */
export const EVENT_KIND_TEXT = Object.freeze({
  reboot: { label: '재부팅', tone: 'warn' },
  auth: { label: '키 로그인 거부', tone: 'crit' },
  hostkey: { label: '호스트키 승인 필요', tone: 'warn' },
  start: { label: '수집 시작', tone: 'off' },
  stop: { label: '수집 끝', tone: 'off' },
  user: { label: '직접 적음', tone: 'ok' },
  oom: { label: 'OOM', tone: 'crit' }, // v3.16.0 ⑯ C2
  kerr: { label: '커널 오류', tone: 'warn' },
  alert: { label: '알림', tone: 'warn' }, // v3.16.0 ⑯ C1
  tune: { label: '수집 조절', tone: 'off' }, // v3.16.0 ⑯ C3
});
export const EVENT_SCOPE_TEXT = Object.freeze({ server: '이 서버', group: '이 서버의 그룹', session: '이 서버가 든 수집 전체' });
/** 차트 위 표시 — 구간 안 사건만 · x 는 0~1 · 같은 자리에 겹치면 줄을 바꾼다(최대 3줄). */
export function eventMarks(events, from, to, { minGap = 0.025 } = {}) {
  const f = n(from); const t = n(to);
  if (f == null || t == null || !(t > f)) return [];
  const out = []; const lastX = [-1, -1, -1];
  for (const e of events || []) {
    const at = n(e?.at); if (at == null || at < f || at > t) continue;
    const x = (at - f) / (t - f);
    let row = lastX.findIndex((lx) => x - lx >= minGap); if (row < 0) row = 2;
    lastX[row] = x;
    out.push({ n: e.n, x, row, kind: e.kind, tone: EVENT_KIND_TEXT[e.kind]?.tone || 'off' });
  }
  return out;
}
/** 사건 목록의 한 줄 글. */
export function eventLine(e) {
  const k = EVENT_KIND_TEXT[e?.kind]?.label || e?.label || DASH;
  return `${e?.n ?? DASH}. ${clockText(e?.at, true)} · ${k}${e?.text ? ` — ${e.text}` : ''}`;
}
/** datetime-local 값 ↔ 시각(브라우저 시간대). 빈 값은 null(= 지금). */
export function localInputValue(ts) {
  const x = n(ts); if (x == null) return '';
  const d = new Date(x); const p = (v) => String(v).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
export function fromLocalInput(v) {
  if (!v) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(String(v));
  if (!m) return null;
  const t = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5])).getTime();
  return Number.isFinite(t) ? t : null;
}

/* ── 가장 변했나 ───────────────────────────────────────────────────────────── */
/** 값 + 단위(못 읽음 ‘—’). */
export function changeValText(v, unit) {
  const x = n(v); if (x == null) return DASH;
  const t = Math.abs(x) >= 100 ? String(Math.round(x)) : String(Math.round(x * 100) / 100);
  return unit ? `${t}${unit === '%' || unit === 'ms' ? '' : ' '}${unit}` : t;
}
/** 바뀐 방향 · 비 — '×3.2 늘었음' · '×0.4 줄었음'. */
export function changeRatioText(r) {
  const x = n(r); if (x == null || x <= 0) return DASH;
  if (x >= 1) return `×${x >= 10 ? Math.round(x) : Math.round(x * 10) / 10} 늘었음`;
  return `×${Math.round(x * 100) / 100} 줄었음`;
}
/** 겹침 0~1 → '겹침 12%'. */
export function overlapText(o) { const x = n(o); return x == null ? DASH : `겹침 ${Math.round(x * 100)}%`; }
/** 앞 구간 · 고른 구간 설명. */
export function changesCaption(r) {
  if (!r) return '';
  const src = r.src === 'raw' ? '원본 표본' : r.src === 'm' ? '1분 요약 평균' : r.src === 'h' ? '1시간 요약 평균' : DASH;
  return `고른 구간 ${clockText(r.b?.from, true)} ~ ${clockText(r.b?.to, true)} 를 그 앞 4배 길이(${clockText(r.a?.from, true)} ~)와 견줍니다 · 값 ${src} · 서버 ${r.targets ?? DASH}대 × 지표 ${r.keys ?? DASH}개`;
}
