import React, { useEffect, useState, useCallback, useRef } from 'react';
import { fetchJson, putJson, postJson } from '../api.js';
import { Loading, ErrorBox } from '../components/ui.jsx';
import { STable } from '../components/STable.jsx';

/**
 * 호스트 접근 제어(v2.485) — 이 서버(포탈 호스트)의 SSH·웹(80/443/포탈 포트) 클라이언트 제어와 OS 방화벽 추가 규칙.
 * 엔진은 firewalld. 적용은 런타임 → N분 안에 확정하지 않으면 자동 되돌림(commit-confirm). 적용/확정에 본인 OTP.
 */
const when = (ts) => (ts ? new Date(ts).toLocaleString('ko-KR') : '—');
const listToText = (a) => (a || []).join('\n');
const textToList = (t) => String(t || '').split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);

function OtpModal({ title, onSubmit, onClose, busy }) {
  const [code, setCode] = useState('');
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 420 }} onClick={(e) => e.stopPropagation()}>
        <h3 style={{ marginTop: 0 }}>{title}</h3>
        <p className="muted" style={{ fontSize: 12.5 }}>서버 접근 경로를 바꾸는 작업입니다. 본인 OTP 코드(6자리)를 입력하세요.</p>
        <input className="input" autoFocus inputMode="numeric" placeholder="000000" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
          onKeyDown={(e) => { if (e.key === 'Enter' && code.length === 6) onSubmit(code); }} style={{ width: '100%', fontSize: 18, letterSpacing: 4, textAlign: 'center' }} />
        <div className="flex gap" style={{ marginTop: 12, justifyContent: 'flex-end' }}>
          <button className="tab" onClick={onClose} disabled={busy}>취소</button>
          <button className="login-btn" onClick={() => onSubmit(code)} disabled={busy || code.length !== 6}>{busy ? '실행 중…' : '실행'}</button>
        </div>
      </div>
    </div>
  );
}

const fromServer = (s) => ({
  sshMode: s.ssh.mode, sshAllow: listToText(s.ssh.allow), sshStop: !!s.ssh.stopService,
  webMode: s.web.mode, webAllow: listToText(s.web.allow), web80: s.web.ports.includes('80'), web443: s.web.ports.includes('443'),
  extra: s.firewall.extra.map((r) => ({ ...r, sources: listToText(r.sources) })), confirmMinutes: s.confirmMinutes,
});

