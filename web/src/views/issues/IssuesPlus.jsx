/**
 * IssuesPlus — 이슈 확장 화면(v2.882 · 시안 docs/design/wiki-issues ⑥⑦⑧⑬): 스프린트 보드 · 에픽 · 검색식/저장 필터 · 일괄 편집 ·
 * 상세의 에픽/스프린트 칸 · 하위 작업 칸. 판정(계층 규칙 · 범위 · 검색식 해석)은 서버가 하고 화면은 거부 사유를 그대로 보인다.
 * 폴링하지 않는다(들어올 때 1회 + 동작 뒤 다시 읽기). 늦게 온 이전 응답은 버린다(makeLatest).
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchJson, postJson, putJson, delJson } from '../../api.js';
import { STable } from '../../components/STable.jsx';
import { Loading, ErrorBox } from '../../components/primitives.jsx';
import Select from '../../components/Select.jsx';
import { Avatar, TypeTag, PrioTag, StatusChip, Due, ProgressLine } from './issueParts.jsx';
import {
  STATUS_ORDER, STATUS_TEXT, makeLatest, saveFailText, persistNote, peopleOptions, vcName, vcenterOptions, dateText, timeText, parseLabels, LOAD_CAP, loadPct,
  QUICK_FILTERS, QUERY_FIELD_TEXT, chipText, removeChip, errorSegments, SPRINT_STATE_TEXT, sprintRangeText, sprintName, sprintOptions, burnPoints, childText,
  epicOptions, colorIndexOf, progressOf,
} from './issueText.js';

function useLatest() {
  const ref = useRef(null);
  if (!ref.current) ref.current = makeLatest();
  useEffect(() => () => { ref.current.invalidate(); }, []);
  return ref.current;
}
const fmtFail = (r) => (r?.code === 'query' ? `검색식을 읽지 못했습니다 — ${r.errors?.[0]?.msg || r.reason}` : saveFailText(r));

/* ───────────── 일괄 편집(스프린트 · 에픽 · 라벨) — 목록 · 필터 결과가 같이 쓴다 ───────────── */
export function BulkEditBar({ keys, meta, epics, onDone, onClear }) {
  const [sprint, setSprint] = useState('');
  const [epic, setEpic] = useState('');
  const [labels, setLabels] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const sprints = sprintOptions(meta.sprintList);
  const run = async () => {
    const set = {};
    if (sprint) set.sprintId = sprint === '__none' ? '' : sprint;
    if (epic) set.parentKey = epic === '__none' ? '' : epic;
    const add = parseLabels(labels);
    if (add.length) set.addLabels = add;
    if (!Object.keys(set).length) { setMsg('바꿀 것(스프린트 · 에픽 · 라벨)을 고르세요.'); return; }
    setBusy(true); setMsg('');
    try {
      const r = await postJson('/issues/bulk/edit', { keys, set });
      if (r?.ok) {
        const bad = (r.results || []).filter((x) => !x.ok);
        setMsg(`${r.done}건 바꿨습니다${bad.length ? ` · ${bad.length}건 실패(${bad.slice(0, 5).map((x) => `${x.key}: ${x.reason}`).join(' / ')}${bad.length > 5 ? ' …' : ''})` : ''}.`);
        setSprint(''); setEpic(''); setLabels('');
        onDone?.(r);
      } else setMsg(saveFailText(r));
    } catch (e) { setMsg(saveFailText({ reason: e.message })); } finally { setBusy(false); }
  };
  return (
    <div className="iss-bulk iss-bulk-edit">
      <b>{keys.length}건 일괄 편집</b>
      <Select className="select" value={sprint} onChange={(e) => setSprint(e.target.value)} aria-label="스프린트" sort={false}>
        <option value="">스프린트 그대로</option>
        <option value="__none">스프린트에서 빼기(백로그)</option>
        {sprints.map((s) => <option key={s.id} value={s.id}>{s.name} · {SPRINT_STATE_TEXT[s.state]}</option>)}
      </Select>
      <Select className="select" value={epic} onChange={(e) => setEpic(e.target.value)} aria-label="에픽">
        <option value="" data-pin>에픽 그대로</option>
        <option value="__none" data-pin>에픽에서 빼기</option>
        {(epics || []).map((e) => <option key={e.key} value={e.key}>{e.key} {e.title}</option>)}
      </Select>
      <input className="input iss-bulk-labels" value={labels} onChange={(e) => setLabels(e.target.value)} placeholder="라벨 더하기(쉼표)" aria-label="더할 라벨" />
      <button className="btn primary" disabled={busy} onClick={run}>{busy ? '바꾸는 중…' : '적용'}</button>
      {onClear && <button className="btn" onClick={onClear}>선택 해제</button>}
      {msg && <span className="iss-bulk-msg">{msg}</span>}
      <span className="muted iss-bulk-note">키마다 서버가 계층 · 범위 규칙을 다시 본다 — 실패한 키는 사유와 함께 남긴다.</span>
    </div>
  );
}

/** 에픽 목록(쓰기 화면의 선택지) — 보이는 에픽만. */
export function useEpics(enabled = true) {
  const [epics, setEpics] = useState([]);
  const latest = useLatest();
  const load = useCallback(() => {
    if (!enabled) return;
    const k = latest.next();
    fetchJson('/issues', { type: 'epic', done: 'all', limit: 500 }).then((r) => { if (latest.isLatest(k)) setEpics(r.rows || []); }).catch(() => { if (latest.isLatest(k)) setEpics([]); });
  }, [enabled, latest]);
  useEffect(() => { load(); }, [load]);
  return [epics, load];
}

