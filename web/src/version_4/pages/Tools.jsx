/**
 * V4 ⑧ 기능 찾기(v2.508) — 시안 InfoArch.dc.html 의 IA 트리를 실제 화면으로.
 *
 * 특수 기능 79개 + 개발 포탈 탭 + V4 화면 9개를 **한 트리에 1회씩** 배치한다(tree.js, 미분류 0).
 * 도구 본체는 V4 안에서 렌더하지 않고 개발 포탈의 `#/tools/<k>` 로 보낸다 —
 * 그 키 문자열이 권한(toolsDenied)·딥링크·서버 집행 매핑이라 **바꾸지 않는다**.
 *
 * viewer 의 '잠긴 카드 벽' 문제: viewer 는 `tools` 권한이 없어 열 수 있는 도구가 0개다.
 * 78장을 회색으로 늘어놓는 대신 **무엇이 필요한지와 요청 문구**를 먼저 보여준다.
 */
import React, { useMemo, useState } from 'react';
import { can, toolAllowed, getCurrentUser } from '../../api.js';
import { TOOLS } from '../../views/specialToolsList.js';
import { searchTools } from '../../views/toolSearch.js';
import { Panel, Empty } from '../ui.jsx';
import { PAGE_META } from '../nav.js';
import { visibleTree, groupLabelOfTool, groupLabelsOfTool, primaryToolKeys } from '../tree.js';
import { toolHidden } from '../../views/toolVisibility.js';
import { fmtInt } from '../data.js';

const KIND_TAG = { page: '화면', tab: '탭', tool: '기능' };

