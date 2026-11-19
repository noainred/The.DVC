/**
 * focusMonPoll.js — 서버 집중 모니터링 화면의 폴링 훅(v2.983 에 FocusMonTool.jsx 에서 옮김 — 수집 부하 탭 FocusMonLoad.jsx 도 같이 쓴다).
 * 늦게 온 이전 응답은 버린다(세대 번호) · 화면이 숨겨지면 건너뛴다 · 권한 · 인증 오류면 멈춘다(shouldStopPolling).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { fetchJson } from '../../api.js';
import { shouldStopPolling } from './focusMonText.js';

export function usePoll(path, params, intervalMs, enabled = true) {
  const [state, setState] = useState({ data: null, error: null, key: '' });
  const key = useMemo(() => `${path}?${new URLSearchParams(Object.entries(params || {}).filter(([, v]) => v != null && v !== '')).toString()}`, [path, params]);
  const gen = useRef(0);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!enabled || !path) return undefined;
    const my = ++gen.current; let timer = null; let alive = true;
    const loop = async () => {
      if (!alive || my !== gen.current) return;
      let stop = false;
      if (typeof document === 'undefined' || !document.hidden) {
        try {
          const d = await fetchJson(path, Object.fromEntries(Object.entries(params || {}).filter(([, v]) => v != null && v !== '')));
          if (alive && my === gen.current) setState({ data: d, error: null, key });
        } catch (e) {
          if (alive && my === gen.current) setState((s) => ({ ...s, error: e }));
          stop = shouldStopPolling(e);
        }
      }
      if (alive && my === gen.current && intervalMs > 0 && !stop) timer = setTimeout(loop, intervalMs);
    };
    loop();
    return () => { alive = false; if (timer) clearTimeout(timer); };
  }, [key, intervalMs, enabled, tick]); // eslint-disable-line react-hooks/exhaustive-deps
  return { ...state, fresh: state.key === key, reload: () => setTick((x) => x + 1) };
}