/* ───────────── 상세 — 에픽 · 스프린트 칸(옆 칸) ───────────── */
export function EpicSprintBox({ it, meta, canWrite, busy, act, onOpen }) {
  const [epics] = useEpics(canWrite && it.type !== 'epic' && it.level !== 'sub');
  const options = epicOptions(epics, it);
  const sprints = sprintOptions(meta.sprintList, it.sprintId);
  return (
    <>
      {it.type !== 'epic' && (
        <div className="iss-prop">
          <span className="iss-prop-l">{it.level === 'sub' ? '상위 이슈' : '에픽'}</span>
          {it.level === 'sub'
            ? (it.parent ? <button type="button" className="iss-link" onClick={() => onOpen(it.parent.key)}>{it.parent.key} {it.parent.title}</button> : <span className="muted">—</span>)
            : it.epic
              ? <button type="button" className="iss-link" onClick={() => onOpen(it.epic.key)}>{it.epic.key} {it.epic.title}{it.epic.progress != null ? ` · ${it.epic.progress}%` : ''}</button>
              : <span className="muted">에픽 없음</span>}
          {canWrite && it.level !== 'sub' && (
            <Select className="select" value={it.epicKey || ''} disabled={busy} aria-label="에픽 바꾸기" onChange={(e) => act(() => putJson(`/issues/${it.key}`, { parentKey: e.target.value }), e.target.value ? `에픽 ${e.target.value} 에 담았습니다.` : '에픽에서 뺐습니다.')}>
              <option value="" data-pin>에픽 없음</option>
              {it.epicKey && !options.some((o) => o.key === it.epicKey) && <option value={it.epicKey}>{it.epicKey}</option>}
              {options.map((e) => <option key={e.key} value={e.key}>{e.key} {e.title}</option>)}
            </Select>
          )}
          {canWrite && it.level !== 'sub' && <span className="muted iss-small">에픽은 유형 ‘에픽’ 의 이슈 — 같은 법인(또는 공용 에픽)의 이슈만 담습니다.</span>}
        </div>
      )}
      {it.type !== 'epic' && (
        <div className="iss-prop">
          <span className="iss-prop-l">스프린트</span>
          {it.sprint ? <span>{it.sprint.name} <span className="muted iss-small">{sprintRangeText(it.sprint)}</span></span> : <span className="muted">백로그(스프린트 없음)</span>}
          {canWrite && (
            <Select className="select" value={it.sprintId || ''} disabled={busy} aria-label="스프린트 바꾸기" sort={false} onChange={(e) => act(() => putJson(`/issues/${it.key}`, { sprintId: e.target.value }), e.target.value ? '스프린트에 넣었습니다.' : '스프린트에서 뺐습니다.')}>
              <option value="">백로그(스프린트 없음)</option>
              {sprints.map((s) => <option key={s.id} value={s.id} disabled={s.state === 'closed'}>{s.name} · {SPRINT_STATE_TEXT[s.state]}</option>)}
            </Select>
          )}
        </div>
      )}
    </>
  );
}

/* ───────────── 상세 — 하위 작업 · 에픽의 이슈(본문 아래) ───────────── */
export function ChildrenBox({ it, meta, canWrite, busy, act, onOpen }) {
  const [title, setTitle] = useState('');
  const [who, setWho] = useState('');
  const isEpic = it.type === 'epic';
  const canAdd = canWrite && it.level !== 'sub';
  const kids = it.children || [];
  if (it.level === 'sub') return null;
  const people = peopleOptions(meta.people);
  const add = () => act(() => postJson('/issues', { title: title.trim(), parentKey: it.key, vcenterId: it.vcenterId || '', assignee: who, type: 'task' }), isEpic ? '이슈를 에픽에 더했습니다.' : '하위 작업을 더했습니다.')
    .then((ok) => { if (ok) { setTitle(''); setWho(''); } });
  return (
    <div className="iss-children">
      <div className="iss-children-head">
        <b>{isEpic ? '에픽의 이슈' : '하위 작업'} · {kids.length}</b>
        {it.childCount > 0 && (
          <span className="iss-prog"><span className="iss-prog-bar" role="img" aria-label={`완료 ${it.childDone}/${it.childCount}`}><span style={{ width: `${it.progress ?? 0}%` }} /></span>
            <span className="iss-prog-n">{it.progress ?? 0}%</span></span>
        )}
        <span className="muted iss-small">
          {it.childCount > 0 ? `완료 ${it.childDone} / ${it.childCount} — ${isEpic ? '에픽 진행률 = 소속 이슈 완료 비율' : '이 이슈의 진행률은 하위 작업 완료 비율로 자동 계산됩니다(직접 입력은 잠김)'}` : (isEpic ? '이 에픽에 담긴 이슈가 없습니다.' : '하위 작업이 없습니다.')}
        </span>
      </div>
      {kids.length > 0 && (
        <STable className="v3-table iss-children-table" minWidth={620}>
          <thead><tr><th>키</th><th>제목</th><th>담당자</th><th>상태</th><th>진행</th><th>기한</th></tr></thead>
          <tbody>
            {kids.map((k) => (
              <tr key={k.key}>
                <td data-sort={k.num} className="iss-key">{k.key}</td>
                <td style={{ whiteSpace: 'normal' }}><button type="button" className="iss-link" onClick={() => onOpen(k.key)}>{k.title}</button>{childText(k) && <span className="iss-subn">{childText(k)}</span>}</td>
                <td data-sort={k.assignee || '~'}>{k.assignee ? <span className="iss-who"><Avatar name={k.assignee} size={20} />{k.assignee}</span> : <span className="iss-unassigned">미할당</span>}</td>
                <td data-sort={STATUS_ORDER.indexOf(k.status)}><StatusChip s={k.status} /></td>
                <td data-sort={progressOf(k) ?? ''}><ProgressLine r={k} compact /></td>
                <td data-sort={k.dueAt ?? ''}><Due r={k} /></td>
              </tr>
            ))}
          </tbody>
        </STable>
      )}
      {canAdd && (
        <div className="iss-children-add">
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={meta.limits?.title || 200} placeholder={isEpic ? '에픽에 더할 새 이슈 제목' : '하위 작업 제목 — 예: 시한 90초 적용 결과 확인'} aria-label={isEpic ? '새 이슈 제목' : '하위 작업 제목'} />
          <Select className="select" value={who} onChange={(e) => setWho(e.target.value)} aria-label="담당자">
            <option value="" data-pin>미할당</option>
            {people.map((p) => <option key={p.username} value={p.username}>{p.label}</option>)}
          </Select>
          <button className="btn primary" disabled={busy || !title.trim()} onClick={add}>{isEpic ? '+ 이슈 더하기' : '+ 하위 작업'}</button>
        </div>
      )}
      {!isEpic && <div className="muted iss-small">계층은 두 단계만 — 에픽 › 이슈 › 하위 작업. 하위 작업 아래에는 만들 수 없고, 남은 하위 작업이 있으면 상위를 ‘완료’ 로 바꿀 때 묻습니다.</div>}
    </div>
  );
}

