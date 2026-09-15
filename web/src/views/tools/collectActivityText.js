/**
 * views/tools/collectActivityText.js — 수집 '작업 로그' 패널의 **판정·문구**(순수, v2.516).
 *
 * 사용자 요구(2026-09-15): "실패일때 클릭하면 구체적인 로그 보여주는 기능 추가" +
 * "스토리지 모니터링 처럼 화면 하단에 진행상태와 로그 보여주는 기능 추가".
 *
 * 웹 테스트는 node 환경(DOM 없음)이라 컴포넌트 렌더를 테스트할 수 없다. 그래서 이 저장소 관례대로
 * '무엇을 뭐라고 부르고 무엇을 보여줄지' 는 여기서 정하고 회귀로 고정한다.
 *
 * ── 반드시 지킬 것 ──────────────────────────────────────────────────────────
 *  · **오류 문구를 툴팁에만 두지 말 것.** v2.515 까지 실패 사유는 `title` 에만 있어 **복사도
 *    공유도 안 됐고 모바일에서는 볼 수도 없었다**(사용자가 "클릭하면 로그 보여달라" 고 한 이유).
 *    `hasDetail()` 이 참이면 화면은 **클릭 가능한 버튼**으로 그리고 전문을 펼친다.
 *  · **서버가 오류를 300자로 자른다**(`util/activityLog.js`). 잘렸을 수 있다는 사실을 밝힌다 —
 *    전문이라고 말해 놓고 잘려 있으면 사용자가 원인을 못 찾고도 다 봤다고 생각한다.
 *  · **'—' 와 0 을 구분한다.** 수집 실패면 포트·노드 수가 null 이고 0 이 아니다(0 으로 그리면
 *    '포트 0개' 라는 사실과 다른 화면이 된다 — types.js 정직 표기 규칙).
 */

/** 서버 `util/activityLog.js` 의 오류 문구 상한 — 잘림 안내 판정에 쓴다. */
export const ERROR_MAX = 300;

/** 결과 배지 — 성공/실패만 있다(부분 실패는 장비 표가 판정한다). */
export function resultBadge(ok) {
  return ok ? { text: '정상', cls: 'green' } : { text: '실패', cls: 'red' };
}

/** 출처 — 'central' 은 중앙 직접 수집, 그 외는 엣지 이름. */
export function sourceLabel(source) {
  const s = String(source || '').trim();
  if (!s || s === 'central') return { text: '중앙', edge: false };
  return { text: s, edge: true };
}

/** 클릭해서 펼칠 내용이 있는가 — 없는데 버튼으로 그리면 눌러도 아무 일이 없다. */
export function hasDetail(evt) {
  return !!(evt && (evt.error || evt.host || evt.deviceId));
}

/**
 * 펼친 상세에 넣을 줄들. **있는 것만** 넣는다(없는 값을 '—' 로 채워 줄을 늘리지 않는다).
 * @returns {{label:string, value:string}[]}
 */
export function detailLines(evt, { metrics = [] } = {}) {
  const out = [];
  const push = (label, value) => { if (value != null && value !== '') out.push({ label, value: String(value) }); };
  push('장비', evt?.name);
  push('주소', evt?.host);
  push('출처', sourceLabel(evt?.source).text);
  push('시각', evt?.at ? new Date(evt.at).toLocaleString('ko-KR', { hour12: false }) : '');
  push('소요', durationText(evt?.durationMs));
  for (const m of metrics) push(m.label, m.value);
  return out;
}

/** 소요 시간 — 없으면 null(호출부가 '—' 를 그린다). 초 단위 한 자리. */
export function durationText(ms) {
  if (!Number.isFinite(ms)) return null;
  return ms >= 60_000 ? `${Math.floor(ms / 60_000)}분 ${Math.round((ms % 60_000) / 1000)}초` : `${(ms / 1000).toFixed(1)}s`;
}

/**
 * 오류 전문 + 잘림 안내. 서버가 300자로 자르므로 그 경계에 닿으면 밝힌다.
 * @returns {{text:string, truncated:boolean, note:string}}
 */
export function errorBlock(error) {
  const text = String(error ?? '');
  const truncated = text.length >= ERROR_MAX;
  return {
    text,
    truncated,
    note: truncated
      ? `이 사유는 ${ERROR_MAX}자에서 잘렸습니다 — 전체 원문은 장비 상세의 섹션별 수집 상태나 서버 로그를 보세요.`
      : '',
  };
}

/** 진행중 구획 머리말 — 0건과 N건의 말이 다르다(0 을 '수집 중 0건' 으로 쓰면 어색하다). */
export function inFlightText(n) {
  return n > 0 ? `수집 중 ${n}건` : '진행 중인 수집 없음';
}

/**
 * 폴링 주기 안내 — **숫자를 화면에 하드코딩하지 말 것**(CLAUDE.md). API 가 준 값만 쓰고
 * 없으면 '—' 로 둔다(없는 값을 기본값으로 지어내지 않는다).
 */
export function intervalText(intervalMs) {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) return '—';
  return intervalMs >= 60_000 ? `${Math.round(intervalMs / 60_000)}분` : `${Math.round(intervalMs / 1000)}초`;
}

/** 실패만 보기 필터 — 실패가 0건이면 필터를 켤 이유가 없으므로 호출부가 버튼을 숨긴다. */
export function countFailures(events) {
  return (events || []).filter((e) => !e.ok).length;
}
