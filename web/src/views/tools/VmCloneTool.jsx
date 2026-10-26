import React, { useEffect, useMemo, useRef, useState } from 'react';
import { fetchJson, postJson, delJson } from '../../api.js';
import { Loading, ErrorBox, SearchBox } from '../../components/ui.jsx';
import { STable } from '../../components/STable.jsx';
import { unitText } from '../unitText.js';
import { dsOptionLabel } from './vmCloneDsText.js'; // v2.632 WEB2632-05
import { cloneRunMark } from '../authSkipText.js'; // v2.591(감사 F1): 인증 정지로 건너뛴 실행은 실패도 성공도 아니다
import ScopeOmitBanner from '../ScopeOmitBanner.jsx'; // v2.631 A6-2631-06: 범위 제외 문구 단일 소스
import { requireChanged } from '../changeResult.js'; // v2.732 B5-03 계열: 삭제 실패 본문을 성공으로 읽지 않는다
import { mountLabel, MOUNTS_MASKED_NOTE, showMountsMaskedNote } from './vmCloneMountText.js'; // v2.743 AUTHZ-02: NFS 주소 가림
import Select from '../../components/Select.jsx';
import {
  kpisOf, corpCards, lastRunTones, jobState, execText, cloneBytes, fmtBytes, lastVerify, recentSessions, storageRows,
  capacityEstimate, agoText, durText, KIND_LABEL, keepText, rpoText, rpoOverdueCount,
} from './vmCloneView.js';
import VmCloneJobDetail from './VmCloneJobDetail.jsx';
import VmCloneRestore from './VmCloneRestore.jsx';
import VmCloneCorp from './VmCloneCorp.jsx';

/**
 * 특수기능 › VM 복제(백업)(v2.299, admin 전용) → v2.793 'VM 백업 센터'(디자인 캔버스 'VM 백업 센터 시안' ①~⑥).
 *  - 법인(수집 엣지)별 현황 · 최근 14회 실행 막대 · 복원 지점 · 검증(부팅 확인) · 새 VM 으로 복구 · 법인 저장소.
 *  - 엣지 위임 vCenter 의 백업은 **담당 엣지가 실행**하고(중앙은 그 vCenter 에 로그인하지 않는다) 상태는 엣지가 올린다.
 *  - 숫자(KPI·법인 카드·막대·세션)는 전부 vmCloneView.js 하나에서 계산한다.
 * 실행은 노드마다 직렬 큐(한 번에 1개) — 여기서는 등록/실행/현황만 본다.
 */
const MODE_LABEL = { manual: '수동만', daily: '매일', interval: '간격' };

/**
 * v2.732(점검 2회차 B5-05): 잡 추가 폼의 선택 목록(vCenter·VM·데이터스토어) 상태 → 'VM 검색·선택' 라벨.
 * 예전에는 조회가 실패하면 `catch → setVms([])` 라 일시 장애가 그대로 **'0대 중 · 일치 VM 없음'** 으로 굳었다(재현).
 * state: 'idle'(vCenter 미선택) · 'loading' · 'ok' · 'error'. total 은 /vms 응답의 전체 개수(상한 5,000 으로 잘렸으면 밝힌다).
 */
export function vmPickLabel({ state, count, total } = {}) {
  if (state === 'loading') return 'VM 검색·선택 (불러오는 중…)';
  if (state === 'error') return 'VM 검색·선택 — VM 목록을 읽지 못했습니다';
  const n = Number.isFinite(count) ? count : 0;
  if (Number.isFinite(total) && total > n) return `VM 검색·선택 (전체 ${total}대 중 앞 ${n}대 — 이름순)`;
  return `VM 검색·선택 (${n}대 중)`;
}
/** 목록 조회 실패 문구 — 사유를 그대로 말한다('0개' 로 보이지 않게). */
export function listFailText(what, err) {
  const why = (err && (err.message || String(err))) || '사유 미상';
  return `${what} 목록을 읽지 못했습니다(${why}) — 비어 있다는 뜻이 아닙니다.`;
}

const scheduleText = (s) => `${MODE_LABEL[s?.mode] || '수동만'}${s?.mode === 'daily' ? ` ${s.time}` : s?.mode === 'interval' ? ` ${s.hours}시간` : ''}`;
const NEW_FORM = () => ({ vcenterId: '', vmId: '', vmName: '', dest: { type: 'datastore', datastoreName: '' }, schedule: { mode: 'daily', time: '02:00' }, keep: 7, quiesce: false, enabled: true, verifyAfter: true });

