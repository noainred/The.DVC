/**
 * 특수 기능 › 물리서버 폴더(도구 키 bm-folders, v2.984) — 물리서버(베어메탈)를 법인 › 폴더에 등록해 서비스별로 묶어 본다.
 *   설계: docs/design/bm-folders/README.md(시안 2차 · 사용자 '기본값대로 구현' — 1단계 = 목록 + 일괄 등록 + 옆 패널. 맵 · 저장한 보기는 2단계).
 * ⚠ 어느 폴더인지 · 보류 · 없어짐 · 찾기 판정은 서버(bmfolders/build.js)가 한다. 이 파일은 고른 노드로 거르고 그리기와 쓰기 요청만 — 계산은 bmFoldersText.js.
 * ⚠ 폴링하지 않는다(마운트 1회 + 새로고침 + 쓰기 뒤 재조회). 늦게 온 이전 응답은 버린다.
 * ⚠ 훅은 전부 조기 return 위(React #310 사고 규약).
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchJson, postJson, canCsv, downloadFile } from '../../api.js';
import { Loading, ErrorBox } from '../../components/ui.jsx';
import { STable } from '../../components/STable.jsx';
import Select from '../../components/Select.jsx';
import BoldText from '../../components/boldText.jsx';
import BulkAdd from './bmFolders/BulkAdd.jsx';
import SidePanel from './bmFolders/SidePanel.jsx';
import MapView from './bmFolders/MapView.jsx';
import { useNarrowScreen } from '../../components/useNarrowScreen.js';
import { UsagePair, StatusDot, SrcBadge, StackBar } from './bmFolders/parts.jsx';
import { SRC_COLOR, SRC_SHORT, rowSrcClass, srcCounts, metricSrcText } from './bmFolders/usageSrc.js'; // v2.993: 사용률 출처 색
import { whyBands, whyShort, WHY_DOT } from './bmFolders/whyText.js'; // v2.994: 값 없음 사유
import {
  INTRO, PLACE_LABEL, MISSING_WHY, pctText, wattsText, pathText, lastSeg, parentOf, ageText,
  rowsOf, aggregate, filterRows, resultNote, foldersByName, opErrorText, csvNameOf, trimPath,
  VIEWS_KEY, parseViews, upsertView, cleanView, underPath,
  renameNote, removeNote,
} from './bmFoldersText.js';

const btn = { padding: '6px 12px', flex: 'none' };
const ROW_LIMIT = 500;
/** 법인 이름의 앞 'vcenter-' 를 뗀다(서비스 인벤토리 표와 같은 관례 — 트리 · 표 폭 확보. 전체 이름은 title). */
const shortCorp = (n) => String(n || '').replace(/^vcenter-/, '');

