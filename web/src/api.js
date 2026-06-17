import { useEffect, useRef, useState } from 'react';

const BASE = '/api';

export async function fetchJson(path, params = {}) {
  const qs = new URLSearchParams(
    Object.entries(params).filter(([, v]) => v !== undefined && v !== '' && v !== null)
  ).toString();
  const res = await fetch(`${BASE}${path}${qs ? `?${qs}` : ''}`);
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json();
}

/** Poll an endpoint on an interval and expose {data, error, loading}. */
export function usePolling(path, params = {}, intervalMs = 15_000) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const paramsKey = JSON.stringify(params);
  const savedParams = useRef(params);
  savedParams.current = params;

  useEffect(() => {
    let active = true;
    let timer;
    const tick = async () => {
      try {
        const json = await fetchJson(path, savedParams.current);
        if (active) { setData(json); setError(null); }
      } catch (err) {
        if (active) setError(err.message);
      } finally {
        if (active) setLoading(false);
      }
    };
    tick();
    timer = setInterval(tick, intervalMs);
    return () => { active = false; clearInterval(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, paramsKey, intervalMs]);

  return { data, error, loading };
}
