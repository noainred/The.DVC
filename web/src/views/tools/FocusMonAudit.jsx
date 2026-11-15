/**
 * FocusMonAudit.jsx — 서버 집중 모니터링 ‘디스크 점검’ 탭(v3.11.0 — 사용자 2026-11-14 · 15 "집중 모니터링 기능에 배드섹터 점검 프로그램 추가해줘"(+ 프로그램 원문) ·
 * "법인별로 보는 기능, 모델별로 보는 기능 등" · "법인별로 디스크 모델별로 보는 기능" · "기본값대로 모두 구현해줘" — 시안 ⑰ · docs/design/focus-mon/README.md §20).
 *
 *  · 값 · 판정 · 묶어 보기는 응답 `/tools/focus-mon/audit` 그대로(서버 audit/* 하나 — 웹에 같은 집계를 두지 않는다).
 *  · 무거운 조회는 탭을 열 때 · 작업이 끝날 때만. 작업이 있는 동안에는 가벼운 `audit/jobs` 를 5초마다(늦게 온 응답은 usePoll 이 버린다).
 *  · 숫자는 프로그램이 찾은 줄 수 — 장애 횟수 아님. 끝까지 돌지 않은 회차는 ‘—’. 결과의 판정 글자([확정] · [추정] · [불명])는 프로그램 그대로.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { postJson, downloadFile } from '../../api.js';
import { ErrorBox, Loading } from '../../components/ui.jsx';
import { STable } from '../../components/STable.jsx';
import { Seg, Badge, copyText } from './FocusMonBulk.jsx';
import { usePoll } from './focusMonPoll.js';
import {
  DASH, AUDIT_VIEWS, AUDIT_VIEW_KEYS, READY_TEXT, OUTCOME_TEXT, PHASE_NOTE, countText, whenText, durText, nodeText, corpText, smodelText, rowStatus, canRunRow, lastCounts,
  rateText, chipCounts, chipFilter, scopeFilter, scopeText, notReadyText, VERDICT_TONE, KIND_TONE, installSteps, notDoneText, diskCountText,
} from './focusMonAuditText.js';

const ls = () => { try { return window.localStorage; } catch { return null; } };
const lsGet = (k, d) => { try { const v = ls()?.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } };
const lsSet = (k, v) => { try { ls()?.setItem(k, JSON.stringify(v)); } catch { /* 사생활 모드 등 */ } };
const numR = (n) => <span className="fm-num">{countText(n)}</span>;

/** 묶음 표(법인 · 서버 모델 · 그룹 — 같은 모양). */
function GroupTable({ head, list, onOpen, onRun, busy, now }) {
  return (
    <STable className="fm-table" minWidth={960}>
      <thead><tr><th>{head}</th><th className="fm-r">서버</th><th className="fm-r">점검함</th><th className="fm-r">준비 안 됨</th><th className="fm-r" title="끝까지 돈 점검에서 오류 · 재할당 기록이 하나라도 나온 서버">기록 있는 서버</th><th className="fm-r">매체 오류</th><th className="fm-r">I/O · 경로</th><th className="fm-r">재할당</th><th className="fm-r" title="점검한 서버에서 프로그램이 본 물리 디스크(식별자로 하나씩)">디스크(본 것)</th><th>가장 오래된 점검</th><th data-nosort /></tr></thead>
      <tbody>{list.map((g) => (
        <tr key={g.key || '-'} className="fm-click" onClick={() => onOpen(g)}>
          <td data-sort={g.name}><span className="fm-st"><b>{g.name}</b><small>{g.nodes.map(nodeText).join(' · ')}</small></span></td>
          <td className="fm-r fm-num">{g.n}</td><td className="fm-r fm-num">{g.done}</td>
          <td className={`fm-r fm-num ${g.notReady ? 'fm-warn' : ''}`}>{g.notReady}</td>
          <td className={`fm-r fm-num ${g.hit ? 'fm-bad' : ''}`}>{g.hit}</td>
          <td className="fm-r" data-sort={g.media ?? ''}>{numR(g.media)}</td><td className="fm-r" data-sort={g.io ?? ''}>{numR(g.io)}</td><td className="fm-r" data-sort={g.realloc ?? ''}>{numR(g.realloc)}</td>
          <td className="fm-r" data-sort={g.disks ?? ''}>{numR(g.disks)}</td>
          <td data-sort={g.oldestAt || ''}><span className="fm-st"><span className="fm-num">{g.oldestAt ? whenText(g.oldestAt, now) : '점검한 적 없음'}</span>{g.never && g.oldestAt ? <small>안 한 서버 {g.never}</small> : null}</span></td>
          <td className="fm-r"><button type="button" className="fm-btn sm" disabled={!!busy} onClick={(e) => { e.stopPropagation(); onRun(g); }}>묶음 점검</button></td>
        </tr>
      ))}</tbody>
    </STable>
  );
}

