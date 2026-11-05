/**
 * hooks/useSearchHandoff.js — 검색어 인계(hooks/searchHandoff.js, v2.616)를 받는 화면용 훅(v2.909 통합 장비 검색).
 *
 * 헤더 ⌘K 검색에서 장비를 고르거나 ‘모두 보기’ 를 누르면, 팔레트가 `handoffMany([[target, 검색어], [target:focus, 장비 id]])` 를 남기고
 * 그 화면 주소로 간다. 받는 화면은 이 훅으로 **마운트 때 한 번** 꺼내고, 이미 열려 있으면 구독으로 즉시 받는다(꺼내면 지워진다 · 30초 지나면 버린다).
 *   useSearchHandoff('storage-mon', setDcQuery);
 *   useFocusHandoff('san-switch:focus', rows, (r) => openRef.current?.(r));   // v2.911: 고른 장비의 상세 열기
 * target 은 components/invSearchQuery.js 의 SCREEN 표와 글자 그대로 같아야 한다(테스트가 대조한다).
 * set 은 useState 의 setter 처럼 바뀌지 않는 함수여야 한다(effect 의존성에서 뺐다).
 */
import { useEffect, useState } from 'react';
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

/**
 * v2.911(A1 · A2): 인계받은 장비 id 를 그 화면 목록에서 찾아 연다. 목록(items)이 아직 없으면 기다리고, 찾으면 open(행)을 한 번 부른 뒤 잊는다.
 * 목록에 없으면(범위 · 필터 밖 · 그사이 지워짐) 조용히 잊는다 — 검색 칸에는 이미 장비 이름이 들어가 있어 화면이 '없음' 을 말한다.
 * match 기본값은 `String(row.id) === id`. open 은 매 렌더 새 함수여도 된다(마지막 것을 쓴다).
 * ⚠ items 는 **목록을 받기 전에는 undefined/null** 이어야 한다 — `data?.devices || []` 처럼 빈 배열을 주면 '받았는데 없음' 으로 읽고 고른 장비를 잊는다
 *   (v2.911 Chromium 실측: PDU 화면이 첫 렌더의 빈 배열로 인계를 버려 상세가 펼쳐지지 않았다).
 */
export function useFocusHandoff(target, items, open, match = (row, id) => String(row?.id ?? '') === id) {
  const [focus, setFocus] = useState('');
  useSearchHandoff(target, setFocus);
  useEffect(() => {
    if (!focus || !Array.isArray(items)) return;
    const hit = items.find((row) => match(row, focus));
    setFocus('');
    if (hit) open(hit);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus, items]);
}
