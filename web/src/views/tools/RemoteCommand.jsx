import React, { useEffect, useMemo, useRef, useState } from 'react';
import { fetchJson, postJson, putJson, delJson, usePolling } from '../../api.js';
import { Loading, ErrorBox, Kpi, Modal } from '../../components/ui.jsx';
import { ago, durationText, uptimeText, agentStatus, resultSummary, defaultArgs, argsIssue, groupCatalog, modeLabel, targetHint, statusTone, statusLabel } from './remoteCommand.js';

/**
 * 특수기능 › 원격 명령 실행(RMA, v2.416).
 *
 * 엣지 서버에 별도 프로세스(vmware-portal-rma@<인스턴스>)로 상주하는 RMA 가 중앙을 롱폴해 명령을
 * 받아 실행하고 결과만 회신한다(아웃바운드 전용 — 엣지가 NAT 뒤여도 동작). HostMonitor RMA 의
 * passive 모드와 같은 모델. 한 법인에 인스턴스를 여러 개(한 서버에 여러 프로세스 / 여러 서버에
 * 하나씩) 두면 분배 방식(Active-Active · 부하 분산 · Active-Backup)을 법인별로 고른다.
 *
 * 보안: 프리셋 id + 파라미터만 보내고 엣지가 재검증해 셸 없이 실행. 자유 명령은 엣지에서
 * RMA_ALLOW_CUSTOM=true 일 때만. 법인별 RMA 비밀번호(서명)를 등록하면 그 비밀번호로 서명된
 * 명령만 실행된다. 전부 admin 전용 + 감사로그.
 */

const TONE = { ok: 'var(--green, #22c55e)', warn: 'var(--amber, #f59e0b)', bad: 'var(--red, #ef4444)', muted: 'var(--muted, #94a3b8)' };
const Dot = ({ on, title }) => <span title={title} style={{ display: 'inline-block', width: 9, height: 9, borderRadius: 5, background: on ? TONE.ok : TONE.muted, marginRight: 6 }} />;

