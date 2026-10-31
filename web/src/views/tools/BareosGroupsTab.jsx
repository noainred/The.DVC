/**
 * Bareos 관리 도구의 '백업 그룹' 탭(v2.830 · v2.831 개편 — 사용자 요청 'Claude Design 시안대로':
 *   ① 법인 vCenter 의 VM 폴더 구조에서 VM 을 골라 백업 정책 그룹으로 ② 원하는 이름으로 저장 · 즉시 백업 · 매일/매주 지정 시각 스케줄 · 보관 개수).
 *   화면 셋: 목록(그룹 카드) · 만들기·수정(왼쪽 폴더 트리 + 오른쪽 정책) · 상세(정책 요약 · 멤버 VM · 실행 이력과 보관 표지).
 *   스케줄과 보관 정리는 포탈이 한다(서버 bareos/groupRunner.js · groupRetention.js — Bareos 에는 잡 스케줄 수정·잡별 보관 개수가 없다).
 *   값은 GET /api/tools/bareos-backup/groups/tree(원장·표시·인벤토리 — Director 에 접속하지 않는다). 판정·문구는 bareosGroupText.js.
 * ⚠ 훅은 조기 return 위 · 늦게 온 이전 법인의 응답은 버린다 · 조회 실패 상태로 저장 버튼을 열지 않는다 · 무거운 조회는 마운트 1회 + 버튼(실행 중일 때만 다시 읽는다).
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { fetchJson, postJson, putJson, delJson } from '../../api.js';
import { Loading, ErrorBox, Modal } from '../../components/ui.jsx';
import { STable } from '../../components/STable.jsx';
import Select from '../../components/Select.jsx';
import DataList from '../../components/DataList.jsx';
import BoldText from '../../components/boldText.jsx';
import { fmtGb, flattenBareosTree, initialBareosOpen, shortTs, stText, runLine } from './bareosViewText.js';
import { relayWaitMs, outcomeUnknown, unknownOutcomeText } from './bareosText.js';
import {
  DAY_NAMES, LEVELS, NEW_SCHEDULE, scheduleText, draftIssues, toggleDay, GROUP_FILTERS, groupFilterCounts, pickable, buildGroupTree, checkState,
  FIRE_STATE_TEXT, FIRE_STATE_TONE, fireText, fireTone, isDaily, setCadence, scheduleParts,
  KEEP_PRESETS, KEEP_DEFAULT, NEW_GROUP_KEEP, keepOtpReasons, keepText, stepKeep, keepMeaning, keepParts, fireKeepBadge, KEEP_BADGE_TEXT, untilText,
  memberResults, resultBadge, folderSummary, sizeSum,
} from './bareosGroupText.js';

const BASE = '/tools/bareos-backup';
const enc = encodeURIComponent;
const VC_KEY = 'bareos-groups-vc';
const ROW = { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 };
const BTN = { padding: '5px 12px', fontSize: 12.5 };
const TONE = { ok: '#86efac', warn: '#fcd34d', bad: '#fca5a5', run: '#93c5fd', muted: 'var(--text-dim)' };
const TONE_BG = { ok: 'rgba(34,197,94,.14)', warn: 'rgba(245,158,11,.14)', bad: 'rgba(239,68,68,.14)', run: 'rgba(59,130,246,.16)', muted: 'rgba(148,163,184,.12)' };
const GRID = '34px minmax(200px, 2fr) 52px 78px minmax(160px, 1.3fr)';
const loadVc = () => { try { return localStorage.getItem(VC_KEY) || ''; } catch { return ''; } };
const saveVc = (v) => { try { localStorage.setItem(VC_KEY, v); } catch { /* 저장 못 해도 동작 */ } };
const errText = (e) => e?.body?.reason || e?.message || String(e);
const MISSED_REASON = { down: '포탈이 꺼져 있었음', edited: '돌 차례에 스케줄을 고쳐 돌리지 않음' };
const missedReason = (m) => MISSED_REASON[m?.reason] || MISSED_REASON.down;
const FolderIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#fbbf24" strokeWidth="2" strokeLinejoin="round" aria-hidden="true" style={{ flex: 'none' }}><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg>
);
const Badge = ({ tone = 'muted', children }) => (
  <span style={{ display: 'inline-block', padding: '2px 9px', borderRadius: 999, fontSize: 11.5, fontWeight: 700, whiteSpace: 'nowrap', color: TONE[tone], background: TONE_BG[tone] }}>{children}</span>
);
const BackLink = ({ onClick }) => (
  <button type="button" onClick={onClick} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: 'none', border: 0, padding: 0, color: 'var(--text-dim)', font: 'inherit', fontSize: 13, cursor: 'pointer' }}>
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6" /></svg>백업 그룹
  </button>
);

/* 화면 조각(모듈 수준 — 렌더마다 새 컴포넌트가 되어 안의 입력이 다시 만들어지지 않게) */
function Cell({ label, main, sub, tone }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div className="muted" style={{ fontSize: 11.5 }}>{label}</div>
      <div style={{ fontWeight: 700, fontSize: 13.5, marginTop: 2, overflowWrap: 'anywhere' }}>{main}</div>
      <div style={{ fontSize: 11.5, marginTop: 1, color: tone ? TONE[tone] : 'var(--text-dim)', overflowWrap: 'anywhere' }}>{sub}</div>
    </div>
  );
}
function Box({ label, main, sub, children }) {
  return (
    <div className="card" style={{ padding: 14, display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 4, minWidth: 0, alignContent: 'start' }}>
      <div className="muted" style={{ fontSize: 12 }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 800, overflowWrap: 'anywhere' }}>{main}</div>
      {children}
      <div className="muted" style={{ fontSize: 12, overflowWrap: 'anywhere' }}>{sub}</div>
    </div>
  );
}
function SecTitle({ children, extra }) {
  return <div style={{ ...ROW, justifyContent: 'space-between' }}><b style={{ fontSize: 13.5 }}>{children}</b>{extra}</div>;
}

/** 폴더 체크박스 — 일부만 고르면 가운데 상태(indeterminate). */
function TriCheck({ state, disabled, onChange, label }) {
  const ref = useRef(null);
  useEffect(() => { if (ref.current) ref.current.indeterminate = state === 'some'; }, [state]);
  return <input ref={ref} type="checkbox" aria-label={label} checked={state === 'all'} disabled={disabled} onChange={onChange} style={{ width: 16, height: 16 }} />;
}

