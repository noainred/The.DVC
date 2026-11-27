/**
 * 물리서버 장애 바로 받기(Redfish 이벤트 구독 · v3.52 · 시안 ⑬) — 전체 범위 관리자 창(Bare Metal Server › 이벤트 구독). 기본 꺼짐.
 *  · 이 포탈(이 노드)의 iDRAC 등록부에만 구독을 건다 — 엣지가 맡은 서버는 그 엣지 포탈에서 건다(장비가 그 노드로 보낸다).
 *  · 받는 주소 = 장비가 닿을 수 있는 이 노드의 https 주소(경로 없이). 비밀은 화면에 보이지 않는다(새로 만들기만).
 *  · 구독 걸기 · 지우기는 장비 설정을 바꾼다 — 본인 OTP · 뒤에서 돈다(진행 중에는 3초마다 상태를 본다 — 창이 열려 있을 때만).
 *  · 받은 이벤트는 ‘지금 다시 보라’ 는 신호다(위험 · 주의면 부품 장애 점검을 바로 한 번) — 이벤트 글자로 장애를 판정하지 않는다.
 *  · 훅은 조기 return 위에 둔다 · 표는 STable · 문구에 백틱을 쓰지 않는다.
 */
import React, { useEffect, useRef, useState } from 'react';
import { Modal } from '../../../components/Modal.jsx';
import { STable } from '../../../components/STable.jsx';
import { fetchJson, putJson, postJson } from '../../../api.js';
import { opErrorText } from '../bmFoldersText.js';
import { EVT_NOTE, EVT_SYNC_STATUS, EVT_SEV_ORDER, EVT_SYNC_ORDER, evtSevLabel, syncSummary } from './powerText.js';

