/**
 * 포탈 백업 관리 창(v2.819) — vCenter 폴더 트리의 'Portal' 배지와 Backup › 백업 실행의 '포탈 백업 VM' 표가 연다.
 * 복원 지점(Veeam 에 직접 묻는다) · **새 VM 으로** 복원(원본은 그대로) · 포탈 전용 잡에서 빼기 · 백업 삭제(되돌릴 수 없음 — 이름 재입력).
 * 판정(범위·이름 겹침·포탈 잡 여부)은 서버가 한다 — 화면은 값을 보여 주고 버튼을 잠그기만 한다.
 */
import React, { useEffect, useRef, useState } from 'react';
import { fetchJson, postJson } from '../../api.js';
import { Loading, ErrorBox } from '../../components/ui.jsx';
import { Modal } from '../../components/Modal.jsx';
import { STable } from '../../components/STable.jsx';
import Select from '../../components/Select.jsx';
import { VM_STATE, HOW, HOST_HOW, shortTime, ago, portalMark, pointSource } from './backupRunText.js';

function Badge({ cls, children, title }) { return <span className={`badge ${cls || ''}`} title={title}>{children}</span>; }
const field = { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, minWidth: 0 };
const section = { display: 'flex', flexDirection: 'column', gap: 8, padding: '10px 12px', border: '1px solid var(--border)', borderRadius: 8, minWidth: 0 };
const errText = (e) => (e?.status === 403 && !e?.serverReason ? '권한이 없습니다.' : String(e?.message || e));