/* ───────────── 스프린트 보드(⑦) ───────────── */
const EPIC_COLORS = ['#a855f7', '#22d3ee', '#f59e0b', '#22c55e', '#ef4444', '#3b82f6'];
const epicColor = (key) => (key ? EPIC_COLORS[colorIndexOf(key) % EPIC_COLORS.length] : 'transparent');
const BOARD_COLS = ['todo', 'progress', 'review', 'done'];

function SprintForm({ initial = null, onCancel, onSaved, limits }) {
  const today = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const ds = (d) => `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  const [f, setF] = useState(() => initial
    ? { name: initial.name, goal: initial.goal || '', startDay: initial.startDay, endDay: initial.endDay, start: false }
    : { name: '', goal: '', startDay: ds(today), endDay: ds(new Date(today.getTime() + 11 * 86400000)), start: false });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));
  const save = async () => {
    setBusy(true); setMsg('');
    try {
      const body = { name: f.name, goal: f.goal, startDay: f.startDay, endDay: f.endDay, ...(initial ? {} : { state: f.start ? 'active' : 'planned' }) };
      const r = initial ? await putJson(`/issues/sprints/${initial.id}`, body) : await postJson('/issues/sprints', body);
      if (r?.ok) onSaved(r.sprint); else setMsg(saveFailText(r));
    } catch (e) { setMsg(saveFailText({ reason: e.message })); } finally { setBusy(false); }
  };
  return (
    <div className="card iss-sprint-form">
      <b>{initial ? `스프린트 고치기 — ${initial.name}` : '새 스프린트'}</b>
      <div className="iss-sprint-form-grid">
        <label className="iss-field">이름<input className="input" value={f.name} onChange={set('name')} maxLength={limits?.name || 40} placeholder="예: 2026-11 ②" /></label>
        <label className="iss-field">시작<input className="input" type="date" value={f.startDay} onChange={set('startDay')} /></label>
        <label className="iss-field">끝<input className="input" type="date" value={f.endDay} onChange={set('endDay')} /></label>
        <label className="iss-field iss-span2">목표<input className="input" value={f.goal} onChange={set('goal')} maxLength={limits?.goal || 300} placeholder="이번 스프린트에 끝낼 것 — 한 줄" /></label>
      </div>
      {!initial && <label className="iss-check"><input type="checkbox" checked={f.start} onChange={set('start')} /> 바로 시작(진행 중)</label>}
      {msg && <div className="banner warn">{msg}</div>}
      <div className="flex" style={{ gap: 6, flexWrap: 'wrap' }}>
        <button className="btn primary" disabled={busy || !f.name.trim()} onClick={save}>{initial ? '저장' : '만들기'}</button>
        <button className="btn" disabled={busy} onClick={onCancel}>취소</button>
        <span className="muted iss-small">스프린트는 전 법인 공용이라 전체 범위 운영자 · 관리자가 만듭니다 · 기간은 {limits?.maxDays || 60}일까지.</span>
      </div>
    </div>
  );
}

function Burndown({ bd }) {
  const W = 320; const H = 120;
  const pts = burnPoints(bd?.days, W, H);
  const days = bd?.days || [];
  return (
    <div className="iss-burn">
      <div className="iss-burn-head"><b>번다운</b><span className="muted iss-small">남은 열린 이슈 · 일별{pts.last != null ? ` · 오늘 ${pts.last}` : ''} · 기준선 회색</span></div>
      {pts.actual
        ? (
          <svg viewBox={`0 0 ${W} ${H}`} className="iss-burn-svg" role="img" aria-label={pts.last != null ? `번다운 — 오늘 남은 이슈 ${pts.last}건` : '번다운 — 오늘 값 없음'}>
            <line x1="6" y1={H - 6} x2={W - 6} y2={H - 6} className="iss-burn-axis" />
            {pts.ideal && <polyline points={pts.ideal} className="iss-burn-ideal" />}
            <polyline points={pts.actual} className="iss-burn-line" />
          </svg>
        )
        : <div className="muted iss-small">아직 그릴 날이 없습니다(시작 전).</div>}
      <div className="iss-burn-foot muted iss-small"><span>{days[0]?.day?.slice(5) || ''}</span><span>{days[days.length - 1]?.day?.slice(5) || ''}</span></div>
      {bd?.approximate && <div className="muted iss-small">일부 이슈의 오래된 이력이 보관 상한으로 지워져 근사치입니다.</div>}
    </div>
  );
}

function SprintCard({ r, meta, sprintOpen, onOpen, act }) {
  return (
    <div className={`iss-card iss-scard${r.status === 'done' ? ' done' : ''}`} style={{ borderLeftColor: epicColor(r.epicKey) }}>
      <span className="iss-card-top">
        <TypeTag t={r.type} />
        <button type="button" className="iss-key iss-link" onClick={() => onOpen(r.key)}>{r.key}</button>
        {r.sub && r.parentKey && <span className="iss-subn">하위 · {r.parentKey}</span>}
        {!r.sub && childText(r) && <span className="iss-subn">{childText(r)}</span>}
        {r.blocked && <span className="iss-chip s-blocked" title={r.blocked.reason}>보류</span>}
        {r.status === 'backlog' && <StatusChip s="backlog" />}
      </span>
      <button type="button" className="iss-card-title iss-link" onClick={() => onOpen(r.key)}>{r.title}</button>
      <ProgressLine r={r} />
      <span className="iss-card-foot">
        <PrioTag p={r.priority} /><Due r={r} />
        <span className="iss-grow" />
        {sprintOpen && r.writable !== false && act && <button type="button" className="iss-mini-act" onClick={() => act(() => putJson(`/issues/${r.key}`, { sprintId: '' }), `${r.key} 를 스프린트에서 뺐습니다.`)} title="스프린트에서 빼기(백로그로)">빼기</button>}
        <Avatar name={r.assignee} size={22} />
      </span>
      {(meta?.vcenters || []).length > 0 && r.vcenterId && <span className="iss-vc">{vcName(meta, r.vcenterId)}</span>}
    </div>
  );
}

export function SprintView({ meta, onOpen, onWritten, reloadSprints }) {
  const sprints = meta.sprintList || [];
  // 기본 — 기간 안의 진행 중 스프린트 → (기간이 지난) 진행 중 중 가장 최근 → 예정 → 아무거나. 기간 지난 옛 스프린트가 먼저 잡히지 않게(Chromium 판독)
  const pickDefault = () => {
    const act = sprints.filter((s) => s.state === 'active');
    return (act.find((s) => !s.overdue) || act[act.length - 1] || sprints.find((s) => s.state === 'planned') || sprints[0])?.id || '';
  };
  const [sel, setSel] = useState(pickDefault);
  const [board, setBoard] = useState(null);
  const [err, setErr] = useState(null);
  const [mine, setMine] = useState(false);
  const [form, setForm] = useState(null); // null | 'new' | 'edit'
  const [closing, setClosing] = useState(false);
  const [closeTo, setCloseTo] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [backlogOpen, setBacklogOpen] = useState(true);
  const latest = useLatest();
  // 스프린트 목록이 바뀌면(만들기 · 끝내기) 고른 것이 사라졌을 때만 기본값으로 — 고른 것을 따라 다시 돌지 않게 목록만 본다
  useEffect(() => {
    if (!sel || !sprints.some((s) => s.id === sel)) setSel(pickDefault());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sprints]);
  const load = useCallback(() => {
    if (!sel) { setBoard(null); return; }
    const k = latest.next();
    fetchJson(`/issues/sprints/${sel}/board`).then((r) => { if (latest.isLatest(k)) { setBoard(r); setErr(null); } }).catch((e) => { if (latest.isLatest(k)) setErr(e); });
  }, [sel, latest]);
  useEffect(() => { load(); }, [load]);
  const act = async (fn, okMsg = '') => {
    setBusy(true); setMsg('');
    try {
      const r = await fn();
      if (r?.ok) { setMsg([okMsg, persistNote(r.persist)].filter(Boolean).join(' ')); onWritten?.(r); load(); return true; }
      setMsg(saveFailText(r)); return false;
    } catch (e) { setMsg(saveFailText({ reason: e.message })); return false; } finally { setBusy(false); }
  };
  const sp = board?.sprint || sprints.find((s) => s.id === sel) || null;
  const rows = useMemo(() => (board?.rows || []).filter((r) => r.type !== 'epic' && (!mine || r.assignee === meta.me)), [board, mine, meta.me]);
  const nextSprints = sprints.filter((s) => s.state !== 'closed' && s.id !== sel);
  const canManage = !!meta.canSprints;
  const open = sp && sp.state !== 'closed';
  const counts = board?.counts || {};
  const total = board?.total ?? 0;
  const donePct = total ? Math.round(((counts.done || 0) / total) * 100) : null;
  return (
    <div className="iss-sprint">
      <div className="card iss-sprint-pick">
        <b>스프린트</b>
        <div className="iss-sprint-tabs">
          {sprints.length === 0 && <span className="muted">스프린트가 없습니다{canManage ? ' — 새 스프린트를 만드세요' : ' — 전체 범위 운영자 · 관리자가 만듭니다'}.</span>}
          {sprints.map((s) => (
            <button key={s.id} type="button" className={`btn${s.id === sel ? ' primary' : ''}`} onClick={() => { setSel(s.id); setClosing(false); setForm(null); }}>
              {s.name} <span className="iss-small">{SPRINT_STATE_TEXT[s.state]}</span>
            </button>
          ))}
        </div>
        {canManage && <button className="btn" onClick={() => setForm('new')}>+ 새 스프린트</button>}
      </div>
      {form && <SprintForm initial={form === 'edit' ? sp : null} limits={meta.sprintLimits} onCancel={() => setForm(null)} onSaved={(s) => { setForm(null); setSel(s.id); reloadSprints?.(); }} />}
      {msg && <div className="banner">{msg}</div>}
      {err && !board && <ErrorBox error={err} />}
      {sel && !board && !err && <Loading label="스프린트" />}
      {sp && board && (
        <>
          <div className="card iss-sprint-head">
            <div className="iss-sprint-title">
              <h3>{sp.name}</h3><span className={`iss-chip s-${sp.state === 'active' ? 'progress' : sp.state === 'closed' ? 'done' : 'todo'}`}>{SPRINT_STATE_TEXT[sp.state]}</span>
              <span className="muted">{sprintRangeText(sp)} · 공용 + 전 법인{meta.scoped ? '(내 범위의 이슈만 보입니다)' : ''}</span>
            </div>
            {sp.goal && <div className="iss-sprint-goal"><span className="muted">목표</span> {sp.goal}</div>}
            <div className="iss-sprint-sum">
              이슈 {total} · 완료 {counts.done || 0} · 진행 {(counts.progress || 0) + (counts.review || 0)} · 할 일 {(counts.todo || 0) + (counts.backlog || 0)}
              {donePct != null && <span className="iss-prog"><span className="iss-prog-bar" role="img" aria-label={`완료 ${donePct}%`}><span style={{ width: `${donePct}%` }} /></span><span className="iss-prog-n">{donePct}%</span></span>}
              <span className="muted iss-small">하위 작업은 상위 이슈 안에서 셉니다(카드에 n/m)</span>
            </div>
            {canManage && open && (
              <div className="flex" style={{ gap: 6, flexWrap: 'wrap' }}>
                <button className="btn" disabled={busy} onClick={() => setForm('edit')}>목표 · 기간 수정</button>
                {sp.state === 'planned' && <button className="btn" disabled={busy} onClick={() => act(() => putJson(`/issues/sprints/${sp.id}`, { state: 'active' }), '스프린트를 시작했습니다.').then((ok) => { if (ok) reloadSprints?.(); })}>시작</button>}
                <button className="btn" disabled={busy} onClick={() => { setCloseTo(nextSprints.find((s) => s.state === 'planned')?.id || ''); setClosing(true); }}>스프린트 끝내기</button>
              </div>
            )}
            {sp.state === 'closed' && <div className="muted iss-small">끝남 · {sp.closedBy || '—'} · {timeText(sp.closedAt)}{sp.closeNote ? ` · ${sp.closeNote}` : ''} — 회고 기록이라 고치지 않습니다.</div>}
            {closing && (
              <div className="iss-close-box" role="dialog" aria-label="스프린트 끝내기">
                <b>{sp.name} 를 끝냅니다 — 완료 {counts.done || 0} · 미완료 {total - (counts.done || 0)}</b>
                <span>미완료 {total - (counts.done || 0)}건을 어디로 옮길까요? 옮긴 기록은 이슈 이력에 남고, 끝난 스프린트는 회고(완료 목록 · 번다운)로 남습니다.</span>
                <div className="flex" style={{ gap: 10, flexWrap: 'wrap' }}>
                  {nextSprints.map((s) => <label key={s.id} className="iss-check"><input type="radio" name="closeTo" checked={closeTo === s.id} onChange={() => setCloseTo(s.id)} /> {s.name}({SPRINT_STATE_TEXT[s.state]})</label>)}
                  <label className="iss-check"><input type="radio" name="closeTo" checked={closeTo === ''} onChange={() => setCloseTo('')} /> 백로그로</label>
                </div>
                <div className="flex" style={{ gap: 6 }}>
                  <button className="btn primary" disabled={busy} onClick={() => act(() => postJson(`/issues/sprints/${sp.id}/close`, { to: closeTo }), '스프린트를 끝냈습니다.').then((ok) => { if (ok) { setClosing(false); reloadSprints?.(); } })}>끝내기</button>
                  <button className="btn" disabled={busy} onClick={() => setClosing(false)}>취소</button>
                </div>
                <span className="muted iss-small">하위 작업 · 범위 밖 이슈까지 서버가 함께 옮깁니다(이 화면에 보이는 수와 다를 수 있습니다).</span>
              </div>
            )}
          </div>
          <div className="iss-sprint-stats">
            <div className="card"><Burndown bd={board.burndown} /></div>
            <div className="card iss-people">
              <b>사람별 · 열린 이슈</b>
              {(board.people || []).length === 0 && <div className="muted iss-small">담당자가 정해진 열린 이슈가 없습니다.</div>}
              {(board.people || []).map((p) => (
                <div key={p.assignee} className="iss-load">
                  <span className="iss-load-name iss-who"><Avatar name={p.assignee} size={20} />{p.assignee}</span>
                  <span className="iss-bar" role="img" aria-label={`열린 이슈 ${p.open}건`}><span style={{ width: `${loadPct(p.open)}%` }} /></span>
                  <span className="iss-load-n">{p.open}</span>
                </div>
              ))}
              <div className="muted iss-small">막대는 {LOAD_CAP}건을 가득으로(표시 기준). 미할당 {board.unassigned ?? 0}.</div>
            </div>
          </div>
          <div className="iss-sprint-tools">
            <label className="iss-check"><input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} /> 내 이슈만</label>
            <span className="muted iss-small">카드 왼쪽 띠 = 에픽(색은 에픽 키마다 같다 · 없음은 띠 없음)</span>
          </div>
          <div className="iss-board-wrap">
            <div className="iss-board cols4">
              {BOARD_COLS.map((s) => {
                const list = rows.filter((r) => (s === 'todo' ? r.status === 'todo' || r.status === 'backlog' : r.status === s));
                return (
                  <section key={s} className="iss-col" aria-label={STATUS_TEXT[s]}>
                    <div className="iss-col-head"><StatusChip s={s} /><span className="muted" style={{ fontSize: 12 }}>{list.length}</span></div>
                    {list.length === 0 && <div className="muted iss-col-empty">없음</div>}
                    {list.map((r) => <SprintCard key={r.key} r={r} meta={meta} sprintOpen={open && !!meta.canWrite} onOpen={onOpen} act={act} />)}
                  </section>
                );
              })}
            </div>
          </div>
          {open && (
            <div className="card iss-backlog">
              <div className="iss-backlog-head">
                <b>백로그 · {board.backlogTotal ?? 0} · 스프린트 밖 열린 이슈</b>
                <button className="btn" onClick={() => setBacklogOpen((v) => !v)}>{backlogOpen ? '접기' : '펼치기'}</button>
              </div>
              {backlogOpen && (
                <>
                  {(board.backlog || []).length === 0 && <div className="muted iss-small">스프린트 밖 열린 이슈가 없습니다.</div>}
                  {(board.backlog || []).map((r) => (
                    <div key={r.key} className="iss-backlog-row">
                      <TypeTag t={r.type} /><button type="button" className="iss-key iss-link" onClick={() => onOpen(r.key)}>{r.key}</button><PrioTag p={r.priority} />
                      <button type="button" className="iss-link iss-backlog-title" onClick={() => onOpen(r.key)}>{r.title}</button>
                      {meta.canWrite && r.writable !== false
                        ? <button className="btn" disabled={busy} onClick={() => act(() => putJson(`/issues/${r.key}`, { sprintId: sp.id }), `${r.key} 를 ${sp.name} 에 넣었습니다.`)}>넣기</button>
                        : <span className="muted iss-small">조회만</span>}
                    </div>
                  ))}
                  {board.backlogTotal > (board.backlog || []).length && <div className="muted iss-small">위 {(board.backlog || []).length}건만 보입니다(우선순위 · 최근 순). 나머지는 필터에서 ‘sprint is empty’.</div>}
                  <div className="muted iss-small">넣기 · 빼기는 이력에 남습니다. 범위 계정은 자기 법인 이슈만 넣고, 스프린트 자체(이름 · 기간 · 목표)는 전체 범위 운영자 · 관리자가 만듭니다.</div>
                </>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/* ───────────── 에픽 목록 ───────────── */
export function EpicsView({ meta, onOpen, onWritten }) {
  const [epics, reload] = useEpics(true);
  const [title, setTitle] = useState('');
  const vcOpts = vcenterOptions(meta);
  const [vc, setVc] = useState(() => vcOpts[0]?.id || '');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const create = async () => {
    setBusy(true); setMsg('');
    try {
      const r = await postJson('/issues', { title: title.trim(), type: 'epic', vcenterId: vc });
      if (r?.ok) { setTitle(''); setMsg(['에픽을 만들었습니다.', persistNote(r.persist)].filter(Boolean).join(' ')); onWritten?.(r); reload(); onOpen(r.issue.key); } else setMsg(saveFailText(r));
    } catch (e) { setMsg(saveFailText({ reason: e.message })); } finally { setBusy(false); }
  };
  const open = epics.filter((e) => e.status !== 'done');
  const done = epics.filter((e) => e.status === 'done');
  return (
    <div className="card">
      <div className="iss-children-head">
        <b>에픽 · 열림 {open.length} · 완료 {done.length}</b>
        <span className="muted iss-small">에픽 진행률 = 소속 이슈 완료 비율 · 공용 에픽은 전 법인 이슈를 담고, 법인 에픽은 그 법인 이슈만 담습니다.</span>
      </div>
      {meta.canWrite && (
        <div className="iss-children-add">
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={meta.limits?.title || 200} placeholder="새 에픽 제목 — 예: 고RTT 법인 수집 안정화" aria-label="새 에픽 제목" />
          <Select className="select" value={vc} onChange={(e) => setVc(e.target.value)} aria-label="법인">
            {vcOpts.map((o) => <option key={o.id || 'pub'} value={o.id} data-pin={o.id === '' ? true : undefined}>{o.label}</option>)}
          </Select>
          <button className="btn primary" disabled={busy || !title.trim()} onClick={create}>+ 새 에픽</button>
        </div>
      )}
      {msg && <div className="banner">{msg}</div>}
      {epics.length === 0
        ? <div className="muted" style={{ padding: 12 }}>에픽이 없습니다 — 큰 일을 묶을 때 유형 ‘에픽’ 으로 만드세요.</div>
        : (
          <STable className="v3-table" minWidth={880}>
            <thead><tr><th>키</th><th>제목</th><th>법인</th><th>상태</th><th>진행</th><th>이슈</th><th>담당자</th><th>갱신</th></tr></thead>
            <tbody>
              {epics.map((e) => (
                <tr key={e.key}>
                  <td data-sort={e.num} className="iss-key"><span className="iss-epic-dot" style={{ background: epicColor(e.key) }} />{e.key}</td>
                  <td style={{ whiteSpace: 'normal' }}><button type="button" className="iss-link" onClick={() => onOpen(e.key)}>{e.title}</button></td>
                  <td data-sort={e.vcenterId ? vcName(meta, e.vcenterId) : '~'}>{e.vcenterId ? vcName(meta, e.vcenterId) : <span className="muted">공용</span>}</td>
                  <td data-sort={STATUS_ORDER.indexOf(e.status)}><StatusChip s={e.status} /></td>
                  <td data-sort={progressOf(e) ?? ''}><ProgressLine r={e} compact /></td>
                  <td data-sort={e.childCount}>{e.childCount ? `${e.childDone}/${e.childCount}` : <span className="muted">0</span>}</td>
                  <td data-sort={e.assignee || '~'}>{e.assignee || <span className="muted">—</span>}</td>
                  <td data-sort={e.updatedAt} className="muted" title={timeText(e.updatedAt)}>{dateText(e.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </STable>
        )}
    </div>
  );
}

/* ───────────── 검색식 · 저장 필터(⑧) ───────────── */
const QUERY_KEY = 'issues.query';
function readSaved() { try { return window.sessionStorage.getItem(QUERY_KEY) || ''; } catch { return ''; } }
function writeSaved(q) { try { window.sessionStorage.setItem(QUERY_KEY, q); } catch { /* 저장소를 못 쓰는 브라우저 — 무시 */ } }

export function FiltersView({ meta, onOpen, onWritten }) {
  const [q, setQ] = useState(() => readSaved() || QUICK_FILTERS[0].query);
  const [ran, setRan] = useState('');
  const [res, setRes] = useState(null); // { rows, total, all, query:{clauses, order, orderStart} }
  const [qerr, setQerr] = useState(null); // { errors, clauses }
  const [err, setErr] = useState(null);
  const [filters, setFilters] = useState(null);
  const [cur, setCur] = useState(null); // 고른 저장 필터
  const [msg, setMsg] = useState('');
  const [sel, setSel] = useState(() => new Set());
  const [epics] = useEpics(!!meta.canWrite);
  const latest = useLatest();
  const latestF = useLatest();
  const loadFilters = useCallback(() => {
    const k = latestF.next();
    fetchJson('/issues/filters').then((r) => { if (latestF.isLatest(k)) setFilters(r); }).catch(() => { if (latestF.isLatest(k)) setFilters({ filters: [] }); });
  }, [latestF]);
  useEffect(() => { loadFilters(); }, [loadFilters]);
  const run = useCallback((query) => {
    const text = String(query ?? '').trim();
    const k = latest.next();
    setRan(text); writeSaved(text); setSel(new Set());
    fetchJson('/issues', { query: text || 'ORDER BY updated DESC', limit: 500 }, undefined, { retries: 0 })
      .then((r) => { if (latest.isLatest(k)) { setRes(r); setQerr(null); setErr(null); } })
      .catch((e) => {
        if (!latest.isLatest(k)) return;
        const data = e?.body || null;
        if (e?.status === 400 && data?.code === 'query') { setQerr({ errors: data.errors || [], clauses: data.clauses || [] }); setRes(null); setErr(null); }
        else if (e?.status === 400) { setQerr({ errors: [{ msg: String(e.message || '검색식 오류').replace(/^.*?—\s*/, ''), start: 0, end: 0, hint: '' }], clauses: [] }); setRes(null); }
        else setErr(e);
      });
  }, [latest]);
  // 처음 1회 — 그 뒤로는 찾기 · 필터 고르기 · 칩 지우기가 부른다(입력 중에는 부르지 않는다)
  useEffect(() => {
    run(q);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const submit = (e) => { e.preventDefault(); setCur((c) => (c && c.query === q.trim() ? c : c ? { ...c, dirty: true } : null)); run(q); };
  const pick = (f) => { setQ(f.query); setCur(f.id ? f : null); setMsg(''); run(f.query); };
  const clauses = res?.query?.clauses || qerr?.clauses || [];
  const dropChip = (i) => { const nq = removeChip(ran, clauses, i, res?.query?.orderStart ?? -1); setQ(nq); run(nq); };
  const opts = { me: meta.me, sprintName: (id) => sprintName(meta.sprintList, id), vcName: (id) => vcName(meta, id) };
  const fsave = async (mode) => {
    setMsg('');
    try {
      let r;
      if (mode === 'update' && cur?.id) r = await putJson(`/issues/filters/${cur.id}`, { query: q.trim() });
      else if (mode === 'share' && cur?.id) r = await putJson(`/issues/filters/${cur.id}`, { shared: !cur.shared });
      else if (mode === 'delete' && cur?.id) { if (!window.confirm(`필터 ‘${cur.name}’ 를 지울까요?`)) return; r = await delJson(`/issues/filters/${cur.id}`); }
      else {
        const name = window.prompt('필터 이름', cur?.name ? `${cur.name} 사본` : '');
        if (!name) return;
        r = await postJson('/issues/filters', { name, query: q.trim() });
      }
      if (r?.ok) {
        setMsg(mode === 'delete' ? '필터를 지웠습니다.' : '필터를 저장했습니다.');
        setCur(mode === 'delete' ? null : r.filter);
        loadFilters();
      } else setMsg(fmtFail(r));
    } catch (e) { setMsg(fmtFail({ reason: e.message })); }
  };
  const rows = res?.rows || [];
  const writableKeys = rows.filter((r) => r.writable !== false).map((r) => r.key);
  const picked = writableKeys.filter((k) => sel.has(k));
  const allOn = picked.length > 0 && picked.length === writableKeys.length;
  const mineF = (filters?.filters || []).filter((f) => f.mine);
  const sharedF = (filters?.filters || []).filter((f) => !f.mine && f.shared);
  const segs = qerr ? errorSegments(q, qerr.errors) : null;
  return (
    <div className="iss-filters">
      <aside className="card iss-filter-side" aria-label="필터">
        <div className="iss-filter-group"><b>빠른 필터</b>
          {QUICK_FILTERS.map((f) => <button key={f.id} type="button" className={`iss-filter-item${ran === f.query ? ' on' : ''}`} onClick={() => pick(f)}>{f.name}</button>)}
        </div>
        <div className="iss-filter-group"><b>내 필터 · {mineF.length}</b>
          {mineF.length === 0 && <span className="muted iss-small">{meta.canFilters ? '검색식을 쓰고 ‘다른 이름으로 저장’ 하세요.' : '필터 저장은 운영자 · 관리자만 합니다.'}</span>}
          {mineF.map((f) => <button key={f.id} type="button" className={`iss-filter-item${cur?.id === f.id ? ' on' : ''}`} onClick={() => pick(f)}>{f.shared ? '★ ' : ''}{f.name}</button>)}
        </div>
        <div className="iss-filter-group"><b>공유 필터 · {sharedF.length}</b>
          {sharedF.length === 0 && <span className="muted iss-small">전체 범위 운영자 · 관리자가 공유한 필터가 여기에 보입니다.</span>}
          {sharedF.map((f) => <button key={f.id} type="button" className={`iss-filter-item${cur?.id === f.id ? ' on' : ''}`} onClick={() => pick(f)}>{f.name} <span className="muted iss-small">{f.owner}</span></button>)}
        </div>
        <div className="muted iss-small">필터는 검색식 한 줄을 저장한 것입니다. 범위 계정이 공유 필터를 열면 자기 범위로 다시 걸러 보입니다.</div>
      </aside>
      <div className="iss-filter-main">
        <div className="card">
          <div className="iss-filter-title">
            <b>{cur ? cur.name : '검색식'}</b>
            {cur && <span className="muted iss-small">{cur.mine ? '내 필터' : `공유 · ${cur.owner}`}{cur.query !== q.trim() ? ' · 바꾼 뒤 저장 안 됨' : ''}</span>}
            <span className="iss-grow" />
            {meta.canFilters && cur?.editable && <button className="btn" onClick={() => fsave('update')} disabled={cur.query === q.trim()}>저장</button>}
            {meta.canFilters && <button className="btn" onClick={() => fsave('new')}>다른 이름으로 저장</button>}
            {meta.canShareFilters && cur?.editable && <button className="btn" onClick={() => fsave('share')}>{cur.shared ? '공유 끄기' : '공유'}</button>}
            {cur?.deletable && <button className="btn" onClick={() => fsave('delete')}>지우기</button>}
          </div>
          <form className="iss-query" onSubmit={submit}>
            <textarea className="input iss-query-input" rows={2} value={q} onChange={(e) => setQ(e.target.value)} maxLength={meta.queryLimits?.length || 500} spellCheck={false} aria-label="검색식"
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(e); } }} />
            <button className="btn primary" type="submit">찾기</button>
          </form>
          {segs && (
            <div className="iss-query-err" role="alert">
              <code>{segs.map((s, i) => (s.bad ? <mark key={i} title={s.title}>{s.text}</mark> : <React.Fragment key={i}>{s.text}</React.Fragment>))}</code>
              <span>{qerr.errors[0]?.msg}{qerr.errors[0]?.hint ? ` — ${qerr.errors[0].hint}` : ''}</span>
            </div>
          )}
          {!qerr && clauses.length > 0 && (
            <div className="iss-chips" aria-label="해석">
              <span className="muted iss-small">해석</span>
              {clauses.map((c, i) => (
                <span key={`${c.start}-${i}`} className="iss-qchip">{chipText(c, opts)}
                  <button type="button" aria-label={`${chipText(c, opts)} 지우기`} onClick={() => dropChip(i)}>✕</button>
                </span>
              ))}
              {(res?.query?.order || []).length > 0 && <span className="iss-qchip order">정렬 {res.query.order.map((o) => `${QUERY_FIELD_TEXT[o.field] || o.field} ${o.dir === 'desc' ? '↓' : '↑'}`).join(' · ')}</span>}
            </div>
          )}
          {msg && <div className="banner">{msg}</div>}
          <details className="iss-query-help">
            <summary>문법 도움</summary>
            <div><b>필드</b> {(meta.queryFields || Object.keys(QUERY_FIELD_TEXT)).join(' · ')}</div>
            <div><b>연산자 · 값</b> = != in (…) not in (…) &gt; &gt;= &lt; &lt;= ~(포함) is empty · is not empty</div>
            <div><b>함수</b> me() now() active() · 상대 날짜 -7d +3d -2w · 날짜 2026-11-01 · “따옴표 값” · 한글 값(진행 중 · 장애 · 긴급)도 됩니다</div>
            <div><b>묶기 · 정렬</b> AND · OR · 괄호 · ORDER BY 필드 ASC|DESC</div>
            <div className="muted">서버가 식을 해석해 거릅니다 · 범위는 식보다 먼저(식에 다른 법인을 적어도 보이지 않습니다) · 식 {meta.queryLimits?.length || 500}자 · 조건 {meta.queryLimits?.clauses || 20}개 상한.</div>
          </details>
        </div>
        {err && <ErrorBox error={err} />}
        {res && (
          <div className="card">
            {meta.canWrite && picked.length > 0 && <BulkEditBar keys={picked} meta={meta} epics={epics} onDone={(r) => { onWritten?.(r); run(ran); }} onClear={() => setSel(new Set())} />}
            <div className="muted iss-small" style={{ marginBottom: 6 }}>{res.total}건 · 볼 수 있는 이슈 {res.all} 중{res.total > rows.length ? ` · 앞 ${rows.length}건만 보입니다` : ''} · 제목 머리를 누르면 이 표 안에서 정렬합니다(식의 ORDER BY 는 서버 정렬)</div>
            {rows.length === 0
              ? <div className="muted" style={{ padding: 12 }}>조건에 맞는 이슈가 없습니다.</div>
              : (
                <STable className="v3-table" minWidth={1180}>
                  <thead>
                    <tr>
                      {meta.canWrite && <th data-nosort style={{ width: 34 }}><input type="checkbox" checked={allOn} onChange={() => setSel(allOn ? new Set() : new Set(writableKeys))} aria-label="전체 선택" /></th>}
                      <th>키</th><th>유형</th><th>제목</th><th>에픽</th><th>스프린트</th><th>상태</th><th>진행</th><th>우선순위</th><th>담당자</th><th>기한</th><th>갱신</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.key} className={sel.has(r.key) ? 'iss-sel' : ''}>
                        {meta.canWrite && <td>{r.writable !== false ? <input type="checkbox" checked={sel.has(r.key)} onChange={() => setSel((s) => { const n = new Set(s); if (n.has(r.key)) n.delete(r.key); else n.add(r.key); return n; })} aria-label={`${r.key} 선택`} /> : <span className="muted" title="쓰기 범위 밖">—</span>}</td>}
                        <td data-sort={r.num} className="iss-key">{r.key}</td>
                        <td><TypeTag t={r.type} /></td>
                        <td style={{ whiteSpace: 'normal' }}><button type="button" className="iss-link" onClick={() => onOpen(r.key)}>{r.title}</button>{r.parentKey && r.parentKey !== r.epicKey && <span className="iss-subn">하위 · {r.parentKey}</span>}{childText(r) && <span className="iss-subn">{childText(r)}</span>}</td>
                        <td data-sort={r.epicKey || '~'}>{r.epicKey ? <span className="iss-epic-tag" style={{ borderColor: epicColor(r.epicKey) }}>{r.epicKey}</span> : <span className="muted">—</span>}</td>
                        <td data-sort={r.sprintId ? sprintName(meta.sprintList, r.sprintId) : '~'}>{r.sprintId ? sprintName(meta.sprintList, r.sprintId) : <span className="muted">없음</span>}</td>
                        <td data-sort={STATUS_ORDER.indexOf(r.status)}><StatusChip s={r.status} /></td>
                        <td data-sort={progressOf(r) ?? ''}><ProgressLine r={r} compact /></td>
                        <td data-sort={r.priority}><PrioTag p={r.priority} /></td>
                        <td data-sort={r.assignee || '~'}>{r.assignee ? <span className="iss-who"><Avatar name={r.assignee} size={20} />{r.assignee}</span> : <span className="iss-unassigned">미할당</span>}</td>
                        <td data-sort={r.dueAt ?? ''}><Due r={r} /></td>
                        <td data-sort={r.updatedAt} className="muted" title={timeText(r.updatedAt)}>{dateText(r.updatedAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </STable>
              )}
          </div>
        )}
      </div>
    </div>
  );
}

export { epicColor };
