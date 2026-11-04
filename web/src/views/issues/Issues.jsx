/**
 * Issues — 상단 메뉴 '이슈'(v2.864). 이슈를 등록하고 담당자에게 할당해 끝날 때까지 추적한다.
 * 서브탭: 보드(칸반) · 목록(표 · 일괄 할당) · 내 작업(내 이슈 · 내 요청 진행 현황 · 미할당 대기열 · 팀 할당 현황) · 활동(v2.871 팀 활동 피드). 상세는 #/issues/<sub>/<키>.
 *  · v2.871 진행 공유: 진행률(0~100)·진행 메모·'N일 갱신 없음' 표시·링크 복사 — 보는 것은 조회 권한, 고치는 것은 쓰기 범위.
 *  · 읽기는 로그인 사용자 전부, 쓰기(생성·수정·상태·할당·댓글)는 admin·operator(서버가 집행). 삭제는 본인 또는 전체 범위 관리자.
 *  · 전이 규칙(진행 중은 담당자 필수 · 보류는 사유 필수)은 서버가 판정하고 화면은 거부 사유를 그대로 보인다.
 * 폴링하지 않는다(마운트 1회 + 동작 뒤 다시 읽기 + 새로고침 버튼). 늦게 온 이전 응답은 버린다(makeLatest).
 * 디자인 시안: Claude Design 캔버스 '이슈 트래커 시안'(보드·상세·목록·내 작업·새 이슈).
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchJson, postJson, putJson, delJson } from '../../api.js';
import { STable } from '../../components/STable.jsx';
import { Loading, ErrorBox } from '../../components/primitives.jsx';
import Select from '../../components/Select.jsx';
import DataList from '../../components/DataList.jsx';
import { Avatar, TypeTag, PrioTag, StatusChip, Due, ProgressLine } from './issueParts.jsx';
import { SprintView, EpicsView, FiltersView, EpicSprintBox, ChildrenBox, BulkEditBar, LinksBox, useEpics, epicColor } from './IssuesPlus.jsx';
import { useHashTab } from '../../hooks/useHashTab.js';
import {
  STATUS_ORDER, STATUS_TEXT, TYPE_TEXT, PRIORITY_TEXT, statusText, typeText, priorityText, dueInfo, timeText, dateText, initialOf, colorIndexOf,
  groupByStatus, filterRows, myWork, loadPct, LOAD_CAP, toDateInput, fromDateInput, parseLabels, saveFailText, persistNote, historyText,
  peopleOptions, makeLatest, vcName, vcenterOptions, vcenterRequired, notifyStatusText, childText, sprintName, statusConfirmText, STATUS_CONFIRM_FLAG, AUTO_LEVEL_TEXT, autoKindRows, autoOnCount, autoStatusText, simulateText, originText, progressOf, staleInfo, myRequests, activityText, issueLink, STALE_DAYS,
} from './issueText.js';
import { wikiHash, statusText as wikiStatusText } from '../wiki/wikiText.js';
import { MdView } from '../wiki/MdView.jsx';

const SUBS = [['board', '보드'], ['list', '목록'], ['mine', '내 작업'], ['activity', '활동'], ['sprint', '스프린트'], ['epics', '에픽'], ['filters', '필터']]; // v2.882 스프린트 · 에픽 · 필터
/** v2.871: 설정 탭은 전체 범위 관리자에게만 보인다(서버가 같은 기준으로 막는다). 해시 키는 늘 유효 — 권한이 없으면 안내만. */
const SETTINGS_SUB = ['settings', '설정'];
const EMPTY_FILTERS = Object.freeze({ q: '', assignee: '', priority: '', type: '', status: '', vcenterId: '', mine: false });
const KEY_RE = /^ISS-\d{1,9}$/;

function useLatest() {
  const ref = useRef(null);
  if (!ref.current) ref.current = makeLatest();
  useEffect(() => () => { ref.current.invalidate(); }, []);
  return ref.current;
}

