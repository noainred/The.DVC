/**
 * parts — 정기 점검 보고 화면 공용 조각(판정 칩 · 요청 훅). 판정은 색만으로 구분하지 않는다(기호 + 글자).
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { fetchJson } from '../../../api.js';
import { statusText } from './periodicReportText.js';

export function StatusChip({ s, big = false }) {
  const k = ['ok', 'warn', 'crit', 'unknown', 'info'].includes(s) ? s : 'unknown';
  return <span className={`prr-st ${k}${big ? ' big' : ''}`}>{statusText(k)}</span>;
}

/** 요청 하나 — 늦게 온 이전 응답은 버린다(seq). enabled 가 false 면 부르지 않는다. */
export function useLoad(path, enabled = true) {
  const [st, setSt] = useState({ data: null, err: null, busy: false });
  const seq = useRef(0);
  const load = useCallback(() => {
    if (!enabled || !path) return;
    const my = ++seq.current;
    setSt((s) => ({ ...s, busy: true, err: null }));
    fetchJson(path).then((d) => { if (my === seq.current) setSt({ data: d, err: null, busy: false }); })
      .catch((e) => { if (my === seq.current) setSt((s) => ({ ...s, err: e, busy: false })); });
  }, [path, enabled]);
  useEffect(() => { load(); }, [load]);
  return { ...st, reload: load };
}
