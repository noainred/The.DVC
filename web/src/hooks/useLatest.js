/**
 * hooks/useLatest.js — 늦게 도착한 이전 응답이 최신 화면을 덮어쓰지 못하게 하는 세대 가드(v2.447, 감사 B16).
 *
 * 왜 필요한가: 운영 환경의 일부 vCenter 는 RTT 800ms 를 넘는다. 스코프(vCenter)·기간을 빠르게 바꾸면
 * 느린 이전 요청이 **나중에** 도착해 새 스코프 화면에 옛 데이터를 그린다(폴란드 데이터가 한국 화면에).
 * `usePolling` 은 이 문제를 이미 처리하지만, `useEffect` + `fetchJson` 으로 직접 조회하는 화면들에는
 * 가드가 없었다. 저장소 안에 같은 패턴이 세 벌(Topology3D loadGen · HardwareTools genRef ·
 * IpamCore sheetGen) 흩어져 있어 이 훅으로 통일한다.
 *
 * 사용법 — useEffect 안에서:
 *   const run = useLatest();
 *   useEffect(() => { run(fetchJson(path, params), setData, (e) => setErr(e.message)); }, [deps]);
 *
 * 언마운트 후 setState 도 함께 막는다(cleanup 에서 세대를 무효화).
 */
import { useCallback, useEffect, useRef } from 'react';

export function useLatest() {
  const gen = useRef(0);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; gen.current++; };  // 언마운트 시 진행 중 응답 전부 무효화
  }, []);
  return useCallback((promise, onOk, onErr) => {
    const g = ++gen.current;
    const fresh = () => alive.current && g === gen.current;
    return Promise.resolve(promise)
      .then((d) => { if (fresh()) onOk?.(d); })
      .catch((e) => { if (fresh()) onErr?.(e); });
  }, []);
}

export default useLatest;