export default function RemoteCommand() {
  const { data, error, loading } = usePolling('/tools/rma', {}, 10_000);
  const [run, setRun] = useState(null);        // { agent, instance? }
  const [cfg, setCfg] = useState(null);        // agent group for settings
  const [deploy, setDeploy] = useState(null);  // { agent? }
  const [hist, setHist] = useState(null);
  const [histErr, setHistErr] = useState('');
  const [view, setView] = useState(null);      // history row detail
  const [refreshTick, setRefreshTick] = useState(0);
  const [tab, setTab] = useState('run');        // run | schedule | status

  useEffect(() => {
    let alive = true;
    fetchJson('/tools/rma/history', { limit: 100 }).then((r) => { if (alive) { setHist(r.rows || []); setHistErr(''); } }).catch((e) => { if (alive) setHistErr(e.message); });
    const t = setInterval(() => { fetchJson('/tools/rma/history', { limit: 100 }).then((r) => alive && setHist(r.rows || [])).catch(() => {}); }, 15_000);
    return () => { alive = false; clearInterval(t); };
  }, [refreshTick]);

  const groups = data?.agents || [];
  const kpi = useMemo(() => {
    const online = groups.filter((g) => agentStatus(g) === 'online').length;
    const inst = groups.reduce((n, g) => n + (g.instances || []).filter((i) => i.online).length, 0);
    const none = groups.filter((g) => agentStatus(g) === 'none').length;
    return { online, inst, none, pending: groups.reduce((n, g) => n + (g.pending || 0), 0) };
  }, [groups]);

  if (error && !data) return <ErrorBox message={error} />;
  if (loading && !data) return <Loading />;

  return (
    <div>
      <div className="section-title">🖥️ 원격 명령 실행 (RMA — Remote Management Agent)</div>
      <p className="muted" style={{ marginTop: 4 }}>
        엣지 서버의 별도 프로세스(<code>vmware-portal-rma@인스턴스</code>)가 중앙을 롱폴해 프리셋 명령을 실행하고 결과만 회신합니다(아웃바운드 전용).
        한 법인에 인스턴스를 여러 개 두면 분배 방식(Active-Active · 부하 분산 · Active-Backup)을 법인별로 고릅니다. 모든 실행은 감사로그에 남습니다.
      </p>
      {error && <div className="card muted" style={{ borderColor: TONE.warn }}>일시 조회 오류: {error} (마지막 데이터 표시 중)</div>}
      <div className="kpis">
        <Kpi label="RMA 온라인 법인" value={kpi.online} meta={`전체 ${groups.length}`} accent={kpi.online ? TONE.ok : TONE.muted} />
        <Kpi label="온라인 인스턴스" value={kpi.inst} />
        <Kpi label="대기 명령" value={kpi.pending} accent={kpi.pending ? TONE.warn : undefined} />
        <Kpi label="미배포 엣지" value={kpi.none} meta="RMA 하트비트 없음" accent={kpi.none ? TONE.warn : undefined} />
      </div>
      <div className="flex gap wrap" style={{ margin: '8px 0' }}>
        {[['run', '▶ 명령 실행'], ['schedule', '🗓 점검 스케줄'], ['status', '🩺 점검 상태']].map(([k, label]) => (
          <button key={k} className={tab === k ? 'login-btn' : 'tab'} onClick={() => setTab(k)}>{label}</button>
        ))}
      </div>
      {tab === 'schedule' && <ScheduleTab groups={groups} tests={data?.tests || []} schedules={data?.schedules || []} />}
      {tab === 'status' && <StatusTab groups={groups} />}
      {tab === 'run' && <>
      <div className="flex gap wrap" style={{ margin: '8px 0' }}>
        <button className="login-btn" onClick={() => setDeploy({})}>🚀 RMA 배포 (SSH)</button>
        <span className="muted">전역 기본 분배: <b>{modeLabel(data?.settings?.defaultMode, data?.settings?.modes)}</b></span>
        <button className="tab" onClick={() => setCfg({ agent: '', global: true })}>전역 설정</button>
      </div>

      <div className="table-wrap">
        <table>
          <thead><tr><th>법인/엣지</th><th>상태</th><th>인스턴스</th><th>분배</th><th>대기</th><th>보안</th><th>마지막 접속</th><th></th></tr></thead>
          <tbody>
            {groups.map((g) => {
              const st = agentStatus(g);
              return (
                <tr key={g.agent}>
                  <td><b>{g.agent}</b></td>
                  <td style={{ color: st === 'online' ? TONE.ok : st === 'offline' ? TONE.bad : TONE.muted }}>{st === 'online' ? '온라인' : st === 'offline' ? '오프라인' : '미배포'}</td>
                  <td>
                    {(g.instances || []).length ? g.instances.map((i) => (
                      <div key={i.instance} title={`${i.hostname || ''} · v${i.version || '?'} · ${i.os || ''} · pid ${i.pid || '?'} · 가동 ${uptimeText(i.uptimeSec)}${i.ip ? ` · ${i.ip}` : ''}`}>
                        <Dot on={i.online} title={i.online ? '온라인' : `오프라인 (${ago(i.lastSeen)})`} />
                        <code>{i.instance}</code>
                        {g.mode === 'active-backup' && g.activePrimary === i.instance && <span className="badge" style={{ marginLeft: 4 }}>주</span>}
                        <span className="muted"> · 우선순위 {i.priority} · {i.busy ? '실행 중' : i.running ? `진행 ${i.running}` : '유휴'} · {i.hostname}{i.version ? ` v${i.version}` : ''}{i.allowCustom ? ' · 자유명령 허용' : ''}{i.signed ? '' : ' · 무서명'}{i.remoteManage ? ' · 원격관리' : ''}{i.comment ? ` · “${i.comment}”` : ''}</span>
                        {i.stats && <span className="muted" title="수행/거부/점검 실행/점검 실패"> · 수행 {i.stats.performed} · 거부 {i.stats.rejected} · 점검 {i.stats.testsRun}{i.scheduledTests ? ` (스케줄 ${i.scheduledTests}개 v${i.scheduleVersion})` : ''}{i.outbox ? ` · 미전송 ${i.outbox}` : ''}</span>}
                      </div>
                    )) : <span className="muted">— {g.hasToken ? 'RMA 프로세스 미기동' : '개별 토큰 미발급(설정 › 엣지 토큰)'}</span>}
                  </td>
                  <td>{(g.instances || []).length ? modeLabel(g.mode, data?.settings?.modes) : '—'}{g.primary ? <span className="muted"> · 주 {g.primary}</span> : null}</td>
                  <td>{g.pending || 0}</td>
                  <td>{g.hasPassword ? <span style={{ color: TONE.ok }}>서명</span> : <span style={{ color: TONE.warn }} title="법인 비밀번호 미등록 — 토큰만으로 명령이 실행됩니다">무서명</span>}</td>
                  <td className="muted">{ago(g.lastSeen)}</td>
                  <td className="flex gap">
                    <button className="tab" disabled={st === 'none'} onClick={() => setRun({ agent: g.agent })}>▶ 실행</button>
                    <button className="tab" onClick={() => setCfg(g)}>설정</button>
                    <button className="tab" onClick={() => setDeploy({ agent: g.agent })}>배포</button>
                  </td>
                </tr>
              );
            })}
            {!groups.length && <tr><td colSpan={8} className="muted">알려진 엣지가 없습니다. 엣지에 개별 토큰을 발급하고 RMA 를 배포하세요.</td></tr>}
          </tbody>
        </table>
      </div>

      <div className="section-title" style={{ marginTop: 16 }}>최근 실행 이력</div>
      {histErr && <div className="card muted">이력 조회 오류: {histErr}</div>}
      <div className="table-wrap">
        <table>
          <thead><tr><th>시각</th><th>법인</th><th>인스턴스</th><th>명령</th><th>요청자</th><th>결과</th><th>소요</th></tr></thead>
          <tbody>
            {(hist || []).map((h) => {
              const s = resultSummary(h);
              return (
                <tr key={h.reqId} onClick={() => setView(h)} style={{ cursor: 'pointer' }}>
                  <td className="muted">{new Date(h.doneAt).toLocaleString()}</td>
                  <td>{h.agent}</td><td><code>{h.instance || '—'}</code></td>
                  <td>{h.label || h.cmd}{Object.keys(h.args || {}).length ? <span className="muted"> {JSON.stringify(h.args)}</span> : null}</td>
                  <td>{h.user || '—'}</td>
                  <td style={{ color: TONE[s.tone] }}>{s.text}</td>
                  <td>{durationText(h.durationMs)}</td>
                </tr>
              );
            })}
            {hist && !hist.length && <tr><td colSpan={7} className="muted">아직 실행 이력이 없습니다.</td></tr>}
          </tbody>
        </table>
      </div>
      </>}

      {run && <RunModal group={groups.find((g) => g.agent === run.agent)} catalog={data?.catalog || []} modes={data?.settings?.modes || []} onClose={() => { setRun(null); setRefreshTick((t) => t + 1); }} />}
      {cfg && <SettingsModal group={cfg} modes={data?.settings?.modes || []} defaultMode={data?.settings?.defaultMode} onClose={() => setCfg(null)} />}
      {deploy && <DeployModal preset={deploy} groups={groups} onClose={() => setDeploy(null)} />}
      {view && (
        <Modal title={`${view.agent} · ${view.label || view.cmd}`} onClose={() => setView(null)} width={860}>
          <ResultView r={view} />
        </Modal>
      )}
    </div>
  );
}

