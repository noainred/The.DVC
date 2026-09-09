/**
 * hooks/useHashTab.js — 하위 탭을 URL 해시에 실어 **새로고침·북마크·뒤로가기에서 유지**한다(v2.438).
 *
 * useState 를 이 훅으로 바꾸기만 하면 된다:
 *   const [sub, setSub] = useState('list');
 *   → const [sub, setSub] = useHashTab({ base: ['networks'], valid: SUBS.map(s => s.k), fallback: 'list' });
 *
 * 규칙(회귀 방지):
 *  · **훅이므로 조기 return 위(컴포넌트 최상단)에서 호출한다** — 렌더 간 훅 개수가 달라지면 React #310
 *    으로 화면 전체가 크래시한다(CLAUDE.md).
 *  · 해시 갱신은 setter 에서만. 진입 시 하위키가 비어 있으면 replaceState 로 채운다(pushState 로
 *    채우면 화면에 들어가기만 해도 뒤로가기 이력이 쌓여 뒤로가기가 먹통이 된다).
 *  · hashchange 는 **base 아래일 때만** 반영한다 — 다른 상단 탭으로 나간 뒤의 해시 변화까지 삼키면
 *    언마운트 직전에 엉뚱한 탭으로 한 번 튄다.
 *  · base 는 렌더마다 새 배열이 만들어져도 되도록 문자열로 굳혀 비교한다(의존성 루프 방지).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { buildHash, isUnderBase, tabFromHash } from './hashTab.js';

export function useHashTab({ base, valid, fallback }) {
  const baseKey = base.join('/');
  const validKey = valid.join('|');
  const ref = useRef({ base, valid, fallback });
  ref.current = { base, valid, fallback };

  const [tab, setTabState] = useState(() => tabFromHash(window.location.hash, base, valid) || fallback);

  const setTab = useCallback((k) => {
    const { base: b } = ref.current;
    setTabState(k);
    window.location.hash = buildHash(b, k);
  }, []);

  useEffect(() => {
    const { base: b, valid: v, fallback: f } = ref.current;
    // 진입 시 해시에 하위키가 없으면(상단 탭 클릭으로 막 들어옴) 현재 탭을 채워 둔다.
    if (isUnderBase(window.location.hash, b) && !tabFromHash(window.location.hash, b, v)) {
      window.history.replaceState(null, '', buildHash(b, tabFromHash(window.location.hash, b, v) || f));
    }
    const onHash = () => {
      if (!isUnderBase(window.location.hash, b)) return;   // 다른 화면의 해시 변화는 무시
      setTabState(tabFromHash(window.location.hash, b, v) || f);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
    // baseKey/validKey 가 바뀌면(같은 컴포넌트가 다른 도구로 재사용) 다시 무장한다.
  }, [baseKey, validKey]);

  return [tab, setTab];
}
