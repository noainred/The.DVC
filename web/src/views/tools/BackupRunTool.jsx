import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchJson, postJson, putJson, usePolling } from '../../api.js';
import { Loading, ErrorBox, SearchBox } from '../../components/ui.jsx';
import { STable } from '../../components/STable.jsx';
import Select from '../../components/Select.jsx';
import VeeamHeader from './VeeamHeader.jsx';
import { RUN_STATUS, RUN_STATUS_ORDER, VM_STATE, HOW, HOST_HOW, ago, shortTime, powerText, runSummary, takeHandoff, portalMark, rpText, pickHandoff } from './backupRunText.js';
import BackupManageModal from './BackupManageModal.jsx';

/**
 * Backup 현황 › 백업 실행(v2.818, admin 전용 · 도구 키 backup-run) — 포탈에서 고른 VM 을 Veeam B&R REST API 로 백업한다.
 *  · VM 표: 서버(veeam/run/plan.js)가 모니터링 대조 결과로 판정한 실행 상태를 글자로만 보인다(판정 복제 금지).
 *  · 미리보기(같은 판정 — POST plan, 아무것도 보내지 않는다) → OTP 재인증 → 실행. 실행 현황은 10초 폴링(가벼운 목록).
 *  · 설정(잡 이름 접두·서버별 저장소·보존·vCenter 이름)은 전체 범위 관리자만 — 펼칠 때 읽는다(무거운 API 를 폴링하지 않는다).
 *  · Detail 화면에서 고른 VM 은 sessionStorage 로 넘겨받는다(backupRunText.takeHandoff).
 */
function Badge({ cls, children, title }) { return <span className={`badge ${cls || ''}`} title={title}>{children}</span>; }
const field = { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, minWidth: 0 };

export default function BackupRunTool() {
  const handoff = useRef(takeHandoff());
  const [vcId, setVcId] = useState(handoff.current?.vcenterId || '');
  const [list, setList] = useState(null);
  const [listErr, setListErr] = useState(null);
  useEffect(() => {
    fetchJson('/tools/backup-run/vms').then((r) => { setList(r.vcenters || []); setListErr(null); }).catch((e) => setListErr(e));
  }, []);
  useEffect(() => {
    if (!list || vcId) return;
    const first = [...list].filter((v) => v.linked).sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }))[0];
    if (first) setVcId(first.id);
  }, [list, vcId]);

  const vcSelect = list ? (
    <label className="muted" style={{ ...field, minWidth: 200 }}>vCenter
      <Select className="select" value={vcId} onChange={(e) => setVcId(e.target.value)} aria-label="vCenter">
        <option value="">— 고르세요 —</option>
        {list.map((v) => <option key={v.id} value={v.id}>{v.name}{v.linked ? '' : ' (Veeam 연결 없음)'}</option>)}
      </Select>
    </label>
  ) : null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, minWidth: 0 }}>
      <VeeamHeader active="run" desc="포탈에서 고른 VM 을 Veeam 으로 백업합니다 — 보내기 전에 미리보기로 방식을 확인하고 OTP 로 다시 확인합니다. 모든 요청은 감사 로그에 남습니다." actions={vcSelect} />
      {listErr && !list ? <ErrorBox error={listErr} /> : !list ? <Loading label="vCenter 목록" /> : null}
      {vcId ? <VmPanel key={vcId} vcId={vcId} initialIds={handoff.current?.vcenterId === vcId ? handoff.current.vmIds : []} /> : list && <div className="card muted">vCenter 를 고르세요.</div>}
      <RunsPanel />
      <PortalVmsPanel />
      <SettingsPanel />
    </div>
  );
}

/* ── VM 선택 · 미리보기 · 실행 ───────────────────────────────────────── */

