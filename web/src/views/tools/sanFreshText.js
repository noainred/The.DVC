/**
 * sanFreshText.js — SAN 화면의 '지금 보이는 값이 언제 것인가' 판정(순수 · vitest 고정).
 *
 * 검토 I-04(2026-10-09): SAN 스토리지 트래픽 카드는 `usePolling` 이 실패해도 직전 data 를 남기는데
 * 화면은 `error && !data` 일 때만 오류를 그렸다. 첫 성공 뒤 서버 503·90초 시한이 나면 **직전 차트가
 * 지금 값처럼 남고 오류 안내는 사라졌다** — 배지(● N분마다 수집)도 실시간처럼 보였다.
 * 같은 모양이 SAN 스위치 목록(30초 폴링)·포트 사용량 설정(20초 폴링)에도 있었다.
 *
 * 규칙(이 모듈이 소유한다):
 *  · 직전 값은 **지우지 않고 남긴다**(요청 실패마다 차트를 지우면 고RTT 회선에서 화면이 깜빡인다 — v2.459 규약).
 *    대신 모든 오류는 화면 안에 말한다: '직전 조회 결과 표시 중' · 마지막 성공 시각 · 실패가 시작된 시각.
 *  · 304(본문 없음)는 실패가 아니다 — 서버가 '가진 값이 그대로 유효' 라고 답한 것이다.
 *  · 실패 상태에서 배지는 실시간 표시(●)를 쓰지 않는다(`badgeFor`).
 *  · 선택(법인·기간)이 바뀐 직후 한 번의 렌더는 **이전 조건의 data·오류가 그대로** 들어온다
 *    (`usePolling` 은 효과에서 비우므로 커밋 뒤에 비워진다). 그 한 번을 '불러오는 중' 으로 본다(carried).
 *    응답이 요청 조건을 되돌려 주면(echo) 그것과도 대조한다(`echoMatches`) — 다른 조건의 응답은 그리지 않는다.
 *
 * 시각은 전부 **브라우저 시계 하나**로 잰다(성공·실패를 관찰한 시각) — 서버 시각과 섞지 않으므로 시계 차이가 없다.
 * 한계(정직 기록): `usePolling` 은 304 가 이어질 때 다시 그리지 않으므로 '마지막 성공' 은 마지막으로 **관찰한**
 * 성공(새 응답 또는 실패→복구)이다. 실제 마지막 성공보다 이를 수는 있어도 늦지는 않다(신선하다고 과장하지 않는다).
 */

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * 관찰 추적기 — 전이가 있을 때만 시각을 바꾼다(같은 입력을 다시 넣어도 결과가 같다: StrictMode 이중 렌더 안전).
 *   prev : 직전 추적 상태(null = 처음)
 *   obs  : { data, error, key }   key = 지금 선택(법인·기간 등)을 나타내는 문자열
 *   now  : 브라우저 시각(ms)
 * 반환: { key, data, error, okAt, failAt, carried }
 */
export function trackFetch(prev, { data = null, error = null, key = '' } = {}, now = Date.now()) {
  const k = String(key ?? '');
  if (!prev || prev.key !== k) {
    // 선택이 바뀌었다 — 이 렌더의 data·error 는 이전 조건의 것일 수 있다(usePolling 이 아직 비우지 않았다).
    const carried = prev && (prev.data != null || prev.error != null) ? { data: prev.data, error: prev.error } : null;
    const same = carried && data === carried.data && error === carried.error;
    if (same) return { key: k, data, error, okAt: null, failAt: null, carried };
    return trackFetch({ key: k, data: null, error: null, okAt: null, failAt: null, carried: null }, { data, error, key: k }, now);
  }
  const next = { ...prev, data, error };
  if (next.carried) {
    if (data === next.carried.data && error === next.carried.error) return next;   // 아직 이전 조건의 값
    next.carried = null;
    // 이전 조건의 값이 비워졌다 — 그 값과의 비교로 시각을 정하지 않는다.
    if (data != null) next.okAt = now;
    if (error != null) next.failAt = now;
    return next;
  }
  if (data != null && data !== prev.data) next.okAt = now;            // 새 응답(200)
  if (error == null && prev.error != null && data != null) next.okAt = now;   // 실패 → 복구(304 포함)
  if (error == null) next.failAt = null;
  else if (prev.error == null || prev.failAt == null) next.failAt = now;     // 실패 시작(연속 실패는 시작 시각을 유지)
  return next;
}

/**
 * 응답이 되돌려 준 요청 조건(echo)이 지금 선택과 같은가. 응답에 그 필드가 없으면 판정하지 않는다(true).
 *   want: { hours, datacenterIds }   — 트래픽 합계(`/tools/sanswitch/perf/traffic-total`)가 둘 다 되돌려 준다.
 */
