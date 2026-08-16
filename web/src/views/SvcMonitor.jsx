import React, { useEffect, useMemo, useRef, useState } from 'react';
import { usePolling, postJson, putJson, delJson, fetchJson, getCurrentUser, downloadFile } from '../api.js';
import { Loading, ErrorBox } from '../components/ui.jsx';
import { useTreeDnd } from '../hooks/useTreeDnd.js';
import TemplateTab from './svcmon/TemplateTab.jsx';   // 템플릿 화면은 하나만 — 폴더 적용 모달에서도 이 화면을 불러 쓴다
import BulkTab from './svcmon/BulkTab.jsx';           // 통합 등록 마법사 — 트리에서 모달로 불러 쓴다(설정 탭과 같은 하나의 화면)
import EscClose from '../components/EscClose.jsx';
// v2.295 분리 모듈(1차 모듈화 감사 확정 #1·#5): 상수 카탈로그 · 트리/집계 순수 함수 · 점검 마법사.
import { STATUS, METHOD, statusOf, methodText } from './svcmon/constants.js';
import { buildTree, statsOf, matchNode, summarize } from './svcmon/tree.js';
import { TestWizard } from './svcmon/TestWizard.jsx';

/**
 * 성능점검 — Claude Design 핸드오프(design_handoff_perf_check) 기준 구현.
 * 좌: 트리(법인/서비스, 경로 파생) · 스플리터 · 우: 점검 목록(그룹 헤더 + 행) + 상세 모달.
 *
 * 색·간격·타이포는 핸드오프 README 의 토큰을 그대로 따른다(pc-* 클래스, styles.css 하단).
 * 인프라/서비스 두 모드는 대상의 kind('infra'|'service')로 분리 — 트리·목록이 함께 교체된다.
 */

const LEFT_W_KEY = 'perfcheck.leftW';
const DEFAULT_LEFT_W = 340;
const TARGET_PAGE = 50;          // 폴더당 한 번에 표시할 대상 수('더 보기'로 늘린다)

// 상태/유형 카탈로그(STATUS·METHOD·ADD_MENU·TYPE_META·statusOf·methodText·EMPTY_TEST)는
// svcmon/constants.js 로 분리(v2.295) — TestWizard(분리 모듈)와 셸이 단방향으로 공유한다.
/* 트리(buildTree·statsOf·matchNode)·KPI 집계(summarize)는 svcmon/tree.js 로 분리(v2.295) —
   v2.279 실버그(집계 위장) 지점이라 vitest(tree.test.js)가 의미론을 고정한다. */
// 드롭 하이라이트(인라인 — 별도 CSS 불필요). inside=폴더 안, before/after=형제 사이 선(boxShadow).
const DROP_INSIDE = { outline: '2px dashed var(--accent, #3b82f6)', outlineOffset: '-2px', borderRadius: 4, background: 'rgba(59,130,246,.10)' };
const DROP_BEFORE = { boxShadow: 'inset 0 3px 0 0 var(--accent, #3b82f6)' };
const DROP_AFTER = { boxShadow: 'inset 0 -3px 0 0 var(--accent, #3b82f6)' };
// dnd.over({id,zone}) 에 맞는 드롭 표시 스타일.
function dropStyle(dnd, id) {
  const o = dnd.over;
  if (!o || o.id !== id) return null;
  return o.zone === 'inside' ? DROP_INSIDE : o.zone === 'before' ? DROP_BEFORE : DROP_AFTER;
}

function TreeRows({ node, depth, sel, setSel, expanded, toggle, q, onCtx, dnd }) {
  if (depth > 0 && !matchNode(node, q)) return null;
  const open = q ? true : (expanded[node.id] !== false);   // 검색 중 강제 확장(README)
  const { alarms, worst } = statsOf(node);
  const hasKids = node.children.size > 0 || node.targets.length > 0;
  return (
    <>
      {depth > 0 && (
        <div className={`pc-tree-row${sel === node.id ? ' sel' : ''}`} style={{ paddingLeft: 8 + depth * 16, ...(dropStyle(dnd, node.id) || {}) }}
          draggable={dnd.canEdit}
          onDragStart={(e) => { e.stopPropagation(); dnd.start(e, { type: 'folder', path: node.id, name: node.name }); }}
          onDragEnd={dnd.end}
          onDragOver={(e) => dnd.onOver(e, node.id, true)}
          onDragLeave={() => dnd.onLeave(node.id)}
          onDrop={(e) => dnd.onDrop(e, node.id, true)}
          onClick={() => setSel(node.id)}
          onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setSel(node.id); onCtx({ x: e.clientX, y: e.clientY, node: node.id }); }}>
          <span className="pc-tog" onClick={(e) => { e.stopPropagation(); toggle(node.id); }}>{hasKids ? (open ? '−' : '+') : '·'}</span>
          <span className={`pc-dot ${STATUS[worst]?.cls || 'pc-off'}`} />
          <span className={`pc-tree-label${alarms ? ' alarm' : ''}${sel === node.id ? ' on' : ''}`}>{node.name}</span>
          {alarms > 0 && <span className="pc-badge">{alarms}</span>}
        </div>
      )}
      {open && (
        <>
          {[...node.children.values()].map((c) => (
            <TreeRows key={c.id} node={c} depth={depth + 1} sel={sel} setSel={setSel} expanded={expanded} toggle={toggle} q={q} onCtx={onCtx} dnd={dnd} />
          ))}
          {node.targets.filter((t) => !q || t.name.toLowerCase().includes(q) || (t.host || '').toLowerCase().includes(q)).map((t) => {
            const st = statsOf({ children: new Map(), targets: [t] });
            const id = `target:${t.id}`;
            return (
              <div key={t.id} className={`pc-tree-row${sel === id ? ' sel' : ''}`} style={{ paddingLeft: 8 + (depth + 1) * 16, ...(dropStyle(dnd, t.id) || {}) }}
                draggable={dnd.canEdit}
                onDragStart={(e) => { e.stopPropagation(); dnd.start(e, { type: 'target', id: t.id, path: t.path, name: t.name }); }}
                onDragEnd={dnd.end}
                onDragOver={(e) => dnd.onOver(e, t.id, false)}
                onDragLeave={() => dnd.onLeave(t.id)}
                onDrop={(e) => dnd.onDrop(e, t.id, false)}
                onClick={() => setSel(id)}
                onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setSel(id); onCtx({ x: e.clientX, y: e.clientY, node: t.path, targetId: t.id }); }}>
                <span className="pc-tog">·</span>
                <span className={`pc-dot ${STATUS[st.worst]?.cls || 'pc-off'}`} />
                <span className={`pc-tree-label leaf${st.alarms ? ' alarm' : ''}${sel === id ? ' on' : ''}`}>{t.name}</span>
                {st.alarms > 0 && <span className="pc-badge">{st.alarms}</span>}
              </div>
            );
          })}
        </>
      )}
    </>
  );
}

