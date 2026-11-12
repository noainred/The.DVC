/**
 * 좁은 화면 여부 훅(v2.986 — VmDistPanels.jsx 에서 옮김 · 물리서버 폴더와 함께 쓴다). matchMedia 가 없거나 던지면 넓은 화면으로 본다(SSR · 구형 브라우저).
 */
import { useEffect, useState } from 'react';

/** 좁은 화면 여부 — matchMedia 가 없거나 던지면 넓은 화면으로 본다(SSR·구형 브라우저). */
export function useNarrowScreen(query) {
  const read = () => {
    try {
      return typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? !!window.matchMedia(query).matches : false;
    } catch { return false; }
  };
  const [narrow, setNarrow] = useState(read);
  useEffect(() => {
    let mq = null;
    try { mq = typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(query) : null; } catch { mq = null; }
    if (!mq) return undefined;
    const on = () => setNarrow(!!mq.matches);
    on();
    try {
      mq.addEventListener('change', on);
      return () => { try { mq.removeEventListener('change', on); } catch { /* 무시 */ } };
    } catch {
      try { mq.addListener(on); return () => { try { mq.removeListener(on); } catch { /* 무시 */ } }; } catch { return undefined; }
    }
  }, [query]);
  return narrow;
}
