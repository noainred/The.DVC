import React, { useEffect, useMemo, useRef, useState } from 'react';
import { usePolling, postJson, putJson, delJson, getCurrentUser } from '../api.js';
import { Loading, ErrorBox } from '../components/ui.jsx';

/**
 * 성능점검 — Claude Design 핸드오프(design_handoff_perf_check) 기준 구현.
 * 좌: 트리(법인/서비스, 경로 파생) · 스플리터 · 우: 점검 목록(그룹 헤더 + 행) + 상세 모달.
 *
 * 색·간격·타이포는 핸드오프 README 의 토큰을 그대로 따른다(pc-* 클래스, styles.css 하단).
 * 인프라/서비스 두 모드는 대상의 kind('infra'|'service')로 분리 — 트리·목록이 함께 교체된다.
 */

const LEFT_W_KEY = 'perfcheck.leftW';
const DEFAULT_LEFT_W = 340;

/** 상태 매핑(README): Ok/Host is alive → ok, Warning → warn, Disabled → off, 그 외 → bad. */
const STATUS = {
  ok: { label: 'Ok', cls: 'pc-ok' },
  warn: { label: 'Warning', cls: 'pc-warn' },
  bad: { label: 'No answer', cls: 'pc-bad' },
  disabled: { label: 'Disabled', cls: 'pc-off' },
  none: { label: '—', cls: 'pc-off' },
};
const METHOD = {
  ping: 'ping (timeout - 4000 ms)', tcp: 'TCP port', http: 'HTTP/URL',
  dns: 'DNS query', cert: 'SSL certificate expiry', ntp: 'NTP offset',
};
const statusOf = (t, x) => (t.enabled === false || x.enabled === false) ? 'disabled' : (x.result?.status || 'none');
const methodText = (t, x) => {
  const base = METHOD[x.type] || x.type;
  if (x.type === 'tcp') return `${base} ${x.port || ''}`.trim();
  if (x.type === 'http') return `${base} (${x.url})`;
  if (x.type === 'dns') return `${base} (${x.record || ''} @ ${x.server || t.host})`;
  return `${base} (${t.host})`;
};

/* ── 트리: path 세그먼트 누적 ── */
function buildTree(targets) {
  const root = { id: '', name: 'Root', children: new Map(), targets: [] };
  for (const t of targets) {
    let node = root;
    for (const seg of (t.path || '').split('\\').filter(Boolean)) {
      if (!node.children.has(seg)) node.children.set(seg, { id: node.id ? `${node.id}\\${seg}` : seg, name: seg, children: new Map(), targets: [] });
      node = node.children.get(seg);
    }
    node.targets.push(t);
  }
  return root;
}
function statsOf(node) {
  let alarms = 0, worst = 'none';
  const rank = { bad: 3, warn: 2, ok: 1, none: 0, disabled: 0 };
  const visit = (n) => {
    for (const t of n.targets) for (const x of t.tests) {
      const st = statusOf(t, x);
      if (st === 'bad' || st === 'warn') alarms += 1;
      if (rank[st] > rank[worst]) worst = st;
    }
    for (const c of n.children.values()) visit(c);
  };
  visit(node);
  return { alarms, worst };
}
const matchNode = (node, q) => !q || node.name.toLowerCase().includes(q)
  || node.targets.some((t) => t.name.toLowerCase().includes(q) || (t.host || '').toLowerCase().includes(q))
  || [...node.children.values()].some((c) => matchNode(c, q));

