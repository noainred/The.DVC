import { useEffect, useState } from 'react';

/** 그림 폭 = 그 칸의 실제 폭(글자를 늘이거나 줄이지 않게). 재기 전 · 서버 렌더는 기본값. */
export function useBoxWidth(ref, fallback) {
  const [w, setW] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const read = () => { const n = Math.floor(el.clientWidth); if (n > 0) setW(n); };
    read();
    if (typeof ResizeObserver !== 'function') return undefined;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return w;
}