function ResultView({ r }) {
  const s = resultSummary(r);
  return (
    <div>
      <div style={{ color: TONE[s.tone], marginBottom: 6 }}>{s.text}{r.instance ? <span className="muted"> · 인스턴스 {r.instance}</span> : null}{r.failover ? <span style={{ color: TONE.warn }}> · 페일오버로 다른 인스턴스가 실행</span> : null}</div>
      {r.argv && <div className="muted" style={{ marginBottom: 6 }}>argv: <code>{r.argv.join(' ')}</code></div>}
      {r.stdout ? <pre style={{ maxHeight: 420, overflow: 'auto', whiteSpace: 'pre-wrap', fontSize: 12 }}>{r.stdout}</pre> : <div className="muted">(stdout 없음)</div>}
      {r.stderr ? <><div className="muted">stderr</div><pre style={{ maxHeight: 200, overflow: 'auto', whiteSpace: 'pre-wrap', fontSize: 12, color: TONE.warn }}>{r.stderr}</pre></> : null}
      {r.truncated && <div className="muted">⚠ 출력이 상한을 넘어 잘렸습니다.</div>}
    </div>
  );
}

function RunModal({ group, catalog, modes, onClose }) {
  const grouped = useMemo(() => groupCatalog(catalog), [catalog]);
  const [cmd, setCmd] = useState(catalog[0]?.id || '');
  const [args, setArgs] = useState(() => defaultArgs(catalog[0]));
  const [instance, setInstance] = useState('');
  const [timeoutS, setTimeoutS] = useState('');
  const [state, setState] = useState(null);   // { reqId, phase, job, err }
  const pollRef = useRef(null);
  const preset = catalog.find((p) => p.id === cmd);
  const onlineInst = (group?.instances || []).filter((i) => i.online);
  const customBlocked = preset?.shell && !!group && !(instance ? group.instances.find((i) => i.instance === instance)?.allowCustom : group.instances.some((i) => i.online && i.allowCustom));

  useEffect(() => () => { if (pollRef.current) clearTimeout(pollRef.current); }, []);

  const pick = (id) => { setCmd(id); setArgs(defaultArgs(catalog.find((p) => p.id === id))); setState(null); };

  const submit = async () => {
    const issue = argsIssue(preset, args);
    if (issue) { setState({ err: issue }); return; }
    if (preset?.danger && !window.confirm(`'${preset.label}' 은 상태를 바꾸는 명령입니다. ${group.agent}${instance ? `/${instance}` : ''} 에서 실행할까요?`)) return;
    setState({ phase: 'submit' });
    try {
      const r = await postJson('/tools/rma/run', { agent: group.agent, instance, cmd, args, timeoutMs: timeoutS ? Number(timeoutS) * 1000 : undefined });
      setState({ phase: 'wait', reqId: r.reqId, target: r.target, signed: r.signed });
      const started = Date.now();
      const poll = async () => {
        try {
          const j = await fetchJson(`/tools/rma/jobs/${encodeURIComponent(r.reqId)}`);
          if (j.state === 'done') { setState({ phase: 'done', job: j }); return; }
          if (j.state === 'unknown') { setState({ err: '잡을 찾을 수 없습니다(TTL 만료 또는 서버 재시작).' }); return; }
          setState((s) => ({ ...s, phase: j.state, job: j }));
        } catch (e) { setState((s) => ({ ...s, err: e.message })); }
        if (Date.now() - started < 20 * 60_000) pollRef.current = setTimeout(poll, 1500);
      };
      poll();
    } catch (e) { setState({ err: e.message }); }
  };

  if (!group) return null;
  return (
    <Modal title={`▶ 원격 명령 — ${group.agent}`} onClose={onClose} width={900}>
      <div className="flex gap wrap" style={{ alignItems: 'flex-end' }}>
        <label>인스턴스<br />
          <select className="input" value={instance} onChange={(e) => setInstance(e.target.value)}>
            <option value="">자동 (분배 방식: {modeLabel(group.mode, modes)})</option>
            {(group.instances || []).map((i) => <option key={i.instance} value={i.instance}>{i.instance}{i.online ? '' : ' (오프라인)'}</option>)}
          </select>
        </label>
        <label>명령<br />
          <select className="input" value={cmd} onChange={(e) => pick(e.target.value)} style={{ minWidth: 340 }}>
            {grouped.map((g) => <optgroup key={g.group} label={g.group}>{g.items.map((p) => <option key={p.id} value={p.id}>{p.danger ? '⚠ ' : ''}{p.label}</option>)}</optgroup>)}
          </select>
        </label>
        <label>제한 시간(초)<br /><input className="input" style={{ width: 90 }} placeholder={preset?.timeoutMs ? String(preset.timeoutMs / 1000) : '30'} value={timeoutS} onChange={(e) => setTimeoutS(e.target.value.replace(/\D/g, ''))} /></label>
      </div>
      <div className="muted" style={{ margin: '4px 0 8px' }}>{targetHint(group, instance, modes)}{!onlineInst.length && !instance ? '' : ''}</div>
      {(preset?.params || []).map((p) => (
        <div key={p.name} style={{ marginBottom: 6 }}>
          <label>{p.label}{p.required ? ' *' : ''} <span className="muted">({p.hint}{p.type === 'int' && p.min != null ? `, ${p.min}~${p.max}` : ''})</span><br />
            {p.type === 'shell'
              ? <textarea className="input" rows={3} style={{ width: '100%', fontFamily: 'monospace' }} value={args[p.name] || ''} onChange={(e) => setArgs({ ...args, [p.name]: e.target.value })} placeholder="예: cat /proc/loadavg && ls -la /var/log | head" />
              : <input className="input" style={{ width: p.type === 'int' ? 100 : 320 }} value={args[p.name] ?? ''} onChange={(e) => setArgs({ ...args, [p.name]: e.target.value })} />}
          </label>
        </div>
      ))}
      {preset?.shell && <div className="card muted" style={{ borderColor: TONE.warn }}>자유 명령은 엣지 portal.env 의 <code>RMA_ALLOW_CUSTOM=true</code> 인 인스턴스에서만 실행됩니다.{customBlocked ? ' 현재 선택 범위의 온라인 인스턴스 중 허용된 곳이 없습니다 — 엣지가 거부 사유를 회신합니다.' : ''}</div>}
      {preset?.sudo && <div className="muted">sudo 규칙(install.sh 가 설치한 /etc/sudoers.d/vmware-portal-rma)이 필요합니다.</div>}
      <div className="flex gap" style={{ marginTop: 8 }}>
        <button className="login-btn" disabled={state?.phase === 'submit' || state?.phase === 'wait' || state?.phase === 'pending' || state?.phase === 'running'} onClick={submit}>실행</button>
        {state?.phase && state.phase !== 'done' && <span className="muted">{state.phase === 'pending' || state.phase === 'wait' ? `인출 대기 중${state.target ? ` (배정: ${state.target})` : ''}…` : state.phase === 'running' ? `실행 중 (${state.job?.instance || ''})…` : '요청 중…'}</span>}
        {state?.signed === false && state?.phase && <span style={{ color: TONE.warn }}>무서명 요청</span>}
      </div>
      {state?.err && <div className="error-box" style={{ marginTop: 8 }}>{state.err}</div>}
      {state?.phase === 'done' && <div style={{ marginTop: 10 }}><ResultView r={{ ...(state.job.result || {}), instance: state.job.instance, failover: state.job.failover }} /></div>}
    </Modal>
  );
}

