/**
 * views/vcd/useOnce.js — 탭을 열 때 1회 조회 + 버튼으로 다시(무거운·잘 바뀌지 않는 조회는 15초 폴링 금지 — docs/rules/web.md).
 *  - enabled=false(도구 권한 없음 등)면 부르지 않는다 — 403 을 만들지 않는다.
 *  - 늦게 온 이전 응답은 버린다(세대 번호). 실패는 data 를 지우지 않는다(이전 값 유지 — 고RTT 깜빡임 방지 규약).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchJson, HttpError } from '../../api.js';

export function useOnce(path, params, enabled = true) {
  const [state, setState] = useState({ data: null, error: null, loading: !!(enabled && path) });
  const gen = useRef(0);
  const key = path && enabled ? `${path}?${JSON.stringify(params || {})}` : '';
  const load = useCallback(() => {
    if (!key) return;
    const my = ++gen.current;
    setState((s) => ({ ...s, loading: true }));
    fetchJson(path, params || {})
      .then((d) => { if (my === gen.current) setState({ data: d, error: null, loading: false }); })
      .catch((e) => { if (my === gen.current) setState((s) => ({ data: s.data, error: e, loading: false })); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  useEffect(() => {
    const g = gen;   // 세대 번호 상자(DOM 이 아니다) — 정리 때 올려 그 뒤에 도착한 응답을 버린다
    if (!key) { g.current++; setState({ data: null, error: null, loading: false }); return undefined; }
    load();
    return () => { g.current++; };
  }, [key, load]);
  return { ...state, reload: load };
}

/** 도구 권한이 없을 때 그 자리에 보일 403 — ErrorBox 가 권한 안내(AccessDenied)로 바꾼다(숨기지 않는다 — 기본값 5). */
export function toolDenied(label) {
  return new HttpError('forbidden', { status: 403, body: { requiredPerm: ['tools'], reason: `특수 기능 ‘${label}’ 을(를) 쓸 권한이 없어 이 칸을 불러오지 않았습니다.` } });
}
