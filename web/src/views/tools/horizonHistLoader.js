/**
 * horizonHistLoader.js — Horizon '현재 사용자' 추이 조회의 **최신 요청만 반영** 판정(순수 · vitest 고정).
 *
 * 검토 I-09(2026-10-09): `HorizonSessionsPanel` 의 loadHist 는 요청 순번·취소·응답 키 없이 setHist 를 했다.
 * 서버 A·7일 요청 → 서버 B·1일 요청 순으로 시작하고 B 가 먼저 끝난 뒤 A 가 끝나면 화면은 **A·7일** 차트를
 * 그렸다(선택은 B·1일). 같은 화면의 '앱·데스크톱별 사용 현황'(HorizonUsagePanel, v2.689)은 이미
 * 순번 + 요청 키로 막고 있었다 — 형제 비대칭이었다.
 *
 * 규칙:
 *  · 성공·오류·로딩 종료는 **그 요청이 최신일 때만** 상태를 바꾼다(load 가 새로 시작되거나 cancel 되면 이전 요청은 무효).
 *  · 새 요청·취소·unmount 는 진행 중 요청을 AbortController 로 끊는다. 끊긴 요청의 AbortError 는 **장애가 아니다** —
 *    화면에 오류로 내지 않는다(무효가 된 요청은 어떤 상태도 바꾸지 않는다).
 *  · 상태에는 요청 키(days·serverId)를 붙인다. 화면은 `histView` 로 **지금 선택과 같은 키**일 때만 그린다 —
 *    다른 조건의 응답·오류는 보이지 않는다.
 */

/** 요청 키 — 숫자·문자열 표기 차이를 없앤다('' = 전체). */
export function histReqKey(days, serverId) {
  return { days: Number(days), serverId: serverId == null ? '' : String(serverId) };
}
export function sameHistKey(a, b) {
  return !!a && !!b && Number(a.days) === Number(b.days) && String(a.serverId ?? '') === String(b.serverId ?? '');
}

/** 끊긴 요청의 오류인가(사용자 동작·unmount 로 버린 요청 — 장애로 보이지 않는다). 시한 초과(TimeoutError)는 장애다. */
export function isAbortError(e) {
  return !!e && (e.name === 'AbortError' || e.code === 20);
}

/**
 * 지금 선택(days·serverId)에 해당하는 추이 상태만 돌려준다.
 *   { hist, err, loading } — 키가 다르면 전부 비어 있다(이전 조건의 차트·오류를 그리지 않는다).
 */
export function histView(state, days, serverId) {
  const empty = { hist: null, err: null, loading: false };
  if (!state || !sameHistKey(state.key, histReqKey(days, serverId))) return empty;
  return { hist: state.rep ?? null, err: state.err ?? null, loading: !!state.loading };
}

/**
 * 최신 요청만 반영하는 로더.
 *   fetcher(params, signal) → Promise<응답>   (화면은 fetchJson('/tools/horizon-sessions/history', params, signal))
 *   setState(next)                            (화면은 useState 의 setter)
 * 반환: { load(days, serverId), cancel(), dropUnless(days, serverId), pending() }
 */
export function createHistLoader(fetcher, setState) {
  let seq = 0;
  let current = null;              // { my, key, ctl }
  const abortCurrent = () => {
    if (current?.ctl) { try { current.ctl.abort(); } catch { /* 이미 끝남 */ } }
    current = null;
  };
  /** 진행 중 요청을 무효로 만든다(새 선택·unmount). 이후 그 요청의 결과는 어떤 상태도 바꾸지 않는다. */
  const cancel = () => { seq += 1; abortCurrent(); };
  /** 진행 중 요청의 키가 지금 선택과 다르면 끊는다(같으면 둔다 — 방금 시작한 요청을 끊지 않게). */
  const dropUnless = (days, serverId) => {
    if (current && !sameHistKey(current.key, histReqKey(days, serverId))) cancel();
  };
  const load = async (days, serverId) => {
    cancel();
    const my = seq;
    const key = histReqKey(days, serverId);
    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
    current = { my, key, ctl };
    setState({ key, rep: null, err: null, loading: true });
    let out;
    try {
      const rep = await fetcher({ serverId: key.serverId, days: key.days }, ctl?.signal);
      if (my !== seq) return { stale: true };
      setState({ key, rep, err: null, loading: false });
      out = { ok: true };
    } catch (e) {
      if (my !== seq) return { stale: true };
      // 같은 순번인데 끊겼다면(외부에서 signal 을 끊은 경우) 오류로 보이지 않고 로딩만 내린다.
      if (isAbortError(e) || ctl?.signal?.aborted) { setState({ key, rep: null, err: null, loading: false }); return { aborted: true }; }
      setState({ key, rep: null, err: e, loading: false });
      out = { ok: false };
    } finally {
      if (current && current.my === my) current = null;
    }
    return out;
  };
  return { load, cancel, dropUnless, pending: () => (current ? { ...current.key } : null) };
}