export function echoMatches(data, want = {}) {
  if (!data || typeof data !== 'object') return false;
  if (want.hours != null && data.hours != null && Number(data.hours) !== Number(want.hours)) return false;
  if (Array.isArray(want.datacenterIds) && Array.isArray(data.datacenterIds)) {
    const norm = (list) => list.map((x) => String(x ?? '').trim()).filter(Boolean).sort().join('\u0001');
    const a = norm(want.datacenterIds);
    const b = norm(data.datacenterIds);
    if (a !== b) return false;
  }
  return true;
}

/**
 * 표시 상태.
 *   'loading'          — 쓸 값이 없고 오류도 없다(첫 조회 중 · 선택을 바꾼 직후)
 *   'first-fail'       — 쓸 값이 없고 오류가 있다(첫 조회 실패)
 *   'fresh'            — 쓸 값이 있고 마지막 조회가 성공했다(304 포함)
 *   'failed-with-data' — 쓸 값은 직전 성공분이고 지금 조회는 실패 중이다
 * 반환: { state, usable, okAt, failAt, error }
 */
export function freshState(tr, { matches = true } = {}) {
  const t = tr || {};
  if (t.carried) return { state: 'loading', usable: false, okAt: null, failAt: null, error: null };
  const usable = t.data != null && matches !== false;
  const err = t.error != null && t.error !== '' ? t.error : null;
  if (!usable) {
    return err
      ? { state: 'first-fail', usable: false, okAt: null, failAt: isNum(t.failAt) ? t.failAt : null, error: err }
      : { state: 'loading', usable: false, okAt: null, failAt: null, error: null };
  }
  if (err) return { state: 'failed-with-data', usable: true, okAt: isNum(t.okAt) ? t.okAt : null, failAt: isNum(t.failAt) ? t.failAt : null, error: err };
  return { state: 'fresh', usable: true, okAt: isNum(t.okAt) ? t.okAt : null, failAt: null, error: null };
}

/** 시각 표기(브라우저 시계) — 모르면 '—'. */
export function clockText(ts) {
  if (!isNum(ts)) return '—';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 오류 사유 — 시한 초과는 시한을 말로(숫자는 호출자가 준 값), 그 밖은 원문. */
export function failReasonText(error, { timeoutMs = null } = {}) {
  const msg = typeof error === 'string' ? error : String(error?.message || error?.serverReason || error?.reason || error || '');
  if (/timed out|timeout|TimeoutError|due to timeout/i.test(msg)) {
    const s = isNum(timeoutMs) && timeoutMs > 0 ? Math.round(timeoutMs / 1000) : null;
    return s ? `응답 시한(${s}초) 초과` : '응답 시한 초과';
  }
  return msg.trim() || '알 수 없는 오류';
}

const everyText = (ms) => {
  if (!isNum(ms) || ms <= 0) return '';
  if (ms < 60_000) return `약 ${Math.round(ms / 1000)}초`;
  return `약 ${Math.round(ms / 60_000)}분`;
};

/**
 * 화면 안내 — 상태가 'failed-with-data'·'first-fail' 일 때만 문구가 있다(그 밖은 null).
 *   opts: { what: '트래픽 합계', pollMs, timeoutMs, stopped }   stopped = 권한 거부 등으로 자동 조회가 멈춤
 * 반환: { tone, title, text, sub } — 백틱·별표를 쓰지 않는다(BoldText 를 거치지 않는 평문 자리).
 */
export function freshNote(st, { what = '조회', pollMs = null, timeoutMs = null, stopped = false } = {}) {
  if (!st || (st.state !== 'failed-with-data' && st.state !== 'first-fail')) return null;
  const reason = failReasonText(st.error, { timeoutMs });
  const retry = stopped
    ? '자동 조회를 멈췄습니다(같은 요청은 같은 결과입니다) — 권한을 확인한 뒤 화면을 다시 여세요.'
    : `${everyText(pollMs) ? `${everyText(pollMs)} 뒤` : '다음 주기에'} 다시 조회합니다.`;
  if (st.state === 'first-fail') {
    return {
      tone: 'bad',
      title: `${what}를 불러오지 못했습니다`,
      text: `${reason}${st.failAt != null ? ` · 실패 ${clockText(st.failAt)}` : ''}`,
      sub: retry,
    };
  }
  return {
    tone: 'warn',
    title: `${what} 갱신 실패 — 직전 조회 결과 표시 중`,
    text: `마지막 성공 ${clockText(st.okAt)} · 조회 실패 ${clockText(st.failAt)}부터 · ${reason}`,
    sub: `아래 값은 마지막 성공 시점의 것입니다(지금 값이 아닙니다). ${retry} 성공하면 이 안내는 사라집니다.`,
  };
}

/**
 * 머리 배지 — 실패 중이면 실시간 표시(●)를 쓰지 않는다.
 *   live: 정상일 때 쓸 문구(예: collectBadgeText 결과). 반환 { text, live } — text 가 비면 배지를 그리지 않는다.
 */
export function badgeFor(st, live = '') {
  if (!st || !st.usable) return { text: '', live: false };
  if (st.state === 'failed-with-data') return { text: `갱신 실패 · 마지막 성공 ${clockText(st.okAt)}`, live: false };
  return { text: String(live || ''), live: !!live };
}
