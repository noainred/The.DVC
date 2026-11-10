import React, { useEffect, useRef, useState } from 'react';
import { fetchJson, postJson } from '../../api.js';
import { requireChanged } from '../changeResult.js';
import EscClose from '../../components/EscClose.jsx';
import { STable } from '../../components/STable.jsx';
import { trialHeadline } from './easyRegister.js';

/**
 * 시험 점검 후 사용 — 결과 창(v2.960 · 시안 ⑨). 작업은 서버(svcmon/trial.js)가 들고 있고 이 창은 진행을 읽기만 한다.
 * 직접 시험이 도는 동안은 3초, 엣지 보고를 기다리는 동안은 10초마다 다시 읽는다(가벼운 메모리 조회 · 창을 닫으면 멈춘다 — 판정은 서버가 계속한다).
 * 늦게 온 이전 응답은 버린다.
 */
const STATE_LABEL = { pass: '통과', fail: '실패', wait: '대기', skip: '건너뜀', running: '진행 중' };
const RES_LABEL = { ok: '정상', warn: '경고', bad: '실패', none: '결과 없음' };
const STATE_CLS = { pass: 'ok', fail: 'bad', wait: 'pending', skip: 'disabled', running: 'pending' };
const hhmm = (at) => (at ? new Date(at).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false }) : '');