export default function SvcMonitor() {
  const [seq, setSeq] = useState(0);
  const refresh = () => setSeq((n) => n + 1);
  // limit=2000 을 명시 전달한다(v2.279). 과거 미전달로 서버 기본 300 에 잘려, 대상이 300 개를
  // 넘으면 301 번째부터 목록·집계에서 무표시로 사라졌다(truncated 플래그도 무시됐다). 서버 상한이
  // 2000 이므로 그 이상은 data.truncated 배너로 알린다(모드 토글은 클라이언트 필터라 즉시 유지).
  const { data, error, loading } = usePolling('/svcmon/state', { seq, limit: 2000 }, 15_000);
  const me = getCurrentUser();
  const canEdit = me?.role === 'admin' || me?.role === 'operator';

  const [mode, setMode] = useState('infra');           // 'infra' | 'service'
  const [sel, setSel] = useState('');
  const [expanded, setExpanded] = useState({});
  const [treeQ, setTreeQ] = useState('');
  const [testQ, setTestQ] = useState('');
  const [filter, setFilter] = useState('ALL');
  const [sort, setSort] = useState('none');            // none | name | status
  const [detail, setDetail] = useState(null);
  const [leftW, setLeftW] = useState(() => Number(localStorage.getItem(LEFT_W_KEY)) || DEFAULT_LEFT_W);
  const [dragging, setDragging] = useState(false);
  const [modal, setModal] = useState(null);
  const [form, setForm] = useState({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const dragRef = useRef(false);
  // 트리 드래그&드롭 이동(스플리터 dragging 과 별개) — { type:'folder'|'target', path, id?, name }
  // DnD 상태 기계는 useTreeDnd 훅으로 추출(v2.319, 모듈화 #10) — 아래 canDropZone(규칙)과
  // doDrop(서버 호출)만 이 뷰 소유. 훅 콜백은 이벤트 시점에 호출되므로 뒤에 선언된 const 를
  // 참조해도 안전하다(클로저가 바인딩을 캡처).
  const treeDnd = useTreeDnd({
    canDrop: (item, id, zone, isFolder) => canDropZone(item, id, zone, isFolder),
    onPerformDrop: (item, id, zone, isFolder) => doDrop(item, id, zone, isFolder),
  });
  const [moveErr, setMoveErr] = useState('');
  // 우클릭 컨텍스트 메뉴 — { x, y, node:'root'|path, targetId? } · 계단식 서브메뉴 인덱스
  const [ctx, setCtx] = useState(null);
  // 서브메뉴 상태는 단계별로 분리해야 한다 — 변수 하나로 관리하면 3단계에 진입하는 순간
  // 2단계 조건이 거짓이 되어 부모 메뉴가 언마운트되고 커서 밑에서 메뉴가 사라진다(v2.238 수정).
  const [subL2, setSubL2] = useState(false);   // '이 대상에 점검 추가' 열림
  const [subL3, setSubL3] = useState(-1);      // 열린 카테고리 인덱스
  const closeSubs = () => { setSubL2(false); setSubL3(-1); };
  const subTimer = useRef(null);               // 메뉴 사이 이동 중 깜빡임 방지(닫기 지연)
  const holdOpen = (fn) => { if (subTimer.current) { clearTimeout(subTimer.current); subTimer.current = null; } fn(); };
  const delayClose = (fn) => {
    if (subTimer.current) clearTimeout(subTimer.current);
    subTimer.current = setTimeout(() => { fn(); subTimer.current = null; }, 160);
  };
  const [logCfg, setLogCfg] = useState(null);   // 로그 설정 모달 데이터
  // 폴더 안 대상 표시 개수 — 대량 등록으로 한 폴더에 수백~수천 대상이 들어가므로
  // 고정 상한(과거 8개)으로 자르면 나머지가 화면에서 조용히 사라진다.
  const [pageN, setPageN] = useState(TARGET_PAGE);
  // 점검 추가 마법사 — { targetId, targetName, step:1|2|3, cat, type, form, editId }
  // 호버 계단식 메뉴를 단계형으로 바꿨다: 커서가 메뉴 사이를 지나다 닫히는 문제가 원천적으로 없다.
  const [wizFor, setWizFor] = useState(null); // { targetId, targetName, test } — TestWizard(분리 모듈) 표시 대상(v2.295)
  // 폴더에 템플릿 적용 모달 — 별도 창을 만들지 않고 '하나뿐인 템플릿 화면(TemplateTab)'을 불러 쓴다. { path } | null
  const [tplApply, setTplApply] = useState(null);
  // 통합 등록 마법사 모달 — 트리 '＋ 등록'/우클릭 '이 폴더에 등록…'. { path } | null
  const [register, setRegister] = useState(null);

  // 선택 노드나 모드가 바뀌면 표시 개수를 처음으로 되돌린다(이전 폴더에서 늘려 둔 값 승계 금지).
  useEffect(() => { setPageN(TARGET_PAGE); }, [sel, mode]);

  // 컨텍스트 메뉴는 바깥 클릭·ESC·스크롤로 닫는다.
  useEffect(() => {
    if (!ctx) return undefined;
    const close = () => { setCtx(null); closeSubs(); };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    window.addEventListener('click', close);
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', close);
      if (subTimer.current) { clearTimeout(subTimer.current); subTimer.current = null; }
    };
  }, [ctx]);

  // 스플리터 드래그(README: min 220, max = max(320, innerWidth-480), 더블클릭 340 초기화)
  useEffect(() => {
    const move = (e) => {
      if (!dragRef.current) return;
      const max = Math.max(320, window.innerWidth - 480);
      setLeftW(Math.min(max, Math.max(220, e.clientX - 20)));
    };
    const up = () => {
      if (!dragRef.current) return;
      dragRef.current = false; setDragging(false);
      document.body.style.userSelect = '';
      try { localStorage.setItem(LEFT_W_KEY, String(leftW)); } catch { /* 저장 실패는 무시 */ }
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
  }, [leftW]);

  const allTargets = data?.targets || [];
  const targets = useMemo(() => allTargets.filter((t) => (t.kind || 'infra') === mode), [allTargets, mode]);
  const folders = useMemo(() => (data?.folders || []).filter((f) => (f.kind || 'infra') === mode), [data, mode]);
  const sortMode = data?.sort?.[mode] || 'manual';
  const tree = useMemo(() => buildTree(targets, folders, sortMode), [targets, folders, sortMode]);

  if (loading && !data) return <Loading />;
  if (error && !data) return <ErrorBox message={error} />;

  // KPI 요약(현재 모드 기준) — 집계는 svcmon/tree.js summarize(v2.295 추출·vitest 고정).
  // ⚠ v2.279 회귀 방지 의미론(stale/pending 을 disabled 로 합산 금지)은 그 모듈이 소유한다.
  const summary = summarize(targets);

  // 선택 노드 이하 대상 — 전체를 구한 뒤 표시분만 자르고, 남은 수를 화면에 알린다.
  const scoped = (() => {
    if (!sel) return targets;
    if (sel.startsWith('target:')) return targets.filter((t) => t.id === sel.slice(7));
    return targets.filter((t) => t.path === sel || t.path.startsWith(`${sel}\\`));
  })();
  const selected = scoped.slice(0, pageN);
  const hiddenTargets = scoped.length - selected.length;

  const q = testQ.trim().toLowerCase();
  const groups = selected.map((t) => {
    let tests = t.tests.filter((x) => {
      const st = statusOf(t, x);
      if (filter === 'OK' && st !== 'ok') return false;
      if (filter === 'WARN' && st !== 'warn') return false;
      if (filter === 'FAIL' && st !== 'bad') return false;
      if (filter === 'DISABLED' && st !== 'disabled') return false;
      if (filter === 'PENDING' && st !== 'pending') return false;
      if (filter === 'STALE' && st !== 'stale') return false;
      return !q || x.name.toLowerCase().includes(q) || methodText(t, x).toLowerCase().includes(q);
    });
    if (sort === 'name') tests = [...tests].sort((a, b) => a.name.localeCompare(b.name));
    if (sort === 'status') {
      const rank = { bad: 0, stale: 1, warn: 2, pending: 3, ok: 4, disabled: 5, none: 5 };
      tests = [...tests].sort((a, b) => rank[statusOf(t, a)] - rank[statusOf(t, b)]);
    }
    return { target: t, tests };
  }).filter((g) => g.tests.length > 0);   // 결과 0인 대상은 그룹 헤더도 숨김(README)

  const shown = groups.reduce((a, g) => a + g.tests.length, 0);
  const avgMs = (() => {
    const v = groups.flatMap((g) => g.tests.map((x) => x.result?.ms).filter((n) => n != null));
    return v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length) : 0;
  })();
  const selPath = sel ? `Root\\${sel.replace(/^target:/, '')}` : 'Root';


  /* ── 점검 추가/수정 마법사 (1 카테고리 → 2 유형 → 3 파라미터) ── */
  /* ── 점검 추가/수정 마법사 — 구현은 svcmon/TestWizard.jsx(v2.295 분리). 여기는 열기만. ── */
  // 이름(openWizard)을 유지해 호출부(도구줄·컨텍스트 메뉴·상세 모달) 3곳이 무변경이다.
  const openWizard = (targetId, targetName, test = null) => setWizFor({ targetId, targetName, test });

  const submit = async () => {
    setBusy(true); setErr('');
    try {
      if (modal.kind === 'target') {
        const body = { ...form, kind: mode };
        if (modal.edit) await putJson(`/svcmon/targets/${modal.edit}`, body); else await postJson('/svcmon/targets', body);
      } else {
        const body = { ...form, port: form.port || undefined, intervalSec: Number(form.intervalSec) || 60 };
        if (modal.edit) await putJson(`/svcmon/targets/${modal.targetId}/tests/${modal.edit}`, body);
        else await postJson(`/svcmon/targets/${modal.targetId}/tests`, body);
      }
      setModal(null); refresh();
    } catch (e) { setErr(e.message || String(e)); } finally { setBusy(false); }
  };
  const selTarget = targets.find((t) => `target:${t.id}` === sel) || null;
  const doRefresh = async () => { try { await postJson('/svcmon/refresh', {}); setTimeout(refresh, 1500); } catch (e) { window.alert(e.message); } };

  /* ── 폴더 / 정렬 / 로그 설정 ── */
  const folderPath = ctx && ctx.node !== 'root' && !ctx.targetId ? ctx.node : '';
  const newFolder = async () => {
    const name = window.prompt(folderPath ? `'${folderPath}' 하위에 만들 폴더 이름` : '최상위 폴더 이름');
    const n = (name || '').trim();
    if (!n) return;
    try {
      await postJson('/svcmon/folders', { kind: mode, path: folderPath ? `${folderPath}\\${n}` : n });
      setExpanded((e) => ({ ...e, [folderPath]: true }));
      refresh();
    } catch (e) { window.alert(e.message); }
  };
  const renameFolderAt = async (p) => {
    const cur = p.split('\\').pop();
    const name = window.prompt('새 폴더 이름', cur);
    const n = (name || '').trim();
    if (!n || n === cur) return;
    try { await putJson('/svcmon/folders/rename', { kind: mode, path: p, newName: n }); refresh(); }
    catch (e) { window.alert(e.message); }
  };
  // 대상(등록 노드) 이름 빠른 변경 — 폴더 rename 과 같은 프롬프트 방식. name 만 부분 업데이트(호스트·점검 보존).
  const renameTargetAt = async (id) => {
    const t = targets.find((x) => x.id === id);
    if (!t) return;
    const name = window.prompt('새 대상 이름', t.name);
    const n = (name || '').trim();
    if (!n || n === t.name) return;
    try { await putJson(`/svcmon/targets/${id}`, { name: n }); refresh(); }
    catch (e) { window.alert(e.message); }
  };
  // 대상 수정 모달(이름·호스트·위치) 열기 — 현재 값으로 프리필. (기존 '대상 수정' 모달을 활성화)
  const editTargetAt = (id) => {
    const t = targets.find((x) => x.id === id);
    if (!t) return;
    setForm({ kind: mode, path: t.path, name: t.name, host: t.host });
    setErr(''); setModal({ kind: 'target', edit: t.id });
  };
  const deleteFolderAt = async (p) => {
    try {
      await postJson('/svcmon/folders/delete', { kind: mode, path: p });
      if (sel === p || sel.startsWith(`${p}\\`)) setSel('');
      refresh();
    } catch (e) {
      // 409 = 하위 대상 존재 → 강제 삭제 확인
      if (/대상 \d+개/.test(e.message || '') && window.confirm(`${e.message}\n\n하위 대상까지 모두 삭제할까요?`)) {
        try { await postJson('/svcmon/folders/delete', { kind: mode, path: p, force: true }); setSel(''); refresh(); }
        catch (e2) { window.alert(e2.message); }
      } else window.alert(e.message);
    }
  };
  /* ── 드래그&드롭: 폴더 reparent(안으로) · 대상→폴더 이동 · 형제 순서 재정렬(위/아래) ── */
  const parentOf = (p) => (p.includes('\\') ? p.slice(0, p.lastIndexOf('\\')) : '');
  // 어떤 (대상 id/폴더 경로, zone) 조합이 드롭 가능한지. isFolder=드롭 대상이 폴더 행인가.
  // item = 드래그 중 항목(useTreeDnd 가 인자로 전달 — v2.319 전에는 클로저 dragItem 참조).
  const canDropZone = (item, id, zone, isFolder) => {
    if (!item || !canEdit) return false;
    if (item.type === 'folder') {
      if (!isFolder) return false;                                  // 폴더는 대상 사이에 못 낀다
      const src = item.path;
      if (zone === 'inside') {
        if (id === '') return src.includes('\\');                   // Root 안으로 = 최상위로(이미 최상위면 no-op)
        if (id === src || String(id).startsWith(`${src}\\`)) return false;   // 자기/하위 금지
        return parentOf(src) !== id;                                // 이미 그 부모면 no-op
      }
      // before/after = id 폴더의 형제로 재정렬. Root 행은 형제 개념 없음.
      if (id === '') return false;
      const dp = parentOf(id);
      if (id === src || String(id).startsWith(`${src}\\`)) return false;     // 기준이 자기/하위면 불가
      if (dp === src || String(dp).startsWith(`${src}\\`)) return false;     // 목적 부모가 자기/하위면 순환
      return true;
    }
    // 대상 드래그
    if (isFolder) return zone === 'inside' && id !== '' && id !== item.path;   // 폴더 안으로 이동
    // 대상 행 위/아래 = 그 대상의 폴더에서 순서 재정렬(다른 폴더면 이동+재정렬)
    return id !== item.id;
  };

  // 대상 X 를 refTargetId 기준 앞/뒤로 그 폴더에 놓는다(다른 폴더면 경로 이동 후 재정렬).
  const reorderTargetTo = async (dragId, refTargetId, after) => {
    const ref = targets.find((t) => t.id === refTargetId);
    const drag = targets.find((t) => t.id === dragId);
    if (!ref || !drag) return;
    const destPath = ref.path;
    if (drag.path !== destPath) await putJson(`/svcmon/targets/${dragId}`, { path: destPath });
    let ids = targets.filter((t) => t.path === destPath)
      .sort((a, b) => ((a.order ?? 0) - (b.order ?? 0)) || a.name.localeCompare(b.name, 'ko'))
      .map((t) => t.id).filter((id) => id !== dragId);
    const idx = ids.indexOf(refTargetId);
    ids.splice(after ? idx + 1 : idx, 0, dragId);
    await putJson('/svcmon/reorder/targets', { kind: mode, path: destPath, ids });
    refresh();
  };
  // 폴더 X 를 refPath 형제 기준 앞/뒤로. 부모가 다르면 그 부모로 옮기고(reparent) 위치는 기본(끝).
  const reorderFolderTo = async (dragPath, refPath, after) => {
    if (refPath === dragPath) return;
    const destParent = parentOf(refPath);
    if (parentOf(dragPath) !== destParent) {
      await postJson('/svcmon/folders/move', { kind: mode, path: dragPath, newParent: destParent });
      refresh();
      return;
    }
    const fidx = new Map(); folders.forEach((f, i) => fidx.set(f.path, f.order != null ? f.order : i));
    let paths = folders.filter((f) => parentOf(f.path) === destParent).map((f) => f.path)
      .sort((a, b) => fidx.get(a) - fidx.get(b)).filter((p) => p !== dragPath);
    const idx = paths.indexOf(refPath);
    paths.splice(after ? idx + 1 : idx, 0, dragPath);
    await putJson('/svcmon/reorder/folders', { kind: mode, parent: destParent, paths });
    refresh();
  };

  // 훅이 canDrop 통과·상태 clear 후 호출한다(item 인자 전달) — 여기서는 수행만.
  const doDrop = async (item, id, zone, isFolder) => {
    setMoveErr('');
    try {
      if (item.type === 'folder') {
        if (zone === 'inside') {
          await postJson('/svcmon/folders/move', { kind: mode, path: item.path, newParent: id });   // id='' → 최상위
          if (id) setExpanded((ex) => ({ ...ex, [id]: true }));
          refresh();
        } else {
          await reorderFolderTo(item.path, id, zone === 'after');
        }
      } else if (isFolder) {
        await putJson(`/svcmon/targets/${item.id}`, { path: id });                                    // 대상 → 폴더 안으로
        setExpanded((ex) => ({ ...ex, [id]: true }));
        refresh();
      } else {
        await reorderTargetTo(item.id, id, zone === 'after');                                          // 대상 순서 재정렬
      }
    } catch (e) { setMoveErr(e.message || '이동 실패'); }
  };
  // 소비부(TreeRows 등)가 쓰는 dnd 객체 형태는 v2.319 이전과 동일 — 기계 부분만 훅에서 온다.
  // start 시 setMoveErr('') 는 기존 동작 보존(새 드래그 시작 시 이전 오류 배너 제거).
  const dnd = {
    canEdit, ...treeDnd,
    start: (e, item) => { setMoveErr(''); treeDnd.start(e, item); },
  };

  const setSortMode = async (m) => {
    try { await putJson('/svcmon/sort', { kind: mode, mode: m }); refresh(); }
    catch (e) { window.alert(e.message); }
  };
  const openLogSettings = async () => {
    try { const r = await fetchJson('/svcmon/log'); setLogCfg(r); } catch (e) { window.alert(e.message); }
  };
  const saveLogSettings = async () => {
    setBusy(true);
    try {
      const r = await putJson('/svcmon/log', {
        enabled: logCfg.enabled, mode: logCfg.mode, rotate: logCfg.rotate,
        keepFiles: Number(logCfg.keepFiles), maxFileMB: Number(logCfg.maxFileMB),
        maxTotalMB: Number(logCfg.maxTotalMB),
      });
      setLogCfg(r);
    } catch (e) { window.alert(e.message); } finally { setBusy(false); }
  };
  const downloadLog = async (name) => {
    try { await downloadFile(`/svcmon/log/files/${encodeURIComponent(name)}`, name); }
    catch (e) { window.alert(e.message); }
  };
  const exportFolderCsv = async (p) => {
    const qs = new URLSearchParams({ kind: mode });
    if (p) qs.set('path', p);
    try { await downloadFile(`/svcmon/targets/export.csv?${qs}`); }
    catch (e) { window.alert(e.message); }
  };
  /**
   * 성능점검 설정 화면으로 이동 — 경로·구분을 1회용 프리필로 넘긴다.
   * 딥링크 URL 로 넘기지 않는 이유: 도구 해시 파서가 `#/tools/<key>` 까지만 읽고
   * openTool 이 해시를 통째로 덮어써, 전 도구 공용 경로를 건드려야 한다.
   */
  const goToConfig = (tab, spec) => {
    try {
      sessionStorage.setItem('svcmon.prefill', JSON.stringify({
        tab, spec: { kind: spec.kind, path: spec.path },
      }));
    } catch { /* 프리필 실패는 무시 — 화면은 열린다 */ }
    window.location.hash = '#/tools/svcmon-config';
  };
  const doReset = () => { setFilter('ALL'); setTestQ(''); setTreeQ(''); setSort('none'); setDetail(null); };
  const removeSel = async () => {
    if (!selTarget) return;
    if (!window.confirm(`'${selTarget.name}' 대상과 점검 ${selTarget.tests.length}개를 삭제할까요?`)) return;
    try { await delJson(`/svcmon/targets/${selTarget.id}`); setSel(''); refresh(); } catch (e) { window.alert(e.message); }
  };

  return (
    <div className="pc-root">
      <div className="pc-modebar">
        <button className={`pc-mode${mode === 'infra' ? ' on' : ''}`} onClick={() => { setMode('infra'); setSel(''); doReset(); }}>
          {mode === 'infra' && <span className="pc-pulse" />}인프라</button>
        <button className={`pc-mode${mode === 'service' ? ' on' : ''}`} onClick={() => { setMode('service'); setSel(''); doReset(); }}>
          {mode === 'service' && <span className="pc-pulse" />}서비스</button>
      </div>

      <div className="pc-sectionbar">
        <span className="pc-sectitle">{mode === 'service' ? 'SERVICE HEALTH & SLA TESTS' : 'INFRASTRUCTURE PERFORMANCE TESTS'}</span>
        <span className="pc-secline" />
        <span className="pc-secpath">{selPath} · {selected.length} {mode === 'service' ? 'service(s)' : 'host(s)'}</span>
        {/* 설정 바로가기 — 특수기능을 거치지 않고 이 화면에서 바로 성능점검 설정으로.
            현재 모드/선택 경로를 프리필로 넘겨 그 컨텍스트에서 열린다(대량 등록·템플릿 등). */}
        <button type="button" className="pc-secbtn" title="Monitoring 설정 열기"
          onClick={() => goToConfig('tpl', { kind: mode, path: sel && sel !== '' ? sel.replace(/^target:/, '') : '' })}>
          ⚙ 설정
        </button>
      </div>

      {/* 서버가 상한(2000)까지만 대상을 내려줬을 때 경고 — 나머지 대상은 목록·집계에서 빠진다. */}
      {data?.truncated && (
        <div className="badge red" style={{ display: 'block', margin: '0 0 10px', padding: '8px 12px', lineHeight: 1.6 }}>
          ⚠ 등록 대상이 많아 상위 <b>{data.targets?.length ?? 2000}</b>개만 불러왔습니다(전체 <b>{data.targetCount ?? '?'}</b>개).
          나머지 대상은 목록·요약에서 빠집니다 — 폴더로 범위를 좁히거나 대상 수를 줄여 주세요.
        </div>
      )}

      <div className="pc-cards">
        {[
          { k: 'total', label: 'TOTAL TESTS', v: summary.total, note: `${targets.length}개 대상 그룹`, cls: 'b' },
          { k: 'ok', label: '정상', v: summary.ok, note: 'Ok · Host is alive', cls: 'g' },
          { k: 'warn', label: '경고', v: summary.warn, note: '임계치 근접', cls: 'a' },
          { k: 'bad', label: '실패', v: summary.bad, note: 'No answer · Error', cls: 'r' },
          { k: 'off', label: '중지', v: summary.disabled, note: 'Disabled', cls: 'o' },
          // 아래 둘은 '중지'와 합치면 감시 공백이 정상 설정으로 보인다(폴러 과부하 시 뒤쪽 항목이 굶는다).
          { k: 'stale', label: '갱신 안 됨', v: summary.stale ?? 0, note: '주기 초과', cls: 'w' },
          { k: 'pending', label: '점검 대기', v: summary.pending ?? 0, note: '아직 실행 안 됨', cls: 'o' },
        ].map((c) => (
          <div key={c.k} className={`pc-card ${c.cls}`}>
            <div className="pc-card-label">{c.label}</div>
            <div className="pc-card-value">{c.v}</div>
            <div className="pc-card-note">{c.note}</div>
          </div>
        ))}
      </div>

      <div className="pc-body" style={{ gridTemplateColumns: `${leftW}px 8px 1fr` }}>
        <div className="pc-panel pc-tree">
          <div className="pc-panel-head">
            <span>{mode === 'service' ? 'SERVICE TREE' : 'TEST TREE'}</span>
            <span>{targets.length} {mode === 'service' ? 'services' : 'hosts'}</span>
          </div>
          <div className="pc-tree-search">
            <input className="pc-input" placeholder="대상 검색" value={treeQ} onChange={(e) => setTreeQ(e.target.value)} />
          </div>
          {moveErr && <div className="svc-warn" style={{ margin: '6px 8px', fontSize: 12 }}>이동 실패: {moveErr}</div>}
          {canEdit && <div className="muted" style={{ fontSize: 11, padding: '2px 10px' }}>드래그&드롭 — 폴더/대상 가운데에 놓으면 안으로 이동, 위/아래 가장자리에 놓으면 순서 재정렬.</div>}
          <div className="pc-tree-body">
            <div className={`pc-tree-row${sel === '' ? ' sel' : ''}`} style={{ ...(dropStyle(dnd, '') || {}) }}
              onClick={() => setSel('')}
              onDragOver={(e) => dnd.onOver(e, '', true, 'inside')}
              onDragLeave={() => dnd.onLeave('')}
              onDrop={(e) => dnd.onDrop(e, '', true, 'inside')}
              onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setSel(''); setCtx({ x: e.clientX, y: e.clientY, node: 'root' }); closeSubs(); }}>
              <span className="pc-tog">−</span><span className="pc-dot pc-off" />
              <span className={`pc-tree-label${sel === '' ? ' on' : ''}`}>Root</span>
            </div>
            <TreeRows node={tree} depth={0} sel={sel} setSel={setSel} expanded={expanded} q={treeQ.trim().toLowerCase()}
              toggle={(id) => setExpanded((e) => ({ ...e, [id]: e[id] === false }))}
              onCtx={(c) => { setCtx(c); closeSubs(); }} dnd={dnd} />
            {targets.length === 0 && <div className="pc-empty" style={{ padding: 24 }}>
              등록된 {mode === 'service' ? '서비스' : '대상'}이 없습니다.{canEdit ? ' ＋ Add 로 등록하세요.' : ' 관리자에게 요청하세요.'}</div>}
          </div>
        </div>

        <div className={`pc-splitter${dragging ? ' on' : ''}`}
          onMouseDown={() => { dragRef.current = true; setDragging(true); document.body.style.userSelect = 'none'; }}
          onDoubleClick={() => { setLeftW(DEFAULT_LEFT_W); try { localStorage.setItem(LEFT_W_KEY, String(DEFAULT_LEFT_W)); } catch { /* noop */ } }}>
          <span className="pc-splitter-bar" />
        </div>

        <div className="pc-panel">
          <div className="pc-toolbar">
            <button className="pc-btn" disabled={!canEdit} title="대상·점검 통합 등록(소량 직접입력~대량·파일·템플릿)"
              onClick={() => setRegister({ path: sel && !sel.startsWith('target:') ? sel : '' })}>＋ 등록</button>
            <button className="pc-btn" disabled={!canEdit || !selTarget} title={selTarget ? '' : '트리에서 대상을 선택'}
              onClick={() => openWizard(selTarget.id, selTarget.name, null)}>✎ 점검 추가</button>
            <button className="pc-btn" disabled={!canEdit || !selTarget} title={selTarget ? '이름·호스트·위치 수정' : '트리에서 대상을 선택'}
              onClick={() => editTargetAt(selTarget.id)}>🖉 수정</button>
            <button className="pc-btn" disabled={!canEdit || !selTarget} onClick={removeSel}>✕ Remove</button>
            <button className="pc-btn accent" disabled={!canEdit} onClick={doRefresh}>⟳ Refresh</button>
            <button className="pc-btn" onClick={doReset}>⟲ Reset</button>
            <button className="pc-btn" disabled={!canEdit} title="선택 위치에 폴더 만들기(트리 우클릭도 가능)"
              onClick={() => { setCtx({ x: 0, y: 0, node: sel && !sel.startsWith('target:') ? sel : 'root' }); setTimeout(newFolder, 0); }}>📁 폴더</button>
            <button className="pc-btn" title="점검 로그(CSV) 설정" onClick={openLogSettings}>⚙ 로그</button>
            <span className="pc-sep" />
            {['ALL', 'OK', 'WARN', 'FAIL', 'STALE', 'PENDING', 'DISABLED'].map((f) => (
              <button key={f} className={`pc-chip${filter === f ? ' on' : ''}`} onClick={() => setFilter(f)}>{f}</button>
            ))}
            <input className="pc-input pc-search-right" placeholder="Test name 검색" value={testQ} onChange={(e) => setTestQ(e.target.value)} />
          </div>

          <div className="pc-table-wrap">
            <div className="pc-table">
              <div className="pc-thead">
                <div />
                <div className="pc-th click" onClick={() => setSort(sort === 'name' ? 'none' : 'name')}>TEST NAME{sort === 'name' && ' ▲'}</div>
                <div className="pc-th click" onClick={() => setSort(sort === 'status' ? 'none' : 'status')}>STATUS{sort === 'status' && ' ▲'}</div>
                <div className="pc-th r">RECURREN…</div>
                <div className="pc-th r">REPLY</div>
                <div className="pc-th">TEST METHOD</div>
              </div>
              {groups.map(({ target, tests }) => {
                const alarms = tests.filter((x) => ['bad', 'warn'].includes(statusOf(target, x))).length;
                return (
                  <React.Fragment key={target.id}>
                    <div className="pc-group">
                      <span>🗀 Root\{target.path}\{target.name}\{target.host}</span>
                      <span className="pc-group-meta">{tests.length} tests{alarms ? ` · ${alarms} alarm` : ''}</span>
                    </div>
                    {tests.map((x) => {
                      const st = statusOf(target, x);
                      const meta = STATUS[st] || STATUS.none;
                      const label = st === 'ok' && x.type === 'ping' ? 'Host is alive' : meta.label;
                      return (
                        <div key={x.id} className={`pc-tr${st === 'disabled' ? ' off' : ''}`} onClick={() => setDetail({ target, test: x, st, label })}>
                          <div><span className={`pc-dot glow ${meta.cls}`} /></div>
                          <div className="pc-td-name">{x.name}</div>
                          <div className={`pc-td-status ${meta.cls}`}>{label}</div>
                          <div className="pc-td-num">{x.result?.streak?.toLocaleString() || '—'}</div>
                          <div className="pc-td-reply">{x.result?.reply || '—'}</div>
                          <div className="pc-td-method">{methodText(target, x)}</div>
                        </div>
                      );
                    })}
                  </React.Fragment>
                );
              })}
              {groups.length === 0 && <div className="pc-empty">조건에 맞는 점검 항목이 없습니다.</div>}
              {hiddenTargets > 0 && (
                <div className="pc-empty">
                  대상 {selected.length} / {scoped.length} 표시 중 · {hiddenTargets}개 더 있음{' '}
                  <button type="button" className="tab" onClick={() => setPageN((n) => n + TARGET_PAGE)}>
                    {Math.min(TARGET_PAGE, hiddenTargets)}개 더 보기
                  </button>
                  {hiddenTargets > TARGET_PAGE && (
                    <button type="button" className="tab" onClick={() => setPageN(scoped.length)} style={{ marginLeft: 6 }}>
                      전체 {scoped.length}개
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* ── 엣지 위임 카드 — 원격 법인 엣지가 실행하고 보고한 현황 ──
              이 포탈이 직접 실행한 것(위 트리)과 별도로 표시한다. 무보고 엣지는 그 엣지
              담당 점검의 현재 상태를 **알 수 없는 것**이므로 정상으로도 장애로도 세지 않는다. */}
          {(data?.edges?.length > 0) && (
            <div className="svc-edges">
              <div className="svc-edges-head">
                <b>🛰 엣지 위임 ({data.edges.length})</b>
                {data.edgeTotals && (
                  <span className="muted" style={{ fontSize: 11 }}>
                    합계 — 정상 {data.edgeTotals.ok} · 주의 {data.edgeTotals.warn} · 실패 {data.edgeTotals.bad}
                    · 갱신 안 됨 {data.edgeTotals.stale}
                    {data.edgeTotals.unknown ? ` · 알 수 없음 ${data.edgeTotals.unknown}` : ''}
                    {data.edgeTotals.notRun ? ` · 미점검 ${data.edgeTotals.notRun}` : ''}
                  </span>
                )}
              </div>
              <div className="svc-edge-cards">
                {data.edges.map((e) => (
                  <div key={e.agent} className={`svc-edge-card${e.silent ? ' silent' : ''}`}>
                    <div className="svc-edge-name">
                      {e.silent ? '🔴' : '🟢'} {e.agent}
                      {e.skewWarn && <span className="badge amber" title={`시계 오차 추정 ${Math.round(e.skewMs / 1000)}초(전송 지연 포함)`}>시계 오차</span>}
                      {e.caps?.pingMode === 'tcp-fallback' && (
                        <span className="badge amber" title="이 엣지는 ping CLI 가 없어 TCP 연결로 판정합니다 — ICMP 와 의미가 다릅니다">ping=TCP 폴백</span>
                      )}
                    </div>
                    {e.silent ? (
                      <div className="svc-edge-warn">
                        무보고 {Math.round((e.ageMs || 0) / 1000)}초 — 담당 점검 {e.rows}개의 현재 상태를 알 수 없습니다.
                      </div>
                    ) : (
                      <div className="svc-edge-counts">
                        <span className="pc-ok">OK {e.counts.ok}</span>
                        <span className="pc-warn">WARN {e.counts.warn}</span>
                        <span className="pc-bad">FAIL {e.counts.bad}</span>
                        {e.counts.stale > 0 && <span className="pc-stale">낡음 {e.counts.stale}</span>}
                        {e.notRun > 0 && <span className="pc-pending">미점검 {e.notRun}</span>}
                      </div>
                    )}
                    <div className="svc-edge-meta muted">
                      항목 {e.items} · 보고 {e.rows}행 · {e.lastAt ? `${Math.round((e.ageMs || 0) / 1000)}초 전` : '—'}
                      {e.poller?.overdueSkipped > 0 && ` · 밀림 ${e.poller.overdueSkipped}`}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="pc-footer">
            <span>SHOWN {shown} / {summary.total}</span>
            <span>AVG REPLY {avgMs} ms</span>
            {/* 다중 노드에서는 전역 sweep 시각이 의미가 없다 — 이 포탈 로컬 실행 기준임을 명시 */}
            <span>LOCAL SWEEP {data?.lastSweep ? new Date(data.lastSweep).toLocaleTimeString('ko-KR', { hour12: false }) : '—'}</span>
            <span className="pc-live">● LIVE POLLING</span>
          </div>
        </div>
      </div>

      {ctx && ctx.x > 0 && (
        <div className="pc-ctx" style={{ left: Math.min(ctx.x, window.innerWidth - 260), top: Math.min(ctx.y, window.innerHeight - 320) }}
          onClick={(e) => e.stopPropagation()}>
          <div className="pc-ctx-head">{ctx.node === 'root' ? 'Root' : ctx.node}{ctx.targetId ? ' (대상)' : ''}</div>
          {canEdit && <>
            <button className="pc-ctx-item" onClick={() => { setCtx(null); newFolder(); }}>📁 하위 폴더 만들기</button>
            <button className="pc-ctx-item" onClick={() => {
              const p = ctx.node === 'root' ? '' : ctx.node;
              setCtx(null); closeSubs();
              setRegister({ path: p });   // 통합 등록 마법사(소량 직접입력~대량·파일·템플릿)
            }}>🖥 이 폴더에 등록…(대상·점검)</button>
            {ctx.targetId && (
              <button className="pc-ctx-item" onClick={() => {
                const t = targets.find((x) => x.id === ctx.targetId);
                setCtx(null); closeSubs();
                openWizard(ctx.targetId, t?.name || '', null);
              }}>🧪 이 대상에 점검 추가<span className="pc-ctx-ar">▸</span></button>
            )}
            {ctx.targetId && canEdit && (
              <button className="pc-ctx-item" onClick={() => { const id = ctx.targetId; setCtx(null); closeSubs(); renameTargetAt(id); }}>✎ 이름 변경</button>
            )}
            {ctx.targetId && canEdit && (
              <button className="pc-ctx-item" onClick={() => { const id = ctx.targetId; setCtx(null); closeSubs(); editTargetAt(id); }}>🖉 대상 수정(이름·호스트·위치)</button>
            )}
            {!ctx.targetId && <>
              {/* 등록은 위 '이 폴더에 등록…' 하나로 통합(소량 직접입력·대량 붙여넣기·파일·템플릿). */}
              <button className="pc-ctx-item" onClick={() => {
                setCtx(null); closeSubs();
                exportFolderCsv(ctx.node === 'root' ? '' : ctx.node);
              }}>⤓ 이 폴더 CSV 내보내기</button>
              <button className="pc-ctx-item" onClick={() => {
                const p = ctx.node === 'root' ? '' : ctx.node;
                setCtx(null); closeSubs();
                setTplApply({ path: p });   // 별도 창 없이 '하나뿐인 템플릿 화면'을 모달로 불러 이 폴더에 적용
              }}>🧩 이 폴더에 템플릿 적용…</button>
            </>}
            <div className="pc-ctx-sep" />
          </>}
          <div className="pc-ctx-cap">하위 폴더 정렬</div>
          <button className={`pc-ctx-item${sortMode === 'name' ? ' on' : ''}`} onClick={() => { setCtx(null); setSortMode('name'); }}>🔤 이름순</button>
          <button className={`pc-ctx-item${sortMode !== 'name' ? ' on' : ''}`} onClick={() => { setCtx(null); setSortMode('manual'); }}>🕘 등록순</button>
          {canEdit && ctx.node !== 'root' && !ctx.targetId && <>
            <div className="pc-ctx-sep" />
            <button className="pc-ctx-item" onClick={() => { const p = ctx.node; setCtx(null); renameFolderAt(p); }}>✎ 폴더 이름 변경</button>
            <button className="pc-ctx-item danger" onClick={() => { const p = ctx.node; setCtx(null); deleteFolderAt(p); }}>🗑 폴더 삭제</button>
          </>}
        </div>
      )}

      {logCfg && (
        <div className="pc-overlay" onClick={() => setLogCfg(null)}>
          <div className="pc-modal" style={{ width: 'min(600px, 94vw)' }} onClick={(e) => e.stopPropagation()}>
            <div className="pc-modal-head"><b>⚙ 점검 로그 설정 (CSV)</b><button className="pc-x" onClick={() => setLogCfg(null)}>✕</button></div>
            <div className="pc-form">
              <div className="pc-lrow"><span>로그 기록</span>
                <div className="pc-seg">
                  <button className={`pc-chip${logCfg.enabled ? ' on' : ''}`} onClick={() => setLogCfg({ ...logCfg, enabled: true })}>사용</button>
                  <button className={`pc-chip${!logCfg.enabled ? ' on' : ''}`} onClick={() => setLogCfg({ ...logCfg, enabled: false })}>중지</button>
                </div></div>
              <div className="pc-lrow"><span>기록 대상</span>
                <div className="pc-seg">
                  <button className={`pc-chip${logCfg.mode === 'all' ? ' on' : ''}`} onClick={() => setLogCfg({ ...logCfg, mode: 'all' })}>모든 결과</button>
                  <button className={`pc-chip${logCfg.mode === 'changes' ? ' on' : ''}`} onClick={() => setLogCfg({ ...logCfg, mode: 'changes' })}>상태 변화만</button>
                </div></div>
              <div className="pc-lrow"><span>파일 분할 단위</span>
                <div className="pc-seg">
                  {(data?.rotateUnits || ['hour', 'day', 'week', 'month', 'quarter']).map((u) => (
                    <button key={u} className={`pc-chip${logCfg.rotate === u ? ' on' : ''}`} onClick={() => setLogCfg({ ...logCfg, rotate: u })}>
                      {(data?.rotateLabels || {})[u] || u}</button>
                  ))}
                </div></div>
              <div className="pc-lrow"><span>보관 파일 수</span><input className="pc-input" style={{ maxWidth: 110 }} value={logCfg.keepFiles}
                onChange={(e) => setLogCfg({ ...logCfg, keepFiles: e.target.value })} /></div>
              <div className="pc-lrow"><span>파일 최대 크기(MB)</span><input className="pc-input" style={{ maxWidth: 110 }} value={logCfg.maxFileMB}
                onChange={(e) => setLogCfg({ ...logCfg, maxFileMB: e.target.value })} /></div>
              <div className="pc-lrow"><span>전체 상한(MB, 0=무제한)</span><input className="pc-input" style={{ maxWidth: 130 }} value={logCfg.maxTotalMB}
                onChange={(e) => setLogCfg({ ...logCfg, maxTotalMB: e.target.value })} /></div>
              <div className="pc-note">분할 단위 × 보관 수 = 실질 보관 기간. 한 파일이 최대 크기를 넘으면 같은 구간에서 -p02 로 이어 씁니다.
                CSV 는 UTF-8 BOM 이라 엑셀에서 바로 열립니다.</div>
              <div className="pc-logfiles">
                <div>저장 위치: <b>{logCfg.dir}</b></div>
                <div>파일 {logCfg.fileCount}개 · 합계 {(logCfg.totalBytes / 1048576).toFixed(1)} MB
                  {logCfg.stats && <> · 기록 {logCfg.stats.written?.toLocaleString?.() || 0}행
                    {logCfg.stats.dropped ? ` · 폐기 ${logCfg.stats.dropped}행` : ''}
                    {logCfg.stats.buffered ? ` · 대기 ${logCfg.stats.buffered}행` : ''}</>}</div>
                {/* 목록 상자가 스크롤되므로 8개로 자르지 않는다 — 자르면 오래된 로그를 내려받을 방법이 없다. */}
                {(logCfg.files || []).slice(0, 200).map((f) => (
                  <div key={f.name}>
                    {/* 링크(<a href>)는 Authorization 헤더를 못 실어 401 이 된다 — fetch+blob 으로 받는다. */}
                    <button type="button" className="pc-dl" onClick={() => downloadLog(f.name)}>⤓ {f.name}</button>
                    <span> · {(f.sizeBytes / 1048576).toFixed(2)} MB</span>
                  </div>
                ))}
                {(logCfg.files || []).length > 200 && <div>… 외 {logCfg.files.length - 200}개</div>}
              </div>
              <div className="pc-modal-actions">
                <button className="pc-btn" onClick={() => setLogCfg(null)}>닫기</button>
                <button className="pc-btn accent" disabled={busy} onClick={saveLogSettings}>{busy ? '저장 중…' : '저장'}</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {detail && (
        <div className="pc-overlay" onClick={() => setDetail(null)}>
          <div className="pc-modal" onClick={(e) => e.stopPropagation()}>
            <div className="pc-modal-head">
              <span className={`pc-dot glow ${STATUS[detail.st]?.cls || 'pc-off'}`} />
              <b>{detail.test.name}</b>
              <button className="pc-x" onClick={() => setDetail(null)}>✕</button>
            </div>
            <div className="pc-modal-grid">
              <span>Status</span><span className={STATUS[detail.st]?.cls}>{detail.label}</span>
              <span>Reply</span><span>{detail.test.result?.reply || '—'}</span>
              <span>Recurrences</span><span>{detail.test.result?.streak?.toLocaleString() || '—'}</span>
              <span>Test method</span><span>{methodText(detail.target, detail.test)}</span>
              <span>주기</span><span>{detail.test.intervalSec}초</span>
              <span>Path</span><span className="pc-modal-path">Root\{detail.target.path}\{detail.target.name}\{detail.target.host}</span>
            </div>
            {canEdit && (
              <div className="pc-modal-actions">
                <button className="pc-btn" onClick={() => { const d = detail; setDetail(null); openWizard(d.target.id, d.target.name, d.test); }}>✎ 수정</button>
                <button className="pc-btn" onClick={async () => {
                  if (!window.confirm(`점검 '${detail.test.name}' 을 삭제할까요?`)) return;
                  try { await delJson(`/svcmon/targets/${detail.target.id}/tests/${detail.test.id}`); setDetail(null); refresh(); } catch (e) { window.alert(e.message); }
                }}>✕ 삭제</button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* 점검 추가/수정 마법사 — svcmon/TestWizard.jsx 로 분리(v2.295, 1차 감사 확정 #5).
          마운트=열림(조건 렌더) · 자체 busy/err 소유(셸과 교차 누수 없음 — 분리 전 공유 상태였음). */}
      {wizFor && (
        <TestWizard targetId={wizFor.targetId} targetName={wizFor.targetName} test={wizFor.test}
          onClose={() => setWizFor(null)} onSaved={() => { setWizFor(null); refresh(); }} />
      )}

      {/* 통합 등록 마법사 — 트리에서 '하나의 등록 화면(BulkTab)'을 모달로 불러 쓴다(설정 탭과 동일 컴포넌트).
          위치 프리필. 소량 직접입력~대량 붙여넣기~파일(CSV/XLSX)~템플릿 적용~엣지 배정을 한 흐름으로.
          닫으면 트리 새로고침(등록분 반영). */}
      {register && (
        <div className="pc-overlay" onClick={() => { setRegister(null); refresh(); }}>
          <EscClose onClose={() => { setRegister(null); refresh(); }} />
          <div className="pc-modal" style={{ width: 'min(1200px, 97vw)', maxHeight: '92vh', overflowY: 'auto' }} onClick={(e) => e.stopPropagation()}>
            <div className="pc-modal-head">
              <b>＋ 등록</b>
              <span className="pc-wiz-target">{(register.path || 'Root') + ' · ' + (mode === 'service' ? '서비스' : '인프라')}</span>
              <button className="pc-x" onClick={() => { setRegister(null); refresh(); }}>✕</button>
            </div>
            <div style={{ padding: 12 }}>
              <BulkTab canEdit={canEdit} prefill={{ kind: mode, path: register.path }} />
            </div>
          </div>
        </div>
      )}

      {/* 폴더에 템플릿 적용 — 별도 창을 만들지 않고 '하나뿐인 템플릿 화면(TemplateTab)'을 모달로 불러
          이 폴더 경로를 프리필한다. 선택→하위포함→미리보기→적용→'적용 완료' 배너가 이 안에서 진행된다.
          닫으면 트리를 새로고침(추가된 점검 반영). */}
      {tplApply && (
        <div className="pc-overlay" onClick={() => { setTplApply(null); refresh(); }}>
          <EscClose onClose={() => { setTplApply(null); refresh(); }} />
          <div className="pc-modal" style={{ width: 'min(1100px, 96vw)', maxHeight: '90vh', overflowY: 'auto' }} onClick={(e) => e.stopPropagation()}>
            <div className="pc-modal-head">
              <b>🧩 이 폴더에 템플릿 적용</b>
              <span className="pc-wiz-target">{tplApply.path || 'Root(전체)'}</span>
              <button className="pc-x" onClick={() => { setTplApply(null); refresh(); }}>✕</button>
            </div>
            <div style={{ padding: 12 }}>
              <TemplateTab canEdit={canEdit} initialApply={{ kind: mode, path: tplApply.path, includeSub: true }} />
            </div>
          </div>
        </div>
      )}

      {modal && (
        <div className="pc-overlay" onClick={() => setModal(null)}>
          <div className="pc-modal" onClick={(e) => e.stopPropagation()}>
            <div className="pc-modal-head">
              <b>{modal.kind === 'target' ? (modal.edit ? '대상 수정' : `${mode === 'service' ? '서비스' : '대상'} 추가`) : (modal.edit ? '점검 수정' : '점검 추가')}</b>
              <button className="pc-x" onClick={() => setModal(null)}>✕</button>
            </div>
            <div className="pc-form">
              {modal.kind === 'target' ? <>
                <label>경로 (트리 위치, ＼ 구분)<input className="pc-input" value={form.path || ''} onChange={(e) => setForm({ ...form, path: e.target.value })} placeholder="B.Service\A.Data_Landing(SBP)\01.HQ" /></label>
                <label>이름<input className="pc-input" value={form.name || ''} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="SBP_Admin01" /></label>
                <label>호스트/IP<input className="pc-input" value={form.host || ''} onChange={(e) => setForm({ ...form, host: e.target.value })} placeholder="192.168.10.55" /></label>
              </> : <>
                <label>점검 이름<input className="pc-input" value={form.name || ''} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="2. Ping: 192.168.10.55" /></label>
                <label>유형<select className="pc-input" value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
                  {(data?.testTypes || []).map((t) => <option key={t} value={t}>{t} — {METHOD[t]}</option>)}</select></label>
                {form.type === 'tcp' && <label>포트<input className="pc-input" value={form.port || ''} onChange={(e) => setForm({ ...form, port: e.target.value })} placeholder="8080" /></label>}
                {form.type === 'http' && <>
                  <label>URL<input className="pc-input" value={form.url || ''} onChange={(e) => setForm({ ...form, url: e.target.value })} placeholder="http://192.168.10.55:8080/health" /></label>
                  <label>본문 키워드(선택)<input className="pc-input" value={form.keyword || ''} onChange={(e) => setForm({ ...form, keyword: e.target.value })} /></label>
                </>}
                {form.type === 'dns' && <label>조회할 이름<input className="pc-input" value={form.record || ''} onChange={(e) => setForm({ ...form, record: e.target.value })} placeholder="portal.example.com" /></label>}
                <label>주기(초, 최소 10)<input className="pc-input" value={form.intervalSec} onChange={(e) => setForm({ ...form, intervalSec: e.target.value })} /></label>
              </>}
              {err && <div className="pc-err">{err}</div>}
              <div className="pc-modal-actions">
                <button className="pc-btn" onClick={() => setModal(null)}>취소</button>
                <button className="pc-btn accent" disabled={busy} onClick={submit}>{busy ? '저장 중…' : '저장'}</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