export default function BareosGroupsTab({ d }) {
  const [vcs, setVcs] = useState(null);
  const [vcErr, setVcErr] = useState(null);
  const [vc, setVc] = useState(loadVc);
  const [tree, setTree] = useState(null);
  const [err, setErr] = useState(null);
  const [refreshErr, setRefreshErr] = useState(null);   // 버그 점검 W8: 이미 보이는 값이 있으면 새로 읽기 실패는 배너로(화면을 지우지 않는다)
  const treeRef = useRef(null);
  const [loading, setLoading] = useState(false);
  const [view, setView] = useState({ kind: 'list' });   // list · edit{ groupId, filter } · detail{ groupId }
  const [q, setQ] = useState('');
  const [runOf, setRunOf] = useState(null);
  const [fireOf, setFireOf] = useState(null);
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(() => new Set());
  const gen = useRef(0);
  const vcRef = useRef(vc);   // v2.830 검토 L7: 늦게 온 실행·삭제·저장 응답의 안내를 법인을 바꾼 뒤의 화면에 띄우지 않는다
  vcRef.current = vc;

  useEffect(() => { fetchJson('/vcenters').then((r) => setVcs(Array.isArray(r) ? r : [])).catch(setVcErr); }, []);
  // 법인 = Director 에 묶인 vCenter(관리 도구 목록의 directors[].vcenters). 이름은 vCenter 목록에서.
  const options = useMemo(() => {
    const name = new Map((vcs || []).map((v) => [v.id, v.name || v.id]));
    const out = [];
    for (const dir of d?.directors || []) for (const id of dir.vcenters || []) if (!vcs || name.has(id)) out.push({ id, label: `${name.get(id) || id} · Bareos ${dir.name}${dir.agent || dir.relay ? ' (엣지 대행)' : ''}` });
    return out.sort((a, b) => a.label.localeCompare(b.label));
  }, [vcs, d?.directors]);
  useEffect(() => {   // 고른 법인이 목록에 없으면(범위·매핑이 바뀜) 첫 법인으로
    if (!vcs || !options.length) return;
    if (!options.some((o) => o.id === vc)) setVc(options[0].id);
  }, [options, vc, vcs]);

  const load = () => {
    const g = ++gen.current;
    if (!vc) { setTree(null); return; }
    setLoading(true); setErr(null);
    fetchJson(`${BASE}/groups/tree`, { vcenterId: vc })
      .then((r) => { if (g === gen.current) { treeRef.current = r; setTree(r); setRefreshErr(null); } })
      .catch((e) => { if (g === gen.current) { if (treeRef.current) setRefreshErr(e); else { setErr(e); setTree(null); } } })
      .finally(() => { if (g === gen.current) setLoading(false); });
  };
  // 법인을 바꾸면 이전 법인의 화면(만들기·상세·창)과 안내를 닫는다 · 버그 점검 W17: 목록에서 확인되지 않은 법인은 읽지 않는다
  const vcKnown = options.some((o) => o.id === vc);
  useEffect(() => { saveVc(vc); treeRef.current = null; setTree(null); setRefreshErr(null); setView({ kind: 'list' }); setRunOf(null); setFireOf(null); setMsg(null); if (vcKnown) load(); }, [vc, vcKnown]);   // eslint-disable-line react-hooks/exhaustive-deps
  // 실행·정리 중인 그룹이 있을 때만 다시 읽는다(결과 기록을 보려고) — 만들기 화면에서는 읽지 않는다(고르던 트리가 바뀌지 않게)
  const running = !!tree?.groups?.some((x) => x.running);
  useEffect(() => {
    if (!running || view.kind === 'edit') return undefined;
    const t = setTimeout(load, 4000);
    return () => clearTimeout(t);
  }, [running, tree, view.kind]);   // eslint-disable-line react-hooks/exhaustive-deps

  const groups = useMemo(() => tree?.groups || [], [tree]);
  const groupName = useMemo(() => { const m = new Map(groups.map((g) => [g.id, g.name])); return (id) => m.get(id) || ''; }, [groups]);
  const vms = useMemo(() => tree?.vms || [], [tree]);
  const byId = useMemo(() => new Map(vms.map((v) => [v.id, v])), [vms]);
  const writable = !!tree?.writable && !tree?.groupsLoadError && !tree?.registryLoadError;
  const mark = (id, on) => setBusy((b) => { const n = new Set(b); if (on) n.add(id); else n.delete(id); return n; });
  const sameVc = (v0) => vcRef.current === v0;

  const remove = async (g) => {
    if (!window.confirm(`‘${g.name}’ 그룹을 지울까요?\n그룹만 지웁니다 — VM ${g.vmIds.length}대의 백업 대상(잡)과 백업 데이터는 그대로 남습니다.`)) return;
    const v0 = vc; mark(g.id, true); setMsg(null);
    try {
      const r = await delJson(`${BASE}/groups/${enc(g.id)}`);
      if (r?.ok === false) throw new Error(r.reason || '지우지 못했습니다.');
      if (sameVc(v0)) { setMsg({ ok: true, text: `‘${g.name}’ 그룹을 지웠습니다(백업 대상은 남김).` }); setView({ kind: 'list' }); }
    } catch (e) { if (sameVc(v0)) setMsg({ ok: false, text: `오류: ${errText(e)}` }); } finally { mark(g.id, false); if (sameVc(v0)) load(); }
  };
  const run = async (g, level) => {
    const v0 = vc; setRunOf(null); mark(g.id, true); setMsg(null);
    try {
      const r = await postJson(`${BASE}/groups/${enc(g.id)}/run`, level ? { level } : {});
      if (r?.ok === false) throw new Error(r.reason || '실행하지 못했습니다.');
      if (sameVc(v0)) setMsg({ ok: true, text: `‘${g.name}’ 그룹 백업을 보냈습니다 — 결과는 그룹의 **실행 이력**에 곧 보입니다.` });
    } catch (e) { if (sameVc(v0)) setMsg({ ok: false, text: outcomeUnknown(e) ? `결과 모름: ${unknownOutcomeText('그룹 실행', e)}` : `오류: ${errText(e)}` }); } finally { mark(g.id, false); if (sameVc(v0)) load(); }
  };

  if (vcErr) return <ErrorBox error={vcErr} />;
  if (!vcs) return <Loading />;
  if (!options.length) {
    return <div className="card" style={{ padding: 14, fontSize: 13 }}>Director 에 묶인 법인(vCenter)이 없습니다 — <b>설정</b> 탭에서 법인별 Director 를 추가하고 vCenter 를 묶은 뒤 그룹을 만들 수 있습니다.</div>;
  }
  const sitesNote = tree && !tree.mapped ? `이 법인의 Director 매핑이 덜 됐습니다(${(tree.mappingMissing || []).join('·') || 'Director 없음'}) — 새 VM 은 등록되지 않습니다(설정 탭에서 채우세요).` : '';
  const current = view.groupId ? groups.find((x) => x.id === view.groupId) || null : null;

  const banners = (
    <>
      {msg && <div className={`banner ${msg.ok ? 'ok' : 'bad'}`} style={{ marginBottom: 10 }}><BoldText text={msg.text} /></div>}
      {err && <ErrorBox error={err} />}
      {refreshErr && tree && <div className="banner warn" style={{ marginBottom: 10 }}>새로 읽지 못했습니다({errText(refreshErr)}) — 아래는 마지막으로 읽은 값입니다. 새로고침을 눌러 다시 시도하세요.</div>}
      {tree?.groupsLoadError && <div className="banner bad" style={{ marginBottom: 10 }}>백업 그룹 원장을 읽지 못했습니다(손상본 보존) — 그룹 저장과 예약 실행을 멈췄습니다. 서비스 점검에서 확인하세요.</div>}
      {tree?.registryLoadError && <div className="banner bad" style={{ marginBottom: 10 }}>백업 대상 원장을 읽지 못했습니다(손상본 보존) — 그룹 저장·실행을 멈췄습니다.</div>}
      {sitesNote && <div className="banner warn" style={{ marginBottom: 10 }}>{sitesNote}</div>}
      {tree && !tree.writable && <div className="banner warn" style={{ marginBottom: 10 }}>조회 전용 범위입니다 — 이 법인의 그룹은 볼 수만 있습니다(쓰기 범위가 필요합니다).</div>}
    </>
  );

  return (
    <div>
      {view.kind === 'list' && (
        <CorpBar vc={vc} setVc={setVc} options={options} tree={tree} vms={vms} loading={loading} onReload={load} />
      )}
      {banners}
      {!tree && !err && <Loading />}

      {tree && view.kind === 'list' && (
        <GroupList tree={tree} groups={groups} byId={byId} q={q} setQ={setQ} writable={writable} busy={busy}
          onRun={setRunOf} onNew={(filter) => { setMsg(null); setView({ kind: 'edit', groupId: '', filter }); }}
          onEdit={(g) => { setMsg(null); setView({ kind: 'edit', groupId: g.id }); }}
          onDetail={(g) => setView({ kind: 'detail', groupId: g.id })} />
      )}
      {tree && view.kind === 'edit' && (view.groupId === '' || current) && (
        <GroupEdit key={`${vc}:${view.groupId}`} tree={tree} group={current} initialFilter={view.filter || 'all'} vms={vms} byId={byId} groupName={groupName} writable={writable}
          onBack={() => setView(current ? { kind: 'detail', groupId: current.id } : { kind: 'list' })}
          onSaved={(text, ok, saved, v0) => { if (!sameVc(v0)) return; setMsg({ ok, text }); setView(saved ? { kind: 'detail', groupId: saved.id } : { kind: 'list' }); load(); }}
          onReload={(v0) => { if (sameVc(v0)) load(); }} vcNow={vc} />
      )}
      {tree && view.kind === 'detail' && current && (
        <GroupDetail tree={tree} g={current} byId={byId} writable={writable} busy={busy.has(current.id) || current.running}
          onBack={() => setView({ kind: 'list' })} onRun={() => setRunOf(current)} onEdit={() => { setMsg(null); setView({ kind: 'edit', groupId: current.id }); }}
          onDelete={() => remove(current)} onFire={() => setFireOf(current)} />
      )}
      {tree && view.kind !== 'list' && view.groupId && !current && (
        <div className="card" style={{ padding: 14, fontSize: 13 }}>그룹을 찾을 수 없습니다(지워졌을 수 있습니다). <button type="button" className="logout-btn" style={BTN} onClick={() => setView({ kind: 'list' })}>목록으로</button></div>
      )}

      {runOf && <RunModal g={runOf} onClose={() => setRunOf(null)} onRun={(lv) => run(runOf, lv)} />}
      {fireOf && <FireModal g={groups.find((x) => x.id === fireOf.id) || fireOf} onClose={() => setFireOf(null)} />}
    </div>
  );
}

/* ───────── ① 목록 ───────── */