function TreeRows({ node, depth, sel, setSel, expanded, toggle, q }) {
  if (depth > 0 && !matchNode(node, q)) return null;
  const open = q ? true : (expanded[node.id] !== false);   // 검색 중 강제 확장(README)
  const { alarms, worst } = statsOf(node);
  const hasKids = node.children.size > 0 || node.targets.length > 0;
  return (
    <>
      {depth > 0 && (
        <div className={`pc-tree-row${sel === node.id ? ' sel' : ''}`} style={{ paddingLeft: 8 + depth * 16 }}
          onClick={() => setSel(node.id)}>
          <span className="pc-tog" onClick={(e) => { e.stopPropagation(); toggle(node.id); }}>{hasKids ? (open ? '−' : '+') : '·'}</span>
          <span className={`pc-dot ${STATUS[worst]?.cls || 'pc-off'}`} />
          <span className={`pc-tree-label${alarms ? ' alarm' : ''}${sel === node.id ? ' on' : ''}`}>{node.name}</span>
          {alarms > 0 && <span className="pc-badge">{alarms}</span>}
        </div>
      )}
      {open && (
        <>
          {[...node.children.values()].map((c) => (
            <TreeRows key={c.id} node={c} depth={depth + 1} sel={sel} setSel={setSel} expanded={expanded} toggle={toggle} q={q} />
          ))}
          {node.targets.filter((t) => !q || t.name.toLowerCase().includes(q) || (t.host || '').toLowerCase().includes(q)).map((t) => {
            const st = statsOf({ children: new Map(), targets: [t] });
            const id = `target:${t.id}`;
            return (
              <div key={t.id} className={`pc-tree-row${sel === id ? ' sel' : ''}`} style={{ paddingLeft: 8 + (depth + 1) * 16 }}
                onClick={() => setSel(id)}>
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

const EMPTY_TARGET = { kind: 'infra', path: 'B.Service', name: '', host: '' };
const EMPTY_TEST = { name: '', type: 'ping', intervalSec: 60, port: '', url: '', keyword: '', record: '', server: '' };

export default function SvcMonitor() {
  const [seq, setSeq] = useState(0);
  const refresh = () => setSeq((n) => n + 1);
  const { data, error, loading } = usePolling('/svcmon/state', { seq }, 15_000);
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
  const tree = useMemo(() => buildTree(targets), [targets]);

  if (loading && !data) return <Loading />;
  if (error && !data) return <ErrorBox message={error} />;

  const summary = (() => {
    const s = { total: 0, ok: 0, warn: 0, bad: 0, disabled: 0 };
    for (const t of targets) for (const x of t.tests) {
      s.total += 1;
      const st = statusOf(t, x);
      if (st === 'ok') s.ok += 1; else if (st === 'warn') s.warn += 1; else if (st === 'bad') s.bad += 1; else s.disabled += 1;
    }
    return s;
  })();

  // 선택 노드 이하 대상(README: 최대 8개)
  const selected = (() => {
    if (!sel) return targets.slice(0, 8);
    if (sel.startsWith('target:')) return targets.filter((t) => t.id === sel.slice(7));
    return targets.filter((t) => t.path === sel || t.path.startsWith(`${sel}\\`)).slice(0, 8);
  })();

  const q = testQ.trim().toLowerCase();
  const groups = selected.map((t) => {
    let tests = t.tests.filter((x) => {
      const st = statusOf(t, x);
      if (filter === 'OK' && st !== 'ok') return false;
      if (filter === 'WARN' && st !== 'warn') return false;
      if (filter === 'FAIL' && st !== 'bad') return false;
      if (filter === 'DISABLED' && !['disabled', 'none'].includes(st)) return false;
      return !q || x.name.toLowerCase().includes(q) || methodText(t, x).toLowerCase().includes(q);
    });
    if (sort === 'name') tests = [...tests].sort((a, b) => a.name.localeCompare(b.name));
    if (sort === 'status') {
      const rank = { bad: 0, warn: 1, ok: 2, disabled: 3, none: 3 };
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
      </div>

      <div className="pc-cards">
        {[
          { k: 'total', label: 'TOTAL TESTS', v: summary.total, note: `${targets.length}개 대상 그룹`, cls: 'b' },
          { k: 'ok', label: '정상', v: summary.ok, note: 'Ok · Host is alive', cls: 'g' },
          { k: 'warn', label: '경고', v: summary.warn, note: '임계치 근접', cls: 'a' },
          { k: 'bad', label: '실패', v: summary.bad, note: 'No answer · Error', cls: 'r' },
          { k: 'off', label: '중지', v: summary.disabled, note: 'Disabled', cls: 'o' },
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
          <div className="pc-tree-body">
            <div className={`pc-tree-row${sel === '' ? ' sel' : ''}`} onClick={() => setSel('')}>
              <span className="pc-tog">−</span><span className="pc-dot pc-off" />
              <span className={`pc-tree-label${sel === '' ? ' on' : ''}`}>Root</span>
            </div>
            <TreeRows node={tree} depth={0} sel={sel} setSel={setSel} expanded={expanded} q={treeQ.trim().toLowerCase()}
              toggle={(id) => setExpanded((e) => ({ ...e, [id]: e[id] === false }))} />
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
            <button className="pc-btn" disabled={!canEdit} onClick={() => { setForm({ ...EMPTY_TARGET, path: sel && !sel.startsWith('target:') ? sel : EMPTY_TARGET.path }); setErr(''); setModal({ kind: 'target' }); }}>＋ Add</button>
            <button className="pc-btn" disabled={!canEdit || !selTarget} title={selTarget ? '' : '트리에서 대상을 선택'}
              onClick={() => { setForm({ ...EMPTY_TEST }); setErr(''); setModal({ kind: 'test', targetId: selTarget.id }); }}>✎ 점검 추가</button>
            <button className="pc-btn" disabled={!canEdit || !selTarget} onClick={removeSel}>✕ Remove</button>
            <button className="pc-btn accent" disabled={!canEdit} onClick={doRefresh}>⟳ Refresh</button>
            <button className="pc-btn" onClick={doReset}>⟲ Reset</button>
            <span className="pc-sep" />
            {['ALL', 'OK', 'WARN', 'FAIL', 'DISABLED'].map((f) => (
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
            </div>
          </div>

          <div className="pc-footer">
            <span>SHOWN {shown} / {summary.total}</span>
            <span>AVG REPLY {avgMs} ms</span>
            <span>LAST REFRESH {data?.lastSweep ? new Date(data.lastSweep).toLocaleTimeString('ko-KR', { hour12: false }) : '—'}</span>
            <span className="pc-live">● LIVE POLLING</span>
          </div>
        </div>
      </div>

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
                <button className="pc-btn" onClick={() => { setForm({ ...EMPTY_TEST, ...detail.test }); setErr(''); setModal({ kind: 'test', targetId: detail.target.id, edit: detail.test.id }); setDetail(null); }}>✎ 수정</button>
                <button className="pc-btn" onClick={async () => {
                  if (!window.confirm(`점검 '${detail.test.name}' 을 삭제할까요?`)) return;
                  try { await delJson(`/svcmon/targets/${detail.target.id}/tests/${detail.test.id}`); setDetail(null); refresh(); } catch (e) { window.alert(e.message); }
                }}>✕ 삭제</button>
              </div>
            )}
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