export default function TrialModal({ job: initial, onClose }) {
  const [job, setJob] = useState(initial);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);
  const [miss, setMiss] = useState(0);   // 읽기 실패 횟수 — 실패해도 다음 주기에 다시 읽는다(반증 L5: 한 번 실패하면 멈췄다)
  const state = job?.state;
  useEffect(() => {
    if (!job?.id || state === 'done' || miss >= 20) return undefined;
    const id = setTimeout(async () => {
      const my = ++seq.current;
      try { const r = await fetchJson(`/svcmon/trial/${encodeURIComponent(job.id)}`); if (my === seq.current && r?.job) { setJob(r.job); setErr(''); } }
      catch (e) { if (my === seq.current) { setErr(`진행을 읽지 못했습니다 — 다시 시도합니다(${e.message || String(e)})`); setMiss((n) => n + 1); } }
    }, state === 'running' ? 3000 : 10_000);
    return () => clearTimeout(id);
  }, [job, state, miss]);

  if (!job) return null;
  const items = [...(job.items || [])].sort((a, b) => ['fail', 'wait', 'running', 'skip', 'pass'].indexOf(a.state) - ['fail', 'wait', 'running', 'skip', 'pass'].indexOf(b.state));
  const failed = items.filter((x) => x.state === 'fail' && !x.forced).map((x) => x.targetId);
  const where = { local: 0, edge: 0 };
  for (const x of items) if (where[x.where] !== undefined) where[x.where] += 1;

  const retry = async () => {
    setBusy(true); setErr('');
    try { const r = requireChanged(await postJson('/svcmon/trial', { ids: failed })); setJob(r.job); }
    catch (e) { setErr(e.message || String(e)); } finally { setBusy(false); }
  };
  const forceOn = async (id) => {
    if (!window.confirm('시험에 실패한 대상을 그래도 사용으로 켤까요? 실패가 이어지면 알림이 나갈 수 있습니다.')) return;
    setBusy(true); setErr('');
    try {
      requireChanged(await postJson('/svcmon/targets/enabled', { targets: [id], enabled: true }));
      setJob((j) => ({ ...j, items: j.items.map((x) => (x.targetId === id ? { ...x, forced: true } : x)) }));
    } catch (e) { setErr(e.message || String(e)); } finally { setBusy(false); }
  };

  return (
    <div className="pc-overlay tv-trial-ov" onClick={onClose}>
      <EscClose onClose={onClose} />
      <div className="pc-modal tv-trial" role="dialog" aria-modal="true" aria-labelledby="tv-trial-title" onClick={(e) => e.stopPropagation()}>
        <div className="pc-modal-head">
          <b id="tv-trial-title">시험 점검 후 사용</b>
          <span className="pc-wiz-target">{`${hhmm(job.at)} 시작 · ${trialHeadline(job)}`}</span>
          <button className="pc-x" aria-label="닫기" onClick={onClose}>✕</button>
        </div>
        <div className="tv-trial-body">
          <div className="tv-note" style={{ padding: 0 }}>
            점검을 한 번씩 실제로 실행해 <b>통과한 대상만 사용</b>으로 바꿉니다(경고도 통과). 실패한 대상은 중지로 두고, 시험 중에는 실패 알림을 보내지 않습니다.
            {where.edge ? ' 엣지 전용 대상은 엣지가 첫 결과를 올리면 같은 기준으로 판정하고, 시한까지 보고가 없으면 중지로 되돌립니다(이 창을 닫아도 판정은 계속됩니다).' : ''}
          </div>
          <div className="tv-trial-sum">
            {['pass', 'fail', 'wait', 'skip', 'running'].filter((k) => job.counts?.[k]).map((k) => (
              <div key={k} className={STATE_CLS[k]}><span>{STATE_LABEL[k]}</span><b>{job.counts[k]}</b></div>
            ))}
            <div><span>점검 위치</span><b className="tv-trial-where">{`이 포탈 ${where.local} · 엣지 ${where.edge}`}</b></div>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <STable className="tv-table" minWidth={760} limit={500}>
              <thead><tr><th>대상</th><th>점검 위치</th><th>결과</th><th>점검 결과 · 사유</th><th data-nosort>조치</th></tr></thead>
              <tbody>
                {items.map((x) => (
                  <tr key={x.targetId}>
                    <td style={{ whiteSpace: 'normal', overflowWrap: 'anywhere' }}><b>{x.name || x.targetId}</b> <span className="mono" style={{ color: 'var(--text-faint)', fontSize: 11 }}>{x.host}</span></td>
                    <td className="mono">{x.where === 'edge' ? `엣지 ${x.agent}` : x.where === 'local' ? '이 포탈(직접)' : (x.agent ? `엣지 ${x.agent}` : '—')}</td>
                    <td data-sort={x.state}><span className={`tv-pill ${STATE_CLS[x.state] || ''}`}>{STATE_LABEL[x.state] || x.state}</span></td>
                    <td style={{ whiteSpace: 'normal', overflowWrap: 'anywhere' }}>
                      {(x.tests || []).length ? x.tests.map((r) => `${r.name} ${RES_LABEL[r.status] || r.status}${r.reply ? ` · ${r.reply}` : ''}`).join(' / ') : ''}
                      {x.reason ? <div style={{ color: x.state === 'fail' ? 'var(--red)' : 'var(--text-dim)' }}>{x.reason}</div> : null}
                      {x.state === 'wait' && x.deadline ? <div className="mono" style={{ color: 'var(--text-dim)', fontSize: 11 }}>{`시한 ${hhmm(x.deadline)}`}</div> : null}
                    </td>
                    <td>
                      {x.state === 'fail' && !x.forced && <button type="button" className="pc-btn" disabled={busy} onClick={() => forceOn(x.targetId)}>그래도 사용</button>}
                      {x.forced && <span className="tv-pill ok">사용으로 켬</span>}
                      {x.state === 'pass' && <span style={{ color: 'var(--text-dim)', fontSize: 12 }}>사용으로 바꿈</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </STable>
          </div>
          {err && <div className="pc-err">{err}</div>}
          <div className="pc-modal-actions" style={{ flexWrap: 'wrap' }}>
            <span style={{ fontSize: 12, color: 'var(--text-dim)', marginRight: 'auto' }}>결과는 트리의 대상 표지(시험 실패 · 시험 중)와 감사 로그에도 남습니다.</span>
            {failed.length > 0 && state === 'done' && <button type="button" className="pc-btn" disabled={busy} onClick={retry}>{`실패 ${failed.length}건 다시 시험`}</button>}
            <button type="button" className="pc-btn accent" onClick={onClose}>{state === 'waiting' ? '닫기 — 대기 건은 뒤에서 계속 판정' : '닫기'}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