function CorpBar({ vc, setVc, options, tree, vms, loading, onReload }) {
  const inGroup = vms.filter((v) => v.groupId).length;
  const m = memberResults(vms.filter((v) => v.groupId));
  const dir = tree?.director;
  return (
    <section className="card" style={{ padding: '12px 14px', marginBottom: 12, display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 10, minWidth: 0 }}>
      <div style={{ ...ROW }}>
        <span className="muted" style={{ fontSize: 12 }}>법인 (vCenter = Bareos Director)</span>
        <Select className="input" value={vc} onChange={(e) => setVc(e.target.value)} style={{ minWidth: 0, flex: '1 1 260px', maxWidth: 440 }} aria-label="법인 vCenter">
          {options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
        </Select>
        {dir && <span style={{ fontSize: 12, color: dir.ready ? TONE.ok : TONE.warn }}>● Director {dir.name}{dir.via === 'edge' ? ' · 엣지 대행' : ''}{dir.ready ? '' : ` · 접속값 없음(${(dir.missing || []).join('·') || '설정 확인'})`}</span>}
        <button type="button" className="logout-btn" style={{ ...BTN, marginLeft: 'auto' }} disabled={loading} onClick={onReload}>{loading ? '읽는 중…' : '새로고침'}</button>
      </div>
      {tree && (
        <div style={{ ...ROW, gap: 16, fontSize: 13 }}>
          <span>전체 VM <b>{vms.length}</b></span>
          <span>그룹에 속함 <b>{inGroup}</b></span>
          <span>그룹 없음 <b style={{ color: vms.length - inGroup ? TONE.warn : undefined }}>{vms.length - inGroup}</b></span>
          <span className="muted">그룹 VM 마지막 결과 <b style={{ color: TONE.ok }}>성공 {m.ok + m.warn}</b> · <b style={{ color: m.fail ? TONE.bad : undefined }}>실패 {m.fail}</b> · <b style={{ color: m.run ? TONE.run : undefined }}>진행 {m.run}</b>{m.never ? ` · 기록 없음 ${m.never}` : ''}</span>
        </div>
      )}
    </section>
  );
}

function GroupList({ tree, groups, byId, q, setQ, writable, busy, onRun, onNew, onEdit, onDetail }) {
  const needle = q.trim().toLowerCase();
  const shown = needle
    ? groups.filter((g) => g.name.toLowerCase().includes(needle) || g.vmIds.some((id) => String(byId.get(id)?.name || '').toLowerCase().includes(needle)))
    : groups;
  const noGroup = (tree.vms || []).filter((v) => !v.groupId && !v.gone).length;
  return (
    <>
      <div style={{ ...ROW, marginBottom: 12 }}>
        <b style={{ fontSize: 15 }}>백업 그룹 {groups.length}개</b>
        <span className="muted" style={{ fontSize: 12, flex: '1 1 260px', minWidth: 0 }}>VM 하나는 그룹 하나에만 들어갑니다 · 스케줄은 포탈이 실행합니다(시각은 포탈 서버 시각{tree.tz ? ` ${tree.tz}` : ''})</span>
        <input className="input" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="그룹 · VM 이름 검색" aria-label="그룹 검색" style={{ flex: '1 1 180px', minWidth: 0, maxWidth: 260 }} />
        <button type="button" className="login-btn" style={{ flex: 'none', padding: '8px 16px' }} disabled={!writable} onClick={() => onNew('all')}>＋ 새 그룹</button>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 360px), 1fr))', gap: 12 }}>
        {shown.map((g) => <GroupCard key={g.id} g={g} tree={tree} byId={byId} writable={writable} busy={busy.has(g.id) || g.running} onRun={() => onRun(g)} onEdit={() => onEdit(g)} onDetail={() => onDetail(g)} />)}
        {!needle && noGroup > 0 && (
          <button type="button" onClick={() => onNew('nogroup')} disabled={!writable}
            style={{ textAlign: 'left', border: '1.5px dashed var(--border)', borderRadius: 12, background: 'transparent', color: 'var(--text)', padding: 16, cursor: writable ? 'pointer' : 'default', font: 'inherit', display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 8, alignContent: 'start', minHeight: 150 }}>
            <b style={{ fontSize: 15 }}>그룹에 없는 VM {noGroup}대</b>
            <span className="muted" style={{ fontSize: 12.5, lineHeight: 1.5 }}>이 법인 vCenter 의 VM 중 어느 백업 그룹에도 들어 있지 않은 VM 입니다 — 폴더에서 골라 새 그룹을 만드세요.</span>
            <span style={{ color: '#93c5fd', fontWeight: 700, fontSize: 13 }}>폴더에서 VM 고르기 →</span>
          </button>
        )}
      </div>
      {groups.length === 0 && <div className="muted" style={{ marginTop: 12, fontSize: 13 }}>아직 그룹이 없습니다 — <b>새 그룹</b> 을 눌러 폴더에서 VM 을 고르세요.</div>}
      {needle && shown.length === 0 && <div className="muted" style={{ marginTop: 12, fontSize: 13 }}>‘{q.trim()}’ 에 맞는 그룹이 없습니다.</div>}
    </>
  );
}

function GroupCard({ g, tree, byId, writable, busy, onRun, onEdit, onDetail }) {
  const rows = g.vmIds.map((id) => byId.get(id)).filter(Boolean);
  const size = sizeSum(rows);
  const badge = g.running ? { text: g.pruning ? '보관 정리 중' : '실행 중', tone: 'run' } : resultBadge(memberResults(rows));
  const sp = scheduleParts(g.schedule);
  const kp = keepParts(g);
  const warn = g.clockAhead ? '서버 시계가 마지막 처리 회차보다 뒤에 있습니다 — 그 회차까지 예약 실행이 돌지 않습니다.'
    : g.sending && !g.running ? '실행을 보내는 도중 포탈이 재시작했습니다 — 일부 VM 은 보내지 않았을 수 있습니다.'
      : g.missed ? `돌리지 않은 회차 ${g.missed.key}(${missedReason(g.missed)})` : '';
  return (
    <article className="card" style={{ padding: 14, display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 12, minWidth: 0, alignContent: 'start' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, minWidth: 0 }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <button type="button" onClick={onDetail} style={{ background: 'none', border: 0, padding: 0, color: 'var(--text)', font: 'inherit', fontSize: 16, fontWeight: 800, cursor: 'pointer', textAlign: 'left', overflowWrap: 'anywhere' }}>{g.name}</button>
          <div className="muted" style={{ fontSize: 12, marginTop: 2, overflowWrap: 'anywhere' }}>VM {g.vmIds.length}대 · {folderSummary(rows)} · 용량 {fmtGb(size.gb)}{size.unknown ? ` (모름 ${size.unknown}대 제외)` : ''}</div>
        </div>
        <Badge tone={badge.tone}>{badge.text}</Badge>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 10, padding: '10px 0', borderTop: '1px solid var(--border-soft)', borderBottom: '1px solid var(--border-soft)' }}>
        <Cell label="스케줄" main={sp.main} sub={sp.sub} />
        <Cell label="보관" main={kp.main} sub={kp.sub} tone={kp.bad ? 'bad' : undefined} />
        <Cell label="다음 실행" main={g.next ? shortTs(g.next.at) : '—'} sub={g.next ? g.next.level : (g.schedule?.enabled ? '—' : '스케줄 꺼짐')} />
      </div>
      <div style={{ ...ROW, gap: 6 }}>
        <button type="button" className="login-btn" style={{ flex: 'none', padding: '6px 14px', fontSize: 12.5 }} disabled={!writable || busy} onClick={onRun}>{g.running ? (g.pruning ? '정리 중' : '실행 중') : '지금 백업'}</button>
        <button type="button" className="logout-btn" style={BTN} onClick={onDetail}>상세</button>
        <button type="button" className="logout-btn" style={BTN} disabled={!writable || busy} onClick={onEdit}>수정</button>
        <span style={{ fontSize: 11.5, marginLeft: 'auto', minWidth: 0, overflowWrap: 'anywhere', color: warn ? TONE.warn : 'var(--text-dim)' }}>
          {warn || `스토리지 ${g.storage || `기본${tree.siteDefaults?.storage ? `(${tree.siteDefaults.storage})` : ''}`} · 풀 ${g.pool || `기본${tree.siteDefaults?.pool ? `(${tree.siteDefaults.pool})` : ''}`}`}
        </span>
      </div>
    </article>
  );
}

/* ───────── ② 만들기 · 수정 ───────── */

/** 저장 결과 → 한 줄 안내(BoldText — 값 인용은 ‘ ’). */
function savedText(r, isNew) {
  const g = r.group;
  const reg = (r.registered || []).filter((x) => x.ok).length;
  const parts = [`‘${g.name}’ 그룹을 ${isNew ? '만들었습니다' : '저장했습니다'} — VM ${g.vmIds.length}대 · ${g.scheduleText} · ${g.keepText || keepText(g.keep ?? null)}`];
  if (reg) parts.push(`새로 등록한 백업 대상 ${reg}대(Director 스케줄 없음)`);
  if (r.excluded?.length) parts.push(`**등록하지 못해 뺀 VM ${r.excluded.length}대**`);
  if (r.doubleScheduled?.length) parts.push(`**Director 스케줄이 있는 잡 ${r.doubleScheduled.length}대 — 그룹 스케줄과 함께 두 번 돕니다**`);
  return parts.join(' · ');
}