function SettingsModal({ group, modes, defaultMode, onClose }) {
  const [mode, setMode] = useState(group.global ? (defaultMode || 'active-active') : (group.modeExplicit ? group.mode : ''));
  const [primary, setPrimary] = useState(group.primary || '');
  const [pw, setPw] = useState('');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [ips, setIps] = useState((group.allowedIps || []).join(', '));
  const [comment, setComment] = useState(group.comment || '');
  const [remote, setRemote] = useState({ longpollMs: group.remote?.longpollMs || '', testConcurrency: group.remote?.testConcurrency || '', disabledTests: (group.remote?.disabledTests || []).join(',') });
  const saveAccess = async () => {
    setErr(''); setMsg('');
    try { const r = await putJson(`/tools/rma/agents/${encodeURIComponent(group.agent)}/access`, { allowedIps: ips, comment }); setMsg(`접속 허용 IP 저장: ${r.allowedIps.join(', ') || '(제한 없음)'}`); }
    catch (e) { setErr(e.message); }
  };
  const saveRemote = async () => {
    setErr(''); setMsg('');
    try { const r = await putJson(`/tools/rma/agents/${encodeURIComponent(group.agent)}/remote`, remote); setMsg(`원격 관리 설정 저장: ${JSON.stringify(r)} — RMA_REMOTE_MANAGE=true 인 인스턴스만 반영`); }
    catch (e) { setErr(e.message); }
  };
  const pol = (group.instances || []).find((i) => i.policy)?.policy;
  const save = async () => {
    setErr(''); setMsg('');
    try {
      if (group.global) { await putJson('/tools/rma/settings', { defaultMode: mode }); setMsg('전역 기본 분배 방식을 저장했습니다.'); return; }
      const r = await putJson(`/tools/rma/agents/${encodeURIComponent(group.agent)}/mode`, { mode, primary });
      setMsg(`저장됨: ${modeLabel(r.mode, modes)}${r.primary ? ` · 주 ${r.primary}` : ''}`);
    } catch (e) { setErr(e.message); }
  };
  const savePw = async (clear) => {
    setErr(''); setMsg('');
    try {
      const r = await putJson(`/tools/rma/agents/${encodeURIComponent(group.agent)}/password`, { password: clear ? '' : pw });
      setMsg(r.hasPassword ? '비밀번호를 등록했습니다 — 이후 명령은 서명되어 전송됩니다(엣지 RMA_PASSWORD 와 같아야 합니다).' : '비밀번호를 해제했습니다(무서명).');
      setPw('');
    } catch (e) { setErr(e.message); }
  };
  return (
    <Modal title={group.global ? '⚙️ RMA 전역 설정' : `⚙️ RMA 설정 — ${group.agent}`} onClose={onClose} width={640}>
      <div style={{ marginBottom: 8 }}>
        <label>{group.global ? '전역 기본 분배 방식' : '분배 방식'}<br />
          <select className="input" value={mode} onChange={(e) => setMode(e.target.value)} style={{ minWidth: 320 }}>
            {!group.global && <option value="">전역 기본 따름 ({modeLabel(defaultMode, modes)})</option>}
            {modes.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
        </label>
        <div className="muted" style={{ marginTop: 4 }}>{modes.find((m) => m.id === (mode || defaultMode))?.desc}</div>
      </div>
      {!group.global && (
        <div style={{ marginBottom: 8 }}>
          <label>주 인스턴스 (Active-Backup 전용, 비우면 RMA_PRIORITY 최저값)<br />
            <select className="input" value={primary} onChange={(e) => setPrimary(e.target.value)}>
              <option value="">자동(우선순위)</option>
              {(group.instances || []).map((i) => <option key={i.instance} value={i.instance}>{i.instance} (우선순위 {i.priority}{i.online ? '' : ', 오프라인'})</option>)}
            </select>
          </label>
        </div>
      )}
      <button className="login-btn" onClick={save}>저장</button>
      {!group.global && (
        <div className="card" style={{ marginTop: 12 }}>
          <b>RMA 비밀번호(서명)</b> — 현재 {group.hasPassword ? <span style={{ color: TONE.ok }}>등록됨</span> : <span style={{ color: TONE.warn }}>미등록(무서명)</span>}
          <div className="muted">엣지 portal.env 의 <code>RMA_PASSWORD</code> 와 같은 값을 넣습니다. 값은 화면·감사로그에 표시되지 않습니다.</div>
          <div className="flex gap" style={{ marginTop: 6 }}>
            <input className="input" type="password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="비밀번호" />
            <button className="tab" disabled={!pw} onClick={() => savePw(false)}>등록</button>
            <button className="tab" disabled={!group.hasPassword} onClick={() => savePw(true)}>해제</button>
          </div>
        </div>
      )}
      {!group.global && (
        <div className="card" style={{ marginTop: 12 }}>
          <b>접속 허용 IP · 코멘트</b>
          <div className="muted">RMA 폴링을 받아 줄 출처 IP/CIDR(쉼표 구분). 비우면 제한 없음. 엣지가 NAT 뒤면 공인 출구 IP 를 넣습니다.</div>
          <div className="flex gap wrap" style={{ marginTop: 6 }}>
            <input className="input" style={{ minWidth: 300 }} value={ips} onChange={(e) => setIps(e.target.value)} placeholder="10.0.0.0/8, 203.0.113.5" />
            <input className="input" value={comment} onChange={(e) => setComment(e.target.value)} placeholder="코멘트(중앙 표시용)" />
            <button className="tab" onClick={saveAccess}>저장</button>
          </div>
        </div>
      )}
      {!group.global && (
        <div className="card" style={{ marginTop: 12 }}>
          <b>원격 관리(RMA Manager 대응)</b> — 엣지 <code>RMA_REMOTE_MANAGE=true</code> 인 인스턴스만 받아들입니다. 허용 범위는 **축소만** 가능합니다.
          <div className="flex gap wrap" style={{ marginTop: 6 }}>
            <label>롱폴(ms) <input className="input" style={{ width: 90 }} value={remote.longpollMs} onChange={(e) => setRemote({ ...remote, longpollMs: e.target.value.replace(/\D/g, '') })} placeholder="20000" /></label>
            <label>동시 점검 <input className="input" style={{ width: 60 }} value={remote.testConcurrency} onChange={(e) => setRemote({ ...remote, testConcurrency: e.target.value.replace(/\D/g, '') })} placeholder="4" /></label>
            <label>점검 차단 목록 <input className="input" style={{ minWidth: 200 }} value={remote.disabledTests} onChange={(e) => setRemote({ ...remote, disabledTests: e.target.value })} placeholder="script,text-log" /></label>
            <button className="tab" onClick={saveRemote}>저장</button>
          </div>
          {pol && (
            <div className="muted" style={{ marginTop: 6, fontSize: 12 }}>
              엣지 정책(portal.env, 읽기 전용): 명령 허용 {pol.enabled?.length ? pol.enabled.join(',') : '전부'}{pol.disabled?.length ? ` / 차단 ${pol.disabled.join(',')}` : ''} · 점검 허용 {pol.enabledTests?.length ? pol.enabledTests.join(',') : '전부'}{pol.disabledTests?.length ? ` / 차단 ${pol.disabledTests.join(',')}` : ''} · 서비스 유닛 {pol.serviceUnits?.length ? pol.serviceUnits.join(',') : '(없음)'} · 재부팅 {pol.allowReboot ? '허용' : '불가'} · 파일 루트 {(pol.fileRoots || []).join(',')}
            </div>
          )}
        </div>
      )}
      {msg && <div className="muted" style={{ marginTop: 8, color: TONE.ok }}>{msg}</div>}
      {err && <div className="error-box" style={{ marginTop: 8 }}>{err}</div>}
    </Modal>
  );
}

function ScheduleTab({ groups, tests, schedules }) {
  const [agent, setAgent] = useState(groups[0]?.agent || '');
  const [sch, setSch] = useState(null);
  const [err, setErr] = useState('');
  const [form, setForm] = useState(null); // { id?, test, args, intervalSec, instance, name, enabled }
  const [tick, setTick] = useState(0);
  const group = groups.find((g) => g.agent === agent);
  const grouped = useMemo(() => groupCatalog(tests), [tests]);
  useEffect(() => {
    if (!agent) return undefined;
    let alive = true;
    fetchJson(`/tools/rma/agents/${encodeURIComponent(agent)}/schedule`).then((r) => alive && setSch(r)).catch((e) => alive && setErr(e.message));
    return () => { alive = false; };
  }, [agent, tick]);
  const testOf = (id) => tests.find((t) => t.id === id);
  const openNew = () => { const t = tests[1] || tests[0]; setForm({ test: t?.id || '', args: defaultArgs(t), intervalSec: 300, instance: '', name: '', enabled: true }); };
  const openEdit = (row) => setForm({ ...row, args: Object.fromEntries(Object.entries(row.args || {}).map(([k, v]) => [k, String(v)])) });
  const save = async () => {
    setErr('');
    const t = testOf(form.test);
    const issue = argsIssue(t, form.args);
    if (issue) { setErr(issue); return; }
    try { await putJson(`/tools/rma/agents/${encodeURIComponent(agent)}/schedule`, { ...form, intervalSec: Number(form.intervalSec) }); setForm(null); setTick((x) => x + 1); }
    catch (e) { setErr(e.message); }
  };
  const remove = async (row) => {
    if (!window.confirm(`점검 '${row.name || row.test}' 을 삭제할까요?`)) return;
    try { await delJson(`/tools/rma/agents/${encodeURIComponent(agent)}/schedule/${encodeURIComponent(row.id)}`); setTick((x) => x + 1); }
    catch (e) { setErr(e.message); }
  };
  const tform = form ? testOf(form.test) : null;
  return (
    <div>
      <div className="flex gap wrap" style={{ alignItems: 'center', margin: '8px 0' }}>
        <label>법인 <select className="input" value={agent} onChange={(e) => setAgent(e.target.value)}>{groups.map((g) => <option key={g.agent} value={g.agent}>{g.agent}{schedules.find((s) => s.agent === g.agent.toLowerCase()) ? ` (${schedules.find((s) => s.agent === g.agent.toLowerCase()).enabled}개)` : ''}</option>)}</select></label>
        <button className="login-btn" disabled={!agent} onClick={openNew}>+ 점검 추가</button>
        {sch && <span className="muted">스케줄 v{sch.version} · {(sch.tests || []).length}개 · 인스턴스 지정이 없는 항목은 온라인 인스턴스에 자동 분산(중복 실행 없음)</span>}
      </div>
      <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>HostMonitor 'Test by agent' 에 해당 — 중앙이 정한 점검을 RMA 가 현지에서 주기 실행하고 결과만 회신합니다. 중앙 불통 시 결과는 엣지에 보관됐다가 재접속 후 전송됩니다.</div>
      {err && <div className="error-box">{err}</div>}
      <div className="table-wrap">
        <table>
          <thead><tr><th>이름</th><th>점검</th><th>파라미터</th><th>주기</th><th>인스턴스</th><th>상태</th><th></th></tr></thead>
          <tbody>
            {(sch?.tests || []).map((row) => (
              <tr key={row.id}>
                <td>{row.name || <span className="muted">—</span>}</td>
                <td>{testOf(row.test)?.label || row.test}</td>
                <td className="muted" style={{ fontSize: 12 }}>{Object.entries(row.args || {}).map(([k, v]) => `${k}=${v}`).join(' · ')}</td>
                <td>{row.intervalSec}초</td>
                <td><code>{row.instance || '자동'}</code></td>
                <td>{row.enabled === false ? <span className="badge gray">비활성</span> : <span className="badge green">활성</span>}</td>
                <td className="flex gap"><button className="tab" onClick={() => openEdit(row)}>수정</button><button className="tab" onClick={() => remove(row)}>삭제</button></td>
              </tr>
            ))}
            {sch && !(sch.tests || []).length && <tr><td colSpan={7} className="muted">이 법인에 등록된 점검이 없습니다. '+ 점검 추가'로 시작하세요.</td></tr>}
          </tbody>
        </table>
      </div>
      {form && (
        <Modal title={`${form.id ? '점검 수정' : '점검 추가'} — ${agent}`} onClose={() => setForm(null)} width={720}>
          <div className="flex gap wrap" style={{ alignItems: 'flex-end' }}>
            <label>점검<br />
              <select className="input" value={form.test} onChange={(e) => { const t = testOf(e.target.value); setForm({ ...form, test: e.target.value, args: defaultArgs(t) }); }} style={{ minWidth: 300 }}>
                {grouped.map((g) => <optgroup key={g.group} label={g.group}>{g.items.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}</optgroup>)}
              </select>
            </label>
            <label>이름<br /><input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="표시 이름(선택)" /></label>
            <label>주기(초)<br /><input className="input" style={{ width: 90 }} value={form.intervalSec} onChange={(e) => setForm({ ...form, intervalSec: e.target.value.replace(/\D/g, '') })} /></label>
            <label>인스턴스<br />
              <select className="input" value={form.instance} onChange={(e) => setForm({ ...form, instance: e.target.value })}>
                <option value="">자동 분산</option>
                {(group?.instances || []).map((i) => <option key={i.instance} value={i.instance}>{i.instance}</option>)}
              </select>
            </label>
            <label><input type="checkbox" checked={form.enabled !== false} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} /> 활성</label>
          </div>
          {tform?.desc && <div className="muted" style={{ marginTop: 4 }}>{tform.desc}</div>}
          {(tform?.params || []).map((p) => (
            <div key={p.name} style={{ marginTop: 6 }}>
              <label>{p.label}{p.required ? ' *' : ''} <span className="muted">({p.hint}{p.type === 'int' && p.min != null ? `, ${p.min}~${p.max}` : ''})</span><br />
                {p.type === 'shell'
                  ? <textarea className="input" rows={2} style={{ width: '100%', fontFamily: 'monospace' }} value={form.args[p.name] || ''} onChange={(e) => setForm({ ...form, args: { ...form.args, [p.name]: e.target.value } })} />
                  : <input className="input" style={{ width: p.type === 'int' ? 110 : 340 }} value={form.args[p.name] ?? ''} onChange={(e) => setForm({ ...form, args: { ...form.args, [p.name]: e.target.value } })} />}
              </label>
            </div>
          ))}
          <div className="flex gap" style={{ marginTop: 10 }}><button className="login-btn" onClick={save}>저장</button></div>
          {err && <div className="error-box" style={{ marginTop: 8 }}>{err}</div>}
        </Modal>
      )}
    </div>
  );
}