function VmPanel({ vcId, initialIds }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [sel, setSel] = useState(() => new Map());
  const [mode, setMode] = useState('quick');
  const [unprot, setUnprot] = useState('portal');
  const [plan, setPlan] = useState(null);
  const [planErr, setPlanErr] = useState('');
  const [otp, setOtp] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [startedId, setStartedId] = useState('');
  const seq = useRef(0); const planSeq = useRef(0);
  const handoffUsed = useRef(false);   // 넘겨받은 VM 은 첫 목록에만 적용(B4 — 요청 뒤 다시 읽을 때 다시 고르지 않게)

  const load = useCallback(() => {
    const my = ++seq.current;
    fetchJson('/tools/backup-run/vms', { vcenterId: vcId }).then((r) => {
      if (my !== seq.current) return;
      setD(r); setErr(null);
      if (!handoffUsed.current && initialIds?.length) { handoffUsed.current = true; const pick = pickHandoff(r.rows, initialIds, r.writable); setSel((cur) => (cur.size ? cur : pick)); }
    }).catch((e) => { if (my === seq.current) setErr(e); });
  }, [vcId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [load]);

  const ids = useMemo(() => [...sel.keys()], [sel]);
  useEffect(() => {
    if (!ids.length) { setPlan(null); setPlanErr(''); return undefined; }
    const my = ++planSeq.current;
    const t = setTimeout(() => {
      postJson('/tools/backup-run/plan', { vmIds: ids, mode, unprotected: unprot })
        .then((r) => { if (my === planSeq.current) { setPlan(r); setPlanErr(''); } })
        .catch((e) => { if (my === planSeq.current) { setPlan(null); setPlanErr(e.message || String(e)); } });
    }, 350);
    return () => clearTimeout(t);
  }, [ids, mode, unprot]);

  const rows = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (d?.rows || []).filter((r) => (!status || r.run.status === status) && (!s || String(r.name).toLowerCase().includes(s) || String(r.folder || '').toLowerCase().includes(s)));
  }, [d, q, status]);
  const canPick = (r) => d?.writable && r.run.status !== 'unmapped';
  const visibleIds = rows.filter(canPick).map((r) => r.id);
  const allOn = visibleIds.length > 0 && visibleIds.every((id) => sel.has(id));
  const toggle = (r) => setSel((m) => { const n = new Map(m); if (n.has(r.id)) n.delete(r.id); else if (n.size < (d?.maxVms || 200)) n.set(r.id, r.name); return n; });
  const toggleAll = () => setSel((m) => { const n = new Map(m); if (allOn) visibleIds.forEach((id) => n.delete(id)); else for (const r of rows) { if (n.size >= (d?.maxVms || 200)) break; if (canPick(r)) n.set(r.id, r.name); } return n; });
  const count = (h) => (plan?.vms || []).filter((v) => v.how === h).length;
  const canStart = ids.length > 0 && plan && !plan.blocked && (count('quick') + count('portal')) > 0 && !busy;

  const start = async () => {
    setBusy(true); setMsg('');
    try {
      const r = await postJson('/tools/backup-run/backup', { vmIds: ids, mode, unprotected: unprot, otp });
      if (r.ok) { setSel(new Map()); setOtp(''); setStartedId(r.run.id); setMsg(`요청을 보냈습니다(${r.run.id}) — 아래 실행 현황에서 VM 별 결과를 봅니다.`); load(); }
      else setMsg(r.reason || '실행하지 못했습니다.');
    } catch (e) { setMsg(e.message || String(e)); } finally { setBusy(false); }
  };

  if (err && !d) return <ErrorBox error={err} />;
  if (!d) return <Loading label="VM 실행 상태" />;
  const counts = d.counts || {};
  const total = RUN_STATUS_ORDER.reduce((a, k) => a + (counts[k] || 0), 0);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }}>
      <div className="card" style={{ display: 'flex', flexWrap: 'wrap', gap: '8px 18px', alignItems: 'center', fontSize: 13, minWidth: 0 }}>
        {d.servers.length ? d.servers.map((s) => (
          <span key={s.id} style={{ display: 'inline-flex', gap: 6, alignItems: 'center', minWidth: 0, flexWrap: 'wrap' }}>
            <b>{s.name}</b>
            <Badge cls={s.authStopped ? 'red' : 'green'}>{s.authStopped ? '인증 정지' : '연결 등록됨'}</Badge>
            <span className="muted">{s.via === 'edge' ? `엣지${s.agent ? ` ${s.agent}` : ''} 경유` : '중앙 직접'}{s.active ? ' · 백업 요청 진행 중' : ''}{s.repositorySet ? '' : ' · 포탈 전용 잡 저장소 미지정'}</span>
          </span>
        )) : <span className="muted">이 vCenter 를 맡는 Veeam B&amp;R 서버가 없습니다 — 설정 › Veeam 백업 서버에서 연결 vCenter 를 지정하세요.</span>}
        <span className="muted" style={{ flexBasis: '100%', fontSize: 12, overflowWrap: 'anywhere' }}>
          Veeam 이 이 vCenter 를 부르는 이름: <b className="mono">{d.hostName?.name || '—'}</b> ({HOST_HOW[d.hostName?.how || ''] || '모름'}) · 포탈 전용 잡 이름: <span className="mono">{d.jobName}</span>
          {!d.known && d.servers.length ? ' · 이 vCenter 의 Veeam 결과를 다 읽지 못했거나 오래돼 보호 상태를 모릅니다 — 확인 불가 VM 은 어느 방식으로도 보내지 않습니다(Veeam 수집이 다시 성공하면 풀립니다).' : ''}
        </span>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'flex-start' }}>
        <div className="card" style={{ flex: '999 1 620px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'flex-end' }}>
            <label className="muted" style={{ ...field, flex: '1 1 200px' }}>VM 검색
              <SearchBox value={q} onChange={setQ} placeholder="VM · 폴더 이름" style={{ width: '100%' }} />
            </label>
            <div role="group" aria-label="실행 상태 필터" style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
              <button type="button" className={`tab${status === '' ? ' active' : ''}`} onClick={() => setStatus('')}>전체 {total}</button>
              {RUN_STATUS_ORDER.filter((k) => counts[k]).map((k) => <button key={k} type="button" className={`tab${status === k ? ' active' : ''}`} onClick={() => setStatus(k)}>{RUN_STATUS[k].label} {counts[k]}</button>)}
            </div>
            <button type="button" className="logout-btn" onClick={load}>새로 읽기</button>
          </div>
          {/* 표는 자체 세로 스크롤(70vh) — 좁은 화면에서 실행 패널이 수천 행 아래로 밀리지 않게 */}
          <div style={{ maxHeight: '70vh', overflowY: 'auto', minWidth: 0 }}>
            <STable className="table" minWidth={860} limit={1000}>
              <thead><tr>
                <th data-nosort><input type="checkbox" aria-label="보이는 VM 전체 선택" checked={allOn} onChange={toggleAll} disabled={!visibleIds.length} /></th>
                <th>VM</th><th>전원</th><th>실행 상태</th><th>복원 지점</th><th>마지막 백업</th><th>잡</th>
              </tr></thead>
              <tbody>
                {rows.map((r) => {
                  const p = r.run; const st = RUN_STATUS[p.status] || RUN_STATUS.unknown;
                  return (
                    <tr key={r.id} style={sel.has(r.id) ? { background: 'var(--hover)' } : undefined}>
                      <td><input type="checkbox" aria-label={`${r.name} 선택`} checked={sel.has(r.id)} disabled={!canPick(r)} onChange={() => toggle(r)} /></td>
                      <td style={{ fontWeight: 500 }}>{r.name}<div className="muted" style={{ fontSize: 11, overflowWrap: 'anywhere' }}>{r.folder || p.objectId || '—'}</div></td>
                      <td>{powerText(r.powerState)}</td>
                      <td data-sort={RUN_STATUS_ORDER.indexOf(p.status)}><Badge cls={st.cls} title={p.reason || ''}>{st.label}</Badge>{p.running ? <span className="muted" style={{ fontSize: 11 }}> · 백업 중</span> : null}</td>
                      <td data-sort={p.restorePoints ?? ''} className="mono">{rpText(p.restorePoints)}</td>
                      <td data-sort={p.lastBackup ?? ''} className="mono">{shortTime(p.lastBackup)}</td>
                      <td style={{ fontSize: 12 }}>{(p.jobs || []).join(', ') || '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </STable>
          </div>
          <div className="muted" style={{ fontSize: 12 }}>{rows.length > 1000 ? `${rows.length}대 중 앞 1,000대(정렬 뒤)만 표시합니다 — 검색·필터로 좁히세요. ` : ''}템플릿·vCLS 시스템 VM 은 뺐습니다. 보호 상태는 Backup 현황과 같은 대조 결과입니다.</div>
        </div>

        <div className="card" style={{ flex: '1 1 340px', minWidth: 0, maxWidth: 460, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
            <b>선택한 VM {ids.length}대</b>
            {ids.length ? <button type="button" className="logout-btn" onClick={() => setSel(new Map())}>선택 해제</button> : null}
          </div>
          {!d.writable ? <div style={{ fontSize: 12, color: 'var(--amber)' }}>이 vCenter 는 조회 전용 범위라 백업을 실행할 수 없습니다.</div> : null}
          {ids.length ? (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, maxHeight: 110, overflowY: 'auto' }}>
              {[...sel.entries()].slice(0, 60).map(([id, name]) => <span key={id} className="badge">{name}</span>)}
              {ids.length > 60 ? <span className="muted">외 {ids.length - 60}대</span> : null}
            </div>
          ) : <div className="muted" style={{ fontSize: 12 }}>표에서 VM 을 고르세요(한 번에 {d.maxVms}대까지).</div>}
          <fieldset style={{ border: 0, margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <legend className="muted" style={{ fontSize: 12, marginBottom: 6 }}>백업 방식</legend>
            <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', cursor: 'pointer' }}>
              <input type="radio" name="veeam-run-mode" checked={mode === 'quick'} onChange={() => setMode('quick')} />
              <span><b>빠른 백업 (Quick Backup)</b><br /><span className="muted" style={{ fontSize: 12 }}>VM 이 속한 기존 잡의 설정으로 그 VM 만 증분 백업합니다. 전체 복원 지점이 있는 VM 만 됩니다.</span></span>
            </label>
            <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', cursor: 'pointer' }}>
              <input type="radio" name="veeam-run-mode" checked={mode === 'portal'} onChange={() => setMode('portal')} />
              <span><b>포탈 전용 잡으로 백업</b><br /><span className="muted" style={{ fontSize: 12 }}>‘{d.jobName}’ 잡에 VM 을 넣고 잡을 시작합니다. 처음 들어간 VM 은 전체 백업부터 하고, 잡을 시작하면 그 잡의 VM 전부가 함께 돕니다. 포탈은 자기가 만든 잡만 고칩니다.</span></span>
            </label>
          </fieldset>
          {mode === 'quick' ? (
            <label className="muted" style={field}>Quick Backup 이 안 되는 VM
              <Select sort={false} className="select" value={unprot} onChange={(e) => setUnprot(e.target.value)}>
                <option value="portal">포탈 전용 잡으로 넘겨서 함께 백업</option>
                <option value="skip">건너뛰기</option>
              </Select>
            </label>
          ) : null}
          {ids.length ? (
            <div style={{ background: 'var(--panel-deep)', border: '1px solid var(--border-soft)', borderRadius: 10, padding: 10, display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12 }}>
              <div className="muted">미리보기(서버 판정 — 아직 아무것도 보내지 않았습니다)</div>
              {planErr ? <div style={{ color: 'var(--red)' }}>{planErr}</div> : !plan ? <div className="muted">계산 중…</div> : (
                <>
                  <div>Quick Backup <b>{count('quick')}</b> · 포탈 전용 잡 <b>{count('portal')}</b> · 건너뜀 <b>{count('skip')}</b></div>
                  {(plan.groups || []).map((g) => <div key={`${g.serverId}|${g.kind}|${g.vcenterId}`} className="muted">→ {g.serverName}: {HOW[g.kind]}{g.jobName ? ` ‘${g.jobName}’` : ''} {g.count}대</div>)}
                  {(plan.vms || []).filter((v) => v.reason).slice(0, 8).map((v) => <div key={v.vmId} style={{ color: v.how === 'skip' ? 'var(--amber)' : 'var(--text-dim)', overflowWrap: 'anywhere' }}>{v.name}: {v.reason}</div>)}
                  {plan.blocked ? <div style={{ color: 'var(--red)', overflowWrap: 'anywhere' }}>{plan.blocked}</div> : null}
                </>
              )}
            </div>
          ) : null}
          <label className="muted" style={field}>OTP 코드(재인증 — OTP 가 없는 설정 소유자 계정은 비워 둡니다)
            <input className="input" inputMode="numeric" autoComplete="one-time-code" value={otp} onChange={(e) => setOtp(e.target.value.replace(/\D/g, '').slice(0, 8))} placeholder="6자리" style={{ width: 140 }} />
          </label>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            <button type="button" className="login-btn" disabled={!canStart} onClick={start} style={{ minHeight: 40, flex: '1 1 160px' }}>{busy ? '보내는 중…' : '백업 시작'}</button>
          </div>
          {msg ? <div style={{ fontSize: 12, color: startedId && msg.includes(startedId) ? 'var(--green)' : 'var(--red)', overflowWrap: 'anywhere' }}>{msg}</div> : null}
          <div className="muted" style={{ fontSize: 12, lineHeight: 1.6 }}>실패하거나 결과를 모르는 요청을 포탈이 자동으로 다시 보내지 않습니다(이중 실행·계정 잠금 방지). 인증 정지 중인 서버로는 보내지 않습니다.</div>
        </div>
      </div>
    </div>
  );
}

/* ── 실행 현황 ───────────────────────────────────────────────────────── */

function RunsPanel() {
  // 실행 기록은 메모리 목록이라 가볍다 — 10초 폴링(usePolling: 백그라운드 탭 일시정지 · 403 이면 멈춤).
  const { data: d, error: err } = usePolling('/tools/backup-run/runs', { limit: 30 }, 10_000);
  const [open, setOpen] = useState('');
  if (err && !d) return <ErrorBox error={err} />;
  if (!d) return <Loading label="실행 현황" />;
  const runs = d.runs || [];
  return (
    <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: 'space-between', alignItems: 'center' }}>
        <b>실행 현황 · 이력</b>
        <span className="muted" style={{ fontSize: 12 }}>10초마다 새로 읽습니다{d.omittedOutOfScope ? ` · 범위 밖 VM 이 든 요청 ${d.omittedOutOfScope}건은 표시하지 않습니다` : ''}.</span>
      </div>
      {!runs.length ? <div className="muted">아직 실행한 요청이 없습니다.</div> : (
        <STable className="table" minWidth={820}>
          <thead><tr><th>요청 시각</th><th>요청자</th><th>방식</th><th>VM</th><th>상태</th><th>결과</th><th data-nosort>상세</th></tr></thead>
          <tbody>
            {runs.map((r) => (
              <React.Fragment key={r.id}>
                <tr>
                  <td data-sort={r.at} className="mono">{shortTime(r.at)}</td>
                  <td>{r.user || '—'}</td>
                  <td>{[...new Set((r.groups || []).map((g) => HOW[g.kind]))].join(' + ') || '—'}</td>
                  <td data-sort={(r.vms || []).length}>{(r.vms || []).slice(0, 2).map((v) => v.name).join(', ')}{(r.vms || []).length > 2 ? ` 외 ${(r.vms || []).length - 2}` : ''}</td>
                  <td><Badge cls={r.status === 'running' ? 'blue' : 'gray'}>{r.status === 'running' ? '진행 중' : '끝남'}</Badge></td>
                  <td>{runSummary(r)}</td>
                  <td><button type="button" className="logout-btn" onClick={() => setOpen(open === r.id ? '' : r.id)}>{open === r.id ? '접기' : '보기'}</button></td>
                </tr>
                {open === r.id ? <tr><td colSpan={7} style={{ background: 'var(--panel-deep)' }}><RunDetail run={r} /></td></tr> : null}
              </React.Fragment>
            ))}
          </tbody>
        </STable>
      )}
    </div>
  );
}

/** 포탈로 백업한 VM(v2.819) — 마지막 백업·결과·잡에서 뺌·삭제 · '관리' 로 복원 지점·새 VM 복원·빼기·삭제. 로컬 기록이라 가볍다(30초). */
function PortalVmsPanel() {
  const { data: d, error: err } = usePolling('/tools/backup-run/portal-vms', {}, 30_000);
  const [q, setQ] = useState('');
  const [open, setOpen] = useState('');
  if (err && !d) return <ErrorBox error={err} />;
  if (!d) return <Loading label="포탈 백업 VM" />;
  const needle = q.trim().toLowerCase();
  const rows = (d.vms || []).filter((v) => !needle || `${v.name} ${v.vcenterName} ${v.folder}`.toLowerCase().includes(needle));
  return (
    <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: 'space-between', alignItems: 'center' }}>
        <b>포탈 백업 VM {(d.vms || []).length}대</b>
        <div style={{ flex: '0 1 280px', minWidth: 0 }}><SearchBox value={q} onChange={setQ} placeholder="VM · vCenter · 폴더" /></div>
      </div>
      <div className="muted" style={{ fontSize: 12 }}>포탈에서 백업을 요청한 VM 입니다(포탈이 보낸 요청과 그 결과). Veeam 이 지금 가진 복원 지점은 ‘관리’ 창이 Veeam 에 직접 묻습니다. vCenter 상세의 폴더 트리에서도 같은 배지로 보입니다.</div>
      {!rows.length ? <div className="muted">{(d.vms || []).length ? '검색과 맞는 VM 이 없습니다.' : '아직 포탈로 백업한 VM 이 없습니다.'}</div> : (
        <STable className="table" minWidth={860} limit={300}>
          <thead><tr><th>VM</th><th>vCenter · 폴더</th><th>방식</th><th>마지막 요청</th><th>상태</th><th>복원</th><th data-nosort>관리</th></tr></thead>
          <tbody>
            {rows.map((v) => {
              const m = portalMark(v);
              return (
                <tr key={v.vmId}>
                  <td>{v.name}{!v.exists ? <span className="muted" style={{ fontSize: 11 }}> (인벤토리에 없음)</span> : null}</td>
                  <td style={{ fontSize: 12, overflowWrap: 'anywhere' }}>{v.vcenterName}<div className="muted">{v.folder || '—'}</div></td>
                  <td>{HOW[v.how] || '—'}{v.jobName ? <div className="muted" style={{ fontSize: 11 }}>{v.jobName}</div> : null}</td>
                  <td data-sort={v.lastAt ?? ''} className="mono">{shortTime(v.lastAt)}</td>
                  <td>{m ? <Badge cls={m.cls} title={m.title}>{m.label}</Badge> : '—'}</td>
                  <td style={{ fontSize: 12 }}>{v.restores?.length ? `${v.restores[0].newName} (${(VM_STATE[v.restores[0].state] || VM_STATE.unknown).label})` : '—'}</td>
                  <td><button type="button" className="logout-btn" disabled={!v.exists} title={v.exists ? '' : '인벤토리에 없는 VM 은 관리 창을 열 수 없습니다'} onClick={() => setOpen(v.vmId)}>관리</button></td>
                </tr>
              );
            })}
          </tbody>
        </STable>
      )}
      {open ? <BackupManageModal vmId={open} onClose={() => setOpen('')} /> : null}
    </div>
  );
}

function RunDetail({ run }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '6px 2px', minWidth: 0 }}>
      <div className="muted mono" style={{ fontSize: 11 }}>{run.id} · {ago(run.at)}</div>
      {(run.groups || []).map((g) => (
        <div key={`${g.serverId}|${g.kind}|${g.vcenterId}`} style={{ fontSize: 12, overflowWrap: 'anywhere' }}>
          <b>{g.serverName}</b> — {HOW[g.kind]}{g.jobName ? ` ‘${g.jobName}’` : ''}{g.variant ? <span className="muted"> · 요청 형태 {g.variant}</span> : null}
          {g.reason ? <div style={{ color: g.state === 'failed' ? 'var(--red)' : 'var(--text-dim)' }}>{g.reason}</div> : null}
          {(g.notes || []).map((n, i) => <div key={i} className="muted">{n}</div>)}
          {(g.sessions || []).filter((s) => s.lastError).map((s) => <div key={s.id} style={{ color: 'var(--amber)' }}>세션 {s.id} 확인 실패: {s.lastError}</div>)}
          {(g.sessions || []).filter((s) => !s.lastError && s.tasksError).map((s) => <div key={`t${s.id}`} className="muted">세션 {s.id} 의 VM 별 작업을 읽지 못함: {s.tasksError}</div>)}
        </div>
      ))}
      {run.status === 'running' && !(run.vms || []).some((v) => v.state === 'starting' || v.state === 'queued') ? <CloseRun run={run} /> : null}
      <STable className="table" minWidth={680}>
        <thead><tr><th>VM</th><th>방식</th><th>상태</th><th>진행</th><th>내용</th></tr></thead>
        <tbody>
          {(run.vms || []).map((v) => {
            const st = VM_STATE[v.state] || VM_STATE.unknown;
            return (
              <tr key={v.vmId}>
                <td>{v.name}</td><td>{HOW[v.how] || v.how}</td><td><Badge cls={st.cls}>{st.label}</Badge></td>
                <td data-sort={v.progress ?? ''} className="mono">{typeof v.progress === 'number' ? `${v.progress}%` : '—'}</td>
                <td style={{ fontSize: 12, overflowWrap: 'anywhere' }}>{v.detail || '—'}</td>
              </tr>
            );
          })}
        </tbody>
      </STable>
    </div>
  );
}