/** 결과 — 판정 줄 · 디스크 · 읽은 자료 · 근거 · 해석 범위 · 회차 · 원문. */
function Result({ row, now, labels }) {
  const [runId, setRunId] = useState(row.last?.id || '');
  const [scopeOpen, setScopeOpen] = useState(false);
  useEffect(() => { setRunId(row.last?.id || ''); }, [row.id, row.last?.id]);
  const runsQ = usePoll(`/tools/focus-mon/audit/${encodeURIComponent(row.id)}/runs`, null, 0, !!row.last);
  const detQ = usePoll(runId ? `/tools/focus-mon/audit/run/${encodeURIComponent(runId)}` : '', null, 0, !!runId);
  const st = rowStatus(row, now);
  if (!row.last) {
    return (
      <div className="fm-card fm-pad fm-col">
        <div className="fm-row"><h3 className="fm-h3">{row.name} — {row.job ? '진행 중' : '점검 결과 없음'}</h3><Badge b={{ tone: st.tone, label: st.label }} /></div>
        {st.sub ? <span className="fm-dim">{st.sub}</span> : null}
        {row.ready?.state && row.ready.state !== 'ready' ? <span className="fm-dim">아래 ‘대상 서버 준비’ 를 이 서버에서 root 로 한 번 해 주시면 됩니다. 포탈은 대상 서버의 설정을 바꾸지 않습니다.</span> : null}
        {row.job ? <span className="fm-dim">{PHASE_NOTE}</span> : null}
      </div>
    );
  }
  const d = detQ.fresh ? detQ.data : null;
  const run = d?.run || row.last;
  const s = run.summary || {};
  const done = run.outcome === 'done';
  const disksById = d ? d.inventory.filter((x) => !x.virtual && (x.ids.sn || x.ids.wwn)) : [];
  const errs = d ? d.evidence.filter((e) => d.errorKinds.includes(e.kind)) : [];
  const others = d ? d.evidence.filter((e) => !d.errorKinds.includes(e.kind)) : [];
  return (
    <div className="fm-card fm-col fm-audit-res">
      <div className="fm-row fm-between fm-pad-x fm-pad-t">
        <div className="fm-row"><h3 className="fm-h3">{row.name} — 점검 결과</h3>
          <Badge b={{ tone: done ? (s.hit ? 'bad' : 'ok') : 'warn', label: done ? (s.hit ? '오류 · 재할당 기록 있음' : '대상 오류 패턴을 찾지 못함') : OUTCOME_TEXT[run.outcome] || run.outcome }} />
          {done && s.newN ? <span className="fm-badge live">지난 점검 뒤 새 근거 {s.newN}줄</span> : null}
        </div>
        <div className="fm-row">
          <span className="fm-lbl">회차</span>
          {(runsQ.data?.runs || [row.last]).map((x) => <button key={x.id} type="button" className={`fm-chip ${x.id === runId ? 'on' : ''}`} aria-pressed={x.id === runId} title={x.oldEndpoint ? '접속처(주소 · 포트 · 계정 · 담당 노드)가 바뀌기 전의 회차' : undefined} onClick={() => setRunId(x.id)}>{whenText(x.at, now)}{x.oldEndpoint ? ' · 예전 접속처' : ''}</button>)}
          <button type="button" className="fm-btn sm" onClick={() => downloadFile(`/tools/focus-mon/audit/run/${encodeURIComponent(runId)}/report.txt`).catch(() => {})}>보고서 원문 받기(.txt)</button>
        </div>
      </div>
      <span className="fm-dim fm-pad-x">{whenText(run.at, now)} · 걸린 시간 {durText(s.ms ?? (run.ended && run.at ? run.ended - run.at : null))} · 실행 노드 {nodeText(run.node)} · 프로그램 판본 {run.ver || DASH} · 실행한 사람 {run.by || DASH}{s.outBytes ? ` · 출력 ${Math.round(s.outBytes / 1024).toLocaleString('ko-KR')} KB` : ''}{s.truncated ? ' · 출력이 커서 구획마다 일부를 생략해 보관' : ''}</span>
      {!done ? <div className="fm-ban w fm-mar-x">{notDoneText(run)}</div> : null}
      {d?.shape?.length ? <div className="fm-ban w fm-mar-x">보고서 모양 검사: {d.shape.join(' · ')}</div> : null}
      {d?.run?.oldEndpoint ? <div className="fm-ban fm-mar-x">이 회차는 접속처(주소 · 포트 · 계정 · 담당 노드)가 바뀌기 전에 돈 것입니다 — 지금 서버의 결과로 쓰지 않습니다.</div> : null}
      {done && s.disksKnown === false ? <div className="fm-ban w fm-mar-x">상세 근거가 보관 상한에서 잘려 디스크별 기록 수를 모릅니다 — 묶어 보기의 비율에서 이 서버의 디스크를 뺐습니다(서버 합계는 판정 줄의 건수).</div> : null}
      {detQ.error ? <div className="fm-pad-x"><ErrorBox error={detQ.error} /></div> : !d ? <div className="fm-pad-x"><Loading /></div> : (
        <>
          <div className="fm-pad-x fm-verdicts">
            {d.verdicts.map((v, i) => <div key={i} className={`fm-vd ${v.depth ? 'in' : ''}`}><span className={`fm-badge ${VERDICT_TONE[v.tag] || 'off'}`}>{v.tag}</span><span>{v.text}</span></div>)}
            {!d.verdicts.length ? <span className="fm-dim">판정 구획을 읽지 못했습니다 — 원문을 받아 확인하세요.</span> : null}
          </div>
          <div className="fm-col fm-res-stack fm-pad-x">
            <div className="fm-sub-card">
              <b className="fm-pad-x fm-pad-t">지금 있는 물리 디스크 — 식별자가 있는 {disksById.length}개(프로그램이 본 장치 {d.inventory.length}개 중)</b>
              <STable className="fm-table" minWidth={460}>
                <thead><tr><th>장치 · 슬롯</th><th>모델</th><th>식별자</th><th>종류 · 쓰는 중</th></tr></thead>
                <tbody>{disksById.map((x) => (
                  <tr key={x.label}><td className="fm-mono" data-sort={x.label}>{x.label}</td><td className="fm-mono" data-sort={x.model || ''}>{x.model || DASH}</td><td className="fm-mono"><span className="fm-st">{x.idsText ? x.idsText.split(' ').map((id) => <span key={id} className="fm-nowrap-t">{id}</span>) : DASH}</span></td><td><span className="fm-st"><span>{x.scope}</span><small>{x.use}</small></span></td></tr>
                ))}</tbody>
              </STable>
              {!disksById.length ? <span className="fm-dim fm-pad-x">식별자가 있는 물리 디스크를 보지 못했습니다(가상 머신이거나 RAID 도구 · smartctl 이 없는 서버).</span> : null}
            </div>
            <div className="fm-sub-card">
              <b className="fm-pad-x fm-pad-t">읽은 자료 — 못 읽거나 일부만 읽은 것 {d.missing.length + d.partial.length}개(프로그램이 센 것 {countText(d.gaps)}개)</b>
              <STable className="fm-table" minWidth={460}>
                <thead><tr><th>자료</th><th className="fm-r">줄</th><th className="fm-r">후보</th><th>기간</th></tr></thead>
                <tbody>{d.sources.map((x, i) => (
                  <tr key={i}><td className="fm-brk" data-sort={x.name}>{x.name}</td><td className="fm-r fm-num" data-sort={x.lines ?? ''}>{countText(x.lines)}</td><td className="fm-r fm-num" data-sort={x.hits ?? ''}>{countText(x.hits)}</td><td className="fm-num fm-dim">{x.first ? <span className="fm-st"><span>{x.first.slice(0, 10)} ~</span><span>{(x.last || '').slice(0, 10)}</span></span> : '시간 비교 불가'}</td></tr>
                ))}</tbody>
              </STable>
              {[...d.missing.map((x) => ({ ...x, t: '수집 불가' })), ...d.partial.map((x) => ({ ...x, t: '일부만 읽음' }))].map((x, i) => <span key={i} className="fm-why fm-pad-x">{x.t} — {x.what}</span>)}
            </div>
          </div>
          <div className="fm-col">
            <div className="fm-row fm-between fm-pad-x"><b>근거 — 오류 기록 {errs.length}줄 · 그 밖 {others.length}줄{d.evidenceTotal > d.evidence.length ? `(전체 ${countText(d.evidenceTotal)}줄 중 앞 ${d.evidence.length}줄)` : ''}</b><span className="fm-dim">프로그램의 ‘상세 근거’ 를 표로 옮긴 것 · 번호는 보고서와 같음</span></div>
            <STable className="fm-table" minWidth={1120}>
              <thead><tr><th className="fm-r">#</th><th>종류</th><th>어디서</th><th>시각</th><th>식별자</th><th>장치 · 슬롯</th><th>기록</th></tr></thead>
              <tbody>{[...errs, ...others].map((e, i) => (
                <tr key={`${e.n}-${i}`}>
                  <td className="fm-r fm-num fm-dim" data-sort={e.n ?? 1e9}>{e.n != null ? `#${e.n}` : ''}</td>
                  <td data-sort={e.kind}><span className="fm-st"><span className={`fm-badge ${KIND_TONE[e.kind] || 'off'}`}>{e.kind}</span>{e.isNew ? <span className="fm-badge live">새</span> : null}</span></td>
                  <td className="fm-brk" data-sort={e.source}>{e.source}{e.line != null ? <small className="fm-dim">:{e.line}</small> : null}</td>
                  <td className="fm-num fm-dim" data-sort={e.when || ''}>{e.when ? e.when.replace('T', ' ').slice(0, 19) : '시간 비교 불가'}</td>
                  <td className="fm-mono" data-sort={e.idsText || ''}>{e.idsText ? <span className="fm-st">{e.idsText.split(' ').map((id) => <span key={id} className="fm-nowrap-t">{id}</span>)}</span> : '식별자 없음'}</td>
                  <td className="fm-mono">{[e.dev, e.slot].filter(Boolean).join(' · ') || DASH}</td>
                  <td className="fm-mono fm-brk fm-msg">{e.message}</td>
                </tr>
              ))}</tbody>
            </STable>
            {!d.evidence.length ? <span className="fm-dim fm-pad-x">근거 줄이 없습니다.</span> : null}
          </div>
          <div className="fm-pad-x fm-col">
            <div className="fm-row"><button type="button" className="fm-btn sm" aria-expanded={scopeOpen} onClick={() => setScopeOpen(!scopeOpen)}>{scopeOpen ? '해석 범위 접기' : '해석 범위 펼치기'}</button><span className="fm-dim">프로그램이 스스로 밝히는 한계 {d.scope.length}줄 — 결과를 읽기 전에 한 번 보시길 권합니다</span></div>
            {scopeOpen ? <ul className="fm-list">{d.scope.map((x, i) => <li key={i}>{x}</li>)}</ul> : null}
          </div>
        </>
      )}
      <span className="fm-dim fm-pad">이 화면은 결과를 ‘정상’ 이라 부르지 않습니다 — 기록이 없다는 것은 남아 있는 자료에서 찾지 못했다는 뜻이고, 로그 줄은 서버의 다른 계정도 쓸 수 있습니다(고장을 단정하지 않습니다).</span>
    </div>
  );
}