export default function BmFolders() {
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(null);
  const [sel, setSel] = useState({ type: 'all' });
  const [treeMode, setTreeMode] = useState('corp');
  const [treeQ, setTreeQ] = useState('');
  const [open, setOpen] = useState(() => new Set());
  const [q, setQ] = useState('');
  const [quick, setQuick] = useState('');
  const [sub, setSub] = useState(true);
  const [picked, setPicked] = useState(() => new Set());
  const [panel, setPanel] = useState('');
  const [bulk, setBulk] = useState(null);
  // v2.987 맵 보기 · 저장한 보기(브라우저 저장 — 이 사람의 편의만. 못 읽으면 빈 목록) · 입력 다시 읽기 진행 중
  const [view, setView] = useState('list');
  const [groupBy, setGroupBy] = useState('folder');
  const [colorBy, setColorBy] = useState('cpu');
  const [views, setViews] = useState(() => { try { return parseViews(localStorage.getItem(VIEWS_KEY)); } catch { return []; } });
  const [viewName, setViewName] = useState('');
  const [freshBusy, setFreshBusy] = useState(false);
  const narrow = useNarrowScreen('(max-width: 640px)');
  const [form, setForm] = useState('');
  const [fv, setFv] = useState({});
  const seq = useRef(0);

  const load = useCallback(async (fresh = false) => {
    const my = ++seq.current;
    try {
      // fresh: 입력 다시 읽기 — 재시도하지 않는다(429 를 일시 오류로 다시 물으면 늦게 와 문구를 덮는다 — 서비스 인벤토리 규약)
      const r = await fetchJson('/tools/bm-folders', fresh ? { fresh: '1' } : {}, undefined, fresh ? { retries: 0 } : {});
      if (my !== seq.current) return;   // 늦게 온 이전 응답은 버린다
      setD(r); setErr(null);
    } catch (e) { if (my === seq.current) { if (fresh) setNote({ ok: false, warn: e?.status === 429, text: opErrorText(e) }); else setErr(e); } }
  }, []);
  const readFresh = useCallback(async () => { setFreshBusy(true); try { await load(true); } finally { setFreshBusy(false); } }, [load]);
  const saveViews = useCallback((list) => { setViews(list); try { localStorage.setItem(VIEWS_KEY, JSON.stringify(list)); } catch { /* 저장 못 해도 화면은 그대로 — 이 사람의 편의일 뿐 */ } }, []);
  useEffect(() => { load(); }, [load]);

  const op = useCallback(async (body, okText) => {
    setBusy(true); setNote(null);
    try {
      const r = await postJson('/tools/bm-folders/op', body);
      if (!r || r.ok === false) throw new Error(r?.reason || '요청을 처리하지 못했습니다.');
      // okText 가 함수면 응답으로 알림을 만든다(이름 바꾸기 · 지우기 — 서버가 실제로 한 것)
      setNote(typeof okText === 'function' ? okText(r.result || {}) : resultNote(okText, r.result));
      await load();
      return r;
    } catch (e) { setNote({ ok: false, text: opErrorText(e) }); return null; }
    finally { setBusy(false); }
  }, [load]);

  const corps = useMemo(() => d?.corps || [], [d]);
  const servers = useMemo(() => d?.servers || [], [d]);
  const corpName = useCallback((id) => corps.find((c) => c.vcenterId === id)?.name || id || '(법인 미지정)', [corps]);
  const baseRows = useMemo(() => rowsOf(servers, sel, { sub }), [servers, sel, sub]);
  const rows = useMemo(() => filterRows(baseRows, q, quick), [baseRows, q, quick]);
  const agg = useMemo(() => aggregate(baseRows), [baseRows]);
  const byName = useMemo(() => foldersByName(corps), [corps]);
  const selKey = `${sel.type}|${sel.corp || ''}|${sel.path || ''}`;
  // 저장한 보기를 고르면 노드가 바뀌어 거르기가 비워진다 — 그 보기의 거르기는 이 효과가 넣는다(같은 틀에서 순서를 보장)
  const pendingFilter = useRef(null);
  useEffect(() => { const p = pendingFilter.current; pendingFilter.current = null; setPicked(new Set()); setForm(''); setFv({}); setQ(p?.q || ''); setQuick(p?.quick || ''); }, [selKey]);
  const pick = useCallback((corp) => setOpen((s) => { const n = new Set(s); n.add(corp); return n; }), []);

  if (err && !d) {
    const corrupt = err?.status === 503;
    return (
      <div className="card" style={{ padding: 16 }}>
        <ErrorBox error={err} />
        {corrupt ? (
          <div className="muted" style={{ marginTop: 8, fontSize: 13 }}>
            물리서버 폴더 저장소 파일이 손상돼 빈 트리로 시작하지 않았습니다. 백업에서 복원하거나, 전체 범위 관리자가 초기화(손상본은 따로 보관)할 수 있습니다.
            {err?.body?.canReset === true ? (
              <div style={{ marginTop: 8 }}>
                <button type="button" className="logout-btn" onClick={async () => {
                  if (!window.confirm('손상된 저장소를 옆으로 옮기고 빈 저장소로 시작합니다. 폴더 · 등록이 모두 비게 됩니다. 계속할까요?')) return;
                  const r = await postJson('/tools/bm-folders/op', { op: 'store.reset' }).catch((e) => ({ ok: false, reason: opErrorText(e) }));
                  if (r?.ok) load(); else setNote({ ok: false, text: r?.reason || '초기화하지 못했습니다.' });
                }}>저장소 초기화</button>
              </div>
            ) : <div style={{ marginTop: 8 }}>초기화는 전체 범위 관리자만 할 수 있습니다.</div>}
            {note ? <div style={{ marginTop: 6, color: 'var(--red)' }}>{note.text}</div> : null}
          </div>
        ) : null}
      </div>
    );
  }
  if (!d) return <Loading />;

  const bmAll = servers.filter((s) => s.kind === 'bm');
  const sum = { total: bmAll.length, reg: bmAll.filter((s) => s.place).length, un: bmAll.filter((s) => s.corp && !s.place).length, nocorp: bmAll.filter((s) => !s.corp).length, esxi: servers.filter((s) => s.kind === 'esxi').length };
  const corpRow = sel.corp ? corps.find((c) => c.vcenterId === sel.corp) : null;
  const writable = !!corpRow?.writable && sel.type !== 'name' && sel.type !== 'nocorp';
  const folderPaths = (corpRow?.folders || []).map((f) => f.path);
  const missingHere = (d.missing || []).filter((x) => (sel.type === 'corp' ? x.corp === sel.corp : sel.type === 'folder' ? x.corp === sel.corp && (sub ? (x.path === sel.path || x.path.startsWith(`${sel.path}\\`)) : x.path === sel.path) : false));
  const panelRow = panel ? servers.find((s) => s.key === panel) || null : null;
  const pickedRows = rows.filter((r) => picked.has(r.key));
  const openBulk = (o = {}) => setBulk({ corp: '', path: '', text: '', ...o });
  // 서비스 인벤토리 연결 — 고른 폴더에 걸리는 가장 긴 물리서버 폴더 규칙(판정은 서비스 인벤토리가 한다 — 여기는 그 규칙을 보여 줄 뿐)
  const svcLinks = (sel.corp && d.svcLinks?.[sel.corp]) || [];
  const svcLink = sel.type === 'folder' ? svcLinks.filter((x) => underPath(sel.path, x.prefix)).sort((a, b) => b.prefix.length - a.prefix.length)[0] || null : null;
  const svcRuleN = sel.type === 'folder' ? svcLinks.filter((x) => underPath(x.prefix, sel.path)).length : 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }}>
      <div className="card" style={{ padding: '10px 14px', borderLeft: '3px solid var(--accent-2)' }}>
        <div className="flex wrap gap" style={{ alignItems: 'center', marginBottom: 6 }}>
          <b style={{ fontSize: 15 }}>Bare Metal Server</b>
          <div className="tabs" style={{ marginLeft: 0 }} role="group" aria-label="보기 방식">
            <button type="button" className={`tab${view === 'list' ? ' active' : ''}`} onClick={() => setView('list')}>목록</button>
            <button type="button" className={`tab${view === 'map' ? ' active' : ''}`} onClick={() => setView('map')}>맵</button>
          </div>
          <ViewsMenu views={views} viewName={viewName} onPick={(name) => {
            const v = views.find((x) => x.name === name); setViewName(name);
            if (!v) return;
            const s = v.state;
            setSel(s.sel); setTreeMode(s.treeMode); setView(s.view); setGroupBy(s.groupBy); setColorBy(s.colorBy); setSub(s.sub);
            if (s.sel.corp) pick(s.sel.corp);
            // 노드가 같으면 효과가 돌지 않으므로 바로 넣고, 바뀌면 효과가 넣는다
            if (`${s.sel.type}|${s.sel.corp || ''}|${s.sel.path || ''}` === selKey) { setQ(s.q); setQuick(s.quick); } else pendingFilter.current = { q: s.q, quick: s.quick };
          }} onSave={(name) => { const list = upsertView(views, name, { sel, view, treeMode, q, quick, sub, groupBy, colorBy }); saveViews(list); setViewName(cleanView({ name, state: {} })?.name || ''); }}
            onRemove={(name) => { saveViews(views.filter((x) => x.name !== name)); setViewName(''); }} />
          <span style={{ flex: 1 }} />
          {d.canWrite ? <button type="button" className="login-btn" style={btn} disabled={busy} onClick={() => openBulk({ corp: sel.corp || '', path: sel.type === 'folder' ? sel.path : '' })}>서버 찾아 등록</button> : null}
          {canCsv() ? <button type="button" className="logout-btn" style={btn} onClick={() => downloadFile('/tools/bm-folders.csv', csvNameOf()).catch((e) => setNote({ ok: false, text: opErrorText(e) }))}>CSV</button> : null}
          {d.canWrite ? <button type="button" className="logout-btn" style={btn} disabled={freshBusy} title="새로 넣은 iDRAC 서버 · 법인 귀속 변경을 다음 인벤토리 주기 전에 지금 다시 읽습니다(포탈 전체에 상한 하나 — 서비스 인벤토리와 함께 씁니다)" onClick={readFresh}>{freshBusy ? '다시 읽는 중…' : '입력 다시 읽기'}</button> : null}
          <button type="button" className="logout-btn" style={btn} onClick={() => load()}>새로고침</button>
        </div>
        <div style={{ fontSize: 13 }}><BoldText text={INTRO} /></div>
        <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
          {d.at ? `서버 목록 읽은 시각 ${new Date(d.at).toLocaleTimeString()}. ` : ''}
          {d.scoped ? '범위가 지정된 계정이라 자기 법인 서버만 보이고 서비스 태그 · 엣지 이름은 싣지 않습니다. ' : ''}
          {d.settings?.autoRules ? `자동 규칙이 켜져 있습니다(규칙 ${(d.rules || []).length}개 — 손 등록이 먼저). ` : `자동 규칙은 꺼져 있습니다${(d.rules || []).length ? `(저장된 규칙 ${d.rules.length}개는 적용되지 않음)` : ''}. `}
          {d.faultsMeta && d.faultsMeta.available === false ? '부품 장애를 읽지 못해 장애 칸은 ‘—’ 입니다. ' : ''}
          {!d.canWrite ? '조회 전용 계정입니다.' : ''}
        </div>
      </div>
      {note ? <div className="card" style={{ padding: '8px 12px', borderLeft: `3px solid ${note.warn ? 'var(--amber)' : note.ok ? 'var(--green)' : 'var(--red)'}`, fontSize: 13 }}>{note.ok && !note.warn ? '✓ ' : '⚠ '}{note.text}</div> : null}
      {d.blocked?.n || d.blocked?.any ? (
        <div className="card" style={{ padding: '8px 12px', borderLeft: '3px solid var(--amber)', fontSize: 13 }}>
          ⚠ 서버 목록 출처 {d.blocked.n ? `${d.blocked.n}곳` : '일부'}를 읽지 못했습니다 — 등록은 남았는데 목록에 없는 서버를 ‘없어짐’ 으로 판정하지 않고 보류합니다(지우지 않습니다).
          {d.blocked.sources?.length ? <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>{d.blocked.sources.slice(0, 5).map((x) => x.reason).join(' · ')}</div> : null}
        </div>
      ) : null}

      <div className="card bmf-sum">
        <div style={{ flex: 'none' }}><div className="bmf-big">{sum.total.toLocaleString()}</div><div className="muted" style={{ fontSize: 12 }}>물리서버(베어메탈)</div></div>
        <div style={{ flex: '1 1 320px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <StackBar parts={[{ n: sum.reg, c: 'var(--accent)' }, { n: sum.un, c: 'var(--amber)' }, { n: sum.nocorp, c: 'var(--text-dim)' }]} h={10} label={`폴더 등록 ${sum.reg}, 미분류 ${sum.un}, 법인 미지정 ${sum.nocorp}`} />
          <div className="flex wrap" style={{ gap: '4px 16px', fontSize: 12 }}>
            <span className="bmf-lg"><i style={{ background: 'var(--accent)' }} />폴더 등록 <b>{sum.reg}</b>{sum.total ? ` · ${Math.round((sum.reg / sum.total) * 100)}%` : ''}</span>
            <span className="bmf-lg"><i style={{ background: 'var(--amber)' }} />미분류 <b>{sum.un}</b></span>
            {!d.scoped ? <span className="bmf-lg"><i style={{ background: 'var(--text-dim)' }} />법인 미지정 <b>{sum.nocorp}</b></span> : null}
            {sum.esxi ? <span className="bmf-lg">ESXi 호스트 {sum.esxi}대(폴더에 넣은 것 — 위 수에는 없음)</span> : null}
            <span className="bmf-lg">폴더 {corps.reduce((s, c) => s + c.folders.length, 0)}개 · 법인 {corps.length}곳</span>
          </div>
        </div>
        <div style={{ flex: 'none', display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
          <span className="bmf-lg"><StatusDot tone="red" />부품 장애 <b>{servers.filter((s) => s.faults > 0).length}대</b></span>
          <span className="bmf-lg"><StatusDot tone="amber" />보류 {(d.missing || []).filter((x) => x.state === 'held').length} · 없어짐 {(d.missing || []).filter((x) => x.state === 'ghost').length}</span>
        </div>
      </div>

      <div className="bmf-layout">
        <div className="card bmf-tree">
          <div style={{ padding: '10px 10px 8px', display: 'flex', flexDirection: 'column', gap: 8, borderBottom: '1px solid var(--border)' }}>
            <div className="flex wrap gap" style={{ alignItems: 'center' }}>
              <div className="tabs" style={{ marginLeft: 0 }}>
                <button type="button" className={`tab${treeMode === 'corp' ? ' active' : ''}`} onClick={() => setTreeMode('corp')}>법인별</button>
                <button type="button" className={`tab${treeMode === 'name' ? ' active' : ''}`} onClick={() => setTreeMode('name')}>폴더 이름별</button>
              </div>
            </div>
            <input className="input" type="search" value={treeQ} onChange={(e) => setTreeQ(e.target.value)} placeholder="폴더 · 법인 이름 찾기" aria-label="폴더 찾기" />
          </div>
          <div style={{ padding: '6px 2px', overflowY: 'auto', maxHeight: 640 }}>
            <TreeNode on={sel.type === 'all'} depth={0} name="전체 물리서버" count={servers.length} onClick={() => setSel({ type: 'all' })} />
            {treeMode === 'corp' ? (
              <CorpTree corps={corps} sel={sel} setSel={setSel} open={open} setOpen={setOpen} q={treeQ} pick={pick} />
            ) : (
              <NameTree list={byName} sel={sel} setSel={setSel} q={treeQ} />
            )}
            {!d.scoped && d.noCorp ? <TreeNode on={sel.type === 'nocorp'} depth={1} name="(법인 미지정)" count={d.noCorp} un onClick={() => setSel({ type: 'nocorp' })} /> : null}
          </div>
          <div className="muted flex wrap" style={{ gap: '4px 12px', padding: '8px 12px', fontSize: 11, borderTop: '1px solid var(--border)' }}>
            <span className="bmf-lg"><i style={{ background: 'var(--accent)' }} />등록</span>
            <span className="bmf-lg"><i style={{ background: 'var(--amber)' }} />미분류</span>
            <span className="bmf-lg"><StatusDot tone="red" />장애</span>
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }}>
          {sel.type === 'all' && view === 'map' ? (
            <MapView rows={filterRows(servers, q, quick)} groupBy={groupBy} setGroupBy={setGroupBy} colorBy={colorBy} setColorBy={setColorBy} corpName={corpName} onPick={setPanel} picked={panel} />
          ) : sel.type === 'all' ? (
            <Overview d={d} corps={corps} corpName={corpName} setSel={setSel} pick={pick} op={op} busy={busy} openBulk={openBulk} />
          ) : (
            <>
              <div className="card" style={{ minWidth: 0 }}>
                <div className="flex wrap gap" style={{ padding: '10px 14px', alignItems: 'center', borderBottom: '1px solid var(--border)' }}>
                  <Crumb sel={sel} corpName={corpName} />
                  {svcLink ? <a className="badge blue" href="#/tools/svc-inventory" title={`서비스 인벤토리의 물리서버 폴더 규칙 ‘${pathText(svcLink.prefix)}’ → 이 폴더 서버는 그 서비스의 구성원입니다(고정 · 판정 순서에 따라 다를 수 있음)`} style={{ textDecoration: 'none' }}>서비스: {svcLink.service}</a> : null}
                  <span style={{ flex: 1 }} />
                  {writable && sel.type === 'folder' ? (
                    <>
                      <button type="button" className="login-btn" style={btn} disabled={busy} onClick={() => openBulk({ corp: sel.corp, path: sel.path })}>서버 찾아 등록</button>
                      <button type="button" className="logout-btn" style={btn} onClick={() => { setForm('folder'); setFv({ path: `${sel.path}\\` }); }}>＋ 하위 폴더</button>
                      <button type="button" className="logout-btn" style={btn} onClick={() => { setForm('rename'); setFv({ name: lastSeg(sel.path) }); }}>이름 바꾸기</button>
                      <button type="button" className="logout-btn" style={{ ...btn, color: 'var(--red)' }} onClick={() => setForm('remove')}>폴더 삭제</button>
                    </>
                  ) : null}
                  {writable && (sel.type === 'corp' || sel.type === 'un') ? (
                    <>
                      <button type="button" className="login-btn" style={btn} disabled={busy} onClick={() => openBulk({ corp: sel.corp, unassigned: true })}>서버 찾아 등록</button>
                      <button type="button" className="logout-btn" style={btn} onClick={() => { setForm('folder'); setFv({ path: '' }); }}>＋ 폴더</button>
                      {sel.type === 'corp' ? <button type="button" className="logout-btn" style={btn} onClick={() => { setForm('copy'); setFv({ from: '' }); }}>폴더 구조 복사…</button> : null}
                    </>
                  ) : null}
                  {sel.corp && !writable && sel.type !== 'name' ? <span className="badge gray">조회 전용</span> : null}
                </div>
                <FolderForms form={form} setForm={setForm} fv={fv} setFv={setFv} sel={sel} op={op} busy={busy} corps={corps} corpName={corpName}
                  folderN={baseRows.filter((r) => r.place === 'manual').length} ruleN={baseRows.filter((r) => r.place === 'rule').length} svcRuleN={svcRuleN}
                  folderRegs={sel.type === 'folder' ? corps.find((c) => c.vcenterId === sel.corp)?.folders?.find((f) => f.path === sel.path)?.regs : undefined}
                  onRemoved={() => setSel(parentOf(sel.path) ? { type: 'folder', corp: sel.corp, path: parentOf(sel.path) } : { type: 'corp', corp: sel.corp })}
                  onRenamed={(to) => setSel({ type: 'folder', corp: sel.corp, path: to })} />
                {sel.type === 'name' ? <div className="muted" style={{ padding: '8px 14px', fontSize: 12 }}>같은 경로의 폴더를 법인을 넘어 합쳐 본 것입니다(읽기 전용 — 저장은 법인별 그대로). 바꾸려면 법인별 트리에서 고르십시오.</div> : null}
                {sel.type === 'nocorp' ? <div className="muted" style={{ padding: '8px 14px', fontSize: 12 }}>어느 법인 서버인지 모르는 서버는 폴더에 넣을 수 없습니다 — 특수 기능 › 통합 서버 인벤토리에서 법인(vCenter)을 먼저 정하십시오.</div> : null}
                {d.usageOff ? <div className="bmf-offbar" role="status"><b>베어메탈 사용률 수집이 꺼져 있습니다</b> — 이 포탈이 직접 수집하는 서버의 CPU · 메모리가 비어 있는 이유입니다(엣지가 수집하는 서버는 그 엣지 설정을 따릅니다). 설정 › 베어메탈 사용률에서 켜면 다음 주기부터 보입니다.</div> : null}
                <div className="bmf-tiles">
                  <div className="bmf-tile">
                    <span className="k">서버 {agg.n}대 — 상태</span>
                    <span className="v" style={{ fontSize: 13, fontWeight: 600 }}>켜짐 {agg.on} · 꺼짐 {agg.off}{agg.powerUnknown ? ` · 모름 ${agg.powerUnknown}` : ''}</span>
                    <span className="s">사용률 못 읽음 {agg.usageMissing}{agg.noCap ? ` · 용량 모름 ${agg.noCap}` : ''}</span>
                  </div>
                  <div className="bmf-tile"><span className="k">CPU(용량 가중)</span><span className="v">{pctText(agg.cpu)}</span><span className="s">{agg.usageN}대 기준</span>{metricSrcText(baseRows, 'cpu') ? <span className="s" title="이 지표를 읽은 곳별 대수">{metricSrcText(baseRows, 'cpu')}</span> : null}</div>
                  <div className="bmf-tile"><span className="k">메모리(용량 가중)</span><span className="v">{pctText(agg.mem)}</span><span className="s">{agg.usageN}대 기준</span>{metricSrcText(baseRows, 'mem') ? <span className="s" title="이 지표를 읽은 곳별 대수">{metricSrcText(baseRows, 'mem')}</span> : null}</div>
                  <div className="bmf-tile"><span className="k">전력</span><span className="v">{wattsText(agg.watts)}</span><span className="s">{agg.wattsN}대 합{agg.n - agg.wattsN ? ` · 못 읽음 ${agg.n - agg.wattsN}` : ''}</span></div>
                  <div className="bmf-tile" style={agg.faults ? { borderColor: 'rgba(239,68,68,.45)' } : undefined}>
                    <span className="k">부품 장애</span><span className="v" style={agg.faults ? { color: '#f87171' } : undefined}>{agg.faults}대</span>
                    <span className="s">모름 {agg.faultsUnknown}</span>
                  </div>
                </div>
              </div>

              {view === 'map' ? (
                <MapView rows={rows} groupBy={groupBy} setGroupBy={setGroupBy} colorBy={colorBy} setColorBy={setColorBy} corpName={corpName} onPick={setPanel} picked={panel} />
              ) : (
              <div className="card" style={{ minWidth: 0 }}>
                <div className="flex wrap gap" style={{ padding: '8px 14px', alignItems: 'center', borderBottom: '1px solid var(--border)' }}>
                  <input className="input" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="이 목록에서 거르기(이름 · 모델 · 서비스 태그)" aria-label="목록 거르기" style={{ flex: '1 1 220px', minWidth: 0, maxWidth: 360 }} />
                  {[['fault', '장애', baseRows.filter((r) => r.faults > 0).length], ['unread', '못 읽음', baseRows.filter((r) => r.cpu == null && r.mem == null).length], ['off', '꺼짐', baseRows.filter((r) => r.powered === false).length]].map(([k, lb, n]) => (
                    <button key={k} type="button" className={`bmf-chip${quick === k ? ' on' : ''}`} aria-pressed={quick === k} onClick={() => setQuick(quick === k ? '' : k)}>{lb} {n}</button>
                  ))}
                  {sel.type === 'folder' || sel.type === 'name' ? <label style={{ fontSize: 12, display: 'inline-flex', gap: 4, alignItems: 'center' }}><input type="checkbox" checked={sub} onChange={(e) => setSub(e.target.checked)} /> 하위 폴더 포함</label> : null}
                </div>
                <SrcSummary rows={baseRows} />
                <WhyBand rows={baseRows} quick={quick} setQuick={setQuick} />
                {writable && picked.size ? (
                  <SelBar picked={pickedRows} folders={folderPaths} sel={sel} op={op} busy={busy} onDone={() => setPicked(new Set())} />
                ) : null}
                {!rows.length ? <div className="muted" style={{ padding: 16 }}>{baseRows.length ? '거르기 조건에 맞는 서버가 없습니다.' : sel.type === 'folder' ? '이 폴더에 등록된 서버가 없습니다 — ‘서버 찾아 등록’ 으로 넣습니다.' : '서버가 없습니다.'}</div> : narrow ? (
                  <NarrowList rows={rows.slice(0, ROW_LIMIT)} writable={writable} picked={picked} setPicked={setPicked} onOpen={setPanel} scoped={!!d.scoped} />
                ) : (
                  <STable className="table bmf-t" minWidth={720} limit={ROW_LIMIT}>
                    <thead>
                      <tr>
                        {writable ? <th data-nosort style={{ width: 30 }}><input type="checkbox" aria-label="보이는 서버 전체 선택" checked={rows.length > 0 && rows.every((r) => picked.has(r.key))} onChange={(e) => setPicked(e.target.checked ? new Set(rows.map((r) => r.key)) : new Set())} /></th> : null}
                        <th>이름</th>
                        {sel.type !== 'folder' || sub ? <th>폴더</th> : null}
                        <th>{d.scoped ? '모델' : '모델 · 서비스 태그'}</th><th>받는 길</th><th>부품 장애</th><th title="CPU · 메모리 사용률">사용률</th><th>전력</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r) => (
                        <tr key={r.key} className={picked.has(r.key) ? 'bmf-picked' : undefined} style={{ cursor: 'pointer' }} onClick={() => setPanel(r.key)}>
                          {writable ? <td data-nosort onClick={(e) => e.stopPropagation()}><input type="checkbox" aria-label={`${r.name} 선택`} checked={picked.has(r.key)} onChange={(e) => setPicked((s) => { const n = new Set(s); if (e.target.checked) n.add(r.key); else n.delete(r.key); return n; })} /></td> : null}
                          <td data-sort={r.name}><span className="bmf-nm"><StatusDot tone={r.faults > 0 ? 'red' : r.cpu == null && r.mem == null ? 'none' : r.powered === false ? 'gray' : 'green'} />{r.name}{r.kind === 'esxi' ? <span className="badge gray" style={{ marginLeft: 4 }}>ESXi</span> : null}{r.tmpKey ? <TmpKeyBadge /> : null}</span></td>
                          {sel.type !== 'folder' || sub ? <td data-sort={r.place ? r.path : '￿'}>{r.place ? <span title={PLACE_LABEL[r.place]}>{pathText(r.path)}{r.place === 'rule' ? <span className="badge gray" style={{ marginLeft: 4 }}>규칙</span> : null}</span> : <span className="muted">(미분류)</span>}</td> : null}
                          <td data-sort={r.model || ''}>{r.model || '—'}{!d.scoped && r.serviceTag ? <div className="mono muted" style={{ fontSize: 11 }}>{r.serviceTag}</div> : null}</td>
                          <td><SrcBadge src={r.src} />{r.agent ? <div className="muted mono" style={{ fontSize: 11 }}>{r.agent}</div> : null}{r.addr ? <div className="muted mono" style={{ fontSize: 11 }} title="관리 주소(iDRAC) — 관리자 판본">{r.addr}</div> : null}</td>
                          <td data-sort={r.faults ?? ''}>{r.faults == null ? <span className="muted">—</span> : r.faults > 0 ? <span className="badge red">{r.faults}건</span> : <span className="muted">없음</span>}</td>
                          <td data-sort={r.cpu ?? ''}><UsagePair cpu={r.cpu} mem={r.mem} usrc={r.usrc} why={r.why} /></td>
                          <td data-sort={r.watts ?? ''} style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>{wattsText(r.watts)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </STable>
                )}
                <div className="muted" style={{ padding: '8px 14px', fontSize: 12 }}>
                  {rows.length > ROW_LIMIT ? `${rows.length}대 중 ${ROW_LIMIT}대만 그립니다(머리글을 누르면 전체를 정렬한 뒤 자릅니다 — 거르기로 좁히십시오). ` : `${rows.length}대 · `}
                  못 읽은 값(‘—’)은 평균 · 합계에 넣지 않습니다 · 행을 누르면 옆 패널{writable ? ' · 고르면 옮기기 · 빼기' : ''}
                </div>
                {missingHere.length ? (
                  <div style={{ padding: '8px 14px', borderTop: '1px solid var(--border)', fontSize: 12 }}>
                    <b>목록에 없는 등록 {missingHere.length}대</b>
                    <div className="flex wrap" style={{ gap: '4px 12px', marginTop: 4 }}>
                      {missingHere.slice(0, 30).map((x) => (
                        <span key={x.key} className="muted" title={x.state === 'held' ? (MISSING_WHY[x.why] || '판정 보류') : '출처를 다 읽었는데 목록에 없습니다'}>
                          <span className={`badge ${x.state === 'held' ? 'amber' : 'red'}`} style={{ marginRight: 4 }}>{x.state === 'held' ? '보류' : '없어짐'}</span>{x.name} · {pathText(x.path)}
                          {d.canWrite && corps.find((c) => c.vcenterId === x.corp)?.writable ? (
                            <button type="button" className="logout-btn" style={{ padding: '0 6px', fontSize: 11, marginLeft: 4 }} disabled={busy} title="이 등록만 지웁니다(서버는 그대로)"
                              onClick={() => op({ op: 'unassign', keys: [x.key] }, '목록에 없는 등록 하나를 지웠습니다.')}>지우기</button>
                          ) : null}
                        </span>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
              )}
            </>
          )}
        </div>
      </div>
      {panelRow ? <SidePanel r={panelRow} corps={corps} corpName={corpName} scoped={!!d.scoped} op={op} busy={busy} onClose={() => setPanel('')} /> : null}
      {bulk ? <BulkAdd init={bulk} d={d} corpName={corpName} op={op} busy={busy} onClose={() => setBulk(null)} /> : null}
    </div>
  );
}

function TreeNode({ on, depth, name, title, count, un, onClick, toggle, opened, children }) {
  return (
    <div className={`svcinv-tn${on ? ' on' : ''}`} style={{ paddingLeft: 8 + depth * 14 }} role="button" tabIndex={0} aria-current={on ? 'true' : undefined} title={title || name}
      onClick={onClick} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } }}>
      {toggle ? <span className="bmf-tw" role="button" tabIndex={-1} aria-label={opened ? '접기' : '펼치기'} onClick={(e) => { e.stopPropagation(); toggle(); }}>{opened ? '▾' : '▸'}</span> : <span className="bmf-tw" />}
      {un ? <span className="bmf-fo un" aria-hidden="true" /> : depth >= 2 ? <span className="bmf-fo" aria-hidden="true" /> : null}
      <span className="nm" style={un ? { color: '#fbbf24' } : undefined}>{name}</span>
      {children}
      <span className="cnt">{count}</span>
    </div>
  );
}

function CorpTree({ corps, sel, setSel, open, setOpen, q, pick }) {
  const ql = q.trim().toLowerCase();
  const toggle = (vc) => setOpen((s) => { const n = new Set(s); if (n.has(vc)) n.delete(vc); else n.add(vc); return n; });
  return corps.map((c) => {
    const folders = ql ? c.folders.filter((f) => f.path.toLowerCase().includes(ql)) : c.folders;
    if (ql && !c.name.toLowerCase().includes(ql) && !folders.length) return null;
    const opened = open.has(c.vcenterId) || !!ql;
    const mainSrc = c.sources.edge ? 'edge' : c.sources.collector ? 'collector' : 'central';
    const expired = (c.agents || []).some((a) => a.expired);
    return (
      <React.Fragment key={c.vcenterId}>
        <TreeNode on={sel.type === 'corp' && sel.corp === c.vcenterId} depth={1} name={shortCorp(c.name)} title={c.name} count={c.total} opened={opened} toggle={() => toggle(c.vcenterId)}
          onClick={() => { setSel({ type: 'corp', corp: c.vcenterId }); pick(c.vcenterId); }}>
          {expired ? <span className="badge amber" title="이 법인 서버를 보고하던 엣지의 보고가 만료됐습니다">만료</span> : <SrcBadge src={mainSrc} small />}
          {c.faults ? <StatusDot tone="red" title={`부품 장애 ${c.faults}대`} /> : null}
          <StackBar parts={[{ n: c.registered, c: 'var(--accent)' }, { n: c.unassigned, c: 'var(--amber)' }]} w={28} h={6} label={`등록 ${c.registered}, 미분류 ${c.unassigned}`} />
        </TreeNode>
        {opened ? folders.map((f) => (
          <TreeNode key={f.path} on={sel.type === 'folder' && sel.corp === c.vcenterId && sel.path === f.path} depth={1 + f.depth} name={f.name} count={f.total}
            onClick={() => setSel({ type: 'folder', corp: c.vcenterId, path: f.path })}>
            {f.faults ? <StatusDot tone="red" title={`부품 장애 ${f.faults}대`} /> : null}
          </TreeNode>
        )) : null}
        {opened && c.unassigned && !ql ? <TreeNode on={sel.type === 'un' && sel.corp === c.vcenterId} depth={2} name="(미분류)" count={c.unassigned} un onClick={() => setSel({ type: 'un', corp: c.vcenterId })} /> : null}
      </React.Fragment>
    );
  });
}

function NameTree({ list, sel, setSel, q }) {
  const ql = q.trim().toLowerCase();
  const shown = ql ? list.filter((f) => f.path.toLowerCase().includes(ql)) : list;
  if (!shown.length) return <div className="muted" style={{ padding: '8px 12px', fontSize: 12 }}>폴더가 없습니다.</div>;
  return shown.map((f) => (
    <TreeNode key={f.path} on={sel.type === 'name' && sel.path === f.path} depth={f.depth} name={f.name} count={f.total} onClick={() => setSel({ type: 'name', path: f.path })}>
      <span className="muted" style={{ fontSize: 11, flex: 'none' }}>{f.corps}곳</span>
    </TreeNode>
  ));
}

function Crumb({ sel, corpName }) {
  const parts = [];
  if (sel.type === 'name') parts.push(<b key="n">전 법인</b>);
  else if (sel.type === 'nocorp') parts.push(<b key="x">(법인 미지정)</b>);
  else parts.push(<b key="c">{corpName(sel.corp)}</b>);
  if (sel.path) sel.path.split('\\').forEach((p, i) => { parts.push(<span key={`s${i}`} className="muted">›</span>); parts.push(<span key={`p${i}`} style={{ fontWeight: 600 }}>{p}</span>); });
  if (sel.type === 'un') { parts.push(<span key="s" className="muted">›</span>); parts.push(<b key="u" style={{ color: '#fbbf24' }}>(미분류)</b>); }
  return <span className="flex wrap" style={{ gap: 6, alignItems: 'center', fontSize: 15, minWidth: 0 }}>{parts}</span>;
}

/** 폴더 만들기 · 이름 바꾸기 · 삭제 · 구조 복사 입력 줄. */
function FolderForms({ form, setForm, fv, setFv, sel, op, busy, corps, corpName, folderN, ruleN, svcRuleN = 0, folderRegs, onRemoved, onRenamed }) {
  // 삭제 확인 수는 서버가 세는 것(그 폴더 아래 등록 — 목록에 없는 등록 · 하위 폴더 포함)과 같아야 한다(반증 3a 별건 — 손 등록 서버 행만 세서 늘 409). 서버가 주지 않으면 예전 셈
  const regs = Number.isFinite(folderRegs) ? folderRegs : folderN;
  const extra = Math.max(0, regs - folderN);
  if (!form) return null;
  const bar = { padding: '8px 14px', background: 'var(--panel-2)', alignItems: 'center' };
  if (form === 'folder') {
    return (
      <div className="flex wrap gap" style={bar}>
        <span className="muted" style={{ fontSize: 12 }}>새 폴더(구분자 \ · 최대 10단계)</span>
        <input className="input" autoFocus value={fv.path || ''} onChange={(e) => setFv({ ...fv, path: e.target.value })} placeholder="DB\Oracle RAC" aria-label="새 폴더 경로" style={{ maxWidth: 280 }} />
        <button type="button" className="login-btn" style={btn} disabled={busy || !trimPath(fv.path)} onClick={async () => {
          const path = trimPath(fv.path);
          const r = await op({ op: 'folder.add', corp: sel.corp, path }, `폴더 ‘${path}’ 을(를) 만들었습니다.`); if (r) setForm('');
        }}>만들기</button>
        <button type="button" className="logout-btn" style={btn} onClick={() => setForm('')}>취소</button>
      </div>
    );
  }
  if (form === 'rename') {
    return (
      <div className="flex wrap gap" style={bar}>
        <span className="muted" style={{ fontSize: 12 }}>‘{pathText(sel.path)}’ 새 이름(하위 폴더 · 등록 · 이 법인 규칙의 경로도 함께)</span>
        <input className="input" autoFocus value={fv.name || ''} onChange={(e) => setFv({ ...fv, name: e.target.value })} aria-label="새 폴더 이름" style={{ maxWidth: 220 }} />
        <button type="button" className="login-btn" style={btn} disabled={busy || !String(fv.name || '').trim()} onClick={async () => {
          const r = await op({ op: 'folder.rename', corp: sel.corp, path: sel.path, name: fv.name }, renameNote);
          if (r) { setForm(''); onRenamed(r.result?.path || sel.path); }
        }}>바꾸기</button>
        <button type="button" className="logout-btn" style={btn} onClick={() => setForm('')}>취소</button>
      </div>
    );
  }
  if (form === 'remove') {
    return (
      <div className="flex wrap gap" style={{ ...bar, borderLeft: '3px solid var(--amber)' }}>
        <span style={{ fontSize: 12, flex: '1 1 300px', minWidth: 0 }}>
          폴더 ‘{pathText(sel.path)}’ 와(과) 하위 폴더를 지웁니다. 손 등록한 서버 <b>{folderN}</b>대는 지워지지 않고 <b>(미분류)</b>로 돌아갑니다
          {extra ? ` · 목록에 없는 등록(보류 · 없어짐 · 옛 키) ${extra}개는 함께 지워집니다` : ''}
          {ruleN ? ` · 자동 규칙으로 들어온 ${ruleN}대는 그 규칙(이 법인 규칙)과 함께 빠집니다 — 전 법인 규칙이 이 경로를 가리키면 폴더가 다시 생길 수 있습니다` : ''}.
          {svcRuleN ? ` 서비스 인벤토리의 물리서버 폴더 규칙 ${svcRuleN}개가 이 경로를 가리킵니다 — 그 규칙은 지우지 않으니 서비스 인벤토리 › 소속 규칙에서 정리하십시오.` : ''}
        </span>
        <button type="button" className="logout-btn" style={{ ...btn, color: 'var(--red)' }} disabled={busy} onClick={async () => {
          const r = await op({ op: 'folder.remove', corp: sel.corp, path: sel.path, expect: regs }, (x) => removeNote(pathText(sel.path), x));
          if (r) { setForm(''); onRemoved(); }
        }}>{folderN}대를 미분류로 돌리고 삭제</button>
        <button type="button" className="logout-btn" style={btn} onClick={() => setForm('')}>취소</button>
      </div>
    );
  }
  if (form === 'copy') {
    const from = corps.filter((c) => c.vcenterId !== sel.corp && c.folders.length);
    return (
      <div className="flex wrap gap" style={bar}>
        <span className="muted" style={{ fontSize: 12 }}>다른 법인의 폴더 구조(빈 폴더)를 이 법인에 복사합니다 — 서버 등록은 복사하지 않습니다</span>
        <Select className="select" value={fv.from || ''} onChange={(e) => setFv({ ...fv, from: e.target.value })} aria-label="복사할 법인" style={{ maxWidth: 240 }}>
          <option value="">법인 고르기…</option>
          {from.map((c) => <option key={c.vcenterId} value={c.vcenterId}>{c.name} · 폴더 {c.folders.length}개</option>)}
        </Select>
        <button type="button" className="login-btn" style={btn} disabled={busy || !fv.from} onClick={async () => {
          const r = await op({ op: 'folder.copy', from: fv.from, to: sel.corp }, `${corpName(fv.from)} 의 폴더 구조를 복사했습니다.`); if (r) setForm('');
        }}>복사</button>
        <button type="button" className="logout-btn" style={btn} onClick={() => setForm('')}>취소</button>
      </div>
    );
  }
  return null;
}

/** 고른 서버 — 같은 법인의 다른 폴더로 옮기기 · 폴더에서 빼기. */
function SelBar({ picked, folders, sel, op, busy, onDone }) {
  const [to, setTo] = useState('');
  const manual = picked.filter((r) => r.place === 'manual').length;
  const rule = picked.filter((r) => r.place === 'rule').length;
  return (
    <div className="flex wrap gap bmf-selbar">
      <b>{picked.length}대 선택</b>
      <Select className="select" value={to} onChange={(e) => setTo(e.target.value)} aria-label="옮길 폴더" style={{ maxWidth: 260 }}>
        <option value="">옮길 폴더…</option>
        {folders.filter((p) => !(sel.type === 'folder' && p === sel.path)).map((p) => <option key={p} value={p}>{pathText(p)}</option>)}
      </Select>
      <button type="button" className="login-btn" style={btn} disabled={busy || !to} onClick={async () => {
        const r = await op({ op: 'assign', corp: sel.corp, path: to, keys: picked.map((x) => x.key), moveExisting: true, createMissing: false }, `${picked.length}대를 ‘${pathText(to)}’ 로 옮겼습니다.`);
        if (r) { setTo(''); onDone(); }
      }}>옮기기</button>
      <button type="button" className="logout-btn" style={btn} disabled={busy || !manual} title={rule ? `자동 규칙으로 들어온 ${rule}대는 뺄 수 없습니다(규칙이 다시 넣습니다 — 규칙을 지우거나 다른 폴더로 손 등록)` : undefined} onClick={async () => {
        const r = await op({ op: 'unassign', keys: picked.filter((x) => x.place === 'manual').map((x) => x.key) }, `${manual}대를 폴더에서 뺐습니다((미분류)로).`);
        if (r) onDone();
      }}>폴더에서 빼기{manual !== picked.length ? ` (${manual}대)` : ''}</button>
    </div>
  );
}

/** 전체 — 법인별 현황 · 미분류 묶음 · 법인 불일치 · 없어짐 정리 · 자동 규칙. */
function Overview({ d, corps, corpName, setSel, pick, op, busy, openBulk }) {
  const now = Date.now();
  const ghosts = (d.missing || []).filter((x) => x.state === 'ghost');
  const [prune, setPrune] = useState(null);
  return (
    <>
      <div className="card" style={{ minWidth: 0 }}>
        <div className="flex wrap gap" style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)', alignItems: 'center' }}>
          <b>법인별 현황</b><span className="muted" style={{ fontSize: 12 }}>엣지 · 수집 서버가 보고한 서버도 중앙에서 폴더에 넣습니다(등록 정보는 중앙에만 저장)</span>
        </div>
        {!corps.length ? <div className="muted" style={{ padding: 16 }}>범위 안에 물리서버가 있는 법인이 없습니다.</div> : (
          <STable className="table bmf-t" minWidth={700}>
            <thead><tr><th>법인</th><th>받는 길</th><th>물리서버</th><th>폴더 등록 / 미분류</th><th>폴더</th><th>부품 장애</th><th>보류 · 없어짐</th></tr></thead>
            <tbody>
              {corps.map((c) => (
                <tr key={c.vcenterId} style={{ cursor: 'pointer' }} title={c.unassigned ? '누르면 이 법인의 미분류 서버' : '누르면 이 법인'}
                  onClick={() => { setSel(c.unassigned ? { type: 'un', corp: c.vcenterId } : { type: 'corp', corp: c.vcenterId }); pick(c.vcenterId); }}>
                  <td data-sort={c.name}><b>{shortCorp(c.name)}</b></td>
                  <td>
                    <span className="flex wrap" style={{ gap: 4, alignItems: 'center' }}>
                      {['central', 'edge', 'collector'].filter((k) => c.sources[k]).map((k) => <span key={k} style={{ whiteSpace: 'nowrap' }}><SrcBadge src={k} /> <span className="muted" style={{ fontSize: 11 }}>{c.sources[k]}</span></span>)}
                    </span>
                    {(c.agents || []).filter((a) => !a.agent.startsWith('collector:')).slice(0, 3).map((a) => (
                      <div key={a.agent} className="muted" style={{ fontSize: 11 }}><span className="mono">{a.agent}</span> · {a.expired ? <span style={{ color: '#fbbf24' }}>보고 만료</span> : `보고 ${ageText(a.at, now)}`}</div>
                    ))}
                  </td>
                  <td data-sort={c.bm}>{c.bm}{c.esxiPlaced ? <span className="muted" style={{ fontSize: 11 }}> + ESXi {c.esxiPlaced}</span> : null}</td>
                  <td data-sort={c.unassigned}><span className="flex" style={{ gap: 8, alignItems: 'center' }}><StackBar parts={[{ n: c.registered, c: 'var(--accent)' }, { n: c.unassigned, c: 'var(--amber)' }]} w={92} h={7} label={`등록 ${c.registered}, 미분류 ${c.unassigned}`} /><span style={{ whiteSpace: 'nowrap' }}>{c.registered} / <span style={{ color: c.unassigned ? '#fbbf24' : undefined }}>{c.unassigned}</span></span></span></td>
                  <td data-sort={c.folders.length}>{c.folders.length}</td>
                  <td data-sort={c.faults}>{c.faults ? <span className="badge red">{c.faults}</span> : null}{c.faultsUnknown ? <span className="muted" style={{ marginLeft: c.faults ? 4 : 0 }} title="부품 장애를 못 읽은 서버 — 장애에도 정상에도 넣지 않습니다">{c.faults ? '' : '— '}(모름 {c.faultsUnknown})</span> : c.faults ? null : 0}</td>
                  <td data-sort={c.held + c.ghosts}>{c.held || c.ghosts ? <span>{c.held ? <span className="badge amber">보류 {c.held}</span> : null} {c.ghosts ? <span className="badge red">없어짐 {c.ghosts}</span> : null}</span> : <span className="muted">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </STable>
        )}
        <div className="muted" style={{ padding: '8px 14px', fontSize: 12 }}>
          {!d.scoped && d.noCorp ? `법인 미지정 ${d.noCorp}대는 폴더에 넣을 수 없습니다 — 통합 서버 인벤토리에서 법인을 먼저 정하십시오. ` : ''}
          행을 누르면 그 법인의 미분류 서버 · 보류 = 서버 목록 출처를 못 읽어 판정을 미룬 등록(지우지 않음) · 없어짐 = 출처를 다 읽었는데 목록에 없는 등록.
        </div>
      </div>

      {d.prefixGroups?.length ? (
        <div className="card" style={{ minWidth: 0 }}>
          <div className="flex wrap gap" style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)', alignItems: 'center' }}>
            <b>이름 앞부분이 같은 미분류 서버</b><span className="muted" style={{ fontSize: 12 }}>누르면 ‘서버 찾아 등록’ 이 그 글자로 열립니다(자동으로 등록하지 않습니다)</span>
          </div>
          <div className="bmf-groups">
            {d.prefixGroups.map((g) => (
              <div key={g.prefix} className="bmf-group">
                <span className="flex" style={{ gap: 6, alignItems: 'center', minWidth: 0 }}><span className="mono bmf-tag">{g.prefix}*</span><span className="badge gray" style={{ marginLeft: 'auto' }}>{g.n}대</span></span>
                <span className="muted" style={{ fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{g.corps.length === 1 ? corpName(g.corps[0]) : `법인 ${g.corps.length}곳`}</span>
                {d.canWrite ? <button type="button" className="logout-btn" style={{ padding: '4px 8px', fontSize: 12 }} onClick={() => openBulk({ corp: g.corps.length === 1 ? g.corps[0] : '', text: g.prefix, unassigned: true })}>찾아 등록…</button> : null}
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {d.mismatch?.length ? (
        <div className="card" style={{ padding: '10px 14px', borderLeft: '3px solid var(--amber)', fontSize: 13, minWidth: 0 }}>
          <b>법인이 바뀐 서버 {d.mismatch.length}대</b> — 등록한 법인과 지금 법인이 달라 예전 폴더 등록을 적용하지 않고 (미분류)로 둡니다. 새 법인 폴더로 다시 등록하거나 예전 등록을 지우십시오.
          <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>{d.mismatch.slice(0, 10).map((x) => `${corpName(x.was) || '?'}${x.path ? ` › ${pathText(x.path)}` : ''} → ${x.corp ? corpName(x.corp) : '(법인 모름)'}`).join(' · ')}</div>
          {d.canWrite ? <button type="button" className="logout-btn" style={{ ...btn, marginTop: 6 }} disabled={busy} onClick={() => op({ op: 'unassign', keys: d.mismatch.map((x) => x.key) }, '예전 법인 등록을 지웠습니다.')}>예전 등록 지우기</button> : null}
        </div>
      ) : null}

      {ghosts.length && d.canWrite ? (
        <div className="card" style={{ padding: '10px 14px', borderLeft: '3px solid var(--red)', fontSize: 13, minWidth: 0 }}>
          <b>없어진 서버 {ghosts.length}대</b> — 서버 목록 출처를 다 읽었는데 목록에 없는 등록입니다. {ghosts.slice(0, 6).map((x) => x.name).join(' · ')}{ghosts.length > 6 ? ' …' : ''}
          <div className="flex wrap gap" style={{ marginTop: 6, alignItems: 'center' }}>
            {!prune ? (
              <button type="button" className="logout-btn" style={btn} disabled={busy} onClick={async () => {
                try { const r = await postJson('/tools/bm-folders/op', { op: 'ghost.prune', dry: true }); if (r?.ok) setPrune(r.result); } catch (e) { setPrune({ error: opErrorText(e) }); }
              }}>정리 미리보기</button>
            ) : prune.error ? <span style={{ color: 'var(--red)' }}>{prune.error}</span> : (
              <>
                <span>쓰기 범위 안 {prune.n}건을 지웁니다(미리 본 목록과 달라진 키는 지우지 않습니다){prune.held ? ` · 보류 ${prune.held}건은 그대로` : ''}.</span>
                <button type="button" className="logout-btn" style={{ ...btn, color: 'var(--red)' }} disabled={busy || !prune.n} onClick={async () => { const r = await op({ op: 'ghost.prune', keys: prune.keys }, '없어진 서버 등록을 정리했습니다.'); if (r) setPrune(null); }}>{prune.n}건 정리</button>
                <button type="button" className="logout-btn" style={btn} onClick={() => setPrune(null)}>취소</button>
              </>
            )}
          </div>
        </div>
      ) : null}

      <RulesCard d={d} corps={corps} corpName={corpName} op={op} busy={busy} />
    </>
  );
}

/** 자동 규칙 — 이름에 글자가 들어가면 그 폴더(꺼진 채 시작 · 켜기는 전체 범위 관리자). */
function RulesCard({ d, corps, corpName, op, busy }) {
  const [v, setV] = useState({ corp: '', value: '', path: '' });
  const rules = d.rules || [];
  const writableCorps = corps.filter((c) => c.writable);
  const canAdd = d.canFleet || writableCorps.length;
  if (!rules.length && !canAdd) return null;
  return (
    <div className="card" style={{ minWidth: 0 }}>
      <div className="flex wrap gap" style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)', alignItems: 'center' }}>
        <b>자동 규칙</b>
        <span className={`badge ${d.settings?.autoRules ? 'green' : 'gray'}`}>{d.settings?.autoRules ? '켜짐' : '꺼짐'}</span>
        <span className="muted" style={{ fontSize: 12 }}>이름에 글자가 들어간 미분류 서버를 그 법인의 폴더에 넣습니다(정규식 아님 · 손 등록이 먼저 · 베어메탈만)</span>
        <span style={{ flex: 1 }} />
        {d.canFleet ? (
          <button type="button" className="logout-btn" style={btn} disabled={busy} onClick={() => op({ op: 'settings', autoRules: !d.settings?.autoRules }, `자동 규칙을 ${d.settings?.autoRules ? '껐' : '켰'}습니다.`)}>{d.settings?.autoRules ? '끄기' : '켜기'}</button>
        ) : <span className="muted" style={{ fontSize: 12 }}>켜기 · 끄기는 전체 범위 관리자</span>}
      </div>
      {rules.length ? (
        <STable className="table bmf-t" minWidth={560}>
          <thead><tr><th>법인</th><th>이름에 들어가면</th><th>넣을 폴더</th><th>만든 사람</th><th data-nosort /></tr></thead>
          <tbody>
            {rules.map((r) => (
              <tr key={r.id}>
                <td>{r.corp === '*' ? <span className="badge blue">전 법인</span> : corpName(r.corp)}</td>
                <td className="mono">{r.value}</td>
                <td>{pathText(r.path)}</td>
                <td className="muted">{r.by || '—'}</td>
                <td data-nosort>{r.writable ? <button type="button" className="logout-btn" style={{ padding: '3px 8px', fontSize: 12 }} disabled={busy} onClick={() => op({ op: 'rule.remove', id: r.id }, '규칙을 지웠습니다.')}>지우기</button> : null}</td>
              </tr>
            ))}
          </tbody>
        </STable>
      ) : <div className="muted" style={{ padding: '10px 14px', fontSize: 13 }}>규칙이 없습니다. ‘서버 찾아 등록’ 에서 조건을 규칙으로 저장하거나 아래에서 만듭니다.</div>}
      {canAdd ? (
        <div className="flex wrap gap" style={{ padding: '8px 14px', alignItems: 'center', borderTop: '1px solid var(--border)' }}>
          <Select className="select" value={v.corp} onChange={(e) => setV({ ...v, corp: e.target.value })} aria-label="규칙 법인" style={{ maxWidth: 200 }}>
            <option value="">법인 고르기…</option>
            {d.canFleet ? <option value="*">전 법인</option> : null}
            {writableCorps.map((c) => <option key={c.vcenterId} value={c.vcenterId}>{c.name}</option>)}
          </Select>
          <input className="input" value={v.value} onChange={(e) => setV({ ...v, value: e.target.value })} placeholder="이름에 들어가면(예: ora)" aria-label="규칙 글자" style={{ maxWidth: 180 }} />
          <input className="input" value={v.path} onChange={(e) => setV({ ...v, path: e.target.value })} placeholder="넣을 폴더(예: DB\Oracle RAC)" aria-label="넣을 폴더" style={{ maxWidth: 240 }} />
          <button type="button" className="login-btn" style={btn} disabled={busy || !v.corp || !v.value.trim() || !v.path.trim()} onClick={async () => {
            const r = await op({ op: 'rule.add', corp: v.corp, value: v.value, path: trimPath(v.path) }, `규칙을 만들었습니다${d.settings?.autoRules ? '' : ' — 자동 규칙이 꺼져 있어 켜야 적용됩니다'}.`);
            if (r) setV({ corp: v.corp, value: '', path: '' });
          }}>규칙 만들기</button>
        </div>
      ) : null}
    </div>
  );
}

/** 저장한 보기 — 고르기 · 지금 보기 저장(이름) · 지우기. 이 브라우저에만 저장된다(다른 사람 · 다른 기기와 나누지 않는다). */
function ViewsMenu({ views, viewName, onPick, onSave, onRemove }) {
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  return (
    <span className="flex wrap" style={{ gap: 6, alignItems: 'center', minWidth: 0 }}>
      <Select className="select" value={viewName} onChange={(e) => onPick(e.target.value)} aria-label="저장한 보기" style={{ maxWidth: 180 }} title="저장한 보기 — 이 브라우저에만 저장됩니다">
        <option value="">보기 고르기…</option>
        {views.map((v) => <option key={v.name} value={v.name}>{v.name}</option>)}
      </Select>
      {naming ? (
        <>
          <input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="보기 이름" aria-label="보기 이름" maxLength={40} style={{ maxWidth: 150 }}
            onKeyDown={(e) => { if (e.key === 'Enter' && name.trim()) { onSave(name.trim()); setNaming(false); setName(''); } if (e.key === 'Escape') setNaming(false); }} />
          <button type="button" className="login-btn" style={{ padding: '5px 10px' }} disabled={!name.trim()} onClick={() => { onSave(name.trim()); setNaming(false); setName(''); }}>저장</button>
          <button type="button" className="logout-btn" style={{ padding: '5px 10px' }} onClick={() => setNaming(false)}>취소</button>
        </>
      ) : (
        <>
          <button type="button" className="logout-btn" style={{ padding: '5px 10px' }} onClick={() => { setNaming(true); setName(viewName || ''); }} title="지금 고른 노드 · 보기 방식 · 거르기 · 묶기 · 색을 이름으로 저장">보기 저장</button>
          {viewName ? <button type="button" className="logout-btn" style={{ padding: '5px 10px' }} onClick={() => onRemove(viewName)}>지우기</button> : null}
        </>
      )}
    </span>
  );
}

/** 좁은 화면(640px 이하) 목록 — 서버 한 대 = 카드 두 줄(이름 · 받는 길 / 모델 · 사용률 · 전력). 고르기는 44px 칸. */
function NarrowList({ rows, writable, picked, setPicked, onOpen, scoped }) {
  return (
    <div className="bmf-cards">
      {rows.map((r) => (
        <div key={r.key} className={`bmf-card${picked.has(r.key) ? ' picked' : ''}`}>
          {writable ? (
            <label className="bmf-card-chk" onClick={(e) => e.stopPropagation()}>
              <input type="checkbox" aria-label={`${r.name} 선택`} checked={picked.has(r.key)} onChange={(e) => setPicked((s) => { const n = new Set(s); if (e.target.checked) n.add(r.key); else n.delete(r.key); return n; })} />
            </label>
          ) : null}
          <button type="button" className="bmf-card-body" onClick={() => onOpen(r.key)}>
            <span className="l1"><StatusDot tone={r.faults > 0 ? 'red' : r.cpu == null && r.mem == null ? 'none' : r.powered === false ? 'gray' : 'green'} /><b>{r.name}</b>
              {r.faults > 0 ? <span className="badge red">{r.faults}건</span> : null}<span style={{ marginLeft: 'auto' }}><SrcBadge src={r.src} small /></span></span>
            <span className="l2">{[r.place ? pathText(r.path) : '(미분류)', r.model, !scoped ? r.serviceTag : ''].filter(Boolean).join(' · ')}</span>
            <span className="l2">{r.cpu == null && r.mem == null && r.why?.code ? `사용률 — ${whyShort(r.why)}` : <>CPU {pctText(r.cpu)} · 메모리 {pctText(r.mem)}</>} · {wattsText(r.watts)}{SRC_SHORT[rowSrcClass(r)] ? ` · ${SRC_SHORT[rowSrcClass(r)]}` : ''}</span>
          </button>
        </div>
      ))}
    </div>
  );
}

/** v2.993(출처 색 — 설계 bm-folders §13 ①): 표 위 '사용률을 읽은 곳' 개수 띠. 출처가 하나도 없으면 그리지 않는다. */
function SrcSummary({ rows }) {
  const c = srcCounts(rows);
  const items = [['os', 'OS(SSH)'], ['idrac', 'iDRAC'], ['vcenter', 'vCenter'], ['mixed', '지표마다 다름'], ['none', '없음'], ['unknown', '출처 모름']].filter(([k]) => c[k]);
  if (!c.os && !c.idrac && !c.vcenter && !c.mixed) return null;
  return (
    <div className="bmf-rsum" role="group" aria-label="사용률을 읽은 곳">
      <span className="muted">사용률을 읽은 곳</span>
      {items.map(([k, lb]) => (
        <span key={k} className="it">
          {k === 'mixed' ? <><span className="bmf-sw" style={{ background: SRC_COLOR.os }} /><span className="bmf-sw" style={{ background: SRC_COLOR.idrac }} /></> : <span className={`bmf-sw${SRC_COLOR[k] ? '' : ' none'}`} style={SRC_COLOR[k] ? { background: SRC_COLOR[k] } : undefined} />}
          {lb} <b>{c[k]}</b>
        </span>
      ))}
      <span className="muted" style={{ marginLeft: 'auto' }}>OS 를 먼저 읽고, 안 되거나 값이 없으면 iDRAC 값을 씁니다 — 막대 색과 표지가 출처입니다(지표마다 따로)</span>
    </div>
  );
}

/** v2.994(값 없음 사유 — 설계 §12): 값이 없는 칸의 사유별 개수 띠 — 누르면 그 사유의 서버만(다시 누르면 풂). 사유가 없으면 그리지 않는다. */
function WhyBand({ rows, quick, setQuick }) {
  const bands = whyBands(rows);
  if (!bands.length) return null;
  return (
    <div className="bmf-wband" role="group" aria-label="값이 없는 칸의 이유">
      <span className="muted">값이 없는 칸의 이유</span>
      {bands.map((b) => {
        const k = `why:${b.code}`;
        return (
          <button key={b.code} type="button" className={`bmf-chip${quick === k ? ' on' : ''}`} aria-pressed={quick === k} onClick={() => setQuick(quick === k ? '' : k)} title={`${b.l} ${b.a}`.trim()}>
            <span className={`bmf-wd ${b.cls}`} style={{ background: WHY_DOT[b.cls], marginRight: 5 }} aria-hidden="true" />{b.s} {b.n}
          </button>
        );
      })}
    </div>
  );
}

/** v2.995(묶음 C): 서비스 태그를 아직 읽지 못한 서버 — 임시 키(이름 기반)로 등록된다. 태그가 읽히면 등록이 태그 키로 저절로 옮겨 간다. */
function TmpKeyBadge() {
  return <span className="badge gray" style={{ marginLeft: 4, fontSize: 10.5 }} title="서비스 태그를 아직 읽지 못해 임시 키(이름 기반)로 다룹니다. 태그가 읽히면 폴더 등록이 태그 키로 저절로 옮겨 가고 위치는 그대로입니다. 이름이 바뀌면 임시 키도 바뀌어 등록이 ‘목록에 없는 등록’ 으로 보일 수 있습니다.">태그 없음</span>;
}

