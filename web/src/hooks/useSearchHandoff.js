/**
 * hooks/useSearchHandoff.js — 검색어 인계(hooks/searchHandoff.js, v2.616)를 받는 화면용 훅(v2.909 통합 장비 검색).
 *
 * 헤더 ⌘K 검색에서 장비를 고르거나 ‘모두 보기’ 를 누르면, 팔레트가 `handoffSearch(target, 검색어)` 를 남기고 그 화면 주소로 간다.
 * 받는 화면은 이 훅으로 **마운트 때 한 번** 꺼내고, 이미 열려 있으면 구독으로 즉시 받는다(꺼내면 지워진다 · 30초 지나면 버린다).
 *   useSearchHandoff('storage-mon', setDcQuery);
 * target 은 components/invSearchQuery.js 의 SCREEN 표와 글자 그대로 같아야 한다(테스트가 대조한다).
 * set 은 useState 의 setter 처럼 바뀌지 않는 함수여야 한다(effect 의존성에서 뺐다).
 */
import { useEffect } from 'react';
import { takeSearch, onSearchHandoff } from './searchHandoff.js';

export default function useSearchHandoff(target, set) {
  useEffect(() => {
    const first = takeSearch(target);
    if (first) set(first);
    return onSearchHandoff((t) => {
      if (t !== target) return;
      const s = takeSearch(target);
      if (s) set(s);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);
}