export function AuditTab({ setMsg }) {
  const q = usePoll('/tools/focus-mon/audit', null, 0);
  const d = q.data;
  const hasJobs = !!d && d.rows.some((r) => r.job);
  const jq = usePoll('/tools/focus-mon/audit/jobs', null, 5000, hasJobs);
  const [view, setViewRaw] = useState(() => { const v = lsGet('fm.audit.view', 'server'); return AUDIT_VIEW_KEYS.includes(v) ? v : 'server'; });
  const setView = (v) => { setViewRaw(v); lsSet('fm.audit.view', v); };
  const [outer, setOuterRaw] = useState(() => (lsGet('fm.audit.outer', 'corp') === 'model' ? 'model' : 'corp'));
  const setOuter = (v) => { setOuterRaw(v); lsSet('fm.audit.outer', v); };
  const [chip, setChip] = useState('all');
  const [scope, setScope] = useState(null);
  const [sel, setSel] = useState('');
  const [picked, setPicked] = useState([]);
  const [busy, setBusy] = useState('');
  const [showInstall, setShowInstall] = useState(false);
  const now = Date.now();
  // 작업 수가 줄면(끝난 작업이 있으면) 전체를 다시 읽는다
  const prevJobs = useRef(null);
  useEffect(() => {
    const n = jq.data?.jobs?.length;
    if (n == null) return;
    if (prevJobs.current != null && n < prevJobs.current) q.reload();
    prevJobs.current = n;
  }, [jq.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const jobsNow = useMemo(() => new Map((jq.fresh && jq.data?.jobs ? jq.data.jobs : []).map((j) => [j.id, j])), [jq.data, jq.fresh]);
  const rows = useMemo(() => (d ? d.rows.map((r) => (jobsNow.has(r.id) ? { ...r, job: jobsNow.get(r.id) } : r)) : []), [d, jobsNow]);
  if (q.error && !d) return <ErrorBox error={q.error} />;
  if (!d) return <Loading />;
  const labels = d.labels;
  const shown = rows.filter(chipFilter(chip)).filter(scopeFilter(scope, labels));
  const selRow = rows.find((r) => r.id === sel) || null;
  const run = async (ids, mode, what) => {
    if (!ids.length) return;
    setBusy(mode);
    try {
      const r = await postJson('/tools/focus-mon/audit/run', { ids, mode });
      const bad = (r?.results || []).filter((x) => !x.ok);
      setMsg?.({ tone: bad.length && !r.started ? 'bad' : 'ok', text: `${what}: 시작 ${r?.started ?? 0}대${bad.length ? ` · 시작하지 않음 ${bad.length}대(${[...new Set(bad.map((x) => x.reason))].slice(0, 2).join(' / ')})` : ''}` });
      q.reload();
    } catch (e) { setMsg?.({ tone: 'bad', text: e?.body?.reason || e?.message || '요청 실패' }); }
    finally { setBusy(''); }
  };
  const k = d.kpis;
  const togglePick = (id) => setPicked(picked.includes(id) ? picked.filter((x) => x !== id) : [...picked, id]);
  const openGroup = (kind) => (g) => { setScope({ k: kind, key: g.key, name: g.name }); setView('server'); };
  const runGroup = (g) => run(g.ids, 'run', `${g.name} 묶음 점검`);
  return (
    <div className="fm-col fm-audit">
      <div className="fm-kpis">
        <div className="fm-card fm-kpi"><span className="l">점검한 서버</span><span className="v fm-num">{k.done}<small>/ {k.servers}</small></span><span className="s">끝까지 돈 최근 점검이 있는 서버</span></div>
        <div className="fm-card fm-kpi"><span className="l">매체 오류 기록이 있는 서버</span><span className={`v fm-num ${k.hit ? 'fm-bad' : ''}`}>{k.hit}</span><span className="s">오류 · 재할당 기록이 있는 서버 전체 {k.anyHit}대</span></div>
        <div className="fm-card fm-kpi"><span className="l">준비 안 된 서버</span><span className={`v fm-num ${k.notReady ? 'fm-warn' : ''}`}>{k.notReady}</span><span className="s">{notReadyText(k.notReadyBy)}</span></div>
        <div className="fm-card fm-kpi"><span className="l">지금 실행 중</span><span className="v fm-num">{k.running}</span><span className="s">차례를 기다림 {k.queued} · 노드마다 한 번에 {d.limits.nodeConcurrency}대</span></div>
      </div>
      {d.mock ? <div className="fm-ban">데모 모드 — 데모 서버의 점검 결과는 가상 값입니다(프로그램의 글자 꼴은 실제와 같습니다).</div> : null}
      {!d.dbAvailable ? <div className="fm-ban w">기록 DB 를 열지 못해 점검 결과를 남길 수 없습니다 — 준비 확인만 됩니다.</div> : null}
      <div className="fm-card fm-col">
        <div className="fm-row fm-between fm-pad-x fm-pad-t">
          <div className="fm-row"><h3 className="fm-h3">서버별 점검</h3>
            {chipCounts(rows).map(([key, label]) => <button key={key} type="button" className={`fm-chip ${chip === key ? 'on' : ''}`} aria-pressed={chip === key} onClick={() => setChip(key)}>{label}</button>)}
          </div>
          <div className="fm-row">
            <span className="fm-lbl">고른 서버 {picked.length}대</span>
            <button type="button" className="fm-btn" disabled={!picked.length || !!busy} onClick={() => run(picked, 'check', '준비 상태 확인')}>준비 상태 다시 확인</button>
            <button type="button" className="fm-btn pri" disabled={!picked.length || !!busy} onClick={() => run(picked, 'run', '디스크 점검')}>고른 서버 점검</button>
          </div>
        </div>
        <div className="fm-row fm-pad-x">
          <span className="fm-lbl">묶어 보기</span><Seg label="묶어 보기" value={view} onChange={(v) => { setView(v); if (v !== 'server') setScope(null); }} options={AUDIT_VIEWS} />
          {scope && view === 'server' ? <button type="button" className="fm-chip on" onClick={() => setScope(null)} title="거르기 풀기">{scopeText(scope)} ✕</button> : null}
          {view === 'cross' ? <><span className="fm-lbl">먼저 묶기</span><Seg label="먼저 묶기" value={outer} onChange={setOuter} options={[['corp', '법인 먼저'], ['model', '디스크 모델 먼저']]} /></> : null}
        </div>
        {view === 'server' ? (
          <STable className="fm-table fm-atable" minWidth={1040}>
            <thead><tr><th data-nosort /><th>서버</th><th>법인 · 담당 노드</th><th>준비 · 상태</th><th>마지막 점검</th><th className="fm-r">매체 오류</th><th className="fm-r">I/O · 경로</th><th className="fm-r">재할당</th><th className="fm-r" title="프로그램이 확인하지 못했거나 일부만 읽은 자료 수">못 읽은 것</th><th data-nosort /></tr></thead>
            <tbody>{shown.map((r) => {
              const st = rowStatus(r, now); const c = lastCounts(r);
              return (
                <tr key={r.id} className={`fm-click ${sel === r.id ? 'fm-sel' : ''}`} onClick={() => setSel(sel === r.id ? '' : r.id)}>
                  <td data-nosort onClick={(e) => e.stopPropagation()}><input type="checkbox" checked={picked.includes(r.id)} aria-label={`${r.name} 고르기`} onChange={() => togglePick(r.id)} /></td>
                  <td data-sort={r.name}><span className="fm-st"><span><b className="fm-mono">{r.name}</b>{r.demo ? <span className="fm-badge off">데모</span> : null}</span><small className="fm-mono">{r.host}</small>{r.smodel ? <small>{r.smodel}</small> : null}</span></td>
                  <td data-sort={corpText(r, labels)}><span className="fm-st"><span>{corpText(r, labels)}</span><small>{nodeText(r.agent)}{r.corp?.how === 'edge' ? ' · 엣지의 법인' : ''}</small></span></td>
                  <td data-sort={st.label} className="fm-stcol"><span className="fm-st"><span className={`fm-badge ${st.tone}`}>{st.label}</span>{st.sub ? <small className="fm-brk">{st.sub}</small> : null}</span></td>
                  <td data-sort={r.last?.at || ''}><span className="fm-st"><span className="fm-num">{r.last ? whenText(r.last.at, now) : DASH}</span>{r.last ? <small>{durText(r.last.summary?.ms ?? (r.last.ended && r.last.at ? r.last.ended - r.last.at : null))}</small> : null}</span></td>
                  <td className={`fm-r ${c?.media ? 'fm-bad' : ''}`} data-sort={c ? c.media : ''}>{numR(c?.media)}</td>
                  <td className="fm-r" data-sort={c ? c.io : ''}>{numR(c?.io)}</td>
                  <td className="fm-r" data-sort={c ? c.realloc : ''}>{numR(c?.realloc)}</td>
                  <td className="fm-r" data-sort={r.last?.outcome === 'done' ? r.last.summary?.gaps ?? '' : ''}>{numR(r.last?.outcome === 'done' ? r.last.summary?.gaps : null)}</td>
                  <td className="fm-r" onClick={(e) => e.stopPropagation()}><button type="button" className={`fm-btn sm ${canRunRow(r) ? 'pri' : ''}`} disabled={!canRunRow(r) || !!busy} title={canRunRow(r) ? '' : r.job ? '진행 중' : '준비 안 됨 — 준비 상태를 다시 확인하거나 설치해 주세요'} onClick={() => run([r.id], 'run', `${r.name} 점검`)}>{r.job ? '진행 중' : '점검'}</button></td>
                </tr>
              );
            })}</tbody>
          </STable>
        ) : null}
        {view === 'corp' ? <GroupTable head="법인" list={d.views.corp} onOpen={openGroup('corp')} onRun={runGroup} busy={busy} now={now} /> : null}
        {view === 'smodel' ? <GroupTable head="서버 모델" list={d.views.smodel} onOpen={openGroup('smodel')} onRun={runGroup} busy={busy} now={now} /> : null}
        {view === 'group' ? <GroupTable head="그룹" list={d.views.group} onOpen={openGroup('group')} onRun={runGroup} busy={busy} now={now} /> : null}
        {view === 'disk' ? (
          <>
            <STable className="fm-table" minWidth={1120}>
              <thead><tr><th>디스크 모델</th><th>종류 · 크기</th><th className="fm-r">디스크</th><th className="fm-r">서버</th><th>법인</th><th className="fm-r">기록 있는 디스크</th><th className="fm-r">매체 오류</th><th className="fm-r">재할당</th><th>비율</th><th>어디서 봤나</th></tr></thead>
              <tbody>{d.views.disk.map((x) => (
                <tr key={x.model} className="fm-click" onClick={() => { setScope({ k: 'disk', key: x.model, name: x.model }); setView('server'); }}>
                  <td className="fm-mono" data-sort={x.model}><b>{x.model}</b></td><td className="fm-dim">{x.kind || DASH}</td><td className="fm-r fm-num" data-sort={x.n}>{diskCountText(x)}</td><td className="fm-r fm-num">{x.servers}</td><td className="fm-brk">{x.corps.join(' · ')}</td>
                  <td className={`fm-r fm-num ${x.bad ? 'fm-bad' : ''}`}>{x.bad}</td><td className="fm-r fm-num">{x.mediaN}</td><td className="fm-r fm-num">{x.reallocN}</td>
                  <td data-sort={x.rate ?? ''}><span className="fm-rate"><i><u style={{ width: `${x.rate != null ? Math.min(100, Math.max(x.bad ? 3 : 0, x.rate)) : 0}%` }} /></i><span className="fm-num">{rateText(x, d.limits.rateMinDisks)}</span></span></td>
                  <td className="fm-dim fm-brk">{x.where.join(' · ') || '기록 없음'}</td>
                </tr>
              ))}</tbody>
            </STable>
            {!d.views.disk.length ? <span className="fm-dim fm-pad-x">아직 디스크 모델을 본 점검이 없습니다(끝까지 돈 점검 · 물리 디스크가 보이는 서버만).</span> : null}
          </>
        ) : null}
        {view === 'cross' ? (
          <div className="fm-col fm-cross">
            {(outer === 'corp' ? d.views.crossCorp : d.views.crossModel).map((g) => (
              <div key={g.key || '-'} className="fm-col">
                <div className="fm-row fm-xhead"><b>{g.name}</b>
                  <span className="fm-badge off">{outer === 'corp' ? `서버 ${g.n}대 중 결과 ${g.done}대 · 물리 디스크 ${g.total.n}개${g.total.unknown ? ` · 기록 수 모름 ${g.total.unknown}개` : ''}` : `${g.total.kind || DASH} · 디스크 ${g.total.n}개${g.total.unknown ? ` · 기록 수 모름 ${g.total.unknown}개` : ''} · 법인 ${g.corps}곳`}</span>
                  {g.total.bad ? <span className="fm-badge bad">기록 있는 디스크 {g.total.bad}개</span> : null}
                  <span className="fm-dim">{outer === 'corp' ? (g.noResult?.length ? `결과 없는 서버: ${g.noResult.slice(0, 4).join(' · ')}${g.noResult.length > 4 ? ` 외 ${g.noResult.length - 4}` : ''}` : '전 서버 결과 있음') : `전체 ${rateText(g.total, d.limits.rateMinDisks)}`}</span>
                </div>
                {g.rows.length ? (
                  <STable className="fm-table fm-xtable" minWidth={1000}>
                    <colgroup><col style={{ width: '22%' }} /><col style={{ width: '15%' }} /><col style={{ width: '7%' }} /><col style={{ width: '6%' }} /><col style={{ width: '8%' }} /><col style={{ width: '7%' }} /><col style={{ width: '18%' }} /><col style={{ width: '17%' }} /></colgroup>
                    <thead><tr><th>{outer === 'corp' ? '디스크 모델' : '법인'}</th><th>{outer === 'corp' ? '종류 · 크기' : '서버'}</th><th className="fm-r">디스크</th><th className="fm-r">서버</th><th className="fm-r">매체 오류</th><th className="fm-r">재할당</th><th>기록 있는 디스크</th><th>어디서 봤나</th></tr></thead>
                    <tbody>{g.rows.map((x) => {
                      const corp = outer === 'corp' ? { key: g.key, name: g.name } : { key: x.key, name: x.name };
                      const model = outer === 'corp' ? x.name : g.name;
                      return (
                        <tr key={x.key || '-'} className="fm-click" onClick={() => { setScope({ k: 'cross', corp: corp.key, corpName: corp.name, model }); setView('server'); }}>
                          <td className={outer === 'corp' ? 'fm-mono' : ''} data-sort={x.name}>{x.name}</td>
                          <td className="fm-dim fm-brk">{outer === 'corp' ? (x.kind || DASH) : x.serverNames.join(' · ')}</td>
                          <td className="fm-r fm-num" data-sort={x.n}>{diskCountText(x)}</td><td className="fm-r fm-num">{x.servers}</td>
                          <td className={`fm-r fm-num ${x.mediaN ? 'fm-bad' : ''}`}>{x.mediaN}</td><td className="fm-r fm-num">{x.reallocN}</td>
                          <td data-sort={x.bad}><span className="fm-rate"><i><u style={{ width: `${x.n ? Math.min(100, Math.max(x.bad ? 4 : 0, (x.bad / x.n) * 100)) : 0}%` }} /></i><span className="fm-num">{rateText(x, d.limits.rateMinDisks)}</span></span></td>
                          <td className="fm-dim fm-brk">{x.where.join(' · ') || '기록 없음'}</td>
                        </tr>
                      );
                    })}</tbody>
                  </STable>
                ) : <span className="fm-dim fm-pad-x">프로그램이 본 물리 디스크가 없습니다 — 점검 결과가 없거나 가상 머신뿐입니다.</span>}
              </div>
            ))}
          </div>
        ) : null}
        <span className="fm-dim fm-pad">숫자는 프로그램이 찾은 <b>기록 줄 수</b>이지 장애 횟수가 아닙니다(같은 일이 여러 로그에 겹쳐 남습니다). ‘—’ 는 점검하지 않았거나 끝까지 돌지 않은 것이고 0 과 다릅니다. 0 도 ‘과거에 문제가 없었다’ 가 아니라 ‘남아 있는 자료에서 찾지 못했다’ 입니다. 디스크는 식별자(시리얼 · WWN)로 하나씩 세고, 식별자가 없는 기록은 디스크 모델 집계에 넣지 않습니다. 점검은 단추를 누를 때만 돕니다(주기 실행 없음 · 같은 서버는 {d.limits.runGapMin}분에 한 번).</span>
      </div>
      {selRow ? <Result row={selRow} now={now} labels={labels} /> : <div className="fm-card fm-empty">표의 서버 줄을 누르면 그 서버의 점검 결과가 여기에 나옵니다.</div>}
      <div className="fm-grid2">
        <div className="fm-card fm-pad fm-col">
          <div className="fm-row fm-between"><h3 className="fm-h3">대상 서버 준비 — 서버마다 한 번 · root 로</h3><div className="fm-row"><span className="fm-badge off">판본 {d.version.program || DASH}</span><button type="button" className="fm-btn sm" onClick={() => downloadFile('/tools/focus-mon/audit/install.sh').catch(() => {})}>설치 파일 받기</button><button type="button" className="fm-btn sm" aria-expanded={showInstall} onClick={() => setShowInstall(!showInstall)}>{showInstall ? '명령 접기' : '명령 보기'}</button></div></div>
          <ol className="fm-list">
            <li>‘설치 파일 받기’ 로 받은 파일을 대상 서버에 올립니다(점검 프로그램 원본 · 실행 파일 · sudoers 한 줄이 한 파일에 들어 있습니다).</li>
            <li>root 로 <b>sh dvc-disk-audit-install.sh 수집계정</b> — 두 파일을 root 소유 고정 경로에 두고, 수집 계정이 <b>그 실행 파일 하나만 · 인자 없이</b> root 로 실행하도록 sudoers 에 한 줄을 넣습니다(visudo 검사 뒤).</li>
            <li>포탈에서 ‘준비 상태 다시 확인’ — 판본 · 소유자 · sudo 규칙을 일반 계정으로 확인합니다.</li>
          </ol>
          {showInstall ? <div className="fm-row"><pre className="fm-code fm-grow">{installSteps(d.paths, d.version)}</pre><button type="button" className="fm-btn sm" onClick={() => copyText(installSteps(d.paths, d.version))}>복사</button></div> : null}
          <span className="fm-dim">포탈은 이 고정 명령만 부르고, root 로 돌 코드를 보내지 않습니다. 실행 전마다 두 파일의 sha256 · 소유자 · 쓰기 권한을 일반 계정으로 읽어, 포탈 판본과 다르거나 root 소유가 아니면 실행하지 않습니다. 프로그램은 Python 3.6 이상이 필요합니다(RHEL 7 은 python3 를 따로 설치해야 합니다).</span>
        </div>
        <div className="fm-card fm-pad fm-col">
          <h3 className="fm-h3">실행 규칙 · 밝혀 둘 것</h3>
          <ul className="fm-list">
            <li>그 서버를 맡은 노드(중앙 · 법인 엣지)가 실행합니다. 엣지는 실행 출력을 중앙에 올리고, 중앙이 다시 해석합니다.</li>
            <li>노드마다 한 번에 {d.limits.nodeConcurrency}대 · 세션 시한 {d.limits.deadlineMin}분 · 같은 서버는 {d.limits.runGapMin}분에 한 번 · 준비 확인은 {d.limits.checkGapSec}초에 한 번.</li>
            <li>프로그램은 journal 전체와 회전된 messages 파일을 모두 읽습니다. 걸리는 시간과 부하는 로그 크기에 비례하고, 낮은 우선순위(nice 19 · ionice)로 돕니다.</li>
            <li>실행 · 준비 확인 · 설치 파일 · 원문 받기는 감사 기록에 남습니다. 결과에는 커널 로그 줄 · 디스크 시리얼이 들어 있어 이 탭은 관리자 · 전체 범위만 봅니다.</li>
            <li>대상 서버에 보고서 파일을 남기지 않습니다(임시 폴더에서 돌리고 지웁니다). 결과는 서버마다 최근 {d.limits.keepRuns}회 · {d.limits.keepDays}일 보관합니다.</li>
          </ul>
        </div>
      </div>
    </div>
  );
}
