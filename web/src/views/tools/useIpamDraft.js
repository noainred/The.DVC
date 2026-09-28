/**
 * useIpamDraft.js — 편집 초안(ipamDraft.js)을 폼 상태로 쓰는 훅(v2.636).
 *
 *   const d = useIpamDraft('ipms:settings');
 *   useEffect(() => { fetchJson(...).then((r) => d.load(r.settings)); }, []);
 *   d.value            — 폼 값(서버 값을 읽기 전에는 null)
 *   d.set(next | fn)   — 입력(서버 값과 다르면 초안에 남고, 같아지면 초안을 지운다)
 *   d.saved(server)    — 저장 성공 뒤(초안 삭제 + 서버 값으로)
 *   d.revert()         — 서버 값으로 되돌리기(초안 삭제)
 *   d.dirty / d.restored / d.serverChanged / d.volatile
 *
 * 키가 바뀌면(예: 에이전트·vCenter 선택) 그 키의 폼으로 새로 시작한다 — 다른 대상의 값이 새 대상에 남지 않게
 * (v2.622 WEB-08 '다른 에이전트 설정으로 채워진 폼을 저장' 결함과 같은 판단). 훅이므로 조기 return 위에서 부른다.
 */
import { useCallback, useRef, useState } from 'react';
import { clearDraft, readDraft, resolveDraft, sameValue, writeDraft } from './ipamDraft.js';

const EMPTY = { value: null, base: undefined, restored: false, serverChanged: false, volatile: false };

export function useIpamDraft(key) {
  const [st, setSt] = useState(() => ({ key, ...EMPTY }));
  const keyRef = useRef(key);
  keyRef.current = key;
  // 키가 바뀌면 렌더 중에 새 키의 빈 폼으로(파생 상태 패턴 — 이전 대상 값이 한 프레임도 새 대상에 보이지 않게).
  let cur = st;
  if (st.key !== key) { cur = { key, ...EMPTY }; setSt(cur); }

  const load = useCallback((server) => {
    const k = keyRef.current;
    const r = resolveDraft(server, readDraft(k));
    setSt({ key: k, value: r.value, base: server, restored: r.restored, serverChanged: r.serverChanged, volatile: r.volatile });
  }, []);
  const set = useCallback((next) => {
    setSt((c) => {
      if (c.key !== keyRef.current) return c;             // 늦게 온 이전 대상 입력은 버린다
      const v = typeof next === 'function' ? next(c.value) : next;
      let volatile = false;
      if (c.base !== undefined && sameValue(v, c.base)) clearDraft(c.key);
      else volatile = !!writeDraft(c.key, v, c.base).volatile;
      return { ...c, value: v, volatile };
    });
  }, []);
  const saved = useCallback((server) => {
    const k = keyRef.current;
    clearDraft(k);
    setSt({ key: k, value: server, base: server, restored: false, serverChanged: false, volatile: false });
  }, []);
  const revert = useCallback(() => {
    setSt((c) => { clearDraft(c.key); return { ...c, value: c.base === undefined ? c.value : c.base, restored: false, serverChanged: false, volatile: false }; });
  }, []);
  const dirty = cur.value != null && cur.base !== undefined && !sameValue(cur.value, cur.base);
  return { value: cur.value, base: cur.base, loaded: cur.base !== undefined, dirty, restored: cur.restored && dirty, serverChanged: cur.serverChanged && dirty,
    volatile: cur.volatile && dirty, load, set, saved, revert };
}