function GroupEdit({ tree, group, initialFilter, vms, byId, groupName, writable, onBack, onSaved, onReload, vcNow }) {
  const editingId = group?.id || '';
  const [name, setName] = useState(group?.name || '');
  const [sched, setSched] = useState(() => (group ? { ...group.schedule } : { ...NEW_SCHEDULE }));
  const [keep, setKeep] = useState(() => (group ? group.keep ?? null : NEW_GROUP_KEEP));   // v2.831.1 사용자 결정: 새 그룹은 제한 없음
  const [otp, setOtp] = useState('');
  const [serverOtp, setServerOtp] = useState(null);   // 서버가 needOtp 로 돌려준 까닭(화면 판정과 어긋날 때 칸을 연다)
  const [storage, setStorage] = useState(group?.storage || '');
  const [pool, setPool] = useState(group?.pool || '');
  const [sel, setSel] = useState(() => new Set(group?.vmIds || []));
  const [filter, setFilter] = useState(initialFilter);
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(null);
  const [opts, setOpts] = useState(null);
  const [optsErr, setOptsErr] = useState('');
  const [saving, setSaving] = useState('');   // '' · 'save' · 'run'
  const [result, setResult] = useState(null);   // 실패 응답(사유 · 등록 결과)
  const v0 = useRef(vcNow).current;
  useEffect(() => {
    let live = true;
    // 버그 점검 W10: Director 에 닿는 조회 — 자동 재시도 없음 · 시한은 서버 값(엣지 대행이면 인출 + 회신, 숫자를 박지 않는다)
    const viaEdge = tree.director?.via === 'edge';
    fetchJson(`${BASE}/groups/options`, { vcenterId: tree.vcenterId }, undefined, { retries: 0, timeoutMs: (viaEdge && relayWaitMs(tree.relayLimits, 'catalog')) || 60_000 })
      .then((r) => { if (live) setOpts(r); })
      .catch((e) => { if (live) setOptsErr(errText(e)); });
    return () => { live = false; };
  }, [tree.vcenterId]);   // eslint-disable-line react-hooks/exhaustive-deps -- 화면을 열 때 한 번만(목록 재조회로 tree 가 바뀌어도 Director 에 다시 닿지 않게)

  const counts = useMemo(() => groupFilterCounts(vms, editingId), [vms, editingId]);
  const built = useMemo(() => buildGroupTree(vms, { filter, q, editingId, groupName }), [vms, filter, q, editingId, groupName]);
  useEffect(() => { if (built && open === null) setOpen(initialBareosOpen(built)); }, [built, open]);
  const forceOpen = !!q.trim() || filter !== 'all';
  const flat = useMemo(() => flattenBareosTree(built, open || new Set(), forceOpen), [built, open, forceOpen]);
  // 고른 VM 중 지금 고를 수 없게 된 것(다른 그룹에 들어감·목록에서 사라짐)은 뺀다
  useEffect(() => {
    setSel((s) => { const n = new Set([...s].filter((id) => byId.has(id) && pickable(byId.get(id), { editingId, groupName }).ok)); return n.size === s.size ? s : n; });
  }, [byId, editingId, groupName]);
  const toggleSel = (ids, on) => setSel((s) => { const n = new Set(s); for (const id of ids) { if (on) n.add(id); else n.delete(id); } return n; });
  const toggleOpen = (key) => setOpen((s) => { const n = new Set(s || []); if (n.has(key)) n.delete(key); else n.add(key); return n; });

  const vmIds = [...sel];
  const members = vmIds.map((id) => byId.get(id)).filter(Boolean);
  const size = sizeSum(members);
  const toRegister = members.filter((m) => !m.job).length;
  const doubled = sched.enabled ? members.filter((m) => m.job?.schedule) : [];
  // 반증 F5: 보관 개수가 있는 그룹에 이력이 있는 VM 을 더하면 그 VM 의 예전 백업도 정리 대상이 된다 — 미리 알린다
  const addedWithHistory = members.filter((m) => !(group?.vmIds || []).includes(m.id) && m.job && m.b?.ok != null).length;
  // v2.831.1 사용자 결정: 지울 범위가 넓어지는 저장(보관 개수를 정함·줄임·기존 잡 VM 추가)은 본인 OTP — 서버가 다시 판정한다
  const otpReasons = keepOtpReasons(group, { keep, vmIds }, (id) => !!byId.get(id)?.job);
  const needOtp = otpReasons.length > 0 || !!serverOtp?.length;
  const issues = draftIssues({ name, vmIds, schedule: sched }, { maxMembers: tree.limits?.maxMembers || 200 });
  // 서버 precheck 와 같은 상한(API 값) — 넘으면 저장 버튼을 열지 않는다(눌러 봐야 400)
  if (tree.limits?.maxBulk && toRegister > tree.limits.maxBulk) issues.push(`잡이 없는 VM 은 한 번에 ${tree.limits.maxBulk}대까지 등록할 수 있습니다(지금 ${toRegister}대) — 나눠서 저장하세요.`);
  else if (tree.limits?.jobsLeft != null && toRegister > tree.limits.jobsLeft) issues.push(`백업 대상을 ${tree.limits.jobsLeft}대만 더 등록할 수 있습니다(지금 ${toRegister}대).`);
  const lim = tree.keepLimits || { min: 1, max: 365, presets: KEEP_PRESETS };
  // 새 VM 등록이 들어가면 Director 응답을 기다린다 — 서버가 기다리는 시간(API 값)만큼(v2.830 검토 M3 — 숫자를 박지 않는다)
  const waitMs = toRegister > 0 ? relayWaitMs(tree.relayLimits, 'addJobs') : null;

  const save = async (runAfter) => {
    setSaving(runAfter ? 'run' : 'save'); setResult(null);
    const body = { name, vmIds, schedule: sched, storage, pool, keep, ...(needOtp ? { otp } : {}), ...(group ? { updatedAt: group.updatedAt } : {}) };
    const o = waitMs ? { timeoutMs: waitMs } : {};
    let r;
    try {
      r = group ? await putJson(`${BASE}/groups/${enc(group.id)}`, body, o) : await postJson(`${BASE}/groups`, { ...body, vcenterId: tree.vcenterId }, o);
    } catch (e) {
      setSaving('');
      // 브라우저 시한·504 — 서버는 등록·저장을 끝냈을 수 있다(실패로 단정하지 않는다) — 목록으로 돌아가 새로 읽는다
      if (outcomeUnknown(e)) { onSaved(`결과 모름: ${unknownOutcomeText('그룹 저장', e)}`, false, null, v0); return; }
      setResult({ reason: errText(e), ...(e?.body || {}) });
      if (e?.body?.needOtp) { setServerOtp(e.body.reasons || ['본인 OTP 필요']); setOtp(''); }
      return;
    }
    if (!r?.ok) {
      setSaving('');
      if (r?.needOtp) { setServerOtp(r.reasons || ['본인 OTP 필요']); setOtp(''); }   // 쓴(또는 틀린) 코드를 남기면 다시 누를 때 실패 횟수만 오른다
      // 버그 점검 W9: 거부돼도 서버가 VM 을 등록했을 수 있다 — 목록을 다시 읽는다. 다른 화면이 먼저 고쳤으면(409) 목록으로
      if (r?.conflict) { onSaved(`${r.reason} 목록을 새로 읽었습니다 — 다시 ‘수정’ 을 눌러 주세요.`, false, null, v0); return; }
      setResult(r || { reason: '저장하지 못했습니다.' });
      onReload?.(v0);
      return;
    }
    let text = savedText(r, !group);
    let ok = true;
    if (runAfter) {
      try {
        const rr = await postJson(`${BASE}/groups/${enc(r.group.id)}/run`, {});
        if (rr?.ok === false) throw new Error(rr.reason || '실행하지 못했습니다.');
        text += ' · **지금 백업을 보냈습니다**(결과는 실행 이력에)';
      } catch (e) { ok = false; text += ` · 저장은 됐지만 백업을 보내지 못했습니다: ${outcomeUnknown(e) ? unknownOutcomeText('그룹 실행', e) : errText(e)}`; }
    }
    setSaving('');
    onSaved(text, ok, r.group, v0);
  };
  const dayBtn = (k, day, on) => (
    <button key={`${k}${day}`} type="button" aria-pressed={on} onClick={() => setSched((s) => toggleDay(s, day, k))}
      style={{ padding: '6px 0', minWidth: 38, borderRadius: 8, border: `1px solid ${on ? '#3b82f6' : 'var(--border)'}`, background: on ? '#3b82f6' : 'var(--panel-deep)', color: on ? '#fff' : 'var(--text-dim)', font: 'inherit', fontWeight: 700, cursor: 'pointer' }}>{DAY_NAMES[day]}</button>
  );
  const seg = (on) => ({ padding: '7px 16px', borderRadius: 8, border: `1px solid ${on ? '#22d3ee' : 'var(--border)'}`, background: on ? '#22d3ee' : 'var(--panel-deep)', color: on ? '#07202a' : 'var(--text-dim)', font: 'inherit', fontWeight: 800, cursor: 'pointer' });
  const daily = isDaily(sched);
  const disabledAll = !writable || !!saving;

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 12 }}>
      <div style={{ ...ROW, gap: 12 }}>
        <BackLink onClick={onBack} />
        <h2 style={{ margin: 0, fontSize: 20, fontWeight: 800 }}>{group ? `정책 수정 — ${group.name}` : '새 백업 그룹'}</h2>
        <span className="muted" style={{ fontSize: 12.5 }}>법인 <b style={{ color: 'var(--text)' }}>{tree.vcName}</b>{tree.director ? ` → Bareos ${tree.director.name}` : ''}</span>
        <span className="muted" style={{ fontSize: 12, marginLeft: 'auto' }}>① VM 고르기 → ② 정책 정하기 → ③ 저장</span>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'flex-start' }}>
        {/* 왼쪽: 폴더 트리 */}
        <section className="card" aria-label="vCenter 폴더에서 VM 고르기" style={{ flex: '3 1 560px', minWidth: 0, padding: 0, overflow: 'hidden' }}>
          <div style={{ ...ROW, padding: '10px 14px', borderBottom: '1px solid var(--border-soft)' }}>
            <b>{tree.vcName} 폴더 › VM</b>
            <span className="muted" style={{ fontSize: 12 }}>전체 {vms.length}대 · 그룹 없음 {counts.nogroup}대</span>
            <div className="flex wrap" role="group" aria-label="보기" style={{ gap: 4 }}>
              {GROUP_FILTERS.map(([k, l]) => (
                <button key={k} type="button" className={`tab${filter === k ? ' active' : ''}`} aria-pressed={filter === k} onClick={() => setFilter(k)} style={{ padding: '4px 10px', fontSize: 12 }}>{l} {counts[k]}</button>
              ))}
            </div>
            <input className="input" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="VM · 폴더 검색" aria-label="VM · 폴더 검색" style={{ flex: '1 1 150px', minWidth: 0, maxWidth: 240 }} />
          </div>
          <div style={{ ...ROW, padding: '8px 14px', background: sel.size ? 'rgba(59,130,246,.12)' : 'var(--panel-deep)', borderBottom: '1px solid var(--border-soft)' }}>
            <b style={{ fontSize: 14 }}>{sel.size}대 선택</b>
            <span className="muted" style={{ fontSize: 12 }}>{fmtGb(size.gb)}{size.unknown ? ` (용량 모름 ${size.unknown}대)` : ''} · 오른쪽 정책이 이 VM 들에 적용됩니다</span>
            {sel.size > 0 && <button type="button" className="logout-btn" style={{ ...BTN, marginLeft: 'auto' }} onClick={() => setSel(new Set())}>선택 해제</button>}
          </div>
          {/* 트리는 자기 스크롤(세로 62vh) — VM 수백 대를 내려도 선택 바가 보인다 · 열 제목은 그 안에 고정 */}
          <div style={{ overflow: 'auto', maxHeight: '62vh' }}>
            <div role="treegrid" aria-label="폴더 › VM — 그룹에 넣을 VM 고르기" style={{ minWidth: 600, fontSize: 13 }}>
              <div role="row" style={{ display: 'grid', gridTemplateColumns: GRID, background: 'var(--panel-deep)', color: 'var(--text-dim)', fontSize: 12, fontWeight: 600, position: 'sticky', top: 0, zIndex: 1 }}>
                <div role="columnheader" style={{ padding: '9px 0 9px 12px' }} aria-label="선택" />
                <div role="columnheader" style={{ padding: '9px 6px' }}>폴더 › VM</div>
                <div role="columnheader" style={{ padding: '9px 6px' }}>전원</div>
                <div role="columnheader" style={{ padding: '9px 10px 9px 6px', textAlign: 'right' }}>용량</div>
                <div role="columnheader" style={{ padding: '9px 14px 9px 6px' }}>현재 그룹 · 마지막 백업</div>
              </div>
              {flat.length === 0 && <div className="muted" style={{ padding: 14 }}>{vms.length ? '조건에 맞는 VM 이 없습니다.' : '이 법인의 인벤토리에 VM 이 없습니다.'}</div>}
              {flat.map((row) => {
                const pad = 6 + row.depth * 20;
                if (row.kind === 'folder') {
                  const ids = row.node.pickIds || [];
                  const st = checkState(ids, sel);
                  return (
                    <div role="row" key={row.key} aria-expanded={row.open} style={{ display: 'grid', gridTemplateColumns: GRID, alignItems: 'center', borderTop: '1px solid var(--border-soft)', background: row.depth === 0 ? 'rgba(251,146,60,.06)' : 'rgba(251,146,60,.03)' }}>
                      <div role="gridcell" style={{ paddingLeft: 12 }}><TriCheck state={st} disabled={disabledAll || !ids.length} label={`${row.node.name} 폴더의 VM ${ids.length}대 모두 고르기`} onChange={() => toggleSel(ids, st !== 'all')} /></div>
                      <div role="gridcell" style={{ minWidth: 0, paddingLeft: pad }}>
                        <button type="button" onClick={() => toggleOpen(row.node.key)} disabled={forceOpen} style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', minHeight: 38, padding: '0 8px 0 0', background: 'none', border: 0, color: 'var(--text)', font: 'inherit', cursor: forceOpen ? 'default' : 'pointer', textAlign: 'left' }}>
                          <span className="muted" style={{ width: 12 }}>{row.open ? '▾' : '▸'}</span>
                          <FolderIcon />
                          <b title={row.node.name} style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.node.name}</b>
                          <span className="muted" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>{row.node.agg.n} VM</span>
                        </button>
                      </div>
                      <div role="gridcell" />
                      <div role="gridcell" style={{ padding: '0 10px 0 6px', textAlign: 'right', fontSize: 12, fontVariantNumeric: 'tabular-nums' }}><b>{fmtGb(row.node.agg.gb)}</b></div>
                      <div role="gridcell" style={{ padding: '0 14px 0 6px', fontSize: 12, color: 'var(--text-dim)' }}>{ids.length ? `고를 수 있음 ${ids.length}` : '고를 VM 없음'}</div>
                    </div>
                  );
                }
                const r = row.row;
                const pk = pickable(r, { editingId, groupName });
                const on = sel.has(r.id);
                const b = r.b;
                const other = r.groupId && r.groupId !== editingId;
                return (
                  <label role="row" key={row.key} aria-selected={on} style={{ display: 'grid', gridTemplateColumns: GRID, alignItems: 'center', borderTop: '1px solid var(--border-soft)', background: on ? 'rgba(59,130,246,.12)' : undefined, cursor: pk.ok && !disabledAll ? 'pointer' : 'default', minHeight: 36 }} title={pk.ok ? undefined : pk.why}>
                    <div role="gridcell" style={{ paddingLeft: 12 }}><input type="checkbox" aria-label={`${r.name} 고르기`} checked={on} disabled={disabledAll || !pk.ok} onChange={() => toggleSel([r.id], !on)} style={{ width: 16, height: 16 }} /></div>
                    <div role="gridcell" style={{ minWidth: 0, paddingLeft: pad + 20, display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span title={r.name} style={{ fontWeight: 600, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: r.gone || other ? 'var(--text-dim)' : undefined }}>{r.name}</span>
                      {r.gone && <span className="muted" style={{ fontSize: 11 }}>인벤토리에 없음</span>}
                    </div>
                    <div role="gridcell" style={{ padding: '0 6px', fontSize: 12, color: r.power === 'POWERED_ON' ? TONE.ok : 'var(--text-dim)' }}>{r.power === 'POWERED_ON' ? '켜짐' : r.power ? '꺼짐' : '—'}</div>
                    <div role="gridcell" style={{ padding: '0 10px 0 6px', textAlign: 'right', fontSize: 12, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{fmtGb(r.gb)}</div>
                    <div role="gridcell" style={{ padding: '0 14px 0 6px', fontSize: 12, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {other ? <span style={{ color: '#fdba74' }}>‘{groupName(r.groupId) || '그룹'}’ 그룹</span>
                        : !r.job ? (r.eligible ? <span className="muted">잡 없음 — 저장 때 등록</span> : <span style={{ color: TONE.bad }}>등록 불가 — {r.reason}</span>)
                          : b?.st ? <span style={{ color: TONE[b.st === 'ok' ? 'ok' : b.st === 'warning' ? 'warn' : 'bad'] }}>{stText(b.st)} · {shortTs(b.at)}{r.job.schedule ? ` · Director 스케줄 ${r.job.schedule}` : ''}</span>
                            : <span style={{ color: TONE.warn }}>백업 기록 없음{r.job.schedule ? ` · Director 스케줄 ${r.job.schedule}` : ''}</span>}
                    </div>
                  </label>
                );
              })}
            </div>
          </div>
          <div className="muted" style={{ padding: '8px 14px', fontSize: 12, borderTop: '1px solid var(--border-soft)' }}>
            폴더 체크 = 그 아래 고를 수 있는 VM 전부 · 다른 그룹에 든 VM 은 잠깁니다(VM 하나는 그룹 하나) · 템플릿·vCLS 는 보이지 않습니다 · 잡 없는 VM 은 저장할 때 Director 스케줄 없이 등록됩니다.
          </div>
        </section>

        {/* 오른쪽: 정책 */}
        <aside aria-label="백업 정책" style={{ flex: '2 1 340px', minWidth: 0, display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 12 }}>
          <section className="card" style={{ padding: 14, display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 6, minWidth: 0 }}>
            <label htmlFor="bareos-group-name" style={{ fontWeight: 700, fontSize: 13.5 }}>그룹 이름</label>
            <input id="bareos-group-name" className="input" value={name} maxLength={60} disabled={disabledAll} onChange={(e) => setName(e.target.value)} placeholder="예: 그룹웨어 DB" style={{ fontSize: 15, fontWeight: 700, minWidth: 0 }} />
            <span className="muted" style={{ fontSize: 12 }}>같은 법인 안에서 하나뿐인 이름 · 나중에 바꿀 수 있습니다</span>
          </section>

          <section className="card" style={{ padding: 14, display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 10, minWidth: 0 }}>
            <SecTitle extra={(
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, cursor: 'pointer' }}>
                <input type="checkbox" checked={sched.enabled} disabled={disabledAll} onChange={(e) => setSched((s) => ({ ...s, enabled: e.target.checked }))} />사용
              </label>
            )}>백업 스케줄</SecTitle>
            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 10, opacity: sched.enabled ? 1 : 0.5 }}>
              <div role="group" aria-label="주기" style={{ display: 'flex', gap: 6 }}>
                <button type="button" aria-pressed={daily} disabled={disabledAll} style={seg(daily)} onClick={() => setSched((s) => setCadence(s, true))}>매일</button>
                <button type="button" aria-pressed={!daily} disabled={disabledAll} style={seg(!daily)} onClick={() => setSched((s) => setCadence(s, false))}>매주</button>
              </div>
              {!daily && <div role="group" aria-label="요일" style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>{[1, 2, 3, 4, 5, 6, 0].map((day) => dayBtn('days', day, sched.days.includes(day)))}</div>}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 8 }}>
                <label style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 4, fontSize: 12, color: 'var(--text-dim)' }}>실행 시각(포탈 서버 시각)
                  <input className="input" type="time" step={60} value={sched.time} disabled={disabledAll} onChange={(e) => setSched((s) => ({ ...s, time: e.target.value }))} style={{ fontSize: 14, minWidth: 0 }} />
                </label>
                <label style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 4, fontSize: 12, color: 'var(--text-dim)' }}>레벨
                  <Select className="input" sort={false} value={sched.level} disabled={disabledAll} onChange={(e) => setSched((s) => ({ ...s, level: e.target.value, fullDays: e.target.value === 'Full' ? [] : s.fullDays }))} aria-label="기본 레벨" style={{ minWidth: 0, fontSize: 14 }}>
                    {LEVELS.map((l) => <option key={l} value={l}>{l}</option>)}
                  </Select>
                </label>
              </div>
              {sched.level !== 'Full' && (
                <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 4 }}>
                  <span className="muted" style={{ fontSize: 12 }}>Full 로 돌릴 요일(실행 요일 안에서만)</span>
                  <div role="group" aria-label="Full 로 돌릴 요일" style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>{[1, 2, 3, 4, 5, 6, 0].filter((day) => sched.days.includes(day)).map((day) => dayBtn('fullDays', day, (sched.fullDays || []).includes(day)))}</div>
                </div>
              )}
            </div>
            <div style={{ background: 'var(--panel-deep)', borderRadius: 8, padding: '8px 12px', fontSize: 12.5 }}>미리 보기: <b>{scheduleText(sched)}</b>{tree.tz ? <span className="muted"> · {tree.tz}</span> : null}</div>
          </section>

          <section className="card" style={{ padding: 14, display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 10, minWidth: 0 }}>
            <SecTitle extra={(
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, cursor: 'pointer' }}>
                <input type="checkbox" checked={keep == null} disabled={disabledAll} onChange={(e) => setKeep(e.target.checked ? null : KEEP_DEFAULT)} />제한 없음
              </label>
            )}>보관 개수</SecTitle>
            {keep != null && (
              <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10 }}>
                <button type="button" className="logout-btn" aria-label="보관 개수 줄이기" disabled={disabledAll || keep <= lim.min} onClick={() => setKeep((k) => stepKeep(k, -1, lim))} style={{ width: 40, height: 40, padding: 0, fontSize: 18, fontWeight: 800 }}>−</button>
                <span aria-live="polite" style={{ minWidth: 48, textAlign: 'center', fontSize: 26, fontWeight: 800, fontVariantNumeric: 'tabular-nums' }}>{keep}</span>
                <button type="button" className="logout-btn" aria-label="보관 개수 늘리기" disabled={disabledAll || keep >= lim.max} onClick={() => setKeep((k) => stepKeep(k, 1, lim))} style={{ width: 40, height: 40, padding: 0, fontSize: 18, fontWeight: 800 }}>+</button>
                <div role="group" aria-label="자주 쓰는 값" style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                  {(lim.presets || KEEP_PRESETS).map((k) => <button key={k} type="button" aria-pressed={keep === k} disabled={disabledAll} onClick={() => setKeep(k)} style={seg(keep === k)}>{k}</button>)}
                </div>
              </div>
            )}
            <div style={{ fontSize: 12.5, lineHeight: 1.6 }}>
              {keep == null
                ? <>포탈은 백업을 지우지 않습니다 — {keepMeaning(null, sched)}</>
                : <>VM 마다 최근 <b>{keep}</b>회분의 성공 백업을 유지합니다({keepMeaning(keep, sched)}). 그보다 오래된 실행은 그룹 백업이 끝난 뒤 Bareos 카탈로그에서 지웁니다 — Incremental 이 기대는 Full 은 남깁니다.</>}
            </div>
            {keep != null && <div className="muted" style={{ fontSize: 11.5, lineHeight: 1.5 }}>카탈로그에서 지운 백업은 복원할 수 없습니다. 디스크 공간은 그 볼륨이 Bareos 풀 설정에 따라 재활용될 때 비워집니다. Director 의 보존 기간이 더 짧으면 그쪽이 먼저 지웁니다.</div>}
            {group && (group.keep ?? null) !== keep && keep != null && (group.keep == null || keep < group.keep) && (
              <div className="banner warn" style={{ fontSize: 12.5 }}>보관 개수를 {group.keep == null ? '처음 정하면' : `${group.keep} → ${keep} 로 줄이면`} 이 그룹의 다음 백업이 끝난 뒤 그보다 오래된 백업을 카탈로그에서 지웁니다.</div>
            )}
            {keep != null && addedWithHistory > 0 && (
              <div className="banner warn" style={{ fontSize: 12.5 }}>이미 백업 기록이 있는 VM {addedWithHistory}대를 더합니다 — 그룹 백업이 끝나면 이 VM 들의 예전 백업도 보관 개수({keep}회)에 맞춰 정리합니다.</div>
            )}
          </section>

          <section className="card" style={{ padding: 14, display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 8, minWidth: 0 }}>
            <b style={{ fontSize: 13.5 }}>저장 위치</b>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 8 }}>
              <label style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 4, fontSize: 12, color: 'var(--text-dim)', minWidth: 0 }}>스토리지(SD)
                <input className="input" list="bareos-group-storages" value={storage} disabled={disabledAll} onChange={(e) => setStorage(e.target.value.trim())} placeholder={tree.siteDefaults?.storage ? `기본(${tree.siteDefaults.storage})` : '잡 기본값'} aria-label="스토리지" style={{ minWidth: 0 }} />
              </label>
              <label style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 4, fontSize: 12, color: 'var(--text-dim)', minWidth: 0 }}>풀
                <input className="input" list="bareos-group-pools" value={pool} disabled={disabledAll} onChange={(e) => setPool(e.target.value.trim())} placeholder={tree.siteDefaults?.pool ? `기본(${tree.siteDefaults.pool})` : '잡 기본값'} aria-label="풀" style={{ minWidth: 0 }} />
              </label>
            </div>
            <DataList id="bareos-group-storages">{(opts?.storages || []).map((s) => <option key={s} value={s} />)}</DataList>
            <DataList id="bareos-group-pools">{(opts?.pools || []).map((s) => <option key={s} value={s} />)}</DataList>
            <span className="muted" style={{ fontSize: 12 }}>
              {optsErr ? `Director 목록을 읽지 못했습니다(${optsErr}) — 이름을 직접 적을 수 있습니다.`
                : !opts ? 'Director 의 스토리지·풀 목록을 읽는 중…'
                  : `비우면 잡 기본값 · Director 목록: 스토리지 ${Array.isArray(opts.storages) ? `${opts.storages.length}개` : '모름'} · 풀 ${Array.isArray(opts.pools) ? `${opts.pools.length}개` : '모름'} · 실행할 때마다 이 값으로 지정합니다(잡 정의는 바뀌지 않습니다).`}
            </span>
            {/* v2.830 검토 L5(추정 — 실환경 미확인): Job·JobDefs 의 레벨별 풀이 run 의 pool 지정보다 먼저일 수 있다 */}
            <span className="muted" style={{ fontSize: 11.5 }}>풀 참고: 잡 정의(JobDefs)에 레벨별 풀(Full·Incremental Backup Pool)이 있으면 Bareos 가 그 풀을 먼저 쓸 수 있습니다(실환경 확인 전).</span>
          </section>

          {needOtp && (
            <section className="card" style={{ padding: 14, display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 6, minWidth: 0, borderColor: 'rgba(245,158,11,.45)' }}>
              <b style={{ fontSize: 13.5 }}>본인 OTP 확인</b>
              <span style={{ fontSize: 12.5, lineHeight: 1.5 }}>이 저장은 그룹 백업이 끝난 뒤 오래된 백업을 지울 수 있어 본인 OTP 가 필요합니다 — {(otpReasons.length ? otpReasons : serverOtp || []).join(' · ')}</span>
              <label style={{ display: 'grid', gap: 4, fontSize: 12, color: 'var(--text-dim)', maxWidth: 220 }}>OTP(6자리)
                <input className="input" inputMode="numeric" autoComplete="one-time-code" value={otp} disabled={disabledAll} onChange={(e) => setOtp(e.target.value.replace(/\D/g, '').slice(0, 6))} aria-label="본인 OTP 6자리" style={{ minWidth: 0, fontSize: 15, letterSpacing: 2 }} />
              </label>
            </section>
          )}
          {toRegister > 0 && <div className="muted" style={{ fontSize: 12.5 }}>저장하면 잡이 없는 {toRegister}대를 백업 대상으로 등록합니다(Director 스케줄 없이 — 그룹이 실행).</div>}
          {doubled.length > 0 && (
            <div className="banner warn" style={{ fontSize: 12.5 }}>
              Director 스케줄이 있는 잡 {doubled.length}대({doubled.slice(0, 3).map((m) => m.name).join(', ')}{doubled.length > 3 ? ' …' : ''}) — 그룹 스케줄과 함께면 두 번 백업됩니다.
              Bareos 에는 잡의 스케줄을 바꾸는 콘솔 명령이 없어 포탈이 대신 고치지 않습니다. 이 VM 들을 빼거나, 그룹 스케줄을 끄거나, 백업 대상 탭에서 지운 뒤 그룹으로 다시 등록하세요.
            </div>
          )}
          {result && (
            <div className="banner bad" style={{ fontSize: 12.5 }}>
              <div>{result.reason || '저장하지 못했습니다.'}</div>
              {(result.registered || []).some((x) => x.ok) && <div style={{ marginTop: 4 }}>이번에 백업 대상으로 등록된 VM {result.registered.filter((x) => x.ok).length}대는 남아 있습니다(백업 대상 탭).</div>}
              {(result.excluded || []).length > 0 && <div style={{ marginTop: 4 }}>등록하지 못한 VM: {result.excluded.slice(0, 10).map((x) => `${byId.get(x.vmId)?.name || x.vmId}(${x.reason})`).join(' · ')}{result.excluded.length > 10 ? ` 외 ${result.excluded.length - 10}대` : ''}</div>}
            </div>
          )}
          {issues.length > 0 && <div className="muted" style={{ fontSize: 12 }}>{issues.join(' · ')}</div>}
          {issues.length === 0 && needOtp && !/^\d{6}$/.test(otp) && <div className="muted" style={{ fontSize: 12 }}>본인 OTP 6자리를 입력하면 저장할 수 있습니다.</div>}
          {saving && <div className="muted" style={{ fontSize: 12 }}>저장 중 — 새 VM 등록은 Director 응답을 기다립니다(엣지 대행 법인은 몇 분 걸릴 수 있습니다)</div>}
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 8 }}>
            <button type="button" className="login-btn" style={{ padding: '11px 16px', fontSize: 14, fontWeight: 800 }} disabled={disabledAll || issues.length > 0 || (needOtp && !/^\d{6}$/.test(otp))} onClick={() => save(true)}>
              {saving === 'run' ? '저장 · 백업 보내는 중…' : `저장하고 지금 백업 (${vmIds.length}대)`}
            </button>
            <div style={{ display: 'flex', gap: 8 }}>
              <button type="button" className="logout-btn" style={{ flex: 1, padding: '9px 12px' }} disabled={disabledAll || issues.length > 0 || (needOtp && !/^\d{6}$/.test(otp))} onClick={() => save(false)}>{saving === 'save' ? '저장 중…' : '저장만'}</button>
              <button type="button" className="logout-btn" style={{ flex: 1, padding: '9px 12px' }} disabled={!!saving} onClick={onBack}>취소</button>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}

