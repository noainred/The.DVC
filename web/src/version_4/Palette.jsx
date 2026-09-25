/**
 * version_4/Palette.jsx — ⌘K 커맨드 팔레트(v2.508). 후보 계산·매칭은 palette.js(순수)가 하고
 * 여기서는 입력·커서·키 처리만 한다(웹 테스트가 node 환경이라 판정은 컴포넌트 밖에 둔다).
 *
 * 잘라낸 개수는 화면에 밝힌다 — 조용히 자르면 "검색해도 안 나온다" 가 된다.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { can, toolAllowed } from '../api.js';
import { TOOLS } from '../views/specialToolsList.js';
import { visibleTools, lockReasonOf } from '../views/toolVisibility.js'; // v2.613 CATALOG2613-07: 잠금 사유도 같은 모듈
import { PAGE_META } from './nav.js';
import { search, flatten } from './palette.js';

const KIND_LABEL = { tool: '기능', page: '화면', tab: '탭' };

export default function Palette({ onClose, onPick, isAdmin, toolsAllowed = null }) {
  const [q, setQ] = useState('');
  const [cur, setCur] = useState(0);
  const inputRef = useRef(null);
  // 관리자 전용 도구는 비관리자에게 제안하지 않는다(내비 트리와 같은 규칙 — 판정은
  // views/toolVisibility.js 하나가 소유한다. 여기서 조건을 다시 쓰면 트리와 갈라진다).
  // ⚠ 의존성 키는 JSON — 빈 배열(전면 차단)과 null(재정의 없음)을 구분해야 한다.
  const allowKey = JSON.stringify(toolsAllowed ?? null);
  const tools = useMemo(
    () => visibleTools(TOOLS, { isAdmin, toolsAllowed: JSON.parse(allowKey), hideAdminOnly: true }),
    [isAdmin, allowKey],
  );
  const res = useMemo(() => search(q, { tools, pageMeta: PAGE_META }), [q, tools]);
  const flat = useMemo(() => flatten(res), [res]);
  // v2.613(CATALOG2613-07): 잠긴 도구는 제안에서 빼지 않고(숨김 축은 위 visibleTools) 🔒 와 사유를 붙인다 —
  //   판정은 카드 그리드·V4 내비·기능 찾기와 같은 lockReasonOf(perm 축 포함).
  const byKey = useMemo(() => new Map(TOOLS.map((t) => [t.k, t])), []);
  const lockOf = useMemo(() => {
    const allow = JSON.parse(allowKey);
    return (k) => lockReasonOf(byKey.get(k), { isAdmin, toolsAllowed: allow, can, toolAllowed });
  }, [isAdmin, allowKey, byKey]);

  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => { setCur(0); }, [q]);

  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); onClose(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); setCur((i) => Math.min(flat.length - 1, i + 1)); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); setCur((i) => Math.max(0, i - 1)); return; }
    if (e.key === 'Enter' && flat[cur]) { e.preventDefault(); onPick(flat[cur].hash); }
  };

  const omitted = res.toolsOmitted + res.pagesOmitted + res.tabsOmitted;

  return (
    <div className="v4-palette-back" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="v4-palette" role="dialog" aria-label="기능 찾기">
        <div className="v4-palette-in">
          <span className="v3-mono">⌕</span>
          <input ref={inputRef} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKey}
            placeholder="기능 · 화면 · 탭 찾기 — 이름 · 키(gpu) · 분류(스토리지) · 옛 이름(낭비)" />
          <span className="v3-kbd">ESC</span>
        </div>
        <div className="v4-palette-list">
          {!q.trim() && <div className="v3-empty">이름뿐 아니라 <b>키</b>(gpu · ipam · rma) · <b>분류명</b>(스토리지 · 운영 작업) · <b>옛 이름</b>(낭비 · 자원 최적화 → Optimization)으로도 찾습니다.</div>}
          {q.trim() && res.empty && <div className="v3-empty">“{q}”에 해당하는 기능·화면이 없습니다.</div>}
          {flat.map((it, i) => {
            const lock = it.kind === 'tool' ? lockOf(it.k) : null;
            return (
            <button key={`${it.kind}:${it.k || it.id}`} type="button" className={`v4-palette-row${i === cur ? ' on' : ''}`}
              title={lock || undefined} onMouseEnter={() => setCur(i)} onClick={() => onPick(it.hash)}>
              <span className="v3-tag">{KIND_LABEL[it.kind]}</span>
              <span className="v4-palette-name">{lock ? '🔒 ' : ''}{it.label}</span>
              <span className="v3-faint" style={{ fontSize: 11 }}>{it.group}</span>
              <span className="v3-num v3-faint" style={{ fontSize: 10.5, marginLeft: 'auto' }}>{it.hash}</span>
            </button>
            );
          })}
          {omitted > 0 && <div className="v3-note" style={{ padding: '8px 14px' }}>일치 항목 {omitted}개를 더 찾았지만 목록에 넣지 않았습니다 — 검색어를 좁히세요.</div>}
        </div>
      </div>
    </div>
  );
}