export default function EventSubSettings({ onClose, initial = null }) {
  const [d, setD] = useState(initial);
  const [err, setErr] = useState('');   // 처음 읽기 실패(본문 대신) — 이미 읽은 뒤의 실패는 loadErr(띠)로 · 성공하면 지운다(반증 B3)
  const [loadErr, setLoadErr] = useState('');
  const [f, setF] = useState(initial?.settings ? { enabled: !!initial.settings.enabled, base: initial.settings.base || '', rotate: false, otp: '' } : null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const timer = useRef(null);
  const dRef = useRef(initial); dRef.current = d;
  const load = () => fetchJson('/admin/bm-events').then((x) => { setD(x); setErr(''); setLoadErr(''); setF((cur) => cur || { enabled: !!x.settings?.enabled, base: x.settings?.base || '', rotate: false, otp: '' }); return x; })
    .catch((e) => { const t = opErrorText(e); if (dRef.current) setLoadErr(t); else setErr(t); return null; });
  useEffect(() => { if (!initial) load(); return () => { if (timer.current) clearTimeout(timer.current); }; }, []);   // eslint-disable-line react-hooks/exhaustive-deps
  // 뒤에서 도는 동안만 3초마다 다시 읽는다(창이 닫히면 멈춘다)
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!d?.sync?.running || initial) return undefined;
    timer.current = setTimeout(() => { load().finally(() => setTick((x) => x + 1)); }, 3000);   // 한 번 실패해도 다음 회차를 잡는다(반증 B3)
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [d, tick]);   // eslint-disable-line react-hooks/exhaustive-deps
  const otpOk = !d?.otpRequired || /^\d{6}$/.test(f?.otp || '');
  const changed = !!(d && f && (f.enabled !== !!d.settings?.enabled || f.base.trim() !== (d.settings?.base || '') || f.rotate));
  const save = async () => {
    setBusy(true); setMsg(null);
    try {
      const r = await putJson('/admin/bm-events', { enabled: f.enabled, base: f.base.trim(), rotate: f.rotate });
      if (!r || r.ok === false) throw new Error(r?.reason || '저장하지 못했습니다.');
      setMsg({ ok: true, text: `저장했습니다 — ${r.settings.enabled ? '켜짐' : '꺼짐'}.${r.rotated ? ' 비밀을 새로 만들었습니다 — 구독을 다시 걸어야 장비가 보내는 이벤트를 받습니다.' : ''}` });
      setF({ enabled: !!r.settings.enabled, base: r.settings.base || '', rotate: false, otp: f.otp });
      setD((cur) => (cur ? { ...cur, settings: r.settings, ...(r.rotated ? { sync: null } : {}) } : cur));
      await load();   // 실패해도 저장 결과 문구는 남는다(띠로 따로 — 반증 B3)
    } catch (e) { setMsg({ ok: false, text: opErrorText(e) }); } finally { setBusy(false); }
  };
  const sync = async (unsubscribe) => {
    if (!window.confirm(unsubscribe ? '이 포탈 등록부의 iDRAC 에서 이 포탈이 건 이벤트 구독을 지웁니다. 계속할까요?' : '이 포탈 등록부의 켜진 iDRAC 모두에 이벤트 구독을 겁니다(장비 설정을 바꿉니다 · 이 포탈이 건 옛 구독은 지우고 하나만 둡니다). 계속할까요?')) return;   // 걸기에도 묻는다(반증 B17)
    setBusy(true); setMsg(null);
    try {
      const r = await postJson('/admin/bm-events/sync', { unsubscribe, otp: f.otp }, { timeoutMs: 30_000 });
      if (!r || r.ok === false) throw new Error(r?.reason || '시작하지 못했습니다.');
      setMsg({ ok: true, text: unsubscribe ? '구독 지우기를 시작했습니다 — 장비마다 결과가 아래에 나옵니다.' : '구독 걸기를 시작했습니다 — 장비마다 결과가 아래에 나옵니다.' });
      setF((x) => ({ ...x, otp: '' }));
      await load();
    } catch (e) { setMsg({ ok: false, text: opErrorText(e) }); setF((x) => ({ ...x, otp: '' })); } finally { setBusy(false); }
  };
  const st = d?.status; const sy = d?.sync;
  return (
    <Modal title="장애 바로 받기 — 이벤트 구독" onClose={() => { if (!busy) onClose(); }} width={760}>
      <div className="bmd-al">
        <div className="muted bmd-note">{EVT_NOTE}</div>
        {loadErr ? <div className="bmd-note" style={{ color: 'var(--amber)' }} role="status">다시 읽지 못했습니다 — {loadErr}(아래는 지난 값 · 다음 회차에 다시 읽습니다)</div> : null}
        {err ? <div className="bmd-note" style={{ color: 'var(--red)' }}>설정을 읽지 못했습니다 — {err}</div>
          : !d || !f ? <div className="muted bmd-note">읽는 중…</div>
            : (
              <>
                {d.unreadable ? <div className="bmd-note" style={{ color: 'var(--amber)' }} role="alert">설정 파일을 읽지 못했습니다(서비스 점검에서 확인) — 꺼짐으로 보고 저장이 막힙니다.</div> : null}
                {d.edge ? <div className="muted bmd-note">이 포탈은 법인 엣지입니다 — 받은 이벤트는 이 엣지의 부품 장애 점검을 바로 돌려 중앙에 보냅니다.</div> : null}
                <fieldset className="pfe-fs" disabled={busy}>
                  <label className="pfe-on bmd-wrapline"><input type="checkbox" checked={f.enabled} onChange={(e) => setF({ ...f, enabled: e.target.checked })} /> 켜기(꺼져 있으면 장비가 보내도 받지 않습니다)</label>
                  <label className="muted bmd-pw-f">받는 주소(장비가 닿을 수 있는 이 포탈의 https 주소 — 경로 없이)
                    <input className="input" value={f.base} maxLength={200} placeholder="https://portal.example:8443" onChange={(e) => setF({ ...f, base: e.target.value })} aria-label="받는 주소" />
                  </label>
                  {d.destinationPreview ? <div className="muted bmd-note">장비에 거는 주소: <span className="mono">{d.destinationPreview}</span>(뒤는 비밀 — 화면에 보이지 않습니다)</div> : null}
                  {d.settings?.hasSecret ? <label className="pfe-on bmd-wrapline"><input type="checkbox" checked={f.rotate} onChange={(e) => setF({ ...f, rotate: e.target.checked })} /> 비밀 새로 만들기(새어 나갔을 때 — 저장 뒤 구독을 다시 걸어야 합니다)</label> : null}
                  {d.otpRequired ? <label className="muted bmd-pw-f">본인 OTP(6자리 — 구독 걸기 · 지우기)<input className="input" inputMode="numeric" autoComplete="one-time-code" value={f.otp} onChange={(e) => setF({ ...f, otp: e.target.value.replace(/\D/g, '').slice(0, 6) })} aria-label="OTP" /></label> : null}
                </fieldset>
                <div className="flex wrap gap" style={{ alignItems: 'center' }}>
                  <button type="button" className="login-btn bmd-btn" disabled={busy || !!d.unreadable || !changed} onClick={save}>{busy ? '처리 중…' : '저장'}</button>
                  <button type="button" className="logout-btn" disabled={busy || changed || !d.settings?.enabled || !otpOk || !!sy?.running} title={changed ? '먼저 저장하십시오' : ''} onClick={() => sync(false)}>구독 걸기</button>
                  <button type="button" className="logout-btn" disabled={busy || !otpOk || !!sy?.running} onClick={() => sync(true)}>구독 지우기</button>
                  <button type="button" className="logout-btn" disabled={busy} onClick={onClose}>닫기</button>
                  {msg ? <span className={msg.ok ? 'muted' : 'pfe-bad'} role={msg.ok ? 'status' : 'alert'} style={{ minWidth: 0 }}>{msg.text}</span> : null}
                </div>
                {sy ? (
                  <div className="bmd-note">
                    <b>{sy.unsubscribe ? '구독 지우기' : '구독 걸기'}</b> — {sy.running ? '진행 중…' : sy.error ? <span style={{ color: 'var(--red)' }}>{sy.error}</span> : syncSummary(sy.results)}
                    {!sy.running && Array.isArray(sy.results) && sy.results.length > 200 ? <div className="muted" style={{ fontSize: 12 }}>표는 앞 200대만 보입니다 — 나머지 {sy.results.length - 200}대는 위 줄의 상태별 수에 들어 있습니다.</div> : null}
                    {!sy.running && Array.isArray(sy.results) && sy.results.length ? (
                      <STable className="table bmd-ct" minWidth={300} limit={200}>
                        <thead><tr><th>서버</th><th>결과</th><th>내용</th></tr></thead>
                        <tbody>
                          {sy.results.map((x, i) => (
                            <tr key={`${x.id}:${i}`}>
                              <td style={{ overflowWrap: 'anywhere' }}>{x.name || x.id}</td>
                              <td data-sort={EVT_SYNC_ORDER[x.status] ?? 9}><span className={`badge ${EVT_SYNC_STATUS[x.status]?.tone || 'gray'}`}>{EVT_SYNC_STATUS[x.status]?.label || x.status}</span></td>
                              <td style={{ overflowWrap: 'anywhere', fontSize: 12 }}>{[x.removed ? `옛 구독 ${x.removed}개 지움` : '', x.message || ''].filter(Boolean).join(' · ') || '—'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </STable>
                    ) : null}
                  </div>
                ) : null}
                <div className="bmd-note"><b>받은 이벤트</b> — {st ? `${st.received}건 받음 · 거절 ${st.rejected}건${st.dropped ? ` · 한 번에 ${d?.limits?.perPost ?? '정한 수'}건이 넘어 버림 ${st.dropped}건` : ''}${st.deferred ? ` · 바로 읽기 상한(${d?.limits?.batch ?? '정한 수'}대)을 넘어 다음 정규 수집으로 미룬 서버 ${st.deferred}대` : ''}${st.unreadable ? ` · 구독 설정 · 등록부를 못 읽어 다시 보내게 한 것 ${st.unreadable}건` : ''} · 바로 점검 ${st.checks}번${st.rxAt ? ` · 마지막 ${new Date(st.rxAt).toLocaleString('ko-KR')}` : ''}(이 포탈이 다시 시작하면 0 부터 — 기록은 메모리에만)` : '—'}</div>
                {st?.recent?.length ? (
                  <STable className="table bmd-ct" minWidth={300} limit={200}>
                    <thead><tr><th>받은 시각</th><th>서버</th><th>등급</th><th>내용</th></tr></thead>
                    <tbody>
                      {st.recent.map((x, i) => (
                        <tr key={`${x.rx}:${i}`}>
                          <td data-sort={x.rx} style={{ whiteSpace: 'nowrap', fontSize: 12 }}>{new Date(x.rx).toLocaleString('ko-KR')}</td>
                          <td style={{ overflowWrap: 'anywhere' }}>{x.name || x.id}</td>
                          <td data-sort={EVT_SEV_ORDER[x.sev] ?? 9}>{evtSevLabel(x.sev)}</td>
                          <td style={{ overflowWrap: 'anywhere', fontSize: 12 }}>{[x.msgId, x.msg].filter(Boolean).join(' — ') || '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </STable>
                ) : null}
              </>
            )}
      </div>
    </Modal>
  );
}
