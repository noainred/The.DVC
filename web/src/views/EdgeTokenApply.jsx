/**
 * views/EdgeTokenApply.jsx — 엣지 개별 central 토큰 **자동 적용** 버튼 + 실시간 진행 + 작업 기록(v2.776 — 사용자 요청
 *   "이걸 자동으로 수정하는 기능 만들어줘, 진행할 때 세부 진행 내용 보여주는 화면과 로그 저장 기능").
 *  · 작업은 서버에서 돈다(central/tokenApplyJob.js) — 이 화면은 기록을 1.5초마다 읽어 단계별로 그린다(창을 닫아도 작업은 계속).
 *  · 기록은 서버 파일(edge-token-apply-log.json, 최근 50건)에 남는다 — 아래 '작업 기록' 이 그것을 보여 준다. 토큰 평문은 없다(지문만).
 *  · 실행은 설정 소유자만(발급과 같은 경계) — 403 은 권한 안내로.
 * ⚠ 훅은 조기 return 위에. 백틱 금지(BoldText).
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { fetchJson, postJson } from '../api.js';
import { JOB_STATE, STEP_STATE_ICON, STEP_TONE, stepTimeText, jobLine, confirmText, applyStartOutcome } from './edgeTokenApplyText.js';

const TONE = { ok: '#4ade80', bad: '#f87171', warn: 'var(--amber)', muted: 'var(--text-dim)' };

function Steps({ job }) {
  return (
    <ol style={{ margin: '4px 0 0', paddingLeft: 20, display: 'grid', gap: 4 }}>
      {(job.steps || []).map((s, i) => (
        <li key={`${s.key}-${i}`} style={{ minWidth: 0, overflowWrap: 'anywhere', fontSize: 12 }}>
          <span style={{ fontWeight: 600 }}>{STEP_STATE_ICON[s.state] || '·'} {s.label}</span>
          <span className="muted" style={{ fontSize: 11, marginLeft: 6 }}>{stepTimeText(s)}</span>
          {s.detail && <div style={{ color: TONE[STEP_TONE[s.state]] || 'var(--text-dim)' }}>{s.detail}</div>}
        </li>
      ))}
    </ol>
  );
}

export default function EdgeTokenApply({ agent, canRun = true, onDone }) {
  const [job, setJob] = useState(null);        // 지금 보고 있는(진행 중이거나 방금 끝난) 작업
  const [history, setHistory] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [openId, setOpenId] = useState(null);  // 기록에서 펼친 작업
  const timer = useRef(null);
  const alive = useRef(true);

  const loadHistory = useCallback(async () => {
    try {
      const r = await fetchJson(`/admin/central/token-apply/jobs?agent=${encodeURIComponent(agent)}`);
      if (!alive.current) return;
      const jobs = Array.isArray(r?.jobs) ? r.jobs : [];
      setHistory(jobs);
      return jobs;
    } catch (e) { if (alive.current) setHistory(null); return null; }
  }, [agent]);

  const poll = useCallback((id) => {
    if (timer.current) clearTimeout(timer.current);
    const tick = async () => {
      try {
        const r = await fetchJson(`/admin/central/token-apply/jobs/${encodeURIComponent(id)}`);
        if (!alive.current) return;
        setJob(r.job);
        if (r.job?.state === 'running') { timer.current = setTimeout(tick, 1500); return; }
        loadHistory();
        if (onDone) onDone();
      } catch (e) { if (alive.current) { setErr(e.message); timer.current = setTimeout(tick, 4000); } }
    };
    tick();
  }, [loadHistory, onDone]);

  useEffect(() => {
    alive.current = true;
    // 진행 중인 작업이 있으면(다른 창에서 시작했거나 화면을 다시 연 경우) 이어서 본다
    loadHistory().then((jobs) => { const run = (jobs || []).find((j) => j.state === 'running'); if (run && alive.current) { setJob(run); poll(run.id); } });
    return () => { alive.current = false; if (timer.current) clearTimeout(timer.current); };
  }, [agent, loadHistory, poll]);

  const start = async () => {
    if (!window.confirm(confirmText(agent))) return;
    setBusy(true); setErr('');
    try {
      const r = await postJson(`/admin/central/agent-tokens/${encodeURIComponent(agent)}/apply`, {});
      // v2.785(GE A-B2): 409(이미 진행 중)는 던지지 않고 본문으로 온다 — r.job 을 바로 읽지 않는다(applyStartOutcome).
      const o = applyStartOutcome(r);
      if (o.error) setErr(o.error);
      if (o.job) setJob(o.job);
      if (o.pollId) poll(o.pollId);
    } catch (e) {
      setErr(e.status === 403 ? '설정 소유자(전체 범위)만 개별 토큰을 발급·적용할 수 있습니다.' : e.message);
      if (e.body?.jobId) poll(e.body.jobId);
    } finally { setBusy(false); }
  };

  const running = job?.state === 'running';
  const st = job ? JOB_STATE[job.state] : null;
  const past = (history || []).filter((j) => !job || j.id !== job.id).slice(0, 5);

  return (
    <div data-edge-token-apply="" style={{ marginTop: 10, padding: 10, borderRadius: 8, border: '1px solid var(--border)', minWidth: 0 }}>
      <div className="flex gap wrap" style={{ alignItems: 'center' }}>
        {canRun && <button className="login-btn" style={{ flex: 'none', padding: '6px 14px' }} disabled={busy || running} title={running ? '진행 중입니다' : undefined} onClick={start}>{running ? '적용 중…' : '개별 토큰 자동 적용'}</button>}
        <span className="muted" style={{ fontSize: 12 }}>발급 → 엣지 전달(수집 토큰, 안 되면 SSH) → 중앙 확인 → 배포 기록 맞춤. 단계마다 기록이 남습니다.</span>
      </div>
      {err && <div style={{ color: TONE.bad, fontSize: 12, marginTop: 6 }}>{err}</div>}
      {job && (
        <div style={{ marginTop: 8, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: TONE[st?.tone] || 'inherit' }}>{st?.text || job.state} <span className="muted" style={{ fontWeight: 400, fontSize: 12 }}>{jobLine(job)}</span></div>
          {job.summary && <div style={{ fontSize: 12, color: TONE[st?.tone] || 'inherit', overflowWrap: 'anywhere' }}>{job.summary}</div>}
          <Steps job={job} />
        </div>
      )}
      {past.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>작업 기록(최근 {past.length}건 — 서버에 저장, 토큰 값 없음)</div>
          {past.map((j) => (
            <div key={j.id} style={{ fontSize: 12, minWidth: 0 }}>
              <button type="button" className="tab" style={{ padding: '2px 8px', fontSize: 12, textAlign: 'left', whiteSpace: 'normal' }} onClick={() => setOpenId(openId === j.id ? null : j.id)}>
                {openId === j.id ? '▾' : '▸'} {jobLine(j)}
              </button>
              {openId === j.id && <div style={{ paddingLeft: 10 }}>{j.summary && <div style={{ color: TONE[JOB_STATE[j.state]?.tone] || 'inherit', overflowWrap: 'anywhere' }}>{j.summary}</div>}<Steps job={j} /></div>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