/* ───────── ③ 상세 ───────── */

function GroupDetail({ tree, g, byId, writable, busy, onBack, onRun, onEdit, onDelete, onFire }) {
  const rows = g.vmIds.map((id) => byId.get(id) || { id, name: id, folder: '', missing: true });
  const size = sizeSum(rows.filter((r) => !r.missing));
  const badge = g.running ? { text: g.pruning ? '보관 정리 중' : '실행 중', tone: 'run' } : resultBadge(memberResults(rows.filter((r) => !r.missing)));
  const sp = scheduleParts(g.schedule);
  const kp = keepParts(g);
  const fires = Array.isArray(g.fires) ? g.fires : [];
  const p = g.lastPrune;
  const slots = g.keep != null ? Math.min(g.keep, 30) : 0;
  const filled = p && p.keptMin != null ? Math.min(slots, p.keptMin) : 0;
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 12 }}>
      <div style={{ ...ROW, gap: 12 }}>
        <BackLink onClick={onBack} />
        <h2 style={{ margin: 0, fontSize: 22, fontWeight: 800, overflowWrap: 'anywhere' }}>{g.name}</h2>
        <Badge tone={badge.tone}>{badge.text}</Badge>
        <div style={{ ...ROW, gap: 6, marginLeft: 'auto' }}>
          <button type="button" className="login-btn" style={{ flex: 'none', padding: '8px 16px' }} disabled={!writable || busy} onClick={onRun}>{g.running ? (g.pruning ? '정리 중' : '실행 중') : '지금 백업'}</button>
          <button type="button" className="logout-btn" style={BTN} disabled={!writable || busy} onClick={onEdit}>정책 수정</button>
          <button type="button" className="logout-btn" style={{ ...BTN, color: TONE.bad }} disabled={!writable || busy} onClick={onDelete}>그룹 삭제</button>
        </div>
      </div>
      <div className="muted" style={{ fontSize: 12.5, marginTop: -6 }}>법인 {tree.vcName}{tree.director ? ` → Bareos ${tree.director.name}` : ''} · 만든 사람 {g.createdBy || '—'} · {shortTs(g.createdAt)}{g.updatedAt !== g.createdAt ? ` · 고친 사람 ${g.updatedBy || '—'} · ${shortTs(g.updatedAt)}` : ''}</div>
      {g.missed && <div className="banner warn" style={{ fontSize: 12.5 }}>돌리지 않은 회차 {g.missed.key} — {missedReason(g.missed)}</div>}
      {g.clockAhead && <div className="banner warn" style={{ fontSize: 12.5 }}>마지막 처리 회차({g.lastKey})가 지금 서버 시각보다 뒤입니다 — 서버 시계를 확인하세요. 그 회차까지 예약 실행이 돌지 않습니다.</div>}
      {g.sending && !g.running && <div className="banner warn" style={{ fontSize: 12.5 }}>{g.sending.key || '수동'} 실행을 보내는 도중 포탈이 재시작했습니다 — 일부 VM 은 보내지 않았을 수 있습니다(백업 대상 탭에서 확인).</div>}
      {p?.errors?.length > 0 && (
        <div className="banner bad" style={{ fontSize: 12.5 }}>
          마지막 보관 정리({shortTs(p.at)})에서 실패가 있었습니다 — {p.errors.slice(0, 5).map((e) => `${e.vmName ? `${e.vmName}: ` : ''}${e.reason}`).join(' · ')}{p.errors.length > 5 ? ` 외 ${p.errors.length - 5}건` : ''}. 지우지 못한 것은 다음 정리 때 다시 봅니다.
        </div>
      )}

      <section aria-label="정책 요약" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 220px), 1fr))', gap: 12 }}>
        <Box label="스케줄" main={sp.main} sub={`${sp.sub} · 포탈이 실행`} />
        <Box label="다음 실행" main={g.next ? shortTs(g.next.at) : '—'} sub={g.next ? `${g.next.level}${untilText(g.next.at - (tree.now || Date.now())) ? ` · ${untilText(g.next.at - (tree.now || Date.now()))}` : ''}` : (g.schedule?.enabled ? '—' : '스케줄 꺼짐 — 수동 실행만')} />
        <Box label="보관" main={kp.main} sub={kp.sub}>
          {slots > 0 && (
            <div role="img" aria-label={`보관 ${g.keep}개 중 ${p?.keptMin ?? '모름'}개 보유`} style={{ display: 'flex', gap: 2, margin: '4px 0' }}>
              {Array.from({ length: slots }, (_, i) => <span key={i} style={{ flex: 1, height: 8, borderRadius: 2, background: i < filled ? '#22d3ee' : 'var(--border)' }} />)}
            </div>
          )}
        </Box>
        <Box label="저장 위치 · VM 용량" main={fmtGb(size.gb)} sub={`스토리지 ${g.storage || `기본${tree.siteDefaults?.storage ? `(${tree.siteDefaults.storage})` : ''}`} · 풀 ${g.pool || `기본${tree.siteDefaults?.pool ? `(${tree.siteDefaults.pool})` : ''}`} · VM 용량 합(백업 사용량 아님)${size.unknown ? ` · 모름 ${size.unknown}대 제외` : ''}`} />
      </section>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'flex-start' }}>
        <section className="card" aria-label="멤버 VM" style={{ flex: '3 1 560px', minWidth: 0, padding: 0, overflow: 'hidden' }}>
          <div style={{ ...ROW, padding: '10px 14px', borderBottom: '1px solid var(--border-soft)' }}>
            <b>멤버 VM {g.vmIds.length}대</b>
            <span className="muted" style={{ fontSize: 12 }}>{folderSummary(rows.filter((r) => !r.missing))} · 용량 {fmtGb(size.gb)}</span>
            {writable && <button type="button" className="logout-btn" style={{ ...BTN, marginLeft: 'auto' }} disabled={busy} onClick={onEdit}>VM 더하기 · 빼기</button>}
          </div>
          <STable minWidth={640} limit={200}>
            <thead><tr><th>VM</th><th>폴더</th><th>전원</th><th className="right">용량</th><th>마지막 백업</th><th>결과</th></tr></thead>
            <tbody>
              {rows.map((r) => {
                const b = r.b;
                const tone = b?.run ? 'run' : b?.st === 'ok' ? 'ok' : b?.st === 'warning' ? 'warn' : b?.st ? 'bad' : 'muted';
                return (
                  <tr key={r.id}>
                    <td style={{ whiteSpace: 'normal', overflowWrap: 'anywhere' }}><b>{r.name}</b>{r.missing && <span style={{ color: TONE.bad, fontSize: 11.5 }}> 목록에 없음</span>}{r.gone && <span className="muted" style={{ fontSize: 11.5 }}> 인벤토리에 없음</span>}</td>
                    <td style={{ fontSize: 12.5, whiteSpace: 'normal', overflowWrap: 'anywhere' }}>{r.folder || '—'}</td>
                    <td style={{ fontSize: 12.5, color: r.power === 'POWERED_ON' ? TONE.ok : 'var(--text-dim)' }}>{r.power === 'POWERED_ON' ? '켜짐' : r.power ? '꺼짐' : '—'}</td>
                    <td className="right" data-sort={r.gb ?? ''} style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtGb(r.gb)}</td>
                    <td data-sort={b?.at ?? ''} style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>{b?.at ? shortTs(b.at) : '—'}</td>
                    <td style={{ fontSize: 12.5, color: TONE[tone], whiteSpace: 'normal' }}>
                      {b?.run ? '진행 중' : b?.st ? `${stText(b.st)}${runLine(b) ? ` · ${runLine(b)}` : ''}` : r.job || b?.job ? '백업 기록 없음' : '잡 없음'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </STable>
        </section>

        <section className="card" aria-label="실행 이력" style={{ flex: '2 1 340px', minWidth: 0, padding: 0, overflow: 'hidden' }}>
          <div style={{ ...ROW, padding: '10px 14px', borderBottom: '1px solid var(--border-soft)' }}>
            <b>실행 이력</b>
            <span className="muted" style={{ fontSize: 12 }}>회차마다 VM {g.vmIds.length}대 · {g.keepText || keepText(g.keep ?? null)}</span>
          </div>
          <ol style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {g.next && (
              <li style={{ display: 'flex', gap: 10, padding: '10px 14px', borderBottom: '1px solid var(--border-soft)', alignItems: 'flex-start' }}>
                <span aria-hidden="true" style={{ width: 9, height: 9, marginTop: 5, borderRadius: 99, border: '2px solid #93c5fd', flex: 'none' }} />
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontWeight: 700, fontSize: 13 }}>{shortTs(g.next.at)} <span className="muted" style={{ fontWeight: 400, fontSize: 12 }}>예정 · {g.next.level}</span></div>
                  {g.keep != null && <div className="muted" style={{ fontSize: 12 }}>끝나면 보관 개수({g.keep}회)를 넘는 오래된 백업을 정리합니다</div>}
                </div>
                <Badge tone="run">다음</Badge>
              </li>
            )}
            {fires.length === 0 && <li className="muted" style={{ padding: '12px 14px', fontSize: 12.5 }}>아직 실행 기록이 없습니다.</li>}
            {fires.map((f, i) => {
              const kb = fireKeepBadge(f, i > 0 ? fires[i - 1] : null, g);
              const tone = fireTone(f);
              return (
                <li key={`${f.at}-${i}`} style={{ display: 'flex', gap: 10, padding: '10px 14px', borderBottom: '1px solid var(--border-soft)', alignItems: 'flex-start', opacity: kb === 'pruned' ? 0.6 : 1 }}>
                  <span aria-hidden="true" style={{ width: 9, height: 9, marginTop: 5, borderRadius: 99, background: TONE[tone] === TONE.muted ? 'var(--border)' : TONE[tone], flex: 'none' }} />
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontWeight: 700, fontSize: 13 }}>{shortTs(f.at)} <span className="muted" style={{ fontWeight: 400, fontSize: 12 }}>{f.trigger === 'timer' ? '예약' : '수동'} · {f.level || '—'}{f.by ? ` · ${f.by}` : ''}</span></div>
                    <div style={{ fontSize: 12, color: TONE[tone], overflowWrap: 'anywhere' }}>
                      {i === 0 && g.lastFire
                        ? <button type="button" onClick={onFire} style={{ color: 'inherit', background: 'none', border: 0, padding: 0, cursor: 'pointer', textAlign: 'left', font: 'inherit', textDecoration: 'underline dotted' }}>{fireText(f).split(' · ').slice(1).join(' · ') || '—'}</button>
                        : (fireText(f).split(' · ').slice(1).join(' · ') || '—')}
                    </div>
                  </div>
                  {kb && <Badge tone={kb === 'kept' ? 'ok' : kb === 'pruned' ? 'muted' : 'warn'}>{KEEP_BADGE_TEXT[kb]}</Badge>}
                </li>
              );
            })}
          </ol>
          <div className="muted" style={{ padding: '8px 14px', fontSize: 11.5, lineHeight: 1.5 }}>
            보관 중 = 복원할 수 있는 회차 · 정리됨 = 보관 개수를 넘어 카탈로그에서 지운 회차(표지는 마지막 정리의 기준 Full 시각으로 정한 추정입니다). {tree.limits?.firesKeep ? `이력은 최근 ${tree.limits.firesKeep}회까지 · ` : ''}Director 의 보존 기간이 더 짧으면 그쪽이 먼저 지웁니다.
          </div>
        </section>
      </div>
    </div>
  );
}