export default function HostAccessSettings() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [draft, setDraft] = useState(null);   // 편집 중 설정(문자열 필드 포함)
  const [plan, setPlan] = useState(null);
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState(null);
  const [otpFor, setOtpFor] = useState(null); // 'apply' | 'confirm'
  const [now, setNow] = useState(Date.now());
  const inited = useRef(false);

  const load = useCallback(async (resetDraft = false) => {
    try {
      const d = await fetchJson('/admin/host-access');
      setData(d); setError(null);
      // 편집 폼은 최초 1회(또는 명시 리셋)만 서버값으로 채운다 — 15초 폴링이 편집 중인 값을 되돌리지 않게.
      if (!inited.current || resetDraft) { inited.current = true; setDraft(fromServer(d.draft)); }
    } catch (e) { setError(e.message); }
  }, []);
  useEffect(() => {
    load();
    const t = setInterval(() => setNow(Date.now()), 1000);
    const t2 = setInterval(() => load(), 15_000);
    return () => { clearInterval(t); clearInterval(t2); };
  }, [load]);

  if (error && !data) return <ErrorBox error={error} />;
  if (!data || !draft) return <Loading />;

  const toSettings = () => ({
    ssh: { mode: draft.sshMode, allow: textToList(draft.sshAllow), stopService: draft.sshStop },
    web: { mode: draft.webMode, allow: textToList(draft.webAllow), ports: [String(data.portalPort), ...(draft.web80 ? ['80'] : []), ...(draft.web443 ? ['443'] : [])] },
    firewall: { extra: draft.extra.map((r) => ({ ...r, sources: textToList(r.sources) })) },
    confirmMinutes: Number(draft.confirmMinutes) || 5,
  });
  const run = async (kind, otp) => {
    setBusy(kind); setMsg(null);
    try {
      if (kind === 'draft') { const r = await putJson('/admin/host-access/draft', { settings: toSettings() }); setMsg(r.ok ? { ok: true, text: '초안을 저장했습니다(적용 아님).' } : { ok: false, text: (r.errors || []).join(' / ') }); }
      else if (kind === 'plan') { const r = await postJson('/admin/host-access/plan', { settings: toSettings() }); setPlan(r); }
      else if (kind === 'apply') { const r = await postJson('/admin/host-access/apply', { settings: toSettings(), otp }); setPlan(null); setOtpFor(null); setMsg(r.ok ? { ok: true, text: r.noop ? '바꿀 것이 없어 명령을 실행하지 않았습니다(확정하면 현재 상태를 기록합니다).' : `런타임에 적용했습니다(명령 ${r.commands.length}개). ${when(r.pending.deadline)} 까지 확정하지 않으면 자동으로 되돌립니다.` } : { ok: false, text: (r.errors || [r.reason]).join(' / ') }); }
      else if (kind === 'confirm') { const r = await postJson('/admin/host-access/confirm', { otp }); setOtpFor(null); setMsg(r.ok ? { ok: true, text: `영구 설정으로 확정했습니다. ${(r.notes || []).join(' ')}` } : { ok: false, text: (r.errors || [r.reason]).join(' / ') }); }
      else if (kind === 'revert') { const r = await postJson('/admin/host-access/revert', {}); setMsg(r.ok ? { ok: true, text: '런타임 변경을 영구 설정으로 되돌렸습니다.' } : { ok: false, text: (r.errors || []).join(' / ') }); }
      await load(kind === 'apply' || kind === 'confirm');
    } catch (e) { setMsg({ ok: false, text: e.message }); if (otp) setOtpFor(null); } finally { setBusy(''); }
  };
  const addMyIp = (field) => { if (!data.requesterIp) return; const cur = textToList(draft[field]); if (!cur.includes(data.requesterIp)) setDraft({ ...draft, [field]: [...cur, data.requesterIp].join('\n') }); };
  const eng = data.engine; const cur = eng?.current;
  const pend = data.pending; const remain = pend ? Math.max(0, Math.round((pend.deadline - now) / 1000)) : 0;
  const upd = (k, v) => setDraft({ ...draft, [k]: v });
  const updExtra = (i, k, v) => upd('extra', draft.extra.map((r, j) => (j === i ? { ...r, [k]: v } : r)));

  return (
    <div>
      {pend && (
        <div className="card" style={{ marginBottom: 12, borderLeft: '4px solid var(--amber)' }}>
          <b>⏳ 확정 대기 중</b> — {when(pend.at)} 에 {pend.by || '?'} 가 런타임에 적용. <b>{Math.floor(remain / 60)}분 {remain % 60}초</b> 안에 확정하지 않으면 자동으로 되돌립니다.
          {' '}SSH 가 필요하면 다른 창에서 접속을 먼저 확인하세요.
          <div className="flex gap" style={{ marginTop: 8 }}>
            <button className="login-btn" disabled={busy !== ''} onClick={() => setOtpFor('confirm')}>✅ 확정(영구 반영, OTP)</button>
            <button className="tab" disabled={busy !== ''} onClick={() => run('revert')}>↩ 되돌리기</button>
          </div>
        </div>
      )}
      <div className="card" style={{ marginBottom: 12 }}>
        <div style={{ fontWeight: 700, marginBottom: 6 }}>엔진 상태</div>
        {eng?.ok ? (
          <div style={{ fontSize: 13, lineHeight: 1.7 }}>
            firewalld 실행 중 · 기본 존 <b>{eng.zone}</b>{cur?.active ? ' (active)' : ''} · target <b>{cur?.target}</b> · 인터페이스 {cur?.interfaces?.join(', ') || '—'}
            <div>서비스: {cur?.services?.join(', ') || '—'} · 포트: {cur?.ports?.join(', ') || '—'}</div>
            <div>sshd: <b style={{ color: data.sshdActive ? 'var(--green)' : 'var(--red)' }}>{data.sshdActive == null ? '알 수 없음' : data.sshdActive ? '실행 중' : '중지'}</b> · 내 IP <b>{data.requesterIp || '판별 불가'}</b> · 포탈 포트 {data.portalPort}
              {data.applied ? <> · 마지막 확정 {when(data.applied.at)}({data.applied.by}){data.dirty ? <span style={{ color: 'var(--amber)' }}> · 초안이 확정본과 다름</span> : ''}</> : ' · 아직 확정한 적 없음'}</div>
            {cur?.richRules?.length > 0 && (
              <details style={{ marginTop: 6 }}><summary className="muted" style={{ cursor: 'pointer' }}>현재 rich rule {cur.richRules.length}개</summary>
                <STable style={{ fontSize: 12, marginTop: 4 }}><thead><tr><th>규칙</th></tr></thead><tbody>{cur.richRules.map((r, i) => <tr key={i}><td><code>{r}</code></td></tr>)}</tbody></STable>
              </details>
            )}
          </div>
        ) : (
          <div style={{ fontSize: 13, lineHeight: 1.7 }}>
            <b style={{ color: 'var(--red)' }}>방화벽 엔진을 쓸 수 없습니다</b> — {eng?.detail || eng?.reason}
            {eng?.reason === 'sudo-denied' && (<>
              <div className="muted" style={{ marginTop: 6 }}>포탈 서비스 계정에 아래 sudoers 줄이 필요합니다(설치 스크립트 v2.485+ 가 <code>/etc/sudoers.d/vmware-portal-hostaccess</code> 로 설치). 업그레이드로 올라온 서버는 root 로 한 번 추가하세요(<code>visudo -f /etc/sudoers.d/vmware-portal-hostaccess</code>).</div>
              <pre style={{ fontSize: 12, whiteSpace: 'pre-wrap' }}>{data.sudoersHint}</pre>
            </>)}
          </div>
        )}
      </div>

      <div className="card" style={{ marginBottom: 12 }}>
        <div style={{ fontWeight: 700 }}>① SSH 접근</div>
        <div className="flex gap wrap" style={{ gap: 14, marginTop: 6, alignItems: 'center' }}>
          {[['open', '열림(모든 클라이언트)'], ['allowlist', '허용목록만'], ['deny', '완전 차단']].map(([v, l]) => (
            <label key={v} className="flex gap" style={{ alignItems: 'center', gap: 4 }}><input type="radio" name="sshMode" checked={draft.sshMode === v} onChange={() => upd('sshMode', v)} /> {l}</label>
          ))}
        </div>
        {draft.sshMode === 'allowlist' && (
          <div style={{ marginTop: 8 }}>
            <div className="muted" style={{ fontSize: 12 }}>허용 주소(IP 또는 CIDR, 줄/쉼표 구분) <button className="tab" style={{ padding: '2px 8px', fontSize: 11, marginLeft: 6 }} onClick={() => addMyIp('sshAllow')}>내 IP 추가</button></div>
            <textarea className="input" rows={4} style={{ width: '100%', fontFamily: 'monospace' }} value={draft.sshAllow} onChange={(e) => upd('sshAllow', e.target.value)} placeholder={'10.0.0.0/8\n192.168.1.10'} />
          </div>
        )}
        {draft.sshMode === 'deny' && (
          <div style={{ marginTop: 8, fontSize: 12.5 }}>
            <label className="flex gap" style={{ alignItems: 'center', gap: 6 }}><input type="checkbox" checked={draft.sshStop} onChange={(e) => upd('sshStop', e.target.checked)} /> 방화벽 차단에 더해 <b>sshd 서비스도 중지·비활성</b>(확정 단계에서 실행, 모드를 바꿔 확정하면 다시 시작)</label>
            <div style={{ color: 'var(--amber)', marginTop: 4 }}>⚠ 완전 차단 전에 콘솔(iDRAC/IPMI/vSphere 콘솔) 접근 경로를 확보하세요. 포탈이 잠기면 SSH 로도 못 들어갑니다.</div>
          </div>
        )}
      </div>

      <div className="card" style={{ marginBottom: 12 }}>
        <div style={{ fontWeight: 700 }}>② 웹(포탈 포트 {data.portalPort}{draft.web80 ? ' · 80' : ''}{draft.web443 ? ' · 443' : ''}) 접근</div>
        <div className="flex gap wrap" style={{ gap: 14, marginTop: 6, alignItems: 'center' }}>
          {[['open', '열림(모든 클라이언트)'], ['allowlist', '허용목록만']].map(([v, l]) => (
            <label key={v} className="flex gap" style={{ alignItems: 'center', gap: 4 }}><input type="radio" name="webMode" checked={draft.webMode === v} onChange={() => upd('webMode', v)} /> {l}</label>
          ))}
          <label className="flex gap" style={{ alignItems: 'center', gap: 4 }}><input type="checkbox" checked={draft.web80} onChange={(e) => upd('web80', e.target.checked)} /> 80/tcp 포함</label>
          <label className="flex gap" style={{ alignItems: 'center', gap: 4 }}><input type="checkbox" checked={draft.web443} onChange={(e) => upd('web443', e.target.checked)} /> 443/tcp 포함</label>
        </div>
        {draft.webMode === 'allowlist' && (
          <div style={{ marginTop: 8 }}>
            <div className="muted" style={{ fontSize: 12 }}>허용 주소 — <b>내 IP({data.requesterIp || '?'})가 포함돼야 적용됩니다</b>(자기 잠금 방지) <button className="tab" style={{ padding: '2px 8px', fontSize: 11, marginLeft: 6 }} onClick={() => addMyIp('webAllow')}>내 IP 추가</button></div>
            <textarea className="input" rows={4} style={{ width: '100%', fontFamily: 'monospace' }} value={draft.webAllow} onChange={(e) => upd('webAllow', e.target.value)} placeholder={'10.0.0.0/8'} />
            <div className="muted" style={{ fontSize: 11.5 }}>웹은 '완전 차단' 이 없습니다 — 포탈 자체가 잠깁니다. 중계(HAProxy) 뒤라면 중계 서버 IP 를 넣으세요(그 경우 실제 클라이언트 제어는 중계에서).</div>
          </div>
        )}
      </div>

      <div className="card" style={{ marginBottom: 12 }}>
        <div style={{ fontWeight: 700 }}>③ OS 방화벽 — 추가 규칙(기본 존 rich rule)</div>
        <div className="muted" style={{ fontSize: 12, margin: '4px 0 8px' }}>포트/프로토콜별 허용·차단. 출발지를 비우면 전체에 적용. 여기 없는 기존 존 설정(다른 서비스·포트)은 건드리지 않습니다.</div>
        <STable minWidth={720} sortable={false} style={{ fontSize: 12.5 }}>
          <thead><tr><th>포트(a 또는 a-b)</th><th>프로토콜</th><th>동작</th><th>출발지(IP/CIDR, 비우면 전체)</th><th>메모</th><th></th></tr></thead>
          <tbody>
            {draft.extra.map((r, i) => (
              <tr key={i}>
                <td><input className="input" style={{ width: 110 }} value={r.port} onChange={(e) => updExtra(i, 'port', e.target.value)} /></td>
                <td><select className="select" value={r.proto} onChange={(e) => updExtra(i, 'proto', e.target.value)}><option value="tcp">tcp</option><option value="udp">udp</option></select></td>
                <td><select className="select" value={r.action} onChange={(e) => updExtra(i, 'action', e.target.value)}><option value="accept">accept(허용)</option><option value="drop">drop(무응답 차단)</option><option value="reject">reject(거부 응답)</option></select></td>
                <td><input className="input" style={{ width: 240, fontFamily: 'monospace' }} value={r.sources} onChange={(e) => updExtra(i, 'sources', e.target.value)} placeholder="10.0.0.0/8, 192.168.1.5" /></td>
                <td><input className="input" style={{ width: 160 }} value={r.comment || ''} onChange={(e) => updExtra(i, 'comment', e.target.value)} /></td>
                <td><button className="tab" style={{ padding: '2px 8px' }} onClick={() => upd('extra', draft.extra.filter((_, j) => j !== i))}>삭제</button></td>
              </tr>
            ))}
            {!draft.extra.length && <tr><td colSpan={6} className="muted">추가 규칙 없음</td></tr>}
          </tbody>
        </STable>
        <button className="tab" style={{ marginTop: 6 }} onClick={() => upd('extra', [...draft.extra, { port: '', proto: 'tcp', action: 'accept', sources: '', comment: '' }])}>+ 규칙 추가</button>
      </div>

      <div className="card">
        <div className="flex gap wrap" style={{ alignItems: 'center', gap: 10 }}>
          <label className="flex gap" style={{ alignItems: 'center', gap: 6, fontSize: 13 }}>확정 대기(분) <input className="input" type="number" min={1} max={30} style={{ width: 70 }} value={draft.confirmMinutes} onChange={(e) => upd('confirmMinutes', e.target.value)} /></label>
          <button className="tab" disabled={busy !== ''} onClick={() => run('draft')}>초안 저장</button>
          <button className="tab" disabled={busy !== '' || !eng?.ok} onClick={() => run('plan')}>🔍 계획 보기(실행 안 함)</button>
          <button className="login-btn" disabled={busy !== '' || !eng?.ok || !!pend} onClick={() => setOtpFor('apply')}>▶ 적용(런타임, {draft.confirmMinutes || 5}분 내 확정, OTP)</button>
        </div>
        <div className="muted" style={{ fontSize: 11.5, marginTop: 6 }}>적용은 런타임에만 반영됩니다. 새 창에서 SSH/포탈 접속을 확인한 뒤 '확정' 을 눌러야 영구 설정이 됩니다. 확정하지 않으면 자동으로 되돌리며, 포탈이 재시작돼도 기한은 이어집니다.</div>
        {msg && <div style={{ marginTop: 8, fontSize: 13, color: msg.ok ? 'var(--green)' : 'var(--red)' }}>{msg.text}</div>}
        {plan && (
          <div style={{ marginTop: 10, fontSize: 12.5 }}>
            <b>계획</b>{plan.ok ? <span style={{ color: 'var(--green)' }}> — 적용 가능</span> : <span style={{ color: 'var(--red)' }}> — 적용 불가</span>}
            {(plan.errors || []).map((x, i) => <div key={`e${i}`} style={{ color: 'var(--red)' }}>✗ {x}</div>)}
            {(plan.warnings || []).map((x, i) => <div key={`w${i}`} style={{ color: 'var(--amber)' }}>⚠ {x}</div>)}
            {(plan.commands || []).length ? <pre style={{ fontSize: 12, whiteSpace: 'pre-wrap', marginTop: 6 }}>{plan.commands.map((c) => `firewall-cmd ${c.join(' ')}`).join('\n')}</pre> : <div className="muted">실행할 명령 없음(현재 상태와 동일)</div>}
          </div>
        )}
      </div>
      {otpFor && <OtpModal title={otpFor === 'apply' ? '적용(런타임)' : '확정(영구 반영)'} busy={busy !== ''} onClose={() => setOtpFor(null)} onSubmit={(code) => run(otpFor, code)} />}
    </div>
  );
}