export default function Tools({ isAdmin, goAnywhere, go }) {
  const [q, setQ] = useState('');
  const canTools = can('tools');
  // v2.555: 숨김 판정은 views/toolVisibility.js 하나가 소유한다(내비 트리·팔레트와 같은 답).
  // ⚠ 의존성 키는 JSON — 빈 배열(전면 차단)과 null(재정의 없음)을 구분해야 한다.
  const allowKey = JSON.stringify(getCurrentUser()?.toolsAllowed ?? null);
  const shownOf = useMemo(() => {
    const allow = JSON.parse(allowKey);
    return (t) => !toolHidden(t, { isAdmin, toolsAllowed: allow, hideAdminOnly: true });
  }, [isAdmin, allowKey]);
  const groups = useMemo(() => visibleTree(TOOLS, { isAdmin, toolShown: shownOf }), [isAdmin, shownOf]);
  const byKey = useMemo(() => new Map(TOOLS.map((t) => [t.k, t])), []);
  const openable = useMemo(() => TOOLS.filter(shownOf).filter((t) => canTools && toolAllowed(t.k)).length, [shownOf, canTools]);

  const hits = useMemo(() => (q.trim()
    ? new Set(searchTools(TOOLS, q, { catsOf: (t) => groupLabelsOfTool(t.k) }).map((t) => t.k))
    : null), [q]);

  const open = (it, g) => {
    if (it.kind === 'page') { go(it.id); return; }
    goAnywhere(it.kind === 'tab' ? it.hash : `#/tools/${it.k}`);
    void g;
  };

  const totalTools = primaryToolKeys().length;

  return (
    <>
      {!canTools && (
        <Panel title="🔒 특수 기능 — 접근 권한이 없습니다">
          <p style={{ margin: '0 0 10px', fontSize: 12.5, lineHeight: 1.7, color: '#526075' }}>
            현재 계정에는 <b>tools(특수 기능)</b> 권한이 없어 아래 트리의 기능을 열 수 없습니다.
            어떤 기능이 있는지는 그대로 보여 드립니다 — 필요한 기능을 정해 관리자에게 요청하세요.
          </p>
          <div className="v4-band">
            <span>요청 문구 예시 — <b>“VMware 포탈에서 ‘특수 기능(tools)’ 권한과 다음 기능이 필요합니다: (기능 이름). 사유: (업무).”</b></span>
          </div>
        </Panel>
      )}

      <div className="v3-kpis">
        <div className="v3-kpi" style={{ '--kpi': '#2563eb' }}>
          <div className="v3-kpi-label">특수 기능</div>
          <div className="v3-kpi-value">{fmtInt(totalTools)}</div>
          <div className="v3-kpi-meta">전부 트리에 1회씩 배치 · 미분류 0</div>
        </div>
        <div className="v3-kpi" style={{ '--kpi': canTools ? '#16a34a' : '#d97706' }}>
          <div className="v3-kpi-label">지금 열 수 있는 기능</div>
          <div className="v3-kpi-value">{fmtInt(openable)}</div>
          <div className="v3-kpi-meta">{canTools ? '도구별 차단(toolsDenied) 반영' : 'tools 권한이 없어 0개입니다'}</div>
        </div>
        <div className="v3-kpi" style={{ '--kpi': '#0e7490' }}>
          <div className="v3-kpi-label">V4 화면</div>
          <div className="v3-kpi-value">{fmtInt(Object.keys(PAGE_META).length)}</div>
          <div className="v3-kpi-meta">셸 안에서 바로 열립니다</div>
        </div>
        <div className="v3-kpi" style={{ '--kpi': '#68738a' }}>
          <div className="v3-kpi-label">빠른 찾기</div>
          <div className="v3-kpi-value" style={{ fontSize: 18 }}>⌘K / Ctrl+K</div>
          <div className="v3-kpi-meta">이름 · 키(gpu) · 분류명 · 옛 이름으로 검색</div>
        </div>
      </div>

      <Panel title="전체 기능 트리" sub={`${groups.length}개 그룹 · 별칭은 회색 표시`} right={
        <label className="v3-search" style={{ maxWidth: 300 }}>
          <span className="v3-mono">⌕</span>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="이름 · 키 · 분류명 · 옛 이름" />
          {q ? <button type="button" className="v3-kbd" style={{ cursor: 'pointer' }} onClick={() => setQ('')}>지움</button> : <span className="v3-kbd">필터</span>}
        </label>
      }>
        <div className="v4-tree">
          {groups.map((g) => {
            const items = hits ? g.items.filter((i) => i.kind === 'tool' && hits.has(i.k)) : g.items;
            if (hits && items.length === 0) return null;
            return (
              <div className="v4-tree-group" key={g.id}>
                <div className="v4-tree-h"><b>{g.label}</b><span className="v3-num">{items.length}</span></div>
                <div className="v4-tree-items">
                  {items.map((it) => {
                    const t = it.kind === 'tool' ? byKey.get(it.k) : null;
                    const name = it.kind === 'page' ? (PAGE_META[it.id]?.title || it.id) : it.kind === 'tab' ? it.name : `${t?.icon || ''} ${t?.label || it.k}`;
                    const locked = it.kind === 'tool' && !(canTools && toolAllowed(it.k));
                    return (
                      <button key={`${it.kind}:${it.k || it.id}`} type="button" className="v4-tree-item" onClick={() => open(it, g)}
                        title={it.kind === 'tool' ? `#/tools/${it.k}${it.alias ? ` · 주소속: ${groupLabelOfTool(it.k)}` : ''}` : (it.hash || `#/v4/${it.id}`)}>
                        <span className="v3-tag">{KIND_TAG[it.kind]}</span>
                        <span className="nm" style={it.alias ? { color: '#68738a' } : undefined}>{name}</span>
                        {it.alias && <span className="v3-tag">별칭</span>}
                        {locked && <span className="v3-tag" title="접근 권한이 없습니다">🔒</span>}
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
        {hits && hits.size === 0 && <Empty>“{q}”에 해당하는 기능이 없습니다.</Empty>}
      </Panel>

      <div className="v3-note">
        <b>별칭</b>은 같은 기능을 한 번 더 보여 주는 것입니다 — 주소속은 한 곳뿐이고, 어느 쪽을 눌러도 같은 화면이 열립니다.
        {' '}기능 화면은 개발 포탈(<code>#/tools/&lt;키&gt;</code>)에서 열립니다 — 그 키는 권한 설정과 북마크가 쓰는 값이라 이름이 바뀌어도 그대로입니다.
      </div>
    </>
  );
}
