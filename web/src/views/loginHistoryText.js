/**
 * 설정 › 로그 › 최근 로그인 · 로그인 횟수(v2.912) — 화면 문구·기간 계산(순수 함수, vitest 로 고정).
 * 숫자(횟수 · 구간 · partial)는 서버 `server/src/security/loginHistory.js` 하나가 만든다 — 여기서 다시 세지 않는다.
 */

const DAY = 86_400_000;

/**
 * 기간 선택 — 서버 응답의 키(d1 · d7 · d30 · range)와 같다. 일수는 서버 응답 windows[].days 를 쓴다(화면에 숫자를 박지 않는다 —
 * '1달' 이 몇 일인지는 서버 LOGIN_WINDOWS 가 정한다). 응답이 없을 때만 이름만 보인다.
 */
export const LOGIN_PERIOD_KEYS = Object.freeze(['d1', 'd7', 'd30', 'range']);
const BASE_LABEL = { d1: '최근 1일', d7: '최근 7일', d30: '최근 1달', range: '사용자 정의' };
export function periodLabel(key, windows) {
  const base = BASE_LABEL[key] || '';
  if (key !== 'd30') return base;
  const w = (Array.isArray(windows) ? windows : []).find((x) => x?.key === key);
  return Number.isFinite(w?.days) ? `${base}(${w.days}일)` : base;
}

export const ACCOUNT_LABEL = Object.freeze({
  local: '로컬', ad: 'AD', deleted: '삭제된 로컬 계정', unknown: '모름',
});
/** 계정 종류 문구. 'unknown' 은 감사 로그에서 옮겨 온 기록만 있어 출처를 모르는 경우다. */
export function accountText(account) {
  return ACCOUNT_LABEL[account] || '모름';
}

const pad = (n) => String(n).padStart(2, '0');
/** 'YYYY-MM-DD HH:mm'(브라우저 현지 시각). 값이 없으면 '—'. */
export function fmtDateTime(ms) {
  if (!Number.isFinite(ms)) return '—';
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
/** 'YYYY-MM-DD'(현지). date 입력칸 값과 같은 모양. */
export function fmtDay(ms) {
  if (!Number.isFinite(ms)) return '';
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 경과 시간 문구 — '3분 전' · '5시간 전' · '12일 전'. 값이 없으면 '—'(0 이 아니다). */
export function agoText(ms, now) {
  if (!Number.isFinite(ms) || !Number.isFinite(now)) return '—';
  const diff = Math.max(0, now - ms);
  if (diff < 60_000) return '방금';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}분 전`;
  if (diff < DAY) return `${Math.floor(diff / 3_600_000)}시간 전`;
  return `${Math.floor(diff / DAY)}일 전`;
}

/**
 * date 입력칸 두 개(시작일 · 종료일, 둘 다 포함) → 서버 질의 { from, to }(epoch ms, [from, to)) 또는 { error }.
 * 하루의 경계는 브라우저 현지 자정이다(서머타임이 있어도 Date 생성자가 맞춘다 — 24시간을 더하지 않는다).
 */
export function dayRangeToQuery(fromDay, toDay, now = Date.now()) {
  const parse = (s) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
    if (!m) return null;
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const dt = new Date(y, mo - 1, d);
    if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;
    return { y, mo, d };
  };
  const a = parse(fromDay); const b = parse(toDay);
  if (!a || !b) return { error: '시작일과 종료일을 모두 고르세요.' };
  const from = new Date(a.y, a.mo - 1, a.d).getTime();
  const to = new Date(b.y, b.mo - 1, b.d + 1).getTime();
  if (from >= to) return { error: '종료일이 시작일보다 앞입니다.' };
  if (from > now) return { error: '시작일이 미래입니다.' };
  return { from, to };
}

/** 사용자 정의 기간 기본값 — 최근 14일(오늘 포함). */
export function defaultCustomDays(now = Date.now()) {
  const d = new Date(now);
  return { fromDay: fmtDay(new Date(d.getFullYear(), d.getMonth(), d.getDate() - 13).getTime()), toDay: fmtDay(now) };
}

/** 선택 구간의 시작~끝 문구. 고정 구간은 서버 windows[].from ~ now, 사용자 정의는 [from, to) 를 날짜로(끝은 포함 날짜). */
export function periodSpanText(data, key) {
  if (!data) return '';
  if (key === 'range') {
    const r = data.range;
    if (!r) return '';
    return `${fmtDay(r.from)} ~ ${fmtDay(r.to - 1)}`;
  }
  const w = (data.windows || []).find((x) => x.key === key);
  return w ? `${fmtDateTime(w.from)} ~ ${fmtDateTime(data.now)}` : '';
}

/** '기간 시작이 가장 오래된 기록보다 앞' 안내. 그 앞부분은 세지 못한 것이지 0 회가 아니다. 해당 없으면 ''. */
export function partialNote(data, key) {
  if (!data?.partial?.[key]) return '';
  if (data.coverageFrom == null) return '아직 로그인 기록이 없습니다 — 이 기능이 켜진 뒤의 로그인부터 셉니다.';
  return `선택한 기간의 시작이 가장 오래된 기록(${fmtDateTime(data.coverageFrom)})보다 앞입니다 — 그 앞의 로그인은 기록이 없어 세지 못했습니다(0 회라는 뜻이 아닙니다).`;
}