/* ───────── 창 ───────── */

function RunModal({ g, onClose, onRun }) {
  const [level, setLevel] = useState('');
  return (
    <Modal title={`지금 백업 — ${g.name}`} onClose={onClose} width={460}>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 12 }}>
        <div style={{ fontSize: 13 }}>그룹 VM {g.vmIds.length}대의 백업을 지금 보냅니다. 이미 실행 중인 VM 과 꺼진 대상은 건너뜁니다.</div>
        <label style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 4 }}>
          <span className="muted" style={{ fontSize: 12 }}>레벨</span>
          <Select className="input" sort={false} value={level} onChange={(e) => setLevel(e.target.value)} aria-label="실행 레벨">
            <option value="">그룹 기본({g.schedule?.level || 'Incremental'})</option>
            {LEVELS.map((l) => <option key={l} value={l}>{l}</option>)}
          </Select>
        </label>
        <div style={{ ...ROW, justifyContent: 'flex-end' }}>
          <button type="button" className="logout-btn" onClick={onClose}>취소</button>
          <button type="button" className="login-btn" style={{ flex: 'none', padding: '8px 18px' }} onClick={() => onRun(level)}>백업 시작</button>
        </div>
      </div>
    </Modal>
  );
}

function FireModal({ g, onClose }) {
  const f = g.lastFire;
  return (
    <Modal title={`마지막 실행 — ${g.name}`} onClose={onClose} width={820}>
      {!f ? <div className="muted">실행 기록이 없습니다.</div> : (
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 10 }}>
          <div style={{ fontSize: 13 }}>{fireText(f)} · 레벨 {f.level || '—'}{f.storage ? ` · 스토리지 ${f.storage}` : ''}{f.pool ? ` · 풀 ${f.pool}` : ''}{f.key ? ` · 회차 ${f.key}` : ''}{f.by ? ` · ${f.by}` : ''}</div>
          {f.error && <div className="banner bad" style={{ fontSize: 12.5 }}>{f.error}</div>}
          {(f.items || []).length > 0 && (
            <STable minWidth={600} limit={200}>
              <thead><tr><th>VM</th><th>결과</th><th className="right">jobid</th><th>사유</th></tr></thead>
              <tbody>
                {f.items.map((it) => (
                  <tr key={it.vmId}>
                    <td><b>{it.vmName}</b></td>
                    <td style={{ color: TONE[FIRE_STATE_TONE[it.state]] || TONE.muted, whiteSpace: 'nowrap' }}>{FIRE_STATE_TEXT[it.state] || it.state}</td>
                    <td className="right" style={{ fontFamily: 'var(--mono)' }} data-sort={it.jobid ?? ''}>{it.jobid ?? '—'}</td>
                    <td style={{ fontSize: 12.5, overflowWrap: 'anywhere' }}>{it.reason || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </STable>
          )}
          <div className="muted" style={{ fontSize: 12 }}>시작한 실행의 결과(성공·실패)는 Director 상태 조회가 반영합니다 — 멤버 VM 표 · 실행 현황 탭에서 봅니다.</div>
        </div>
      )}
    </Modal>
  );
}