/** 기록 닫기 — 세션 추적이 계속 실패해 그 서버의 새 요청이 막힐 때. 포탈 기록만 닫는다(Veeam 은 멈추지 않는다). */
function CloseRun({ run }) {
  const [otp, setOtp] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const close = async () => {
    setBusy(true); setMsg('');
    try { const r = await postJson(`/tools/backup-run/runs/${encodeURIComponent(run.id)}/close`, { otp }); setMsg(r.ok ? '닫았습니다 — 다음 새로 고침에 반영됩니다.' : (r.reason || '닫지 못했습니다.')); if (r.ok) setOtp(''); }
    catch (e) { setMsg(e?.status === 403 ? '권한이 없습니다(조회 전용 범위 또는 재인증 실패).' : String(e?.message || e)); }
    finally { setBusy(false); }
  };
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', fontSize: 12, minWidth: 0 }}>
      <span className="muted" style={{ flex: '1 1 260px', minWidth: 0, overflowWrap: 'anywhere' }}>세션 확인이 계속 실패하면 이 Veeam 서버의 새 요청이 막힙니다. 기록을 닫으면 끝나지 않은 VM 은 확인 불가가 됩니다(Veeam 의 백업은 멈추지 않습니다).</span>
      <input className="input" inputMode="numeric" autoComplete="one-time-code" value={otp} onChange={(e) => setOtp(e.target.value.replace(/\D/g, '').slice(0, 8))} placeholder="OTP" aria-label="기록 닫기 OTP" style={{ width: 100 }} />
      <button type="button" className="logout-btn" disabled={busy} onClick={close}>{busy ? '닫는 중…' : '기록 닫기'}</button>
      {msg ? <span style={{ overflowWrap: 'anywhere', minWidth: 0 }}>{msg}</span> : null}
    </div>
  );
}