function StatusTab({ groups }) {
  const { data, error } = usePolling('/tools/rma/tests/results', {}, 10_000);
  const [hist, setHist] = useState(null);
  const [filter, setFilter] = useState('');
  const rows = (data?.rows || []).filter((r) => !filter || r.agent === filter);
  const openHist = async (r) => {
    try { const h = await fetchJson('/tools/rma/tests/history', { agent: r.agent, id: r.testId, hours: 24 }); setHist({ r, ...h }); } catch (e) { setHist({ r, rows: [], err: e.message }); }
  };
  return (
    <div>
      <div className="flex gap wrap" style={{ alignItems: 'center', margin: '8px 0' }}>
        <select className="input" value={filter} onChange={(e) => setFilter(e.target.value)}><option value="">전체 법인</option>{groups.map((g) => <option key={g.agent} value={g.agent}>{g.agent}</option>)}</select>
        {(data?.summary || []).filter((s) => !filter || s.agent === filter).map((s) => (
          <span key={s.agent} className="badge" style={{ background: s.bad ? 'rgba(239,68,68,.15)' : s.warn ? 'rgba(245,158,11,.15)' : 'rgba(34,197,94,.15)' }}>{s.agent}: ok {s.ok} · warn {s.warn} · bad {s.bad} · unknown {s.unknown}</span>
        ))}
      </div>
      {error && !data && <ErrorBox message={error} />}
      <div className="table-wrap">
        <table>
          <thead><tr><th>법인</th><th>점검</th><th>상태</th><th>결과</th><th>값</th><th>인스턴스</th><th>마지막 실행</th><th>상태 유지</th><th>마지막 정상</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.agent}|${r.testId}`} onClick={() => openHist(r)} style={{ cursor: 'pointer' }}>
                <td>{r.agent}</td><td>{r.name || r.test}<div className="muted" style={{ fontSize: 11 }}>{r.test}</div></td>
                <td><span className="badge" style={{ background: statusTone(r.status, TONE), color: '#fff' }}>{statusLabel(r.status)}</span></td>
                <td style={{ maxWidth: 420, whiteSpace: 'pre-wrap' }}>{r.reply}</td>
                <td>{r.value ?? '—'}</td><td><code>{r.instance || '—'}</code></td>
                <td className="muted">{ago(r.at)}</td><td className="muted">{ago(r.since)} 부터</td><td className="muted">{r.okAt ? ago(r.okAt) : '—'}</td>
              </tr>
            ))}
            {data && !rows.length && <tr><td colSpan={9} className="muted">결과가 없습니다 — 점검 스케줄을 등록하면 RMA 가 실행하고 여기에 상태가 쌓입니다.</td></tr>}
          </tbody>
        </table>
      </div>
      {hist && (
        <Modal title={`${hist.r.agent} · ${hist.r.name || hist.r.test} — 24시간 이력(상태 변화 + 1시간 단위)`} onClose={() => setHist(null)} width={820}>
          {hist.err && <div className="error-box">{hist.err}</div>}
          {hist.unavailable && <div className="muted">이 서버는 node:sqlite 가 없어 이력이 저장되지 않습니다.</div>}
          <div className="table-wrap"><table><thead><tr><th>시각</th><th>상태</th><th>결과</th><th>값</th><th>인스턴스</th></tr></thead>
            <tbody>{(hist.rows || []).map((h, i) => <tr key={i}><td className="muted">{new Date(h.ts).toLocaleString()}</td><td style={{ color: statusTone(h.status, TONE) }}>{statusLabel(h.status)}</td><td>{h.reply}</td><td>{h.value ?? '—'}</td><td><code>{h.instance || '—'}</code></td></tr>)}</tbody></table></div>
        </Modal>
      )}
    </div>
  );
}

function DeployModal({ preset, groups, onClose }) {
  const [f, setF] = useState({ host: '', port: 22, username: 'root', password: '', agentName: preset.agent || '', centralUrl: '', centralToken: '', rmaPassword: '', registerPassword: true, allowCustom: false,
    serviceUnits: '', allowReboot: false, fileRoots: '', enabledCommands: '', enabledTests: '', remoteManage: false, comment: '' });
  const [instances, setInstances] = useState([{ name: 'default', priority: 100 }]);
  const [busy, setBusy] = useState('');
  const [list, setList] = useState(null);
  const [result, setResult] = useState(null);
  const [err, setErr] = useState('');
  const set = (k, v) => setF((s) => ({ ...s, [k]: v }));
  const target = () => ({ host: f.host, port: Number(f.port) || 22, username: f.username, password: f.password });

  const doList = async () => {
    setBusy('list'); setErr(''); setResult(null);
    try { setList(await postJson('/tools/rma/deploy/list', target())); } catch (e) { setErr(e.message); } finally { setBusy(''); }
  };
  const doDeploy = async () => {
    setBusy('deploy'); setErr(''); setResult(null);
    try {
      const r = await postJson('/tools/rma/deploy', { ...target(), instances, rmaPassword: f.rmaPassword, registerPassword: f.registerPassword, allowCustom: f.allowCustom, agentName: f.agentName, centralUrl: f.centralUrl, centralToken: f.centralToken,
        serviceUnits: f.serviceUnits, allowReboot: f.allowReboot, fileRoots: f.fileRoots, enabledCommands: f.enabledCommands, enabledTests: f.enabledTests, remoteManage: f.remoteManage, comment: f.comment });
      setResult(r);
      if (!r.ok) setErr(r.reason || '배포 실패');
    } catch (e) { setErr(e.message); } finally { setBusy(''); }
  };
  const doRemove = async (name) => {
    if (!window.confirm(`인스턴스 '${name}' 을 이 서버에서 제거할까요?`)) return;
    setBusy('remove'); setErr('');
    try { const r = await postJson('/tools/rma/deploy/remove', { ...target(), name }); if (!r.ok) setErr(r.reason); else await doList(); } catch (e) { setErr(e.message); } finally { setBusy(''); }
  };

  return (
    <Modal title="🚀 RMA 배포 — 엣지 서버에 인스턴스 설치(SSH root)" onClose={onClose} width={860}>
      <div className="muted" style={{ marginBottom: 8 }}>
        대상 서버에 포탈(엣지, v2.416+)이 systemd 로 설치되어 있어야 합니다. 템플릿 유닛 <code>vmware-portal-rma@.service</code> 와 인스턴스별 env, sudoers(포탈 재시작 1줄)를 쓰고 인스턴스를 기동합니다.
        여러 서버에 하나씩 두려면 서버마다 이 화면을 반복하고 <b>같은 법인 이름(AGENT_NAME)과 토큰</b>을 쓰면 됩니다.
      </div>
      <div className="flex gap wrap">
        <label>SSH 호스트<br /><input className="input" value={f.host} onChange={(e) => set('host', e.target.value)} placeholder="10.0.0.10" /></label>
        <label>포트<br /><input className="input" style={{ width: 70 }} value={f.port} onChange={(e) => set('port', e.target.value)} /></label>
        <label>계정(root)<br /><input className="input" style={{ width: 100 }} value={f.username} onChange={(e) => set('username', e.target.value)} /></label>
        <label>비밀번호<br /><input className="input" type="password" value={f.password} onChange={(e) => set('password', e.target.value)} /></label>
        <button className="tab" disabled={busy || !f.host} onClick={doList} style={{ alignSelf: 'flex-end' }}>{busy === 'list' ? '조회 중…' : '현재 인스턴스 조회'}</button>
      </div>
      {list && (
        <div className="card" style={{ marginTop: 8 }}>
          {list.ok ? (
            <>
              <div>템플릿 유닛: {list.unitInstalled ? '설치됨' : '없음'}{list.install ? <span className="muted"> · 설치 경로 {list.install.prefix} · 계정 {list.install.user}</span> : <span style={{ color: TONE.warn }}> · 포탈 설치 경로를 찾지 못함</span>}</div>
              {(list.instances || []).length ? list.instances.map((i) => (
                <div key={i.name}><code>vmware-portal-rma@{i.name}</code> — {i.active}/{i.sub} <button className="tab" disabled={!!busy} onClick={() => doRemove(i.name)}>제거</button></div>
              )) : <div className="muted">인스턴스 없음</div>}
            </>
          ) : <div className="error-box">{list.reason}</div>}
        </div>
      )}
      <div className="section-title" style={{ marginTop: 12 }}>인스턴스 (한 서버에 여러 프로세스)</div>
      {instances.map((i, idx) => (
        <div key={idx} className="flex gap" style={{ marginBottom: 4 }}>
          <input className="input" value={i.name} onChange={(e) => setInstances(instances.map((x, k) => k === idx ? { ...x, name: e.target.value } : x))} placeholder="이름(영숫자·._-)" />
          <label>우선순위 <input className="input" style={{ width: 70 }} value={i.priority} onChange={(e) => setInstances(instances.map((x, k) => k === idx ? { ...x, priority: e.target.value.replace(/\D/g, '') } : x))} /></label>
          <button className="tab" disabled={instances.length <= 1} onClick={() => setInstances(instances.filter((_, k) => k !== idx))}>−</button>
        </div>
      ))}
      <button className="tab" disabled={instances.length >= 8} onClick={() => setInstances([...instances, { name: `rma${instances.length + 1}`, priority: 100 + instances.length * 10 }])}>+ 인스턴스 추가</button>
      <div className="section-title" style={{ marginTop: 12 }}>RMA 설정 (portal.env 에 기록)</div>
      <div className="flex gap wrap">
        <label>법인 이름(AGENT_NAME)<br /><input className="input" list="rma-known-agents" value={f.agentName} onChange={(e) => set('agentName', e.target.value)} placeholder="비우면 기존 값 유지" /></label>
        <datalist id="rma-known-agents">{groups.map((g) => <option key={g.agent} value={g.agent} />)}</datalist>
        <label>CENTRAL_URL<br /><input className="input" value={f.centralUrl} onChange={(e) => set('centralUrl', e.target.value)} placeholder="비우면 기존 값 유지" /></label>
        <label>개별 토큰(CENTRAL_TOKEN)<br /><input className="input" type="password" value={f.centralToken} onChange={(e) => set('centralToken', e.target.value)} placeholder="비우면 기존 값 유지" /></label>
      </div>
      <div className="flex gap wrap" style={{ marginTop: 6 }}>
        <label>RMA 비밀번호(서명)<br /><input className="input" type="password" value={f.rmaPassword} onChange={(e) => set('rmaPassword', e.target.value)} placeholder="비우면 기존 값 유지" /></label>
        <label style={{ alignSelf: 'flex-end' }}><input type="checkbox" checked={f.registerPassword} onChange={(e) => set('registerPassword', e.target.checked)} /> 같은 비밀번호를 중앙(이 법인)에도 등록</label>
        <label style={{ alignSelf: 'flex-end' }}><input type="checkbox" checked={f.allowCustom} onChange={(e) => set('allowCustom', e.target.checked)} /> 자유 명령 허용(RMA_ALLOW_CUSTOM)</label>
      </div>
      <div className="section-title" style={{ marginTop: 12 }}>엣지 정책 (HostMonitor '허용 테스트/액션' 대응 — 비우면 기존 값 유지)</div>
      <div className="flex gap wrap">
        <label>서비스 유닛 허용(RMA_SERVICE_UNITS)<br /><input className="input" value={f.serviceUnits} onChange={(e) => set('serviceUnits', e.target.value)} placeholder="nginx,chronyd (sudoers 자동 생성)" /></label>
        <label>파일 점검 루트(RMA_FILE_ROOTS)<br /><input className="input" value={f.fileRoots} onChange={(e) => set('fileRoots', e.target.value)} placeholder="/var/log,/data" /></label>
        <label>허용 명령(RMA_ENABLED_COMMANDS)<br /><input className="input" value={f.enabledCommands} onChange={(e) => set('enabledCommands', e.target.value)} placeholder="비우면 전부 · 예: uptime,df,journal" /></label>
        <label>허용 점검(RMA_ENABLED_TESTS)<br /><input className="input" value={f.enabledTests} onChange={(e) => set('enabledTests', e.target.value)} placeholder="비우면 전부 · 예: ping,tcp,disk-free" /></label>
        <label>코멘트(RMA_COMMENT)<br /><input className="input" value={f.comment} onChange={(e) => set('comment', e.target.value)} placeholder="Seoul-edge-01" /></label>
        <label style={{ alignSelf: 'flex-end' }}><input type="checkbox" checked={f.allowReboot} onChange={(e) => set('allowReboot', e.target.checked)} /> 재부팅 허용(RMA_ALLOW_REBOOT)</label>
        <label style={{ alignSelf: 'flex-end' }}><input type="checkbox" checked={f.remoteManage} onChange={(e) => set('remoteManage', e.target.checked)} /> 원격 관리 수용(RMA_REMOTE_MANAGE)</label>
      </div>
      <div className="flex gap" style={{ marginTop: 10 }}>
        <button className="login-btn" disabled={!!busy || !f.host || !f.password} onClick={doDeploy}>{busy === 'deploy' ? '배포 중…' : '배포 / 갱신'}</button>
      </div>
      {err && <div className="error-box" style={{ marginTop: 8 }}>{err}</div>}
      {result && (
        <div className="card" style={{ marginTop: 8 }}>
          <div style={{ color: result.ok ? TONE.ok : TONE.bad }}>{result.ok ? '배포 완료' : '배포 실패'}{result.install ? <span className="muted"> · {result.install.prefix} · 계정 {result.install.user}</span> : null}{result.sudoers === false ? <span style={{ color: TONE.warn }}> · sudoers 미설치(visudo 검증 실패)</span> : null}</div>
          {(result.instances || []).map((i) => <div key={i.name}><code>vmware-portal-rma@{i.name}</code> — <span style={{ color: i.active === 'active' ? TONE.ok : TONE.bad }}>{i.active}</span>{i.log ? <pre style={{ fontSize: 11, maxHeight: 160, overflow: 'auto' }}>{i.log}</pre> : null}</div>)}
        </div>
      )}
    </Modal>
  );
}
