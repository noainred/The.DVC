// views/insight/useInsight.js — 분석 화면 공용 훅(v3.21.0). VM · Hypervisor 분석이 같이 쓴다.
//   useFolded: 묶음 접힘(브라우저에 화면별 키로 기억 — insightPrefs.js try/catch). 처음은 전부 펼침.
//   useLazyJson: 무거운 요약을 **필요할 때 한 번만**(enabled 가 처음 참이 될 때 · ‘다시 받기’ 는 reload) — 15초 폴링에 얹지 않는다. 늦게 온 이전 응답은 버린다.
import { useEffect, useRef, useState } from 'react';
import { fetchJson } from '../../api.js';
import { loadFolded, saveFolded } from './insightPrefs.js';

export function useFolded(storageKey, keys) {
  const [folded, setFolded] = useState(() => loadFolded(storageKey, keys));
  const toggle = (k) => setFolded((cur) => {
    const next = { ...cur };
    if (next[k]) delete next[k]; else next[k] = true;
    saveFolded(storageKey, next, keys);
    return next;
  });
  return [folded, toggle];
}

/** { data, error, loading, reload } — enabled 가 참이 된 뒤 path+params 마다 한 번. 403 등 오류는 error 글자로(화면이 숨기거나 안내). */
export function useLazyJson(path, params = {}, enabled = true, opts = {}) {
  const [st, setSt] = useState({ data: null, error: null, loading: false });
  const [seq, setSeq] = useState(0);
  const gen = useRef(0);
  const key = JSON.stringify([path, params, seq]);
  useEffect(() => {
    if (!enabled || !path) return undefined;
    const my = ++gen.current;
    const ctl = new AbortController();
    setSt({ data: null, error: null, loading: true });   // 조건이 바뀌면 이전 조건의 값을 남기지 않는다
    fetchJson(path, params, ctl.signal, opts)
      .then((data) => { if (gen.current === my) setSt({ data, error: null, loading: false }); })
      .catch((e) => { if (gen.current === my && !ctl.signal.aborted) setSt({ data: null, error: e?.message || String(e), loading: false }); });
    return () => { ctl.abort(); };
  }, [enabled, key]); // eslint-disable-line react-hooks/exhaustive-deps
  return { ...st, reload: () => setSeq((n) => n + 1) };
}