/* ── 설정(전체 범위 관리자) ──────────────────────────────────────────── */

function SettingsPanel() {
  const [open, setOpen] = useState(false);
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const [form, setForm] = useState(null);
  const [repos, setRepos] = useState({});
  const [otp, setOtp] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState('');
  const load = useCallback(() => fetchJson('/tools/backup-run/settings').then((r) => { setD(r); setErr(null); setForm({ jobPrefix: r.settings.jobPrefix, servers: Object.fromEntries(r.servers.map((s) => [s.id, { repositoryId: s.repositoryId || '', retention: s.retention }])), hosts: { ...r.settings.hosts } }); }).catch((e) => setErr(e)), []);
  useEffect(() => { if (open && !d) load(); }, [open, d, load]);
  const readRepos = async (s) => {
    setBusy(`repo:${s.id}`);
    try { const r = await postJson(`/tools/backup-run/servers/${encodeURIComponent(s.id)}/repos`, {}); setRepos((m) => ({ ...m, [s.id]: r })); }
    catch (e) { setRepos((m) => ({ ...m, [s.id]: { ok: false, reason: e.message || String(e) } })); } finally { setBusy(''); }
  };
  const save = async () => {
    setBusy('save'); setMsg('');
    try { const r = await putJson('/tools/backup-run/settings', { ...form, otp }); if (r.ok) { setOtp(''); setMsg('저장했습니다.'); setD(null); load(); } else setMsg(r.reason || '저장하지 못했습니다.'); }
    catch (e) { setMsg(e.message || String(e)); } finally { setBusy(''); }
  };
  return (
    <details className="card" open={open} onToggle={(e) => setOpen(e.currentTarget.open)} style={{ minWidth: 0 }}>
      <summary style={{ cursor: 'pointer', fontWeight: 600 }}>백업 실행 설정 — 포탈 전용 잡 저장소·보존 · vCenter 이름(전체 범위 관리자)</summary>
      {!open ? null : err && !d ? <div style={{ marginTop: 10 }}><ErrorBox error={err} /></div> : !d || !form ? <Loading label="설정" /> : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 12, minWidth: 0 }}>
          {d.settingsUnreadable ? <div style={{ color: 'var(--red)', fontSize: 12 }}>설정 파일을 읽지 못했습니다 — 저장하면 새 설정으로 씁니다(손상 원본은 보존돼 있습니다).</div> : null}
          {d.registryUnreadable ? <div style={{ color: 'var(--red)', fontSize: 12 }}>Veeam 서버 등록부를 읽지 못해 서버 목록이 비어 있습니다 — 이 상태로 저장하면 서버별 저장소·보존이 지워지므로 저장을 막습니다. 설정 › Veeam 백업 서버에서 먼저 확인하세요.</div> : null}
          <div className="muted" style={{ fontSize: 12 }}>Veeam 서버(주소·계정·담당 엣지·연결 vCenter)는 설정 › Veeam 백업 서버에서 등록합니다. 여기서는 백업 실행에만 쓰는 값을 정합니다.</div>
          <label className="muted" style={{ ...field, maxWidth: 260 }}>포탈 전용 잡 이름 접두
            <input className="input" value={form.jobPrefix} onChange={(e) => setForm({ ...form, jobPrefix: e.target.value })} />
          </label>
          <STable className="table" minWidth={720}>
            <thead><tr><th>Veeam 서버</th><th>호출</th><th data-nosort>포탈 전용 잡 저장소</th><th data-nosort>보존(복원 지점)</th></tr></thead>
            <tbody>
              {d.servers.map((s) => {
                const f = form.servers[s.id] || { repositoryId: '', retention: 7 };
                const rr = repos[s.id];
                const set = (patch) => setForm({ ...form, servers: { ...form.servers, [s.id]: { ...f, ...patch } } });
                return (
                  <tr key={s.id}>
                    <td>{s.name}<div className="muted mono" style={{ fontSize: 11 }}>{s.host}</div></td>
                    <td style={{ fontSize: 12 }}>{s.agent ? `엣지 ${s.agent}` : '중앙 직접'}</td>
                    <td>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
                        {rr?.ok && rr.repositories?.length ? (
                          <Select sort={false} className="select" value={f.repositoryId} onChange={(e) => set({ repositoryId: e.target.value })} aria-label={`${s.name} 저장소`}>
                            <option value="">— 고르세요 —</option>
                            {rr.repositories.map((p) => <option key={p.id} value={p.id}>{p.name}{p.freeGB != null ? ` · 여유 ${Math.round(p.freeGB)} GB` : ''}</option>)}
                          </Select>
                        ) : <input className="input mono" value={f.repositoryId} placeholder="저장소 id" onChange={(e) => set({ repositoryId: e.target.value })} aria-label={`${s.name} 저장소 id`} style={{ width: 200 }} />}
                        <button type="button" className="logout-btn" disabled={!!busy} onClick={() => readRepos(s)}>{busy === `repo:${s.id}` ? '읽는 중…' : '저장소 목록 읽기'}</button>
                      </div>
                      {rr && !rr.ok ? <div style={{ fontSize: 11, color: 'var(--red)', overflowWrap: 'anywhere' }}>{rr.reason}</div> : null}
                    </td>
                    <td><input className="input" type="number" min={1} max={999} value={f.retention} onChange={(e) => set({ retention: e.target.value })} aria-label={`${s.name} 보존`} style={{ width: 90 }} /></td>
                  </tr>
                );
              })}
            </tbody>
          </STable>
          <STable className="table" minWidth={640}>
            <thead><tr><th>vCenter</th><th>포탈 등록 주소</th><th data-nosort>Veeam 이 부르는 이름(직접 지정 — 비우면 자동)</th></tr></thead>
            <tbody>
              {d.vcenters.map((vc) => (
                <tr key={vc.id}>
                  <td>{vc.name}<div className="muted mono" style={{ fontSize: 11 }}>{vc.jobName}</div></td>
                  <td className="mono" style={{ fontSize: 12 }}>{vc.host || '—'}</td>
                  <td><input className="input mono" value={form.hosts[vc.id] || ''} placeholder="자동" onChange={(e) => setForm({ ...form, hosts: { ...form.hosts, [vc.id]: e.target.value } })} aria-label={`${vc.name} Veeam 이름`} style={{ width: '100%' }} /></td>
                </tr>
              ))}
            </tbody>
          </STable>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'flex-end' }}>
            <label className="muted" style={field}>OTP 코드(재인증)
              <input className="input" inputMode="numeric" autoComplete="one-time-code" value={otp} onChange={(e) => setOtp(e.target.value.replace(/\D/g, '').slice(0, 8))} placeholder="6자리" style={{ width: 140 }} />
            </label>
            <button type="button" className="login-btn" disabled={!!busy || !!d.registryUnreadable} onClick={save}>{busy === 'save' ? '저장 중…' : '설정 저장'}</button>
            {msg ? <span style={{ fontSize: 12, overflowWrap: 'anywhere' }}>{msg}</span> : null}
          </div>
          {d.pendingEdgeOps?.length ? <div className="muted" style={{ fontSize: 12 }}>엣지 대기 작업 {d.pendingEdgeOps.length}건</div> : null}
        </div>
      )}
    </details>
  );
}