export default function BackupManageModal({ vmId, onClose }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const [serverId, setServerId] = useState('');
  const [pts, setPts] = useState(null);       // vmPoints 결과
  const [ptsBusy, setPtsBusy] = useState(false);
  const [pick, setPick] = useState('');
  const [newName, setNewName] = useState('');
  const [otp, setOtp] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState(null);       // { ok, text }
  const seq = useRef(0);
  const pseq = useRef(0);   // 복원 지점 요청 순번 — 서버를 바꾸면 늦게 온 이전 응답을 버린다

  const load = () => {
    const my = ++seq.current;
    fetchJson(`/tools/backup-run/vm/${encodeURIComponent(vmId)}`)
      .then((r) => { if (my !== seq.current) return; setD(r); setServerId((s) => s || r.serverId || ''); setNewName((n) => n || r.suggestName || ''); })
      .catch((e) => { if (my === seq.current) setErr(e); });
  };
  useEffect(() => { load(); return () => { seq.current += 1; }; }, [vmId]); // eslint-disable-line react-hooks/exhaustive-deps

  const readPoints = async (sid) => {
    const my = ++pseq.current;
    setPtsBusy(true); setPts(null); setPick('');
    let r;
    try { r = await postJson(`/tools/backup-run/vm/${encodeURIComponent(vmId)}/points`, { serverId: sid }); }
    catch (e) { r = { ok: false, reason: errText(e) }; }
    if (my !== pseq.current) return;
    setPts(r); setPtsBusy(false);
  };
  // 창을 열면 한 번 읽는다(Veeam 왕복 — 폴링하지 않는다. 다시 읽기는 버튼).
  useEffect(() => { if (d?.servers?.length && serverId && !pts && !ptsBusy) readPoints(serverId); }, [d, serverId]); // eslint-disable-line react-hooks/exhaustive-deps

  const act = async (kind, path, body) => {
    setBusy(kind); setMsg(null);
    try {
      const r = await postJson(`/tools/backup-run/vm/${encodeURIComponent(vmId)}/${path}`, { serverId, otp, ...body });
      if (r.ok) { setOtp(''); setConfirm(''); }
      if (kind === 'restore') setNewName('');   // 다음 제안 이름을 새로 받는다(같은 이름으로 다시 보내지 않게)
      const text = r.ok
        ? (kind === 'restore' ? `복원 요청을 보냈습니다(${r.run?.id}) — 결과는 아래 '최근 요청' 과 Backup › 백업 실행 › 실행 현황에서 봅니다.`
          : kind === 'exclude' ? `포탈 전용 잡 '${r.jobName}' 에서 ${r.removed ? '뺐습니다' : '뺄 것이 없었습니다(이미 없음)'}.`
          : `Veeam 이 삭제 요청을 받았습니다(${r.deleted ?? 0}건)${r.excluded ? ' · 포탈 전용 잡에서도 뺐습니다' : ''} — 지우는 작업은 Veeam 에서 이어질 수 있습니다.`)
        : `${r.unknown ? '결과를 모릅니다 — ' : r.notSent ? '보내지 않았습니다 — ' : ''}${r.reason || '실패했습니다.'}${kind === 'delete' && (r.excluded || r.deleted) ? ` (그 전에 바뀐 것: 잡에서 뺌 ${r.excluded ? '예' : '아니오'} · 삭제 요청 ${r.deleted ?? 0}건)` : ''}`;
      setMsg({ ok: !!r.ok, text, notes: Array.isArray(r.notes) ? r.notes.slice(0, 6) : [] });
      load();
      if (r.ok && kind !== 'restore') readPoints(serverId);
    } catch (e) { setMsg({ ok: false, text: errText(e) }); }
    finally { setBusy(''); }
  };

  if (err) return <Modal title="포탈 백업 관리" onClose={onClose} width={900}><ErrorBox error={err} /></Modal>;
  if (!d) return <Modal title="포탈 백업 관리" onClose={onClose} width={900}><Loading label="포탈 백업 관리" /></Modal>;
  const vm = d.vm;
  const rec = d.record;
  const mark = portalMark(rec);
  const job = pts?.job || null;
  const point = (pts?.points || []).find((p) => p.id === pick) || null;
  const otpOk = otp.length >= 6 || otp.length === 0;   // OTP 없는 설정 소유자 계정은 비워 둔다(서버가 판정)
  const noServer = !d.servers.length;
  const lock = !d.writable || noServer || !!busy;

  return (
    <Modal title={`포탈 백업 관리 — ${vm.name}`} onClose={onClose} width={900}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', fontSize: 12, minWidth: 0 }}>
          {mark ? <Badge cls={mark.cls} title={mark.title}>{mark.label}</Badge> : <Badge cls="gray">포탈 백업 기록 없음</Badge>}
          <span className="muted" style={{ overflowWrap: 'anywhere', minWidth: 0 }}>{vm.vcenterName} · {vm.folder || 'vm'} · 호스트 {vm.host || '—'} · 포탈 전용 잡 ‘{d.jobName}’ · Veeam 이 부르는 vCenter 이름 {d.hostName.name || '—'}({HOST_HOW[d.hostName.how] || '모름'})</span>
        </div>
        {!d.writable ? <div style={{ fontSize: 12, color: 'var(--amber)' }}>조회 전용 범위입니다 — 복원·빼기·삭제는 할 수 없습니다.</div> : null}
        {noServer ? <div style={{ fontSize: 12, color: 'var(--amber)' }}>이 vCenter 를 맡는 Veeam B&R 서버가 등록돼 있지 않습니다 — 설정 › Veeam 백업 서버.</div> : null}
        {d.servers.length > 1 ? (
          <label style={field}>Veeam 서버
            <Select className="select" value={serverId} onChange={(e) => { setServerId(e.target.value); readPoints(e.target.value); }} aria-label="Veeam 서버">
              {d.servers.map((s) => <option key={s.id} value={s.id}>{`${s.name}${s.authStopped ? ' (인증 정지)' : ''}${s.active ? ' (진행 중)' : ''}`}</option>)}
            </Select>
          </label>
        ) : null}

        {/* 복원 지점 */}
        <div style={section}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: 'space-between', alignItems: 'center' }}>
            <b style={{ fontSize: 13 }}>복원 지점 {pts?.points ? `${pts.points.length}개` : ''}</b>
            <button type="button" className="logout-btn" disabled={ptsBusy || noServer} onClick={() => readPoints(serverId)}>{ptsBusy ? 'Veeam 에서 읽는 중…' : '다시 읽기'}</button>
          </div>
          {ptsBusy && !pts ? <div className="muted" style={{ fontSize: 12 }}>Veeam 에서 읽는 중…</div> : null}
          {pts && !pts.ok ? <div style={{ fontSize: 12, color: 'var(--red)', overflowWrap: 'anywhere' }}>{pts.reason || '읽지 못했습니다.'}</div> : null}
          {pts?.ok && !pts.points.length ? <div className="muted" style={{ fontSize: 12 }}>이 VM 으로 확인된 복원 지점이 없습니다{pts.truncated || pts.hidden ? '(위 안내 참고 — 없다고 단정할 수는 없습니다)' : ''}.</div> : null}
          {pts?.ok && pts.points.length ? (
            <div style={{ maxHeight: 260, overflow: 'auto', minWidth: 0 }}>
              <STable className="table" minWidth={560}>
                <thead><tr><th data-nosort>선택</th><th>만든 시각</th><th>백업(잡)</th><th>이 VM 확인</th></tr></thead>
                <tbody>
                  {pts.points.map((p) => {
                    const src = pointSource(p);
                    return (
                      <tr key={p.id} onClick={() => setPick(p.id)} style={{ cursor: 'pointer', background: pick === p.id ? 'var(--panel-deep)' : undefined }}>
                        <td><input type="radio" name="rp" checked={pick === p.id} onChange={() => setPick(p.id)} aria-label={`${shortTime(p.at)} 복원 지점 선택`} /></td>
                        <td data-sort={p.at ?? ''} className="mono">{shortTime(p.at)}</td>
                        <td style={{ overflowWrap: 'anywhere' }}>{src.name}{src.portal ? <> <Badge cls="blue">포탈 잡</Badge></> : null}</td>
                        <td style={{ fontSize: 12 }} title={p.binding === 'verified' ? '백업 개체의 moref·vCenter 가 이 VM 과 같습니다' : '응답에서 moref·vCenter 를 확인하지 못했지만 이 vCenter 의 포탈 전용 잡 백업입니다'}>{p.binding === 'verified' ? 'moref·vCenter 일치' : '포탈 잡(이 vCenter)'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </STable>
            </div>
          ) : null}
          {pts?.ok ? (
            <div className="muted" style={{ fontSize: 11, overflowWrap: 'anywhere' }}>
              백업 개체의 moref·vCenter 가 이 VM 과 맞는 지점, 또는 이 vCenter 의 포탈 전용 잡 지점만 보입니다(다른 vCenter 의 같은 이름 VM 백업은 숨깁니다).
              {pts.hidden ? ` 이 VM 으로 확인되지 않아 숨긴 지점 ${pts.hidden}개.` : ''}{pts.truncated ? ' 지점이 많아 앞부분만 읽었습니다 — 오래된 지점은 빠졌을 수 있습니다.' : ''} 요청 형태 {pts.variant || '—'}.
              {(pts.notes || []).slice(0, 4).map((n, i) => <div key={i}>{n}</div>)}
            </div>
          ) : null}
        </div>

        {/* 새 VM 으로 복원 */}
        <div style={section}>
          <b style={{ fontSize: 13 }}>새 VM 으로 복원</b>
          <div className="muted" style={{ fontSize: 12 }}>원본 VM 은 건드리지 않습니다. 고른 복원 지점을 새 이름의 VM 으로, 원래 호스트({vm.host || '—'})에 <b>전원 꺼진 채로</b> 만듭니다. 네트워크가 원본과 같으니 켜기 전에 IP 충돌을 확인하세요.</div>
          {!d.canRestore ? <div style={{ fontSize: 12, color: 'var(--amber)' }}>복원할 ESXi 호스트나 Veeam 이 이 vCenter 를 부르는 이름을 몰라 복원할 수 없습니다 — 백업 실행 설정의 vCenter 이름을 확인하세요.</div> : null}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'flex-end' }}>
            <label style={{ ...field, flex: '1 1 260px' }}>새 VM 이름(영문·숫자 · . _ -)
              <input className="input" value={newName} onChange={(e) => setNewName(e.target.value.slice(0, 80))} />
            </label>
            <div style={{ fontSize: 12, flex: '1 1 200px', minWidth: 0 }}>복원 지점: {point ? <b>{shortTime(point.at)} · {pointSource(point).name}</b> : <span className="muted">위 표에서 고르세요</span>}</div>
          </div>
        </div>

        {/* 포탈 전용 잡 · 삭제 */}
        <div style={section}>
          <b style={{ fontSize: 13 }}>포탈 전용 잡</b>
          <div style={{ fontSize: 12, overflowWrap: 'anywhere' }}>
            {job ? (job.found ? (job.marker ? (job.included ? <>‘{job.name}’ 에 <b>들어 있습니다</b>.</> : <>‘{job.name}’ 에 없습니다.</>) : <span style={{ color: 'var(--amber)' }}>‘{job.name}’ 은 포탈이 만든 잡이 아닙니다 — 고치지 않습니다.</span>) : <>‘{job.name}’ 잡이 Veeam 에 없습니다.</>) : <span className="muted">복원 지점을 읽으면 함께 확인합니다.</span>}
            {rec?.excludedAt ? <span className="muted"> · 포탈에서 뺀 시각 {shortTime(rec.excludedAt)}</span> : null}
          </div>
          <details style={{ fontSize: 12 }}>
            <summary style={{ cursor: 'pointer', color: 'var(--red)' }}>백업 삭제(되돌릴 수 없음)</summary>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6, minWidth: 0 }}>
              <div className="muted">포탈 전용 잡의 이 VM(moref) 백업(복원 지점 전부)을 Veeam 에서 지웁니다. 먼저 잡에서 빼고, 빼지 못하면(잡의 마지막 VM 등) 지우지 않습니다. 사람이 만든 잡의 백업과 다른 VM 의 백업은 지우지 않습니다.
                이 VM 백업만 안전하게 지울 REST 경로가 없으면 잡에서 빼기까지만 하고 그렇다고 알려 드립니다.</div>
              <label style={field}>확인 — VM 이름 ‘{vm.name}’ 을 그대로 입력
                <input className="input" value={confirm} onChange={(e) => setConfirm(e.target.value)} style={{ maxWidth: 320 }} />
              </label>
              <div><button type="button" className="logout-btn" style={{ color: 'var(--red)' }} disabled={lock || confirm !== vm.name || !otpOk} onClick={() => act('delete', 'delete-backup', { confirmName: confirm })}>{busy === 'delete' ? '지우는 중…' : '백업 삭제'}</button></div>
            </div>
          </details>
        </div>

        {/* 실행 */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'flex-end' }}>
          <label style={field}>OTP 코드(재인증 — OTP 가 없는 설정 소유자 계정은 비워 둡니다)
            <input className="input" inputMode="numeric" autoComplete="one-time-code" value={otp} onChange={(e) => setOtp(e.target.value.replace(/\D/g, '').slice(0, 8))} placeholder="6자리" style={{ width: 140 }} />
          </label>
          <button type="button" className="login-btn" style={{ flex: '1 1 160px', minHeight: 38 }} disabled={lock || !d.canRestore || !point || !newName || !otpOk}
            onClick={() => act('restore', 'restore', { restorePointId: point.id, newName, pointAt: point.at })}>{busy === 'restore' ? '보내는 중…' : '새 VM 으로 복원'}</button>
          <button type="button" className="logout-btn" style={{ minHeight: 38 }} disabled={lock || !otpOk || (job && (!job.marker || !job.included))}
            onClick={() => act('exclude', 'exclude', {})}>{busy === 'exclude' ? '빼는 중…' : '포탈 잡에서 빼기'}</button>
        </div>
        {msg ? <div style={{ fontSize: 12, color: msg.ok ? 'var(--green)' : 'var(--red)', overflowWrap: 'anywhere' }}>{msg.text}
          {(msg.notes || []).map((n, i) => <div key={i} className="muted">{n}</div>)}</div> : null}

        {/* 최근 요청 */}
        {d.runs.length ? (
          <div style={{ minWidth: 0 }}>
            <b style={{ fontSize: 13 }}>최근 요청</b>
            <STable className="table" minWidth={620}>
              <thead><tr><th>시각</th><th>요청자</th><th>방식</th><th>상태</th><th>내용</th></tr></thead>
              <tbody>
                {d.runs.map((r) => { const st = VM_STATE[r.state] || VM_STATE.unknown; return (
                  <tr key={r.id}>
                    <td data-sort={r.at} className="mono" title={ago(r.at)}>{shortTime(r.at)}</td><td>{r.user || '—'}</td><td>{HOW[r.how] || r.how}{r.newName ? ` → ${r.newName}` : ''}</td>
                    <td><Badge cls={st.cls}>{st.label}</Badge></td><td style={{ fontSize: 12, overflowWrap: 'anywhere' }}>{r.detail || '—'}</td>
                  </tr>
                ); })}
              </tbody>
            </STable>
          </div>
        ) : null}
      </div>
    </Modal>
  );
}