export default function VmCloneTool() {
  const [d, setD] = useState(null);          // { jobs, status, mounts, corps, nfsDatastores, ops, … }
  const [err, setErr] = useState(null);
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState('');      // 진행 중인 요청 대상(잡 id) — 그 대상만 잠근다(web.md '긴 작업의 진행 중 잠금')
  const [view, setView] = useState({ name: 'dash' });   // dash | job | restore | corp | wizard
  const [now, setNow] = useState(Date.now());

  // 늦게 온 이전 응답은 버린다(고RTT·10초 폴링 — 새 응답을 옛 응답이 덮지 않게, web.md 규약).
  const loadSeq = useRef(0);
  const load = () => {
    const seq = ++loadSeq.current;
    return fetchJson('/tools/vm-clone').then((r) => { if (seq !== loadSeq.current) return; setD(r); setErr(null); setNow(Date.now()); }).catch((e) => { if (seq === loadSeq.current) setErr(e.message); });
  };
  useEffect(() => { load(); const t = setInterval(load, 10_000); return () => clearInterval(t); }, []);
  const jobs = useMemo(() => d?.jobs || [], [d]);
  const kpi = useMemo(() => kpisOf(jobs, now), [jobs, now]);
  const cards = useMemo(() => corpCards(d?.corps, jobs, d?.nfsDatastores, now), [d, jobs, now]);
  const sessions = useMemo(() => recentSessions(jobs, d?.ops, 8), [jobs, d]);

  if (err && !d) return <ErrorBox message={err} />;
  if (!d) return <Loading />;

  const runNow = async (id) => {
    setBusy(id); setMsg(null);
    try {
      const r = await postJson(`/tools/vm-clone/jobs/${encodeURIComponent(id)}/run`, {});
      setMsg(r.ok ? (r.where === 'edge' ? `담당 엣지(${r.agent})로 보냈습니다 — 엣지가 다음 동기화에 가져가 실행합니다.` : '실행 큐에 넣었습니다(한 번에 1개씩 직렬 실행).') : `실행 불가: ${r.reason}`);
      await load();
    } catch (e) { setMsg(`오류: ${e.message}`); } finally { setBusy(''); }
  };
  const remove = async (j) => {
    if (!window.confirm(`'${j.vmName}' 복제 잡을 삭제할까요?\n(만들어 둔 클론/NFS 사본은 지우지 않습니다 — 잡 정의만 삭제)`)) return;
    setBusy(j.id); setMsg(null);
    try { requireChanged(await delJson(`/tools/vm-clone/jobs/${encodeURIComponent(j.id)}`)); setView({ name: 'dash' }); await load(); }
    catch (e) { setMsg(`오류: ${e.message}`); } finally { setBusy(''); }
  };
  const openJob = (id) => setView({ name: 'job', id });
  const back = () => { setView({ name: 'dash' }); setMsg(null); };

  if (view.name === 'wizard') {
    return <JobForm d={d} form={view.form} onCancel={() => setView(view.form.id ? { name: 'job', id: view.form.id } : { name: 'dash' })} onSaved={(id) => { setView(id ? { name: 'job', id } : { name: 'dash' }); load(); }} />;
  }
  if (view.name === 'job') {
    const job = jobs.find((j) => j.id === view.id);
    if (!job) return <div className="vbk"><div className="vbk-crumb"><button type="button" onClick={back}>VM 백업</button> › 잡 상세</div><div className="muted">잡을 찾을 수 없습니다(지워졌거나 조회 범위 밖입니다).</div></div>;
    return <VmCloneJobDetail d={d} job={job} now={now} msg={msg} busy={busy === job.id}
      onBack={back} onRun={() => runNow(job.id)} onEdit={() => setView({ name: 'wizard', form: { ...job } })} onDelete={() => remove(job)}
      onRestore={(ref) => setView({ name: 'restore', id: job.id, ref })} onReload={load} setMsg={setMsg} />;
  }
  if (view.name === 'restore') {
    const job = jobs.find((j) => j.id === view.id);
    if (!job) return <div className="vbk"><div className="vbk-crumb"><button type="button" onClick={back}>VM 백업</button> › 복구</div><div className="muted">잡을 찾을 수 없습니다.</div></div>;
    return <VmCloneRestore d={d} job={job} initialRef={view.ref} onBack={() => setView({ name: 'job', id: job.id })} onDone={(text) => { setMsg(text); setView({ name: 'job', id: job.id }); load(); }} />;
  }
  if (view.name === 'corp') {
    return <VmCloneCorp d={d} now={now} initialKey={view.key} onBack={back} onReload={load} />;
  }

  // ── ① 대시보드 ──
  const localRun = d.status?.running;
  const running = [
    ...(localRun ? [{ where: '이 포탈', vm: jobs.find((j) => j.id === localRun.jobId)?.vmName || (localRun.kind === 'nfsds-attach' ? 'NFS 데이터스토어 연결' : localRun.kind === 'nfsds-detach' ? 'NFS 데이터스토어 떼어 내기' : localRun.jobId || '작업'), phase: localRun.phase, since: localRun.startedAt }] : []),
    ...(d.corps || []).filter((c) => c.edge?.runner?.running).map((c) => ({ where: c.label, vm: jobs.find((j) => j.id === c.edge.runner.running.jobId)?.vmName || '작업', phase: c.edge.runner.running.phase, since: c.edge.runner.running.startedAt })),
  ];
  const queued = (d.status?.queued?.length || 0) + (d.corps || []).reduce((a, c) => a + (c.edge?.runner?.queued?.length || 0), 0);
  const stores = storageRows(jobs, [], d.nfsDatastores);

  return (
    <div className="vbk">
      <div className="vbk-head">
        <div>
          <h2 className="vbk-title">VM 백업</h2>
          <div className="vbk-sub">스냅샷 시점 클론으로 만든 사본을 복원 지점으로 관리합니다 · 데이터스토어·ESXi NFS 데이터스토어(서버측 복사) / 엣지 NFS(파일)</div>
        </div>
        <div className="vbk-actions">
          <button type="button" className="vbk-btn" onClick={() => setView({ name: 'corp' })}>법인 저장소</button>
          <button type="button" className="vbk-btn primary" onClick={() => setView({ name: 'wizard', form: NEW_FORM() })}>+ 백업 잡 추가</button>
        </div>
      </div>

      {rpoOverdueCount(jobs) > 0 && (
        <div className="vbk-note" role="status">RPO 초과 잡 {rpoOverdueCount(jobs)}개 — 마지막 성공이 스케줄 주기의 2배 + 1시간을 넘었습니다. 실행이 멈췄거나(엣지 중단·담당 미확정) 매번 건너뛰고 있는지 잡 표의 해당 줄을 확인하세요.</div>
      )}

      {cards.length > 0 && (
        <div>
          <div className="vbk-sec" style={{ marginBottom: 8 }}>법인별 현황 <small>법인 = vCenter 를 수집하는 엣지 · 엣지 위임 vCenter 의 백업은 그 엣지가 실행합니다</small></div>
          <div className="vbk-corps">
            {cards.map((c) => (
              <button type="button" key={c.key} className={`vbk-corp${c.state === 'problem' || c.fail24 ? ' bad' : ['old', 'stale', 'noreport'].includes(c.state) ? ' warn' : ''}`}
                style={{ textAlign: 'left', font: 'inherit', color: 'inherit', cursor: 'pointer' }} onClick={() => setView({ name: 'corp', key: c.key })}>
                <span className="flex between gap" style={{ gap: 8 }}>
                  <span className="nm">{c.name}</span>
                  <span className={`vbk-chip ${c.state === 'ok' || c.state === 'central' ? 'ok' : c.state === 'problem' ? 'fail' : c.state === 'sim' ? '' : 'warn'}`}>{c.stateLabel}</span>
                </span>
                <span className="ln">{c.sub}</span>
                <span className="nums">
                  <span><b>{c.jobs}</b> <span className="muted">잡</span></span>
                  <span><b style={{ color: c.fail24 ? 'var(--red)' : undefined }}>{c.total24 ? `${c.ok24}/${c.total24}` : '—'}</b> <span className="muted">24시간 성공</span></span>
                  {c.queued > 0 && <span><b>{c.queued}</b> <span className="muted">대기</span></span>}
                </span>
                <span className="ln" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.storesText}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="vbk-strip">
        {running.length ? running.map((r, i) => (
          <span key={i} className="flex" style={{ alignItems: 'center', gap: 8, minWidth: 0 }}>
            <span className="vbk-dot running" />
            <b>실행 중 · {r.vm}</b>
            <span className="muted">{r.where} · {r.phase || '—'}{r.since ? ` · ${durText(now - r.since)}째` : ''}</span>
          </span>
        )) : <span className="muted"><span className="vbk-dot" style={{ marginRight: 8 }} />유휴</span>}
        <span className="muted">대기 {queued}건 · 노드마다 한 번에 1개씩 직렬 실행</span>
        {d.status?.runningOutOfScope && <span className="muted">조회 범위 밖 잡이 실행 중입니다</span>}
        {msg && <span style={{ flexBasis: '100%', fontSize: 12.5 }}>{msg}</span>}
      </div>
      {showMountsMaskedNote(d) && <div className="muted" style={{ fontSize: 12 }}>{MOUNTS_MASKED_NOTE}</div>}
      {/* v2.599(AUTHZ-2599-05): 범위 제한 계정에는 범위 밖 vCenter 의 잡을 빼고 그 개수를 밝힌다 */}
      {/* v2.631 A6-2631-06: scoped·omittedOutOfScope 판정·문구는 scopeOmitText.js 하나가 소유한다 */}
      <ScopeOmitBanner data={d} unit="복제 잡" counter="개" why="조회 범위 밖 vCenter 의" />

      <div className="vbk-kpis">
        <div className="vbk-kpi"><div className="l">보호 중인 VM</div><div className="v">{kpi.protectedVms}<small>대</small></div><div className="m">잡 {jobs.length}개{kpi.disabled ? ` · 비활성 ${kpi.disabled}` : ''}{kpi.noReport ? ` · 엣지 보고 없음 ${kpi.noReport}` : ''}</div></div>
        <div className="vbk-kpi"><div className="l">최근 24시간</div><div className="v" style={{ color: kpi.fail24 ? 'var(--amber)' : kpi.total24 ? 'var(--green)' : undefined }}>{kpi.total24 ? kpi.ok24 + kpi.warn24 : '—'}<small>{kpi.total24 ? `/ ${kpi.total24} 성공` : '실행 없음'}</small></div><div className="m">실패 {kpi.fail24} · 경고 {kpi.warn24}{kpi.skip24 ? ` · 건너뜀 ${kpi.skip24}` : ''}</div></div>
        <div className="vbk-kpi"><div className="l">복원 지점</div><div className="v">{kpi.points}<small>개</small></div><div className="m">{kpi.oldestPointAt ? `가장 오래된 지점 ${agoText(kpi.oldestPointAt, now)}` : '아직 없음'}</div></div>
        <div className="vbk-kpi"><div className="l">사본 용량</div><div className="v">{kpi.bytes ? fmtBytes(kpi.bytes) : '—'}</div><div className="m">{kpi.unknownBytes ? `크기 모르는 사본 ${kpi.unknownBytes}개 제외(최소값)` : '원장 사본 합계'}</div></div>
        <div className="vbk-kpi"><div className="l">최근 검증</div><div className="v" style={{ color: kpi.verifyTotal && kpi.verifyOk < kpi.verifyTotal ? 'var(--amber)' : undefined }}>{kpi.verifyTotal ? kpi.verifyOk : '—'}<small>{kpi.verifyTotal ? `/ ${kpi.verifyTotal} 부팅 확인` : '검증 기록 없음'}</small></div><div className="m">잡마다 가장 최근 검증 결과</div></div>
      </div>

      <div className="vbk-cols">
        <div className="vbk-main">
          <div className="vbk-panel">
            <div className="hd"><div className="vbk-sec">백업 잡 <small>{jobs.length}개</small></div></div>
            <div style={{ overflowX: 'auto' }}>
              <STable minWidth={780}>
                <thead><tr><th>VM</th><th>대상</th><th>스케줄</th><th data-nosort>최근 14회</th><th style={{ textAlign: 'right' }}>복원 지점</th><th>검증</th><th className="right" data-nosort>작업</th></tr></thead>
                <tbody>
                  {jobs.length === 0 && <tr><td colSpan={7} className="center muted" style={{ padding: 22 }}>백업 잡이 없습니다 — "+ 백업 잡 추가"로 vCenter별 VM 을 지정하세요.</td></tr>}
                  {jobs.map((j) => {
                    const st = jobState(j);
                    const b = cloneBytes(j.clones);
                    const v = lastVerify(j);
                    const mark = j.lastRun ? cloneRunMark(j.lastRun) : null;
                    return (
                      <tr key={j.id} style={{ opacity: j.enabled ? 1 : 0.6 }}>
                        <td data-sort={j.vmName}>
                          <div className="flex" style={{ alignItems: 'center', gap: 8 }}>
                            <span className={`vbk-dot ${st}`} title={st} />
                            <div style={{ minWidth: 0 }}>
                              <button type="button" className="vcd-link" title="잡 상세 — 복원 지점·검증·복구" style={{ background: 'none', border: 0, padding: 0, font: 'inherit', fontWeight: 600, color: 'inherit', cursor: 'pointer', textDecoration: 'underline', textDecorationColor: 'var(--border)', textUnderlineOffset: 3 }} onClick={() => openJob(j.id)}>{j.vmName}</button>
                              {!j.enabled && <span className="badge gray" style={{ marginLeft: 6 }}>비활성</span>}
                              <div className="muted" style={{ fontSize: 11.5 }}>{d.vcenterNames?.[j.vcenterId] || j.vcenterId}{execText(j, now) ? ` · ${execText(j, now)}` : ''}</div>
                            </div>
                          </div>
                        </td>
                        <td data-sort={j.dest.datastoreName || j.dest.mountId}>
                          {j.dest.type === 'datastore'
                            ? <span className="vbk-chip ds">{j.dest.nfsDsId ? 'NFS-DS' : 'DS'}</span>
                            : <span className="vbk-chip nfs">엣지 NFS</span>}
                          <div className="muted" style={{ fontSize: 11.5, marginTop: 3 }}>{j.dest.type === 'datastore' ? j.dest.datastoreName : `${mountLabel((d.mounts || []).find((m) => m.id === j.dest.mountId)) || j.dest.mountId}${j.dest.subdir ? `/${j.dest.subdir}` : ''}`}</div>
                        </td>
                        <td style={{ fontSize: 12.5 }}>
                          <div>{scheduleText(j.schedule)}</div>
                          {mark && <div style={{ fontSize: 11.5, color: `var(--${mark.tone})` }} title={j.lastRun.detail}>{mark.icon} {agoText(j.lastRun.at, now)}</div>}
                          {/* v2.795: 두 줄로(⏰ RPO 초과 / 사유) — 한 줄이면 스케줄 열이 늘어 1440px 에서도 표가 카드 밖으로 밀린다(Chromium 실측 1013px > 820px). */}
                          {rpoText(j.rpo, now) && <div style={{ fontSize: 11.5, color: 'var(--amber)', maxWidth: 150, whiteSpace: 'normal' }} title="마지막 성공이 스케줄 주기의 2배 + 1시간을 넘었습니다"><b>⏰ RPO 초과</b><br />{rpoText(j.rpo, now).replace(/^RPO 초과 · /, '')}</div>}
                        </td>
                        <td><span className="vbk-runs" aria-label="최근 14회 실행 결과">{lastRunTones(j, 14).map((t, i) => <i key={i} className={t} title={t} />)}</span></td>
                        <td style={{ textAlign: 'right' }} data-sort={(j.clones || []).length}>
                          <div style={{ fontWeight: 600 }}>{(j.clones || []).length}</div>
                          <div className="muted" style={{ fontSize: 11.5 }}>{b.known ? fmtBytes(b.bytes) : '—'}</div>
                        </td>
                        <td>{j.dest.type !== 'datastore' ? <span className="vbk-chip">해당 없음</span> : v ? <span className={`vbk-chip ${v.ok ? 'ok' : 'fail'}`} title={v.detail}>{v.ok ? '부팅 확인' : '검증 실패'}</span> : <span className="vbk-chip">{j.verifyAfter ? '대기' : '검증 안 함'}</span>}</td>
                        <td className="right" style={{ whiteSpace: 'nowrap' }}>
                          <button type="button" className="vbk-btn sm" disabled={busy === j.id || !j.enabled} title="지금 실행" onClick={() => runNow(j.id)}>실행</button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </STable>
            </div>
            <div className="vbk-legend">
              <span><i style={{ background: 'var(--green)' }} />성공</span>
              <span><i style={{ background: 'var(--amber)' }} />경고(스냅샷·보존 삭제 실패)</span>
              <span><i style={{ background: 'var(--red)' }} />실패</span>
              <span><i style={{ background: '#3a4766' }} />건너뜀(인증 정지·재시작 정리 등)</span>
            </div>
          </div>
          <div className="muted" style={{ fontSize: 11.5 }}>
            엣지 NFS 마운트 등록/해제·로그는 그 노드의 <b>설정 › NFS 마운트(백업 대상)</b>에서, ESXi NFS 데이터스토어는 <b>법인 저장소</b>에서 관리합니다. 복제 대상 VM 은 Platform 트리에 <span className="badge blue" style={{ fontSize: 10 }}>Clone</span> 배지로 표시됩니다.
          </div>
        </div>

        <div className="vbk-side">
          <div className="vbk-panel">
            <div className="hd"><div className="vbk-sec">최근 세션</div></div>
            {sessions.length === 0 && <div className="bd muted" style={{ fontSize: 12.5 }}>아직 실행 기록이 없습니다.</div>}
            {sessions.map((s, i) => (
              <div key={i} className="vbk-sess">
                <span className={`vbk-dot ${s.tone}`} style={{ marginTop: 5 }} />
                <div>
                  <div className="flex between" style={{ gap: 8 }}>
                    <b style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.vm || '—'} <span className="muted" style={{ fontWeight: 400 }}>· {KIND_LABEL[s.kind] || s.kind}</span></b>
                    <span className="t">{agoText(s.at, now)}</span>
                  </div>
                  <div className="d">{s.detail}{s.ms ? ` · ${durText(s.ms)}` : ''}</div>
                </div>
              </div>
            ))}
          </div>
          <div className="vbk-panel">
            <div className="hd"><div className="vbk-sec">사본 저장 위치</div></div>
            <div className="bd" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {stores.length === 0 && <div className="muted" style={{ fontSize: 12.5 }}>잡이 없습니다.</div>}
              {stores.map((s) => {
                const cap = Number(s.capacityGB); const free = Number(s.freeGB);
                const pct = s.capacityGB != null && s.freeGB != null && cap > 0 ? Math.round(((cap - free) / cap) * 100) : null;
                return (
                  <div key={s.key} style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                    <div className="flex between" style={{ gap: 8, fontSize: 12.5 }}>
                      <b style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name}</b>
                      <span className="muted" style={{ whiteSpace: 'nowrap' }}>사본 {fmtBytes(s.bytes)}{s.unknown ? ` + 모름 ${s.unknown}` : ''}{pct != null ? ` · 사용 ${pct}%` : ''}</span>
                    </div>
                    <div className="vbk-bar"><b style={{ width: `${pct ?? 0}%`, background: s.kind === 'nfs' ? 'var(--purple)' : 'var(--accent)', opacity: pct == null ? 0 : 1 }} /></div>
                  </div>
                );
              })}
              <div className="muted" style={{ fontSize: 11.5, lineHeight: 1.6 }}>사본 크기는 클론 VM 의 커밋 용량(못 읽은 사본은 '모름')입니다. 사용률은 수집된 데이터스토어 용량 기준이며, 엣지 NFS 는 법인 저장소 화면에서 봅니다.</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/** 저장 대상 선택지 — 법인(실행 위치) 기준. 엣지 위임 vCenter 면 그 엣지가 보고한 마운트, 중앙이면 이 포탈의 마운트. */
function corpOfVc(d, vcenterId) { return (d.corps || []).find((c) => (c.vcenterIds || []).includes(String(vcenterId))) || null; }
// v2.794: 법인이 '백업에 사용' 으로 지정한 마운트만(지정이 없으면 전부). 수정 중인 잡이 이미 쓰는 마운트(keepId)는 지정 밖이어도 남긴다.
function mountsFor(d, vcenterId, keepId = '') {
  const c = corpOfVc(d, vcenterId);
  const all = c?.agent ? (c.edge?.mounts || []) : (d.mounts || []);
  const use = Array.isArray(c?.mountUse?.mountIds) ? new Set(c.mountUse.mountIds) : null;
  return use ? all.filter((m) => use.has(m.id) || (keepId && m.id === keepId)) : all;
}

/** 잡 추가/수정 마법사(시안 ③·⑥) — ① vCenter·VM → ② 저장 대상(법인 저장소) → ③ 스케줄·보존·옵션 → ④ 요약. */
function JobForm({ d, form: initial, onCancel, onSaved }) {
  const [form, setForm] = useState(() => ({ ...NEW_FORM(), ...initial, dest: { ...(initial.dest || {}) }, schedule: { ...(initial.schedule || {}) } }));
  const [step, setStep] = useState(initial.id ? 2 : 1);
  const [vcs, setVcs] = useState([]);
  const [vms, setVms] = useState([]);
  const [dss, setDss] = useState([]);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  // v2.732(점검 2회차 B5-05): 세 목록의 조회 상태 — 실패를 빈 목록으로 삼키지 않는다(사유 + 다시 시도).
  const [vcErr, setVcErr] = useState(null);
  const [vmList, setVmList] = useState({ state: 'idle', total: null, err: null });
  const [dsErr, setDsErr] = useState(null);
  const [retry, setRetry] = useState(0);
  const loadVcs = () => { setVcErr(null); fetchJson('/vcenters').then((r) => setVcs(r || [])).catch((e) => setVcErr(e)); };
  useEffect(() => { loadVcs(); }, []);
  // vCenter 를 고르면 그 vCenter 의 VM(선택용)·데이터스토어(대상용) 로드.
  // 세대(genRef) 가드 — 고RTT 에서 이전 vCenter 응답이 늦게 와 지금 고른 vCenter 의 VM/DS 를
  // 덮어쓰면, 복제 잡이 엉뚱한 VM/데이터스토어를 대상으로 만들어질 수 있다. 늦은 응답은 버린다.
  const loadGen = useRef(0);
  useEffect(() => {
    const gen = ++loadGen.current;
    setVms([]); setDss([]); setDsErr(null);
    if (!form.vcenterId) { setVmList({ state: 'idle', total: null, err: null }); return; }
    setVmList({ state: 'loading', total: null, err: null });
    fetchJson('/vms', { vcenterId: form.vcenterId, limit: 5000, sortBy: 'name', order: 'asc' })
      .then((r) => { if (gen === loadGen.current) { const items = r.items || []; setVms(items); setVmList({ state: 'ok', total: Number.isFinite(r.total) ? r.total : items.length, err: null }); } })
      .catch((e) => { if (gen === loadGen.current) setVmList({ state: 'error', total: null, err: e }); });
    fetchJson('/datastores', { vcenterId: form.vcenterId })
      .then((r) => { if (gen === loadGen.current) setDss(r.items || []); }).catch((e) => { if (gen === loadGen.current) setDsErr(e); });
  }, [form.vcenterId, retry]);

  const ql = q.trim().toLowerCase();
  const filtered = useMemo(() => (ql ? vms.filter((v) => v.name.toLowerCase().includes(ql)) : vms).slice(0, 50), [vms, ql]);
  const sel = vms.find((v) => v.id === form.vmId);
  const corp = form.vcenterId ? corpOfVc(d, form.vcenterId) : null;
  const nfsDs = (d.nfsDatastores || []).filter((x) => String(x.vcenterId) === String(form.vcenterId));
  const mounts = form.vcenterId ? mountsFor(d, form.vcenterId, initial.dest?.type === 'nfs' ? initial.dest.mountId : '') : [];
  const kind = form.dest.type === 'nfs' ? 'nfs' : form.dest.nfsDsId ? 'nfsds' : 'datastore';
  const setKind = (k) => setForm({ ...form, dest: k === 'nfs' ? { type: 'nfs', mountId: '', subdir: '' } : k === 'nfsds' ? { type: 'datastore', datastoreName: '', nfsDsId: '' } : { type: 'datastore', datastoreName: '' }, verifyAfter: k === 'nfs' ? false : form.verifyAfter });
  const destReady = kind === 'nfs' ? !!form.dest.mountId : kind === 'nfsds' ? !!form.dest.nfsDsId : !!form.dest.datastoreName;

  // 필요 용량 예측 — VM 크기(인벤토리 프로비저닝) × 보존. 여유는 고른 대상의 수집값(모르면 '—').
  const destFreeGB = kind === 'datastore' ? dss.find((x) => x.name === form.dest.datastoreName)?.freeGB
    : kind === 'nfsds' ? nfsDs.find((x) => x.id === form.dest.nfsDsId)?.freeGB
      : (() => { const m = mounts.find((x) => x.id === form.dest.mountId); return m?.freeBytes != null ? m.freeBytes / 1024 ** 3 : null; })();
  const est = capacityEstimate(sel?.storageGB ?? null, form.keep, destFreeGB ?? null);

  const save = async () => {
    setBusy(true); setErr(null);
    try {
      const body = { ...form };
      if (kind === 'nfsds') body.dest = { type: 'datastore', nfsDsId: form.dest.nfsDsId };
      const r = await postJson('/tools/vm-clone/jobs', body);
      if (r.ok === false) setErr(r.reason); else onSaved(r.job?.id || form.id || '');
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };

  const steps = [
    ['VM 선택', form.vmName ? `${d.vcenterNames?.[form.vcenterId] || form.vcenterId} · ${form.vmName}` : 'vCenter · VM'],
    ['저장 대상', destReady ? (kind === 'nfs' ? '엣지 NFS' : form.dest.datastoreName || nfsDs.find((x) => x.id === form.dest.nfsDsId)?.name || '') : '법인 저장소'],
    ['스케줄 · 보존', `${scheduleText(form.schedule)} · ${keepText(form)}`],
    ['요약', '확인 후 저장'],
  ];
  const canNext = step === 1 ? !!form.vmId : step === 2 ? destReady : true;

  return (
    <div className="vbk">
      <div className="vbk-head">
        <div>
          <div className="vbk-crumb"><button type="button" onClick={onCancel}>VM 백업</button> › {form.id ? '잡 수정' : '새 백업 잡'}</div>
          <h2 className="vbk-title">{form.id ? `백업 잡 수정 — ${form.vmName}` : '백업 잡 추가'}</h2>
        </div>
      </div>
      <ol className="vbk-steps">
        {steps.map(([n, s], i) => (
          <li key={n} className={i + 1 === step ? 'cur' : i + 1 < step ? 'done' : ''}>
            <span>{i + 1 < step ? '✓' : i + 1}</span>
            <div>{n}<small>{s}</small></div>
          </li>
        ))}
      </ol>

      <div className="vbk-cols">
        <div className="vbk-main">
          <div className="vbk-panel"><div className="bd" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {step === 1 && (
              <>
                <div className="vbk-sec">1. VM 선택 <small>vCenter 를 고르면 그 법인(실행 위치)이 정해집니다</small></div>
                <div className="vbk-form">
                  <label>vCenter
                    <Select className="select" value={form.vcenterId} disabled={!!form.id}
                      onChange={(e) => setForm({ ...form, vcenterId: e.target.value, vmId: '', vmName: '', dest: form.dest.type === 'nfs' ? { type: 'nfs', mountId: '', subdir: '' } : { type: 'datastore', datastoreName: '' } })}>
                      <option value="">{vcErr ? '(vCenter 목록을 읽지 못함)' : '(선택)'}</option>
                      {vcs.map((v) => <option key={v.id} value={v.id}>{v.name} ({v.id})</option>)}
                    </Select>
                  </label>
                  {corp && <div style={{ alignSelf: 'end', fontSize: 12.5 }} className="muted">법인 <b style={{ color: 'var(--text)' }}>{corp.label}</b> · {corp.agent ? `엣지 ${corp.agent} 가 실행` : corp.simulated ? '데모(이 포탈이 시뮬레이션)' : corp.key === 'central' ? '중앙이 실행' : (corp.problem || '실행 위치 미확정')}</div>}
                </div>
                {form.vcenterId && !form.id && (
                  <label style={{ fontSize: 12.5, fontWeight: 600, display: 'flex', flexDirection: 'column', gap: 5 }}>{vmPickLabel({ state: vmList.state, count: vms.length, total: vmList.total })}
                    <SearchBox value={q} onChange={setQ} placeholder="VM 이름 검색" style={{ width: '100%' }} />
                    {ql && !sel && vmList.state === 'ok' && (
                      <div className="card" style={{ maxHeight: 200, overflow: 'auto', marginTop: 4, padding: 6, fontWeight: 400 }}>
                        {filtered.map((v) => (
                          <div key={v.id} className="vcd-link" style={{ padding: '4px 6px', cursor: 'pointer', fontSize: 12.5 }}
                            onClick={() => { setForm({ ...form, vmId: v.id, vmName: v.name }); setQ(v.name); }}>
                            {v.name} <span className="muted">· {v.host || '—'} · {v.cpuCount}vCPU/{Math.round((v.memMB || 0) / 1024)}GB · {unitText(v.storageGB, 'GB')}</span>
                          </div>
                        ))}
                        {!filtered.length && <div className="muted" style={{ fontSize: 12, padding: 6 }}>일치 VM 없음</div>}
                      </div>
                    )}
                  </label>
                )}
                {form.vmId && <span className="badge green" style={{ alignSelf: 'flex-start' }}>선택: {form.vmName}</span>}
              </>
            )}

            {step === 2 && (
              <>
                <div className="vbk-sec">2. 저장 대상 <small>{corp ? `${corp.label} 법인의 저장소` : ''}</small></div>
                <div className="vbk-choice">
                  {[
                    ['nfsds', 'ESXi NFS 데이터스토어', 'NFS 를 ESXi 에 붙인 데이터스토어로 vCenter 가 서버측 클론합니다. 엣지를 거치지 않고, 사본을 켜서 검증·복구할 수 있습니다.'],
                    ['nfs', '엣지 NFS 마운트', `${corp?.agent ? `엣지 ${corp.agent}` : '이 포탈'} 에 마운트된 NFS 로 vmx·vmdk 를 내려받습니다. 회선 속도에 묶이고, 검증·즉시 복구는 안 됩니다.`],
                    ['datastore', '기존 데이터스토어', '이 vCenter 의 다른 데이터스토어로 서버측 클론합니다. 같은 스토리지면 원본 장애와 분리되지 않습니다.'],
                  ].map(([k, n, s]) => (
                    <label key={k} className={kind === k ? 'on' : ''}>
                      <input type="radio" name="vbk-kind" checked={kind === k} onChange={() => setKind(k)} style={{ marginTop: 3 }} />
                      <span>{n}<small>{s}</small></span>
                    </label>
                  ))}
                </div>
                <div className="vbk-form">
                  {kind === 'nfsds' && (
                    <label>NFS 데이터스토어(법인 저장소)
                      <Select className="select" value={form.dest.nfsDsId || ''} onChange={(e) => { const x = nfsDs.find((y) => y.id === e.target.value); setForm({ ...form, dest: { type: 'datastore', datastoreName: x?.name || '', nfsDsId: e.target.value } }); }}>
                        <option value="">{nfsDs.length ? '(선택)' : '(이 vCenter 에 정의 없음 — 법인 저장소에서 추가)'}</option>
                        {nfsDs.map((x) => <option key={x.id} value={x.id}>{x.name} · 호스트 {x.hostsOk}/{x.hostsTotal}{x.freeGB != null ? ` · 여유 ${unitText(x.freeGB, 'GB')}` : ''}</option>)}
                      </Select>
                    </label>
                  )}
                  {kind === 'datastore' && (
                    <label>대상 데이터스토어
                      <Select className="select" value={form.dest.datastoreName || ''} onChange={(e) => setForm({ ...form, dest: { type: 'datastore', datastoreName: e.target.value } })}>
                        <option value="">{dsErr ? '(데이터스토어 목록을 읽지 못함)' : '(선택)'}</option>
                        {dss.map((ds) => <option key={ds.id} value={ds.name}>{dsOptionLabel(ds)}</option>)}
                      </Select>
                    </label>
                  )}
                  {kind === 'nfs' && (
                    <>
                      <label>{corp?.agent ? `엣지 ${corp.agent} 의 NFS 마운트` : 'NFS 마운트(설정 › NFS 마운트에서 등록)'}{d.mountsMasked ? ' — 주소 가림' : ''}
                        <Select className="select" value={form.dest.mountId || ''} onChange={(e) => setForm({ ...form, dest: { ...form.dest, mountId: e.target.value } })}>
                          <option value="">{mounts.length ? '(선택)' : corp?.agent && !corp?.edge ? '(엣지 보고 없음)' : '(마운트 없음)'}</option>
                          {mounts.map((m) => <option key={m.id} value={m.id}>{mountLabel(m)} {m.mounted ? '· 마운트됨' : '· ⚠ 미마운트'}</option>)}
                        </Select>
                      </label>
                      <label>하위 폴더(선택)
                        <input className="input" placeholder="예: prod" value={form.dest.subdir || ''} onChange={(e) => setForm({ ...form, dest: { ...form.dest, subdir: e.target.value } })} />
                      </label>
                    </>
                  )}
                </div>
                {sel?.host && kind === 'nfsds' && <div className="vbk-note info">{form.vmName} 은 호스트 <b style={{ color: 'var(--text)' }}>{sel.host}</b> 에서 돕니다 — 그 호스트에 NFS 데이터스토어가 연결돼 있어야 클론됩니다(법인 저장소의 호스트별 연결 결과).</div>}
              </>
            )}

            {step === 3 && (
              <>
                <div className="vbk-sec">3. 스케줄 · 보존</div>
                <div className="vbk-choice">
                  {[['daily', '매일 지정 시각', '야간 백업 창에 맞춥니다'], ['interval', 'N시간 간격', '1~168시간'], ['manual', '수동만', "'지금 실행' 으로만"]].map(([m, n, s]) => (
                    <label key={m} className={form.schedule.mode === m ? 'on' : ''}>
                      <input type="radio" name="vbk-mode" checked={form.schedule.mode === m} onChange={() => setForm({ ...form, schedule: { mode: m, ...(m === 'daily' ? { time: form.schedule.time || '02:00' } : m === 'interval' ? { hours: form.schedule.hours || 24 } : {}) } })} style={{ marginTop: 3 }} />
                      <span>{n}<small>{s}</small></span>
                    </label>
                  ))}
                </div>
                <div className="vbk-form">
                  {form.schedule.mode === 'daily' && <label>실행 시각(포탈 시각)<input className="input" type="time" value={form.schedule.time || '02:00'} onChange={(e) => setForm({ ...form, schedule: { ...form.schedule, time: e.target.value } })} /></label>}
                  {form.schedule.mode === 'interval' && <label>간격(시간)<input className="input" type="number" min={1} max={168} value={form.schedule.hours || 24} onChange={(e) => setForm({ ...form, schedule: { ...form.schedule, hours: Number(e.target.value) || 24 } })} /></label>}
                  <label>보존 개수(복원 지점)<input className="input" type="number" min={1} max={30} value={form.keep} onChange={(e) => setForm({ ...form, keep: Number(e.target.value) || 3 })} /></label>
                  <label title="이보다 오래된 사본도 지웁니다. 가장 최근 1개는 언제나 남깁니다. 0 이면 개수만 봅니다.">보존 기간(일 · 0=개수만)<input className="input" type="number" min={0} max={365} value={form.keepDays || 0} onChange={(e) => setForm({ ...form, keepDays: Math.max(0, Math.min(365, Math.floor(Number(e.target.value)) || 0)) })} /></label>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10, borderTop: '1px solid var(--border-soft)', paddingTop: 14 }}>
                  <label className="flex gap" style={{ alignItems: 'flex-start', fontSize: 13, gap: 10 }} title="VMware Tools 정지점(VSS/freeze) 스냅샷 — DB 등 앱 정합 사본. Tools 필수.">
                    <input type="checkbox" checked={!!form.quiesce} onChange={(e) => setForm({ ...form, quiesce: e.target.checked })} style={{ marginTop: 3 }} />
                    <span><b>정지점(앱 정합)</b><br /><span className="muted" style={{ fontSize: 12 }}>VMware Tools VSS/freeze 스냅샷. Tools 가 없으면 정지점이 실패합니다{form.quiesce ? ' — 그때 어떻게 할지는 아래에서 고릅니다' : ''}.</span></span>
                  </label>
                  {form.quiesce && (
                    <label className="flex gap" style={{ alignItems: 'flex-start', fontSize: 13, gap: 10, paddingLeft: 24 }}>
                      <input type="checkbox" checked={form.quiesceFallback !== false} onChange={(e) => setForm({ ...form, quiesceFallback: e.target.checked })} style={{ marginTop: 3 }} />
                      <span><b>정지점이 실패하면 일반 스냅샷으로 백업</b><br /><span className="muted" style={{ fontSize: 12 }}>앱 정합이 아닌(crash-consistent) 사본이 되고 결과에 ⚠ 가 남습니다. 끄면 그 회차는 실패로 남고 실패 메일이 갑니다.</span></span>
                    </label>
                  )}
                  <label className="flex gap" style={{ alignItems: 'flex-start', fontSize: 13, gap: 10, opacity: kind === 'nfs' ? 0.5 : 1 }}>
                    <input type="checkbox" disabled={kind === 'nfs'} checked={kind !== 'nfs' && !!form.verifyAfter} onChange={(e) => setForm({ ...form, verifyAfter: e.target.checked })} style={{ marginTop: 3 }} />
                    <span><b>복제 후 자동 검증</b><br /><span className="muted" style={{ fontSize: 12 }}>새 사본에 검증용 스냅샷을 만들고 네트워크를 끊은 채 켜서 VMware Tools 응답을 확인한 뒤, 끄고 검증 전 상태로 되돌립니다{d.limits?.verifyTimeoutMin ? `(응답 대기 ${d.limits.verifyTimeoutMin}분)` : ''}. {kind === 'nfs' ? '엣지 NFS 사본은 켤 VM 이 없어 쓸 수 없습니다.' : ''}</span></span>
                  </label>
                  <label className="flex gap" style={{ alignItems: 'center', fontSize: 13, gap: 10 }}>
                    <input type="checkbox" checked={form.enabled !== false} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} /> <b>활성</b>
                  </label>
                </div>
              </>
            )}

            {step === 4 && (
              <>
                <div className="vbk-sec">4. 요약</div>
                <div>
                  <div className="vbk-kv"><span>VM</span><span>{form.vmName}{sel?.storageGB != null ? ` (${unitText(sel.storageGB, 'GB')})` : ''}</span></div>
                  <div className="vbk-kv"><span>vCenter · 법인</span><span>{d.vcenterNames?.[form.vcenterId] || form.vcenterId} · {corp?.label || '—'}</span></div>
                  <div className="vbk-kv"><span>저장 대상</span><span>{kind === 'nfs' ? `엣지 NFS · ${mountLabel(mounts.find((m) => m.id === form.dest.mountId)) || form.dest.mountId}${form.dest.subdir ? `/${form.dest.subdir}` : ''}` : `${kind === 'nfsds' ? 'ESXi NFS 데이터스토어' : '데이터스토어'} · ${form.dest.datastoreName || nfsDs.find((x) => x.id === form.dest.nfsDsId)?.name || ''}`}</span></div>
                  <div className="vbk-kv"><span>스케줄 · 보존</span><span>{scheduleText(form.schedule)} · {keepText(form)}</span></div>
                  <div className="vbk-kv"><span>옵션</span><span>{[form.quiesce ? (form.quiesceFallback === false ? '정지점(필수)' : '정지점(실패 시 일반)') : '크래시 정합', kind !== 'nfs' && form.verifyAfter ? '자동 검증' : '', form.enabled === false ? '비활성' : ''].filter(Boolean).join(' · ')}</span></div>
                  <div className="vbk-kv"><span>사본 상태</span><span>꺼진 상태로 생성</span></div>
                </div>
              </>
            )}

            {/* v2.732 B5-05: 선택 목록을 못 읽었으면 '없다' 가 아니라 '못 읽었다' 고 말하고 다시 시도하게 한다 */}
            {(vcErr || vmList.state === 'error' || dsErr) && (
              <div style={{ color: 'var(--amber)', fontSize: 12.5, lineHeight: 1.6 }}>
                {vcErr && <div>⚠ {listFailText('vCenter', vcErr)}</div>}
                {vmList.state === 'error' && <div>⚠ {listFailText('VM', vmList.err)}</div>}
                {dsErr && <div>⚠ {listFailText('데이터스토어', dsErr)}</div>}
                <button type="button" className="vbk-btn sm" style={{ marginTop: 4 }} onClick={() => { if (vcErr) loadVcs(); setRetry((x) => x + 1); }}>다시 시도</button>
              </div>
            )}
            {err && <div style={{ color: 'var(--red)', fontSize: 12.5 }}>⚠ {err}</div>}

            <div className="flex between wrap gap" style={{ borderTop: '1px solid var(--border-soft)', paddingTop: 14 }}>
              <button type="button" className="vbk-btn" disabled={step === 1 || (form.id && step === 2)} onClick={() => setStep(step - 1)}>이전</button>
              <div className="flex gap" style={{ gap: 8 }}>
                <button type="button" className="vbk-btn" onClick={onCancel}>취소</button>
                {step < 4
                  ? <button type="button" className="vbk-btn primary" disabled={!canNext} onClick={() => setStep(step + 1)}>다음 — {steps[step][0]}</button>
                  : <button type="button" className="vbk-btn primary" disabled={busy || !form.vmId || !destReady} onClick={save}>{busy ? '저장 중…' : '저장'}</button>}
              </div>
            </div>
          </div></div>
        </div>

        <div className="vbk-side">
          <div className="vbk-panel"><div className="hd"><div className="vbk-sec">필요 용량 예측</div></div><div className="bd">
            {est ? (
              <>
                <div style={{ fontSize: 24, fontWeight: 700 }}>{fmtBytes(est.needGB * 1024 ** 3)} <span className="muted" style={{ fontSize: 13, fontWeight: 500 }}>= {unitText(sel.storageGB, 'GB')} × 보존 {est.keep}</span></div>
                {destReady && <div className="vbk-kv"><span>대상 여유</span><span>{est.freeGB != null ? fmtBytes(est.freeGB * 1024 ** 3) : '—(이 대상의 여유를 모릅니다)'}</span></div>}
                {est.fits === false && <div className="vbk-note" style={{ marginTop: 6 }}>예측이 대상 여유보다 큽니다 — 보존 개수를 줄이거나 다른 대상을 고르세요.</div>}
              </>
            ) : <div className="muted" style={{ fontSize: 12.5 }}>VM 을 고르면 VM 크기 × 보존 개수로 계산합니다.</div>}
            {est && !destReady && <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>저장 대상을 고르면 그 여유와 비교합니다.</div>}
            <div className="muted" style={{ fontSize: 11.5, lineHeight: 1.6, marginTop: 8 }}>사본은 매번 전체 복사입니다(CBT 증분 없음). VM 크기는 프로비저닝 기준이라 씬 디스크면 실제 사본은 더 작을 수 있습니다.</div>
          </div></div>
        </div>
      </div>
    </div>
  );
}