/** 상세 키 — #/issues/<sub>/<키>. 해시가 바뀌면 다시 읽는다. */
function useDetailKey(sub) {
  const read = () => {
    const segs = String(window.location.hash || '').replace(/^#\/?/, '').split('/');
    return segs[0] === 'issues' && KEY_RE.test(segs[2] || '') ? segs[2] : '';
  };
  const [key, setKey] = useState(read);
  useEffect(() => {
    const on = () => setKey(read());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  const open = useCallback((k) => { window.location.hash = `#/issues/${sub}${k ? `/${k}` : ''}`; }, [sub]);
  return [key, open];
}

export default function Issues() {
  const [sub, setSub] = useHashTab({ base: ['issues'], valid: [...SUBS.map(([k]) => k), SETTINGS_SUB[0]], fallback: 'board' });
  const [openKey, openIssue] = useDetailKey(sub);
  const [meta, setMeta] = useState(null);
  const [list, setList] = useState(null);
  const [stats, setStats] = useState(null);
  const [err, setErr] = useState(null);
  const [creating, setCreating] = useState(false); // false | 'issue' | 'request'
  const [note, setNote] = useState('');
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [sprints, setSprints] = useState(null);
  const latest = useLatest();
  const latestS = useLatest();
  // v2.882 스프린트 목록 — 카드 · 상세 · 일괄 편집이 이름을 쓴다(못 읽으면 빈 목록 · 화면은 id 를 그대로 보인다)
  const loadSprints = useCallback(() => {
    const k = latestS.next();
    fetchJson('/issues/sprints').then((r) => { if (latestS.isLatest(k)) setSprints(r.sprints || []); }).catch(() => { if (latestS.isLatest(k)) setSprints([]); });
  }, [latestS]);
  useEffect(() => { loadSprints(); }, [loadSprints]);
  const metaX = useMemo(() => (meta ? { ...meta, sprintList: sprints || [] } : null), [meta, sprints]);
  // 상세를 열거나 닫으면 새 이슈 입력 창은 닫는다(두 편집 맥락이 한 화면에 겹치지 않게 — Chromium 판독에서 발견).
  useEffect(() => { setCreating(false); }, [openKey]);

  const load = useCallback(() => {
    const k = latest.next();
    Promise.all([fetchJson('/issues/meta'), fetchJson('/issues', { done: 'recent', limit: 2000 }), fetchJson('/issues/stats')])
      .then(([m, l, s]) => { if (latest.isLatest(k)) { setMeta(m); setList(l); setStats(s); setErr(null); } })
      .catch((e) => { if (latest.isLatest(k)) setErr(e); });
  }, [latest]);
  useEffect(() => { load(); }, [load]);

  const onWritten = useCallback((r) => { setNote(persistNote(r?.persist)); load(); }, [load]);
  const [epics, reloadEpics] = useEpics(!!meta?.canWrite);

  if (err && !list) return <ErrorBox error={err} />;
  if (!list || !meta || !metaX) return <Loading label="이슈" />;

  const me = meta.me;
  const canWrite = !!meta.canWrite;
  const canRequest = !canWrite && !!meta.canRequest;
  const subs = meta.canSettings ? [...SUBS, SETTINGS_SUB] : SUBS;
  const setF = (k) => (e) => setFilters((f) => ({ ...f, [k]: e?.target ? (e.target.type === 'checkbox' ? e.target.checked : e.target.value) : e }));
  const rows = list.rows || [];
  const shown = filterRows(rows, { ...filters, me });

  return (
    <div className="iss-page">
      <div className="iss-head">
        <div className="flex" style={{ gap: 6, flexWrap: 'wrap' }}>
          {subs.map(([k, label]) => (
            <button key={k} className={`btn${sub === k ? ' primary' : ''}`} onClick={() => { setSub(k); }}>{label}</button>
          ))}
        </div>
        <span className="muted iss-summary">
          열린 이슈 {stats?.open ?? '—'} · 미할당 {stats?.unassigned ?? '—'} · 기한 초과 {stats?.overdue ?? '—'}
        </span>
        <span className="iss-grow" />
        <button className="btn" onClick={load}>새로고침</button>
        {canWrite && <button className="btn primary" onClick={() => setCreating('issue')}>+ 새 이슈</button>}
        {canRequest && <button className="btn primary" onClick={() => setCreating('request')} title="요청 유형으로 등록합니다 — 담당자·상태는 운영자가 정합니다">+ 요청 등록</button>}
        {!canWrite && !canRequest && <span className="muted" style={{ fontSize: 12 }}>이슈 등록·할당은 운영자·관리자만 할 수 있습니다</span>}
      </div>
      {err && <div className="banner">목록을 새로 읽지 못했습니다 — 아래는 직전에 읽은 목록입니다.</div>}
      {note && <div className="banner warn">{note}</div>}
      <PersistWarn persist={list.persist} />
      {creating && <IssueEditor meta={meta} requestOnly={creating === 'request'} onCancel={() => setCreating(false)} onSaved={(r) => { setCreating(false); onWritten(r); openIssue(r.issue.key); }} />}

      {sub === 'settings' && !openKey
        ? (meta.canSettings ? <><IssueSettings /><AutoCreateSettings /></> : <div className="card muted">이슈 설정은 전체 범위(vCenter 제한 없는) 관리자만 볼 수 있습니다.</div>)
        : openKey
        ? <IssueDetail key={openKey} issueKey={openKey} meta={metaX} onBack={() => openIssue('')} onOpen={openIssue} onWritten={(r) => { onWritten(r); reloadEpics(); }} />
        : (
          <>
            {(sub === 'board' || sub === 'list') && <FilterBar filters={filters} setF={setF} meta={meta} sub={sub} onReset={() => setFilters(EMPTY_FILTERS)} />}
            {meta.scoped && <div className="muted" style={{ fontSize: 12 }}>범위가 지정된 계정이라 내 법인(vCenter)의 이슈만 보입니다 — 법인이 없는 공용 이슈는 보이지 않습니다.</div>}
            {sub === 'board' && <BoardView rows={shown} meta={metaX} onOpen={openIssue} recentDays={Math.round((meta.recentDoneMs || 0) / 86400000)} />}
            {sub === 'list' && <ListView rows={shown} total={rows.length} meta={metaX} epics={epics} onOpen={openIssue} onWritten={onWritten} />}
            {sub === 'sprint' && <SprintView meta={metaX} onOpen={openIssue} onWritten={onWritten} reloadSprints={loadSprints} />}
            {sub === 'epics' && <EpicsView meta={metaX} onOpen={openIssue} onWritten={(r) => { onWritten(r); reloadEpics(); }} />}
            {sub === 'filters' && <FiltersView meta={metaX} onOpen={openIssue} onWritten={onWritten} />}
            {sub === 'mine' && <MyWorkView rows={rows} stats={stats} meta={meta} onOpen={openIssue} onWritten={onWritten} />}
            {sub === 'activity' && <ActivityView meta={meta} onOpen={openIssue} />}
          </>
        )}
    </div>
  );
}

function PersistWarn({ persist }) {
  if (!persist || persist.state === 'saved' || persist.state === 'pending') return null;
  return (
    <div className="banner bad" style={{ whiteSpace: 'normal' }}>
      <b>이슈 저장 실패 — 최근 변경이 서버 디스크에 저장되지 않았습니다.</b>
      <div style={{ fontSize: 12.5 }}>화면에는 보이지만 포탈이 다시 시작되면 사라질 수 있습니다. {persist.retrying ? '자동으로 다시 저장합니다.' : '다음 변경 때 다시 저장합니다.'}
        {persist.lastWriteError ? ` 원인: ${persist.lastWriteError.message}(${persist.lastWriteError.code})` : ''}</div>
    </div>
  );
}


function FilterBar({ filters, setF, meta, sub, onReset }) {
  const people = peopleOptions(meta.people);
  const any = filters.q || filters.assignee || filters.priority || filters.type || filters.status || filters.vcenterId || filters.mine;
  const vcs = meta.vcenters || [];
  return (
    <div className="iss-filters">
      <input className="input iss-search" value={filters.q} onChange={setF('q')} placeholder="키·제목·담당자·라벨 검색" maxLength={100} />
      <Select className="select" value={filters.assignee} onChange={setF('assignee')} aria-label="담당자">
        <option value="">담당자: 전체</option>
        <option value="__none" data-pin>미할당</option>
        {people.map((p) => <option key={p.username} value={p.username}>{p.label}</option>)}
      </Select>
      <Select className="select" value={filters.priority} onChange={setF('priority')} sort={false} aria-label="우선순위">
        <option value="">우선순위: 전체</option>
        {(meta.priorities || []).map((p) => <option key={p} value={p}>{PRIORITY_TEXT[p] || p}</option>)}
      </Select>
      <Select className="select" value={filters.type} onChange={setF('type')} sort={false} aria-label="유형">
        <option value="">유형: 전체</option>
        {(meta.types || []).map((t) => <option key={t} value={t}>{TYPE_TEXT[t] || t}</option>)}
      </Select>
      {vcs.length > 0 && (
        <Select className="select" value={filters.vcenterId} onChange={setF('vcenterId')} aria-label="법인">
          <option value="">법인: 전체</option>
          {!meta.scoped && <option value="__none" data-pin>공용(법인 없음)</option>}
          {vcs.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
        </Select>
      )}
      {sub === 'list' && (
        <Select className="select" value={filters.status} onChange={setF('status')} sort={false} aria-label="상태">
          <option value="">상태: 전체</option>
          {STATUS_ORDER.map((s) => <option key={s} value={s}>{STATUS_TEXT[s]}</option>)}
        </Select>
      )}
      <label className="iss-check"><input type="checkbox" checked={filters.mine} onChange={setF('mine')} /> 내 이슈만</label>
      {any && <button className="btn" onClick={onReset}>초기화</button>}
    </div>
  );
}

/* ───────────── 보드 ───────────── */

function BoardView({ rows, meta, onOpen, recentDays }) {
  const g = groupByStatus(rows);
  return (
    <div className="iss-board-wrap">
      <div className="iss-board">
        {STATUS_ORDER.map((s) => (
          <section key={s} className="iss-col" aria-label={STATUS_TEXT[s]}>
            <div className="iss-col-head">
              <StatusChip s={s} />
              <span className="muted" style={{ fontSize: 12 }}>{s === 'done' ? `최근 ${recentDays}일 · ${g[s].length}` : g[s].length}</span>
            </div>
            {g[s].length === 0 && <div className="muted iss-col-empty">없음</div>}
            {g[s].map((r) => <IssueCard key={r.key} r={r} meta={meta} onOpen={onOpen} />)}
          </section>
        ))}
      </div>
      {g.unknown.length > 0 && <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>알 수 없는 상태의 이슈 {g.unknown.length}건은 목록 화면에서 보입니다.</div>}
    </div>
  );
}

function IssueCard({ r, meta, onOpen }) {
  return (
    <button type="button" className={`iss-card${r.status === 'done' ? ' done' : ''}${r.epicKey ? ' has-epic' : ''}`} style={r.epicKey ? { borderLeftColor: epicColor(r.epicKey) } : undefined} onClick={() => onOpen(r.key)}>
      <span className="iss-card-top">
        <TypeTag t={r.type} />
        <span className="iss-key">{r.key}</span>
        {r.blocked && <span className="iss-chip s-blocked" title={r.blocked.reason}>보류</span>}
        {r.blockedOpen > 0 && <span className="iss-chip s-linkblock" title="이 이슈를 막고 있는 열린 이슈가 있습니다(연결)">차단됨 {r.blockedOpen}</span>}
        {(meta?.vcenters || []).length > 0 && <span className="iss-vc" title="법인(vCenter)">{vcName(meta, r.vcenterId)}</span>}
        {r.origin && <span className="iss-auto" title={originText(r.origin)}>자동</span>}
        {childText(r) && <span className="iss-subn">{childText(r)}</span>}
        {r.parentKey && r.parentKey !== r.epicKey && <span className="iss-subn">하위 · {r.parentKey}</span>}
        {r.sprintId && <span className="iss-subn" title="스프린트">{sprintName(meta?.sprintList, r.sprintId)}</span>}
      </span>
      <span className="iss-card-title">{r.title}</span>
      <ProgressLine r={r} />
      <span className="iss-card-foot">
        <PrioTag p={r.priority} />
        <Due r={r} />
        <span className="iss-grow" />
        {r.comments > 0 && <span className="muted" style={{ fontSize: 11.5, whiteSpace: 'nowrap' }}>댓글 {r.comments}</span>}
        <Avatar name={r.assignee} />
      </span>
    </button>
  );
}

/* ───────────── 목록 + 일괄 할당 ───────────── */

function ListView({ rows, total, meta, epics, onOpen, onWritten }) {
  const [sel, setSel] = useState(() => new Set());
  const [to, setTo] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const canWrite = !!meta.canWrite;
  // 감사 A1-02: 쓰기 범위 밖 행(서버 writable:false)은 일괄 선택에서 뺀다 — 누르면 403 이 되는 선택을 만들지 않는다.
  const visibleKeys = rows.filter((r) => r.writable !== false).map((r) => r.key);
  const picked = visibleKeys.filter((k) => sel.has(k));
  const allOn = picked.length > 0 && picked.length === visibleKeys.length;
  const toggle = (k) => setSel((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const toggleAll = () => setSel(allOn ? new Set() : new Set(visibleKeys));
  const people = peopleOptions(meta.people);
  const bulk = async () => {
    setBusy(true); setMsg('');
    try {
      const r = await postJson('/issues/bulk/assign', { keys: picked, assignee: to === '__none' ? '' : to });
      if (r?.ok) {
        const bad = (r.results || []).filter((x) => !x.ok);
        setMsg(`${r.done}건 할당했습니다${bad.length ? ` · ${bad.length}건 실패(${bad.map((x) => `${x.key}: ${x.reason}`).join(' / ')})` : ''}.`);
        setSel(new Set()); onWritten(r);
      } else setMsg(saveFailText(r));
    } catch (e) { setMsg(saveFailText({ reason: e.message })); } finally { setBusy(false); }
  };
  return (
    <div className="card">
      {canWrite && picked.length > 0 && (
        <div className="iss-bulk">
          <b>{picked.length}건 선택됨</b>
          <Select className="select" value={to} onChange={(e) => setTo(e.target.value)} aria-label="일괄 할당 담당자">
            <option value="">담당자 선택…</option>
            <option value="__none" data-pin>할당 해제</option>
            {people.map((p) => <option key={p.username} value={p.username}>{p.label}</option>)}
          </Select>
          <button className="btn primary" disabled={busy || !to} onClick={bulk}>{busy ? '할당 중…' : '담당자 일괄 할당'}</button>
          <button className="btn" onClick={() => setSel(new Set())}>선택 해제</button>
        </div>
      )}
      {canWrite && picked.length > 0 && <BulkEditBar keys={picked} meta={meta} epics={epics} onDone={(r) => { setSel(new Set()); onWritten(r); }} />}
      {msg && <div className="banner">{msg}</div>}
      {rows.length === 0
        ? <div className="muted" style={{ padding: 16 }}>{total ? '조건에 맞는 이슈가 없습니다.' : '아직 이슈가 없습니다.'}</div>
        : (
          <STable className="v3-table" minWidth={1120}>
            <thead>
              <tr>
                {canWrite && <th data-nosort style={{ width: 34 }}><input type="checkbox" checked={allOn} onChange={toggleAll} aria-label="보이는 이슈 전체 선택" /></th>}
                <th>키</th><th>유형</th><th>제목</th><th>법인</th><th>상태</th><th>진행</th><th>우선순위</th><th>담당자</th><th>보고자</th><th>기한</th><th>갱신</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key} className={sel.has(r.key) ? 'iss-sel' : ''}>
                  {canWrite && <td>{r.writable !== false ? <input type="checkbox" checked={sel.has(r.key)} onChange={() => toggle(r.key)} aria-label={`${r.key} 선택`} /> : <span className="muted" title="쓰기 범위 밖 법인 — 조회만">—</span>}</td>}
                  <td data-sort={r.num} className="iss-key">{r.key}</td>
                  <td><TypeTag t={r.type} /></td>
                  <td style={{ whiteSpace: 'normal' }}>
                    <button type="button" className="iss-link" onClick={() => onOpen(r.key)}>{r.title}</button>
                    {r.blocked && <span className="iss-chip s-blocked" style={{ marginLeft: 6 }} title={r.blocked.reason}>보류</span>}
                    {r.blockedOpen > 0 && <span className="iss-chip s-linkblock" style={{ marginLeft: 6 }} title="이 이슈를 막고 있는 열린 이슈가 있습니다(연결)">차단됨 {r.blockedOpen}</span>}
                    {r.origin && <span className="iss-auto" style={{ marginLeft: 6 }} title={originText(r.origin)}>자동</span>}
                    {/* v2.882 에픽 · 하위 · 스프린트는 제목 아래 작은 표시 — 열로 두면 1440px 에서 표가 본문 폭을 넘어 기한 · 갱신이 가로 스크롤 뒤로 숨었다(Chromium 판독).
                        에픽 · 스프린트로 정렬하려면 필터 화면의 결과 표(열이 따로 있다)를 쓴다. */}
                    {(r.epicKey || r.sprintId || childText(r) || (r.parentKey && r.parentKey !== r.epicKey)) && (
                      <span className="iss-row-tags">
                        {r.epicKey && <span className="iss-epic-tag" style={{ borderColor: epicColor(r.epicKey) }}>{r.epicKey}</span>}
                        {r.parentKey && r.parentKey !== r.epicKey && <span className="iss-subn">하위 · {r.parentKey}</span>}
                        {childText(r) && <span className="iss-subn">{childText(r)}</span>}
                        {r.sprintId && <span className="iss-subn" title="스프린트">{sprintName(meta.sprintList, r.sprintId)}</span>}
                      </span>
                    )}
                  </td>
                  <td data-sort={r.vcenterId ? vcName(meta, r.vcenterId) : '~'}>{r.vcenterId ? <span className="iss-vc-cell" title={vcName(meta, r.vcenterId)}>{vcName(meta, r.vcenterId)}</span> : <span className="muted">공용</span>}</td>
                  <td data-sort={STATUS_ORDER.indexOf(r.status)}><StatusChip s={r.status} /></td>
                  <td data-sort={progressOf(r) ?? ''}><ProgressLine r={r} compact /></td>
                  <td data-sort={r.priority}><PrioTag p={r.priority} /></td>
                  <td data-sort={r.assignee || '~'}>{r.assignee ? <span className="iss-who"><Avatar name={r.assignee} size={22} />{r.assignee}</span> : <span className="iss-unassigned">미할당</span>}</td>
                  <td>{r.reporter}</td>
                  <td data-sort={r.dueAt ?? ''}><Due r={r} /></td>
                  <td data-sort={r.updatedAt} className="muted" style={{ whiteSpace: 'nowrap' }} title={timeText(r.updatedAt)}>{dateText(r.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </STable>
        )}
      <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
        표시 {rows.length}건 · 열린 이슈와 최근 {Math.round((meta.recentDoneMs || 0) / 86400000)}일 안에 완료된 이슈 {total}건 중 · 제목 머리를 누르면 정렬합니다
      </div>
    </div>
  );
}

/* ───────────── 내 작업 ───────────── */

function MyWorkView({ rows, stats, meta, onOpen, onWritten }) {
  const w = useMemo(() => myWork(rows, meta.me), [rows, meta.me]);
  const canWrite = !!meta.canWrite;
  const [msg, setMsg] = useState('');
  const assignMe = async (key) => {
    setMsg('');
    try { const r = await postJson(`/issues/${key}/assign`, { assignee: meta.me }); if (r?.ok) onWritten(r); else setMsg(saveFailText(r)); } catch (e) { setMsg(saveFailText({ reason: e.message })); }
  };
  const tiles = [
    ['내 열린 이슈', w.mine.length, ''], ['기한 초과', w.overdue, w.overdue ? 'over' : ''], ['오늘~모레 마감', w.soon, w.soon ? 'soon' : ''], ['보류', w.blocked, ''],
  ];
  return (
    <div className="iss-mine">
      <div className="iss-tiles">
        {tiles.map(([label, n, tone]) => <div key={label} className="card iss-tile"><span className={`iss-tile-n ${tone}`}>{n}</span><span className="muted">{label}</span></div>)}
      </div>
      {msg && <div className="banner">{msg}</div>}
      <div className="iss-mine-grid">
        <div className="iss-mine-col">
          <MiniList title={`내 이슈 · ${w.mine.length}건 · 기한순`} rows={w.mine} onOpen={onOpen} empty="나에게 할당된 열린 이슈가 없습니다." />
          <MyRequests rows={rows} me={meta.me} recentDays={Math.round((meta.recentDoneMs || 0) / 86400000)} onOpen={onOpen} />
        </div>
        <div className="iss-mine-col">
          <div className="card iss-queue">
            <h3 className="iss-h3">미할당 대기열 · {w.unassigned.length}건</h3>
            {w.unassigned.length === 0 && <div className="muted">미할당 이슈가 없습니다.</div>}
            {w.unassigned.slice(0, 20).map((r) => (
              <div key={r.key} className="iss-row">
                <span className="iss-key">{r.key}</span>
                <button type="button" className="iss-link iss-row-title" onClick={() => onOpen(r.key)}>{r.title}</button>
                <PrioTag p={r.priority} />
                <Due r={r} />
                {canWrite && r.writable !== false && <button className="btn btn-sm" onClick={() => assignMe(r.key)}>나에게 할당</button>}
              </div>
            ))}
            {w.unassigned.length > 20 && <div className="muted" style={{ fontSize: 12 }}>앞 20건만 표시 — 나머지는 목록에서 ‘담당자: 미할당’ 으로 보세요.</div>}
          </div>
          <div className="card">
            <h3 className="iss-h3">팀 할당 현황 · 열린 이슈</h3>
            {(stats?.byAssignee || []).length === 0 && <div className="muted">할당된 열린 이슈가 없습니다.</div>}
            {(stats?.byAssignee || []).map((a) => (
              <div key={a.assignee} className="iss-load">
                <Avatar name={a.assignee} size={24} />
                <span className="iss-load-name" title={a.assignee}>{a.assignee}</span>
                <span className="iss-bar" role="img" aria-label={`${a.assignee} 열린 이슈 ${a.open}`}><span style={{ width: `${loadPct(a.open)}%` }} /></span>
                <span className="iss-load-n"><b>{a.open}</b>{a.progress ? ` · 진행 ${a.progress}` : ''}{a.review ? ` · 검토 ${a.review}` : ''}{a.overdue ? <span className="iss-due over"> · 초과 {a.overdue}</span> : ''}</span>
              </div>
            ))}
            <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>막대는 1인당 열린 이슈 {LOAD_CAP}건을 가득으로 그린 표시 기준입니다(제한이 아닙니다). {stats?.unassigned != null ? `미할당 ${stats.unassigned}건은 위 대기열에 있습니다.` : '미할당 이슈는 위 대기열에 있습니다.'}</div>
          </div>
        </div>
      </div>
    </div>
  );
}

function MiniList({ title, rows, onOpen, empty, showAssignee = false }) {
  return (
    <div className="card">
      <h3 className="iss-h3">{title}</h3>
      {rows.length === 0 && <div className="muted">{empty}</div>}
      {rows.map((r) => (
        <div key={r.key} className="iss-row">
          <TypeTag t={r.type} />
          <span className="iss-key">{r.key}</span>
          <button type="button" className="iss-link iss-row-title" onClick={() => onOpen(r.key)}>{r.title}</button>
          {r.blocked && <span className="iss-chip s-blocked" title={r.blocked.reason}>보류</span>}
          <StatusChip s={r.status} />
          <PrioTag p={r.priority} />
          <Due r={r} />
          {showAssignee && <Avatar name={r.assignee} size={22} />}
        </div>
      ))}
    </div>
  );
}

/* ───────────── 진행 공유(v2.871) ───────────── */

/** 진행률 막대 + 멈춤 표시. 보고가 없으면 막대를 그리지 않는다(0% 로 그리지 않는다 — 없음과 0 은 다르다). */

/** 내 요청 진행 현황 — 내가 등록한 이슈를 누가 맡아 어디까지 왔는지(최근 완료 포함). */
function MyRequests({ rows, me, recentDays, onOpen }) {
  const { open, done } = useMemo(() => myRequests(rows, me), [rows, me]);
  const row = (r) => (
    <div key={r.key} className="iss-req">
      <div className="iss-req-top">
        <span className="iss-key">{r.key}</span>
        <button type="button" className="iss-link iss-row-title" onClick={() => onOpen(r.key)}>{r.title}</button>
        <StatusChip s={r.status} />
      </div>
      <div className="iss-req-foot">
        {r.assignee ? <span className="iss-who"><Avatar name={r.assignee} size={20} />{r.assignee}</span> : <span className="iss-unassigned">담당자 배정 대기</span>}
        <ProgressLine r={r} />
        {r.progressNote && r.status !== 'done' && <span className="muted iss-req-note" title={r.progressNote}>{r.progressNote}</span>}
        <span className="iss-grow" />
        <span className="muted" style={{ fontSize: 11.5, whiteSpace: 'nowrap' }} title={timeText(r.status === 'done' ? (r.closedAt || r.updatedAt) : r.updatedAt)}>
          {r.status === 'done' ? `완료 ${dateText(r.closedAt || r.updatedAt)}` : `갱신 ${dateText(r.updatedAt)}`}
        </span>
      </div>
    </div>
  );
  return (
    <div className="card">
      <h3 className="iss-h3">내 요청 진행 현황 · 진행 {open.length}건 · 최근 완료 {done.length}건</h3>
      {open.length + done.length === 0 && <div className="muted">내가 등록한 이슈가 없습니다(완료는 최근 {recentDays}일 것만 보입니다).</div>}
      {open.map(row)}
      {done.length > 0 && <div className="muted iss-req-sep">최근 {recentDays}일 안에 완료</div>}
      {done.slice(0, 10).map(row)}
      {done.length > 10 && <div className="muted" style={{ fontSize: 12 }}>완료 앞 10건만 표시 — 나머지는 목록에서 ‘상태: 완료’ 로 보세요.</div>}
    </div>
  );
}

const ACTIVITY_PAGE = 100;
/** 팀 활동 피드 — 서버가 볼 수 있는 이슈의 변경만 준다. 폴링하지 않는다(마운트 1회 + 새로고침). */
function ActivityView({ meta, onOpen }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const [who, setWho] = useState('');
  const latest = useLatest();
  const load = useCallback(() => {
    const k = latest.next();
    fetchJson('/issues/activity', { limit: ACTIVITY_PAGE }).then((r) => { if (latest.isLatest(k)) { setD(r); setErr(null); } }).catch((e) => { if (latest.isLatest(k)) setErr(e); });
  }, [latest]);
  useEffect(() => { load(); }, [load]);
  if (err && !d) return <ErrorBox error={err} />;
  if (!d) return <Loading label="활동" />;
  const items = (d.items || []).filter((a) => !who || a.by === who);
  const people = [...new Set((d.items || []).map((a) => a.by).filter(Boolean))].sort();
  let lastDay = '';
  return (
    <div className="card iss-activity">
      <div className="iss-filters">
        <Select className="select" value={who} onChange={(e) => setWho(e.target.value)} aria-label="사람">
          <option value="">사람: 전체</option>
          {people.map((p) => <option key={p} value={p}>{p}</option>)}
        </Select>
        <button className="btn" onClick={load}>새로고침</button>
        <span className="muted" style={{ fontSize: 12 }}>할당·상태·진행률·보류·댓글을 최신순으로 보여 줍니다{meta.scoped ? ' — 내 법인 이슈만' : ''}.</span>
      </div>
      {err && <div className="banner">새로 읽지 못했습니다 — 아래는 직전에 읽은 활동입니다.</div>}
      {items.length === 0 && <div className="muted" style={{ padding: 12 }}>표시할 활동이 없습니다.</div>}
      <ol className="iss-feed">
        {items.map((a, i) => {
          const day = dateText(a.at);
          const head = day !== lastDay ? day : '';
          lastDay = day;
          return (
            <li key={`${a.key}-${a.at}-${i}`}>
              {head && <div className="iss-feed-day">{head}</div>}
              <div className="iss-feed-row">
                <Avatar name={a.by} size={24} />
                <div className="iss-feed-main">
                  <div><button type="button" className="iss-link" onClick={() => onOpen(a.key)}><span className="iss-key">{a.key}</span> {a.title}</button></div>
                  <div className="iss-feed-text">{activityText(a)}</div>
                </div>
                <span className="muted iss-feed-at" title={timeText(a.at)}>{timeText(a.at).slice(-5)}</span>
              </div>
            </li>
          );
        })}
      </ol>
      {d.truncated && <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>최근 {d.limit}건만 보입니다. 이슈마다 최근 이력 20건·댓글 5건까지 훑습니다.</div>}
    </div>
  );
}

/** 상세 옆 진행률 상자 — 누구나 보고, 쓰기 가능한 사람만 고친다(서버가 쓰기 범위를 다시 판정). */
function ProgressBox({ it, canWrite, busy, act, noteMax }) {
  const pct = progressOf(it);
  const [open, setOpen] = useState(false);
  const [v, setV] = useState('');
  const [note, setNote] = useState('');
  const st = it.status === 'done' ? null : staleInfo(it);
  const start = () => { setV(pct == null ? '' : String(pct)); setNote(it.progressNote || ''); setOpen(true); };
  const n = v === '' ? null : Number(v);
  const bad = v !== '' && !(Number.isInteger(n) && n >= 0 && n <= 100);
  return (
    <div className="iss-prop">
      <span className="iss-prop-l">진행률</span>
      {pct != null
        ? <span className="iss-prog big"><span className="iss-prog-bar"><span style={{ width: `${pct}%` }} /></span><b>{pct}%</b></span>
        : <span className="muted">보고 없음</span>}
      {it.progressAuto && <span className="muted" style={{ fontSize: 11.5 }}>{it.type === 'epic' ? '소속 이슈' : '하위 작업'} {it.childDone}/{it.childCount} 완료에서 계산 — {it.type === 'epic' ? '이슈를 모두 빼면' : '하위 작업을 모두 지우면'} 다시 직접 입력할 수 있습니다.</span>}
      {it.progressNote && <span className="iss-prog-note">{it.progressNote}</span>}
      {it.progressAt && <span className="muted" style={{ fontSize: 11.5 }}>{it.progressBy} · {timeText(it.progressAt)}</span>}
      {st && <span className="iss-stale">{st.text} — {STALE_DAYS}일 넘게 갱신이 없습니다</span>}
      {canWrite && !open && <button className="btn" disabled={busy} onClick={start}>진행 상황 갱신</button>}
      {canWrite && open && (
        <div className="iss-prog-edit">
          {!it.progressAuto && (
            <label className="iss-inline">진행률(%)
              <input className="input" type="number" min={0} max={100} step={5} value={v} onChange={(e) => setV(e.target.value)} aria-label="진행률" />
            </label>
          )}
          <textarea className="input" rows={2} value={note} maxLength={noteMax} onChange={(e) => setNote(e.target.value)} placeholder="진행 메모 — 예: ESXi 3대 중 2대 완료, 내일 마무리" aria-label="진행 메모" />
          {bad && <span className="iss-due over" style={{ fontSize: 12 }}>0~100 의 정수를 넣으세요(비우면 ‘보고 없음’).</span>}
          <div className="flex" style={{ gap: 6 }}>
            <button className="btn primary" disabled={busy || (bad && !it.progressAuto)} onClick={() => act(() => postJson(`/issues/${it.key}/progress`, it.progressAuto ? { note } : { progress: n, note }), '진행 상황을 갱신했습니다.').then((ok) => { if (ok) setOpen(false); })}>저장</button>
            <button className="btn" disabled={busy} onClick={() => setOpen(false)}>취소</button>
          </div>
        </div>
      )}
    </div>
  );
}

/** 공유 링크 복사 — 받는 사람도 로그인해야 열리고, 볼 수 없는 법인의 이슈면 서버가 404 를 준다. */
function CopyLink({ issueKey }) {
  const [state, setState] = useState('');
  const url = issueLink(issueKey);
  const copy = async () => {
    try { await navigator.clipboard.writeText(url); setState('ok'); setTimeout(() => setState(''), 2000); } catch { setState('manual'); }
  };
  if (!url) return null;
  return (
    <>
      <button className="btn" onClick={copy} title="이 이슈 주소를 복사합니다 — 받는 사람도 로그인해야 열립니다">{state === 'ok' ? '복사했습니다' : '링크 복사'}</button>
      {state === 'manual' && <input className="input iss-linkbox" readOnly value={url} onFocus={(e) => e.target.select()} aria-label="이슈 링크 — 직접 복사하세요" />}
    </>
  );
}

/* ───────────── 새 이슈 · 수정 ───────────── */

function IssueEditor({ meta, initial = null, requestOnly = false, onCancel, onSaved }) {
  const vcOpts = vcenterOptions(meta, initial ? (initial.vcenterId || '') : null);
  const needVc = vcenterRequired(meta);
  const [f, setF] = useState(() => ({
    title: initial?.title || '', body: initial?.body || '', type: initial?.type || (requestOnly ? 'request' : 'task'), priority: initial?.priority || 'p2',
    assignee: initial ? (initial.assignee || '') : '', dueAt: toDateInput(initial?.dueAt), labels: (initial?.labels || []).join(', '), component: initial?.component || '',
    vcenterId: initial ? (initial.vcenterId || '') : (needVc ? (vcOpts[0]?.id || '') : ''),
  }));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [sug, setSug] = useState(null); // { suggestion, autoAssign } — 새 이슈 창에서만
  const latest = useLatest();
  // 담당자 제안 — 컴포넌트·법인이 바뀌면 잠깐 뒤 다시 묻는다(타자마다 묻지 않게). 늦게 온 이전 응답은 버린다.
  useEffect(() => {
    if (initial) return undefined;
    const t = setTimeout(() => {
      const k = latest.next();
      fetchJson('/issues/suggest', { component: f.component, vcenterId: f.vcenterId })
        .then((r) => { if (latest.isLatest(k)) setSug(r); })
        .catch(() => { if (latest.isLatest(k)) setSug(null); });
    }, 400);
    return () => clearTimeout(t);
  }, [initial, f.component, f.vcenterId, latest]);
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  const people = peopleOptions(meta.people, f.assignee);
  const s = sug?.suggestion;
  const save = async () => {
    setBusy(true); setMsg('');
    const payload = { title: f.title, body: f.body, priority: f.priority, dueAt: fromDateInput(f.dueAt), labels: parseLabels(f.labels), component: f.component, vcenterId: f.vcenterId };
    if (!requestOnly) payload.type = f.type;
    try {
      const r = initial ? await putJson(`/issues/${initial.key}`, payload) : await postJson('/issues', requestOnly ? payload : { ...payload, assignee: f.assignee });
      if (r?.ok) onSaved(r); else setMsg(saveFailText(r));
    } catch (e) { setMsg(saveFailText({ reason: e.message })); } finally { setBusy(false); }
  };
  const title = initial ? `${initial.key} 수정` : requestOnly ? '요청 등록' : '새 이슈 만들기';
  return (
    <div className="card iss-editor">
      <h3 className="iss-h3">{title}</h3>
      {requestOnly && <div className="muted" style={{ fontSize: 12.5 }}>요청 유형으로 백로그에 등록합니다. 담당자·상태는 운영자가 정합니다{sug?.autoAssign ? '(자동 할당 규칙이 켜져 있으면 담당자가 바로 정해집니다)' : ''}.</div>}
      <label className="iss-field">제목<input className="input" value={f.title} onChange={set('title')} maxLength={meta.limits?.title || 200} placeholder="무엇이 문제인지 한 줄로" /></label>
      <label className="iss-field">설명<textarea className="input" rows={5} value={f.body} onChange={set('body')} maxLength={meta.limits?.body || 10000} placeholder="재현 절차 · 기대 결과 · 관련 장비" /></label>
      <div className="iss-form-grid">
        {vcOpts.length > 0 && (
          <label className="iss-field">법인(vCenter){needVc ? ' *' : ''}<Select className="select" value={f.vcenterId} onChange={set('vcenterId')}>
            {vcOpts.map((v) => <option key={v.id || '__pub'} value={v.id} data-pin={v.id === '' ? true : undefined}>{v.label}</option>)}
          </Select></label>
        )}
        {!requestOnly && <label className="iss-field">유형<Select className="select" value={f.type} onChange={set('type')} sort={false}>{(meta.types || []).map((t) => <option key={t} value={t}>{TYPE_TEXT[t] || t}</option>)}</Select></label>}
        <label className="iss-field">우선순위<Select className="select" value={f.priority} onChange={set('priority')} sort={false}>{(meta.priorities || []).map((p) => <option key={p} value={p}>{PRIORITY_TEXT[p] || p}</option>)}</Select></label>
        {!initial && !requestOnly && (
          <label className="iss-field">담당자<Select className="select" value={f.assignee} onChange={set('assignee')}>
            <option value="">{s && sug?.autoAssign ? `비워 두면 자동: ${s.assignee}` : '미할당'}</option>
            {people.map((p) => <option key={p.username} value={p.username}>{p.label}</option>)}
          </Select></label>
        )}
        <label className="iss-field">기한<input className="input" type="date" value={f.dueAt} onChange={set('dueAt')} /></label>
        <label className="iss-field">컴포넌트<input className="input" value={f.component} onChange={set('component')} maxLength={meta.limits?.component || 60} placeholder="예: vCenter 수집기" list="iss-components" />
          <DataList id="iss-components">{(meta.components || []).map((c) => <option key={c} value={c} />)}</DataList>
        </label>
        <label className="iss-field">라벨(쉼표 구분)<input className="input" value={f.labels} onChange={set('labels')} placeholder="vcenter, 수집" /></label>
      </div>
      {!initial && !requestOnly && s && !f.assignee && (
        <div className="iss-suggest">
          <span>제안: <b>{s.assignee}</b> — {s.reason}{sug.autoAssign ? ' · 비워 두면 이 사람에게 자동 할당합니다' : ''}</span>
          <button type="button" className="btn btn-sm" onClick={() => setF((x) => ({ ...x, assignee: s.assignee }))}>적용</button>
        </div>
      )}
      {!initial && needVc && vcOpts.length === 0 && <div className="banner warn">쓰기 가능한 법인(vCenter)이 없어 이슈를 만들 수 없습니다 — 관리자에게 수정 가능 vCenter 지정을 요청하세요.</div>}
      {!initial && !requestOnly && sug?.hidden && !f.assignee && <div className="muted" style={{ fontSize: 12 }}>{sug.autoAssign ? '담당자를 비워 두면 자동 할당 규칙이 정합니다.' : '자동 할당 규칙에 이 법인의 담당자 후보가 있습니다.'}</div>}
      {msg && <div className="banner">{msg}</div>}
      <div className="flex" style={{ gap: 6, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
        <button className="btn" onClick={onCancel} disabled={busy}>취소</button>
        <button className="btn primary" onClick={save} disabled={busy || !f.title.trim() || (needVc && !f.vcenterId)}>{busy ? '저장 중…' : initial ? '저장' : requestOnly ? '요청 등록' : '이슈 만들기'}</button>
      </div>
    </div>
  );
}

/* ───────────── 상세 ───────────── */

function IssueDetail({ issueKey, meta, onBack, onOpen, onWritten }) {
  const [x, setX] = useState(null);
  const [err, setErr] = useState(null);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [comment, setComment] = useState('');
  const [tab, setTab] = useState('comments');
  const [blockReason, setBlockReason] = useState('');
  const [blockOpen, setBlockOpen] = useState(false);
  const latest = useLatest();
  const load = useCallback(() => {
    const k = latest.next();
    fetchJson(`/issues/${issueKey}`).then((r) => { if (latest.isLatest(k)) { setX(r); setErr(null); } }).catch((e) => { if (latest.isLatest(k)) setErr(e); });
  }, [issueKey, latest]);
  useEffect(() => { load(); }, [load]);

  if (err && !x) return <div><button className="btn" onClick={onBack}>← 돌아가기</button><div style={{ marginTop: 10 }}><ErrorBox error={err} /></div></div>;
  if (!x) return <Loading label={issueKey} />;
  const it = x.issue;
  // v2.871: 쓰기 역할이어도 이 이슈의 법인이 쓰기 범위 밖이면(서버 writable:false) 버튼을 잠근다 — 누르면 403 이 되는 버튼을 보이지 않는다.
  const roScope = !!x.canWrite && it.writable === false;
  const canWrite = !!x.canWrite && !roScope;
  const act = async (fn, okMsg = '') => {
    setBusy(true); setMsg('');
    try {
      const r = await fn();
      if (r?.ok) {
        if (r.issue) setX((cur) => ({ ...cur, issue: r.issue }));
        const pn = persistNote(r.persist);
        setMsg([okMsg, pn].filter(Boolean).join(' '));
        onWritten(r);
        if (!r.issue) load();
        return true;
      }
      setMsg(saveFailText(r)); return false;
    } catch (e) { setMsg(saveFailText({ reason: e.message })); return false; } finally { setBusy(false); }
  };
  const people = peopleOptions(meta.people, it.assignee);
  // v2.882: 남은 하위 작업(에픽이면 소속 이슈)이 있으면 서버가 409(open-children)로 묻는다 — 확인을 받고 한꺼번에 완료로 다시 보낸다
  // v2.883: 막고 있는 열린 이슈(open-blockers)도 같은 방식으로 묻는다 — 확인할 것이 여럿이면 차례로(최대 3번)
  const statusAct = (st) => act(async () => {
    let extra = {};
    for (let n = 0; n < 3; n += 1) {
      const r = await postJson(`/issues/${it.key}/status`, { status: st, ...extra });
      const ask = statusConfirmText(r);
      if (!ask) return r;
      if (!window.confirm(ask)) return { ok: false, reason: '완료를 취소했습니다 — 아무것도 바꾸지 않았습니다.' };
      extra = { ...extra, [STATUS_CONFIRM_FLAG[r.code]]: true };
    }
    return { ok: false, reason: '확인을 여러 번 받았지만 완료하지 못했습니다 — 다시 시도하세요.' };
  });
  const nextStatus = { backlog: 'todo', todo: 'progress', progress: 'review', review: 'done' }[it.status];
  const mineComment = (c) => !!x.isMod || c.author === x.me;

  return (
    <div className="iss-detail">
      <div className="iss-detail-main">
        <div className="card">
          <button className="btn" onClick={onBack}>← 돌아가기</button>
          {editing
            ? <div style={{ marginTop: 10 }}><IssueEditor meta={meta} initial={it} onCancel={() => setEditing(false)} onSaved={(r) => { setEditing(false); setX((cur) => ({ ...cur, issue: r.issue })); setMsg(persistNote(r.persist)); onWritten(r); }} /></div>
            : (
              <>
                <div className="iss-detail-meta"><TypeTag t={it.type} /><span className="iss-key">{it.key}</span><span className="muted">· {it.reporter} 등록 · {timeText(it.createdAt)}</span>
                  {it.origin && <><span className="iss-auto">{originText(it.origin)}</span><a href="#/tools/part-faults" style={{ fontSize: 12 }}>파트 장애 화면 →</a></>}
                </div>
                {(it.epic || (it.parent && it.parent.type !== 'epic')) && (
                  <div className="iss-crumb">
                    {it.epic && <button type="button" className="iss-link" onClick={() => onOpen(it.epic.key)}><span className="iss-epic-dot" style={{ background: epicColor(it.epic.key) }} />에픽 {it.epic.key} {it.epic.title}</button>}
                    {it.parent && it.parent.type !== 'epic' && <>{it.epic && ' › '}<button type="button" className="iss-link" onClick={() => onOpen(it.parent.key)}>{it.parent.key} {it.parent.title}</button></>}
                    <span> ›</span>
                  </div>
                )}
                <h2 className="iss-title">{it.title}{it.sprint && <span className="iss-subn" title="스프린트">{it.sprint.name}</span>}</h2>
                <div className="iss-actions">
                  {canWrite
                    ? (
                      <>
                        <label className="iss-inline">상태
                          <Select className="select" value={it.status} sort={false} disabled={busy} onChange={(e) => statusAct(e.target.value)}>
                            {STATUS_ORDER.map((s) => <option key={s} value={s}>{STATUS_TEXT[s]}</option>)}
                          </Select>
                        </label>
                        {nextStatus && <button className="btn primary" disabled={busy} onClick={() => statusAct(nextStatus)}>{STATUS_TEXT[nextStatus]}(으)로</button>}
                        {it.blocked
                          ? <button className="btn" disabled={busy} onClick={() => act(() => postJson(`/issues/${it.key}/block`, { on: false }))}>보류 해제</button>
                          : <button className="btn" disabled={busy} onClick={() => setBlockOpen((v) => !v)}>보류로 표시</button>}
                        <button className="btn" disabled={busy} onClick={() => setEditing(true)}>수정</button>
                        {(x.isMod || it.reporter === x.me) && <button className="btn" disabled={busy} onClick={() => { if (window.confirm(`${it.key} 를 지울까요? 댓글·이력도 함께 지워집니다.`)) act(() => delJson(`/issues/${it.key}`)).then((ok) => { if (ok) onBack(); }); }}>삭제</button>}
                      </>
                    )
                    : <><StatusChip s={it.status} /><span className="muted" style={{ fontSize: 12 }}>{roScope ? '이 법인은 쓰기 범위 밖이라 조회만 할 수 있습니다' : '상태 변경·할당은 운영자·관리자만 할 수 있습니다'}</span></>}
                  <CopyLink issueKey={it.key} />
                </div>
                {blockOpen && !it.blocked && (
                  <div className="iss-blockbox">
                    <input className="input" value={blockReason} onChange={(e) => setBlockReason(e.target.value)} maxLength={500} placeholder="보류 사유(필수) — 예: ISS-12 처리 대기" />
                    <button className="btn primary" disabled={busy || !blockReason.trim()} onClick={() => act(() => postJson(`/issues/${it.key}/block`, { on: true, reason: blockReason })).then((ok) => { if (ok) { setBlockOpen(false); setBlockReason(''); } })}>보류</button>
                  </div>
                )}
                {it.blocked && <div className="banner warn" style={{ whiteSpace: 'normal' }}><b>보류</b> — {it.blocked.reason} <span className="muted">({it.blocked.by} · {timeText(it.blocked.at)})</span></div>}
                {msg && <div className="banner">{msg}</div>}
                {/* v2.883 본문은 위키와 같은 렌더러(HTML 미해석 · 안전 주소만) — 줄 하나 바꿈은 그대로 줄바꿈(평문으로 쓴 예전 본문이 한 줄로 붙지 않게) */}
                <div className="iss-body md">{it.body ? <MdView md={it.body} compact breaks unresolvedAsSearch idPrefix={`i${it.key}`} /> : <span className="muted">설명이 없습니다.</span>}</div>
                <ChildrenBox it={it} meta={meta} canWrite={canWrite} busy={busy} act={act} onOpen={onOpen} />
                <LinksBox it={it} meta={meta} canWrite={canWrite} busy={busy} act={act} onOpen={onOpen} />
              </>
            )}
        </div>
        <div className="card">
          <div className="flex" style={{ gap: 6, marginBottom: 8 }}>
            <button className={`btn${tab === 'comments' ? ' primary' : ''}`} onClick={() => setTab('comments')}>댓글 {it.comments.length}</button>
            <button className={`btn${tab === 'history' ? ' primary' : ''}`} onClick={() => setTab('history')}>이력 {it.history.length}</button>
          </div>
          {tab === 'comments'
            ? (
              <>
                {it.comments.length === 0 && <div className="muted">아직 댓글이 없습니다.</div>}
                {it.comments.map((c) => (
                  <div key={c.id} className="iss-comment">
                    <Avatar name={c.author} size={26} />
                    <div className="iss-comment-main">
                      <div className="iss-comment-head"><b>{c.author}</b><span className="muted"> · {timeText(c.createdAt)}</span>
                        {canWrite && mineComment(c) && <button type="button" className="iss-mini-act" disabled={busy} onClick={() => { if (window.confirm('이 댓글을 지울까요?')) act(() => delJson(`/issues/${it.key}/comments/${c.id}`)); }}>삭제</button>}
                      </div>
                      <div className="iss-comment-body md"><MdView md={c.body} compact breaks unresolvedAsSearch idPrefix={`c${c.id}`} /></div>
                    </div>
                  </div>
                ))}
                {canWrite
                  ? (
                    <div className="iss-comment-new">
                      <textarea className="input" rows={2} value={comment} maxLength={meta.limits?.commentBody || 2000} onChange={(e) => setComment(e.target.value)} placeholder="댓글" aria-label="댓글" />
                      <button className="btn primary" disabled={busy || !comment.trim()} onClick={() => act(() => postJson(`/issues/${it.key}/comments`, { body: comment })).then((ok) => { if (ok) setComment(''); })}>댓글 달기</button>
                    </div>
                  )
                  : <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>{roScope ? '이 법인은 쓰기 범위 밖이라 댓글을 쓸 수 없습니다.' : '댓글은 운영자·관리자만 쓸 수 있습니다.'}</div>}
              </>
            )
            : (
              <ol className="iss-history">
                {[...it.history].reverse().map((h, i) => <li key={i}><span className="muted">{timeText(h.at)}</span> {historyText(h)}</li>)}
                {it.historyDropped > 0 && <li className="muted">오래된 이력 {it.historyDropped}건은 보관 상한을 넘어 지워졌습니다.</li>}
              </ol>
            )}
        </div>
      </div>

      <aside className="card iss-side" aria-label="이슈 속성">
        <div className="iss-prop">
          <span className="iss-prop-l">담당자</span>
          <div className="iss-who big"><Avatar name={it.assignee} size={30} /><b>{it.assignee || '미할당'}</b></div>
          {canWrite && (
            <>
              <Select className="select" value={it.assignee || ''} disabled={busy} aria-label="담당자 변경"
                onChange={(e) => act(() => postJson(`/issues/${it.key}/assign`, { assignee: e.target.value }), e.target.value ? `담당자를 ‘${e.target.value}’ 로 바꿨습니다.` : '할당을 해제했습니다.')}>
                <option value="">미할당</option>
                {people.map((p) => <option key={p.username} value={p.username}>{p.label}</option>)}
              </Select>
              {it.assignee !== x.me && <button className="btn" disabled={busy} onClick={() => act(() => postJson(`/issues/${it.key}/assign`, { assignee: x.me }), '나에게 할당했습니다.')}>나에게 할당</button>}
              <span className="muted" style={{ fontSize: 11.5 }}>바꾸면 이력과 감사 로그에 남습니다.</span>
            </>
          )}
        </div>
        <ProgressBox it={it} canWrite={canWrite} busy={busy} act={act} noteMax={meta.limits?.progressNote || 300} />
        <EpicSprintBox it={it} meta={meta} canWrite={canWrite} busy={busy} act={act} onOpen={onOpen} />
        <div className="iss-prop-grid">
          <div className="iss-prop"><span className="iss-prop-l">우선순위</span><PrioTag p={it.priority} /></div>
          <div className="iss-prop"><span className="iss-prop-l">기한</span><Due r={it} /></div>
          <div className="iss-prop"><span className="iss-prop-l">상태</span><StatusChip s={it.status} /></div>
          <div className="iss-prop"><span className="iss-prop-l">보고자</span><span>{it.reporter}</span></div>
        </div>
        <div className="iss-prop"><span className="iss-prop-l">법인(vCenter)</span><span>{vcName(meta, it.vcenterId)}</span>
          {roScope && <span className="muted" style={{ fontSize: 11.5 }}>이 법인은 쓰기 범위 밖입니다 — 조회만 할 수 있습니다.</span>}
        </div>
        <div className="iss-prop"><span className="iss-prop-l">컴포넌트</span><span>{it.component || <span className="muted">—</span>}</span></div>
        <div className="iss-prop"><span className="iss-prop-l">라벨</span>
          <span className="iss-labels">{it.labels.length ? it.labels.map((l) => <span key={l} className="iss-label">{l}</span>) : <span className="muted">—</span>}</span>
        </div>
        <div className="iss-prop"><span className="iss-prop-l">관찰자 · {it.watcherNames.length}</span>
          <span className="iss-labels">{it.watcherNames.map((n) => <Avatar key={n} name={n} size={22} />)}</span>
          {canWrite && <button className="btn" disabled={busy} onClick={() => act(() => postJson(`/issues/${it.key}/watch`, { on: !it.watching }))}>{it.watching ? '관찰 그만하기' : '관찰하기'}</button>}
        </div>
        <RelatedDocs issueKey={it.key} />
        <div className="muted iss-stamp">
          <div>생성 {timeText(it.createdAt)} · {it.createdBy}</div>
          <div>최근 수정 {timeText(it.updatedAt)}{it.updatedBy ? ` · ${it.updatedBy}` : ''}</div>
          {it.closedAt && <div>완료 {timeText(it.closedAt)}</div>}
        </div>
      </aside>
    </div>
  );
}

/**
 * 관련 문서(v2.881) — 본문 · 댓글에 이 이슈 키를 적은 위키 문서(서버 역참조 색인 · 내가 볼 수 있는 스페이스만).
 * 못 읽으면 '없음' 으로 지어내지 않고 못 읽었다고 적는다.
 */
function RelatedDocs({ issueKey }) {
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    let alive = true;
    fetchJson('/wiki/backrefs', { key: issueKey }).then((r) => { if (alive) { setRows(r.pages || []); setErr(''); } }).catch((e) => { if (alive) setErr(String(e?.message || e)); });
    return () => { alive = false; };
  }, [issueKey]);
  return (
    <div className="iss-prop"><span className="iss-prop-l">관련 문서{rows ? ` · ${rows.length}` : ''}</span>
      {err ? <span className="muted" style={{ fontSize: 12 }}>위키 역참조를 읽지 못했습니다 — {err}</span>
        : !rows ? <span className="muted" style={{ fontSize: 12 }}>읽는 중…</span>
          : rows.length ? (
            <span style={{ display: 'flex', flexDirection: 'column', gap: 3, fontSize: 12.5, minWidth: 0 }}>
              {rows.slice(0, 10).map((p) => <a key={p.id} className="wiki-xlink" href={wikiHash({ space: p.spaceId, id: p.id })} style={{ overflowWrap: 'anywhere' }}>{p.title}{p.status !== 'approved' ? ` · ${wikiStatusText(p.status)}` : ''}</a>)}
              {rows.length > 10 && <span className="muted">외 {rows.length - 10}건 — 위키 찾기에서 ‘{issueKey}’</span>}
            </span>
          ) : <span className="muted" style={{ fontSize: 12 }}>위키 문서의 본문 · 댓글에 ‘{issueKey}’ 를 적으면 여기에 이어집니다.</span>}
    </div>
  );
}

/* ───────────── 설정 › 자동 등록(v2.880 — 하드웨어 파트 장애 → 이슈) ───────────── */

/**
 * 전체 범위 관리자 전용(서버가 같은 기준 — GET · PUT /issues/autocreate). 칸은 서버가 알려 준 '추출기가 실제로 보고하는 것' 만 연다.
 * 조회 실패면 저장 버튼을 열지 않는다. 시험 실행은 저장 전 화면 값을 지난 24시간 이벤트에 대 본다(만들지 않는다).
 */
function AutoCreateSettings() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [form, setForm] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [sim, setSim] = useState('');
  const latest = useLatest();
  const load = useCallback(() => {
    const k = latest.next();
    fetchJson('/issues/autocreate').then((r) => {
      if (!latest.isLatest(k)) return;
      setData(r); setErr(null);
      const p = r.settings.partfault;
      setForm({ ...p, matrix: JSON.parse(JSON.stringify(p.matrix)), priority: { ...p.priority }, labels: p.labels.join(', '), agentsOff: [...p.agentsOff] });
    }).catch((e) => { if (latest.isLatest(k)) setErr(e); });
  }, [latest]);
  useEffect(() => { load(); }, [load]);

  if (err && !data) return <ErrorBox error={err} />;
  if (!data || !form) return <Loading label="자동 등록 설정" />;
  const upd = (patch) => setForm((f) => ({ ...f, ...patch }));
  const setCell = (sc, k, v) => setForm((f) => ({ ...f, matrix: { ...f.matrix, [sc]: { ...f.matrix[sc], [k]: v } } }));
  const toggleAgent = (id) => setForm((f) => ({ ...f, agentsOff: f.agentsOff.includes(id.toLowerCase()) ? f.agentsOff.filter((a) => a !== id.toLowerCase()) : [...f.agentsOff, id.toLowerCase()] }));
  const bodyOf = () => ({ partfault: { ...form, labels: form.labels.split(',').map((x) => x.trim()).filter(Boolean) } });
  const save = async () => {
    setBusy(true); setMsg('');
    try {
      const r = await putJson('/issues/autocreate', bodyOf());
      if (r?.ok) { setMsg('저장했습니다.'); load(); } else setMsg(saveFailText(r));
    } catch (e) { setMsg(saveFailText({ reason: e.message })); } finally { setBusy(false); }
  };
  const simulate = async () => {
    setBusy(true); setSim('');
    try {
      const r = await postJson('/issues/autocreate/simulate', { hours: 24, settings: bodyOf() });
      setSim(r?.ok ? simulateText(r) : saveFailText(r));
    } catch (e) { setSim(saveFailText({ reason: e.message })); } finally { setBusy(false); }
  };
  const rows = autoKindRows(data);
  const kl = data.kindLabels || {};
  const sl = data.scopeLabels || {};
  const lim = data.limits || {};
  return (
    <div className="card iss-editor iss-auto-settings">
      {err && <div className="banner bad" style={{ whiteSpace: 'normal' }}>자동 등록 설정을 다시 읽지 못했습니다 — 아래는 직전에 읽은 값입니다. 다시 읽기를 누르세요. ({err.message || String(err)})</div>}
      {data.loadError && <div className="banner bad" style={{ whiteSpace: 'normal' }}>설정 파일(issue-autocreate.json)을 읽지 못해 기본값(꺼짐)으로 동작 중입니다 — 손상본은 옆에 보존했습니다. 저장하면 지금 화면의 값으로 새로 씁니다. 원인: {data.loadError}</div>}
      <h3 className="iss-h3">자동 등록 — 하드웨어 파트 장애</h3>
      <label className="iss-check"><input type="checkbox" checked={form.enabled} onChange={(e) => upd({ enabled: e.target.checked })} /> 파트 장애가 열리면 이슈를 자동으로 만듭니다(켜진 칸 {autoOnCount(form.matrix)}개)</label>
      <div className="muted" style={{ fontSize: 12.5 }}>
        중앙의 파트 장애 점검(특수 기능 › 파트 장애)이 장애를 판정한 직후에 돕니다 — 파트 장애 기능이 켜진 법인만. unknown(못 읽음) · absent(빈 슬롯)는 장애가 아니라 칸을 켜도 만들지 않습니다.
        같은 파트가 열린 이슈에 이미 있으면 새로 만들지 않고 댓글을 답니다. 법인은 그 수집 서버가 수집하는 vCenter 가 하나일 때만 정하고, 아니면 공용 이슈입니다.
      </div>
      <div className="muted" style={{ fontSize: 12 }}>{autoStatusText(data.status)}</div>

      <STable className="v3-table" minWidth={620}>
        <thead>
          <tr><th data-nosort>부품 종류</th>{(data.scopes || []).map((sc) => <th key={sc} data-nosort>{sl[sc] || sc}</th>)}<th data-nosort>우선순위</th></tr>
        </thead>
        <tbody>
          {rows.map((k) => (
            <tr key={k}>
              <td><b>{kl[k] || k}</b></td>
              {(data.scopes || []).map((sc) => (
                <td key={sc}>
                  {(data.supported?.[sc] || []).includes(k)
                    ? (
                      <Select className="select" value={form.matrix[sc]?.[k] || 'off'} sort={false} aria-label={`${sl[sc] || sc} ${kl[k] || k}`} onChange={(e) => setCell(sc, k, e.target.value)}>
                        {(data.levels || []).map((v) => <option key={v} value={v}>{AUTO_LEVEL_TEXT[v] || v}</option>)}
                      </Select>
                    )
                    : <span className="muted" title="이 장비군 추출기는 이 부품을 보고하지 않습니다">—</span>}
                </td>
              ))}
              <td>
                <Select className="select" value={form.priority[k] || 'p2'} sort={false} aria-label={`${kl[k] || k} 우선순위`} onChange={(e) => upd({ priority: { ...form.priority, [k]: e.target.value } })}>
                  {['p0', 'p1', 'p2', 'p3'].map((p) => <option key={p} value={p}>{PRIORITY_TEXT[p] || p}</option>)}
                </Select>
              </td>
            </tr>
          ))}
        </tbody>
      </STable>
      <div className="muted" style={{ fontSize: 11.5 }}>‘—’ 는 그 장비군이 그 부품을 보고하지 않는 칸입니다(추출기 없음). PDU 는 부품 상태 필드가 없어 대상이 아닙니다.</div>

      <div className="iss-auto-grid">
        <div className="iss-auto-box">
          <b>만드는 이슈</b>
          <span className="muted" style={{ fontSize: 12 }}>유형 장애 · 상태 백로그 · 컴포넌트 = 부품 종류 이름(자동 할당 규칙이 켜져 있으면 담당자를 정함)</span>
          <label className="iss-field">라벨(쉼표 구분)<input className="input" value={form.labels} onChange={(e) => upd({ labels: e.target.value })} /></label>
          <label className="iss-field">제목 틀<input className="input" value={form.titleTpl} maxLength={lim.titleTpl || 160} onChange={(e) => upd({ titleTpl: e.target.value })} /></label>
          <span className="muted" style={{ fontSize: 11.5 }}>쓸 수 있는 자리: ‘{'{법인}'}’ ‘{'{장비}'}’ ‘{'{장비군}'}’ ‘{'{부품종류}'}’ ‘{'{부품}'}’ ‘{'{상태}'}’ · 기본 ‘{data.defaultTitleTpl}’</span>
        </div>
        <div className="iss-auto-box">
          <b>중복 · 폭주 막기</b>
          <label className="iss-inline-wrap">한 장비에서 <input className="input iss-num" type="number" min={1} max={1440} value={form.burstWindowMin} onChange={(e) => upd({ burstWindowMin: Number(e.target.value) })} aria-label="묶는 시간(분)" />분 안에
            <input className="input iss-num" type="number" min={1} max={100} value={form.burstMax} onChange={(e) => upd({ burstMax: Number(e.target.value) })} aria-label="묶는 건수" />건을 넘으면 장비 단위 1건</label>
          <label className="iss-inline-wrap">하루 상한 <input className="input iss-num" type="number" min={1} max={1000} value={form.dailyMax} onChange={(e) => upd({ dailyMax: Number(e.target.value) })} aria-label="하루 상한" />건 — 넘으면 만들지 않고 셉니다(위 상태 줄)</label>
          <span className="muted" style={{ fontSize: 11.5 }}>같은 파트 키의 열린 이슈가 있으면 항상 댓글(‘다시 열림 N회째’)입니다.</span>
        </div>
        <div className="iss-auto-box">
          <b>장애가 바뀌면</b>
          <label className="iss-inline-wrap">해소(정상 복귀 · 부품 제거)되면 댓글 +
            <Select className="select" value={form.onResolve} sort={false} aria-label="해소 때 상태" onChange={(e) => upd({ onResolve: e.target.value })}>
              <option value="review">상태를 검토로</option><option value="keep">상태는 그대로</option>
            </Select></label>
          <span className="muted" style={{ fontSize: 11.5 }}>완료는 사람이 합니다. 수동 닫음은 댓글만 · 판정 보류(못 읽음 · 수집 실패)는 사유가 바뀔 때 댓글만 달고 닫지 않습니다.</span>
          <label className="iss-check"><input type="checkbox" checked={form.replaceNotify} onChange={(e) => upd({ replaceNotify: e.target.checked })} /> 이슈가 맡은 파트는 파트 장애 알림을 보내지 않고 이슈 알림만(두 통 방지)</label>
        </div>
        <div className="iss-auto-box">
          <b>법인(수집 서버) 예외 · {form.agentsOff.length}</b>
          <span className="muted" style={{ fontSize: 11.5 }}>체크한 수집 서버의 파트 장애로는 이슈를 만들지 않습니다.</span>
          <div className="iss-checks">
            {(data.agents || []).length === 0 && <span className="muted" style={{ fontSize: 12 }}>등록된 수집 서버가 없습니다(중앙 직접 수집만).</span>}
            {(data.agents || []).map((a) => (
              <label key={a.id} className="iss-check"><input type="checkbox" checked={form.agentsOff.includes(a.id.toLowerCase())} onChange={() => toggleAgent(a.id)} /> {a.name}{a.name !== a.id ? ` (${a.id})` : ''}</label>
            ))}
          </div>
        </div>
      </div>
      {sim && <div className="banner" style={{ whiteSpace: 'normal' }}>{sim}</div>}
      {msg && <div className="banner">{msg}</div>}
      <div className="flex" style={{ gap: 6, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
        <button className="btn" onClick={load} disabled={busy}>다시 읽기</button>
        <button className="btn" onClick={simulate} disabled={busy} title="지금 화면 값을 지난 24시간 파트 장애 이벤트에 대 봅니다 — 만들지 않습니다">지난 24시간으로 시험 실행</button>
        <button className="btn primary" onClick={save} disabled={busy || !!err}>{busy ? '처리 중…' : '저장'}</button>
      </div>
    </div>
  );
}

/* ───────────── 설정(v2.871 — 자동 할당 · 알림 · 사람별 메일 주소) ───────────── */

const EVENT_TEXT = Object.freeze({ assigned: '할당(새 담당자 · 이전 담당자)', status: '상태 변경(담당자 · 보고자 · 관찰자)', progress: '진행률·진행 메모(담당자 · 보고자 · 관찰자)', comment: '댓글 · @멘션(담당자 · 보고자 · 관찰자 · 언급된 사람)', due: '기한 내일 · 오늘 · 지남(담당자 — 포탈 날짜로 하루 한 번)', wiki: '위키 문서 저장 · 댓글 · @멘션(지켜보는 사람 · 언급된 사람)' });
const splitNames = (s) => String(s || '').split(/[,\s]+/).map((x) => x.trim()).filter(Boolean);

/** 전체 범위 관리자 전용 — 서버가 같은 기준으로 막는다(GET·PUT /issues/settings). 조회 실패면 저장 버튼을 열지 않는다. */
function IssueSettings() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [form, setForm] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const latest = useLatest();
  const load = useCallback(() => {
    const k = latest.next();
    fetchJson('/issues/settings').then((r) => {
      if (!latest.isLatest(k)) return;
      setData(r); setErr(null);
      const st = r.settings;
      setForm({
        autoEnabled: !!st.autoAssign.enabled, components: st.autoAssign.components.map((c) => ({ ...c })), pool: st.autoAssign.pool.join(', '),
        notifyEnabled: !!st.notify.enabled, mail: st.notify.mail !== false, chat: !!st.notify.chat, events: { ...st.notify.events }, people: st.notify.people.map((p) => ({ ...p })),
      });
    }).catch((e) => { if (latest.isLatest(k)) setErr(e); });
  }, [latest]);
  useEffect(() => { load(); }, [load]);

  if (err && !data) return <ErrorBox error={err} />;
  if (!data || !form) return <Loading label="이슈 설정" />;
  const upd = (patch) => setForm((f) => ({ ...f, ...patch }));
  const setRow = (key, i, patch) => setForm((f) => ({ ...f, [key]: f[key].map((r, j) => (j === i ? { ...r, ...patch } : r)) }));
  const delRow = (key, i) => setForm((f) => ({ ...f, [key]: f[key].filter((_, j) => j !== i) }));
  const save = async () => {
    setBusy(true); setMsg('');
    const body = {
      autoAssign: { enabled: form.autoEnabled, components: form.components.filter((c) => c.name.trim() || c.assignee.trim()), pool: splitNames(form.pool) },
      notify: { enabled: form.notifyEnabled, mail: form.mail, chat: form.chat, events: form.events, people: form.people.filter((p) => p.username.trim() || p.email.trim()) },
    };
    try {
      const r = await putJson('/issues/settings', body);
      if (r?.ok) { setMsg('저장했습니다.'); load(); } else setMsg(saveFailText(r));
    } catch (e) { setMsg(saveFailText({ reason: e.message })); } finally { setBusy(false); }
  };
  const lim = data.limits || {};
  const st = data.notifyStatus;
  return (
    <div className="iss-settings">
      {err && <div className="banner bad" style={{ whiteSpace: 'normal' }}>설정을 다시 읽지 못했습니다 — 아래는 직전에 읽은 값이라 최신이 아닐 수 있습니다. 저장하기 전에 다시 읽기를 눌러 확인하세요. ({err.message || String(err)})</div>}
      {data.loadError && <div className="banner bad" style={{ whiteSpace: 'normal' }}>설정 파일(issue-settings.json)을 읽지 못해 기본값(자동 할당·알림 꺼짐)으로 동작 중입니다 — 손상본은 옆에 보존했습니다. 저장하면 지금 화면의 값으로 새로 씁니다. 원인: {data.loadError}</div>}
      <div className="card iss-editor">
        <h3 className="iss-h3">자동 할당</h3>
        <label className="iss-check"><input type="checkbox" checked={form.autoEnabled} onChange={(e) => upd({ autoEnabled: e.target.checked })} /> 담당자를 비우고 만든 이슈에 자동으로 담당자를 정합니다</label>
        <div className="muted" style={{ fontSize: 12.5 }}>순서: ① 컴포넌트 기본 담당자(이름이 같은 컴포넌트, 대소문자 무시) ② 아래 후보 중 열린 이슈가 가장 적은 사람. 범위가 지정된 로컬 계정은 그 이슈의 법인을 볼 수 있을 때만 고릅니다. 꺼 두어도 새 이슈 창에 ‘제안’ 은 보입니다.</div>
        <div className="iss-rows">
          {form.components.map((c, i) => (
            <div key={i} className="iss-row-edit">
              <input className="input" value={c.name} onChange={(e) => setRow('components', i, { name: e.target.value })} placeholder="컴포넌트(예: vCenter 수집기)" maxLength={lim.component || 60} aria-label={`규칙 ${i + 1} 컴포넌트`} />
              <input className="input" value={c.assignee} onChange={(e) => setRow('components', i, { assignee: e.target.value })} placeholder="기본 담당자 계정" maxLength={lim.name || 64} aria-label={`규칙 ${i + 1} 담당자`} />
              <button type="button" className="btn" onClick={() => delRow('components', i)}>삭제</button>
            </div>
          ))}
          <button type="button" className="btn" disabled={form.components.length >= (lim.components || 100)} onClick={() => upd({ components: [...form.components, { name: '', assignee: '' }] })}>+ 컴포넌트 규칙</button>
        </div>
        <label className="iss-field">순번 후보(계정, 쉼표 구분)<input className="input" value={form.pool} onChange={(e) => upd({ pool: e.target.value })} placeholder="kim, lee, park" /></label>
      </div>

      <div className="card iss-editor">
        <h3 className="iss-h3">알림</h3>
        <label className="iss-check"><input type="checkbox" checked={form.notifyEnabled} onChange={(e) => upd({ notifyEnabled: e.target.checked })} /> 이슈 알림 켜기</label>
        <div className="iss-checks">
          <label className="iss-check"><input type="checkbox" checked={form.mail} onChange={(e) => upd({ mail: e.target.checked })} /> 사람별 메일(아래 주소)</label>
          <label className="iss-check"><input type="checkbox" checked={form.chat} onChange={(e) => upd({ chat: e.target.checked })} /> 팀 채팅(설정 › 알림의 Slack · 웹훅 · Teams)</label>
        </div>
        <div className="iss-checks">
          {(data.events || []).map((k) => (
            <label key={k} className="iss-check"><input type="checkbox" checked={form.events[k] !== false} onChange={(e) => upd({ events: { ...form.events, [k]: e.target.checked } })} /> {EVENT_TEXT[k] || k}</label>
          ))}
        </div>
        <div className="muted" style={{ fontSize: 12.5 }}>변경한 본인에게는 보내지 않습니다. 같은 사람에게 1분 안의 변경은 한 통으로 묶습니다. 메일은 설정 › 메일 발송에서 ‘이슈 트래커 알림’ 종류가 켜져 있어야 나갑니다. 계정에는 메일 칸이 없어서 받을 주소를 여기에 적습니다 — 주소가 없는 사람은 메일을 받지 않습니다.</div>
        <div className="iss-rows">
          {form.people.map((p, i) => (
            <div key={i} className="iss-row-edit">
              <input className="input" value={p.username} onChange={(e) => setRow('people', i, { username: e.target.value })} placeholder="계정" maxLength={lim.name || 64} aria-label={`사람 ${i + 1} 계정`} />
              <input className="input" type="email" value={p.email} onChange={(e) => setRow('people', i, { email: e.target.value })} placeholder="메일 주소" maxLength={lim.email || 254} aria-label={`사람 ${i + 1} 메일`} />
              <button type="button" className="btn" onClick={() => delRow('people', i)}>삭제</button>
            </div>
          ))}
          <button type="button" className="btn" disabled={form.people.length >= (lim.people || 500)} onClick={() => upd({ people: [...form.people, { username: '', email: '' }] })}>+ 사람</button>
        </div>
        {st && <div className="muted" style={{ fontSize: 12.5 }}>발송 상태: {notifyStatusText(st)}{st.lastError ? ` · 마지막 문제: ${st.lastError}` : ''}</div>}
      </div>
      {msg && <div className="banner">{msg}</div>}
      <div className="flex" style={{ gap: 6, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
        <button className="btn" onClick={load} disabled={busy}>다시 읽기</button>
        <button className="btn primary" onClick={save} disabled={busy || !!err} title={err ? '최신 설정을 읽지 못해 저장을 잠갔습니다 — 다시 읽기' : undefined}>{busy ? '저장 중…' : '저장'}</button>
      </div>
    </div>
  );
}
