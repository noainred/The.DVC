// IpamReport.jsx — IP 관리 › 설정 › '정기 보고'(IPMS 알람 · v3.7.0 재설계 묶음 라 — 시안 ⑫ AlertSettings · ⑬ AlertMail).
// 기본 매주 일요일 09:00 · 전체 종합 + 법인별(받는 사람을 정한 법인). 기준 시각 — 메인 서버 / 법인 현지(법인별 시간대 칸 — 중앙은 엣지 시간대를 모른다).
// 저장 검사 · 회차 · 내용은 서버(/admin/ipam/report — ipam/report*.js). 무거운 미리 보기는 누를 때만 만든다(폴링하지 않는다).
import React, { useEffect, useState } from 'react';
import { fetchJson, putJson, postJson } from '../../api.js';
import { Loading, ErrorBox } from '../../components/ui.jsx';
import { STable } from '../../components/STable.jsx';
import { fmtDt } from './ipamShared.jsx';
import { CLOCK_LABEL, DAY_LABELS, FREQ_LABEL, HISTORY_STATE, bodyOf, formOf, scheduleText, targetText } from './ipamReportText.js';

export function IpamReport() {
  const [d, setD] = useState(undefined);
  const [err, setErr] = useState(null);
  const [f, setF] = useState(null);
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState('');
  const [pv, setPv] = useState(null);
  const [pvPick, setPvPick] = useState('overall');
  const load = () => fetchJson('/admin/ipam/report').then((r) => { setD(r); setF(formOf(r.report || {})); }).catch((e) => setErr(e));
  useEffect(() => { load(); }, []);
  if (err) return <ErrorBox message={err} />;
  if (d === undefined || !f) return <Loading />;
  const set = (patch) => setF((x) => ({ ...x, ...patch }));
  const setCorp = (id, patch) => setF((x) => ({ ...x, corps: { ...x.corps, [id]: { toText: '', tz: '', ...(x.corps[id] || {}), ...patch } } }));
  const corpName = Object.fromEntries((d.datacenters || []).map((c) => [c.id, c.name]));
  const save = async () => {
    setBusy('save'); setMsg(null);
    try {
      const r = await putJson('/admin/ipam/report', { report: bodyOf(f) });
      if (r?.ok) { setMsg({ ok: true, text: '저장했습니다.' }); setD((x) => ({ ...x, report: r.report, status: r.status })); setF(formOf(r.report)); }
      else setMsg({ ok: false, text: r?.reason || '저장하지 못했습니다.' });
    } catch (e) { setMsg({ ok: false, text: e?.message || '저장하지 못했습니다.' }); }
    setBusy('');
  };
  const preview = async () => {
    setBusy('preview'); setMsg(null);
    try {
      const r = await postJson('/admin/ipam/report/preview', { report: bodyOf(f) });
      if (r?.ok) { setPv(r); setPvPick('overall'); } else setMsg({ ok: false, text: r?.reason || '미리 보기를 만들지 못했습니다.' });
    } catch (e) { setMsg({ ok: false, text: e?.message || '미리 보기를 만들지 못했습니다.' }); }
    setBusy('');
  };
  const sendNow = async () => {
    if (!window.confirm('지금 저장된 설정으로 전체 종합 메일을 보냅니다. 보낼까요?')) return;
    setBusy('send'); setMsg(null);
    try {
      const r = await postJson('/admin/ipam/report/send-now', { target: 'overall' });
      const x = (r?.results || [])[0];
      setMsg({ ok: !!r?.ok, text: r?.ok ? '보냈습니다.' : (x?.reason || '보내지 못했습니다.') });
      if (r?.status) setD((y) => ({ ...y, status: r.status }));
    } catch (e) { setMsg({ ok: false, text: e?.message || '보내지 못했습니다.' }); }
    setBusy('');
  };
  const st = d.status || {};
  const pvMail = pv ? (pvPick === 'overall' ? pv.overall : pv.corps.find((c) => c.id === pvPick)) : null;
  return (
    <section className="card" style={{ padding: 14, minWidth: 0 }} aria-label="정기 보고">
      <b style={{ fontSize: 15 }}>정기 보고(IPMS 알람)</b>
      <div className="muted" style={{ fontSize: 12, margin: '2px 0 10px' }}>법인별 IP 사용 변화(새 미등록 IP · MAC 변경 · 충돌 의심 · 대역 사용률 · 가득 찬 대역 · 수집 상태)를 정한 요일 · 시각에 메일로 보냅니다. 전체 종합 한 통 + 받는 사람을 정한 법인마다 한 통. 놓친 회차는 몰아서 보내지 않습니다.</div>
      {d.settingsError && <div className="banner warn" style={{ marginBottom: 8 }}>설정 파일을 읽지 못했습니다({d.settingsError.reason}) — 보내지 않습니다. 손상본은 옆에 보존했습니다.</div>}
      {st.edge && <div className="banner warn" style={{ marginBottom: 8 }}>엣지는 정기 보고를 보내지 않습니다(메인만 보냅니다).</div>}
      <div className="ipam-rep-grid">
        <label className="muted">보내기</label>
        <label className="flex gap" style={{ alignItems: 'center' }}><input type="checkbox" checked={f.enabled} onChange={(e) => set({ enabled: e.target.checked })} /> 켜기 <span className="muted" style={{ fontSize: 12 }}>— {scheduleText(f)}</span></label>
        <label className="muted">주기</label>
        <div className="flex gap wrap" style={{ alignItems: 'center' }}>
          {Object.entries(FREQ_LABEL).map(([k, l]) => <button key={k} type="button" className={`tab${f.freq === k ? ' active' : ''}`} aria-pressed={f.freq === k} style={{ flex: 'none', padding: '4px 11px', fontSize: 12 }} onClick={() => set({ freq: k })}>{l}</button>)}
          {f.freq === 'weekly' && DAY_LABELS.map((l, i) => {
            const on = f.days.includes(i);
            return <button key={i} type="button" className={`tab${on ? ' active' : ''}`} aria-pressed={on} style={{ flex: 'none', padding: '3px 8px', fontSize: 12 }} onClick={() => set({ days: on ? f.days.filter((x) => x !== i) : [...f.days, i].sort() })}>{l}</button>;
          })}
          <input className="input" type="time" aria-label="보내는 시각" value={f.time} onChange={(e) => set({ time: e.target.value })} style={{ width: 135 }} />
        </div>
        <label className="muted">기준 시각</label>
        <div className="flex gap wrap" style={{ alignItems: 'center' }}>
          {Object.entries(CLOCK_LABEL).map(([k, l]) => <label key={k} className="flex gap" style={{ alignItems: 'center', fontSize: 13 }}><input type="radio" name="ipam-rep-clock" checked={f.clock === k} onChange={() => set({ clock: k })} />{l}</label>)}
          <span className="muted" style={{ fontSize: 11.5 }}>{f.clock === 'corp' ? '법인마다 아래 시간대의 그 요일 · 시각에 보냅니다(시간대가 비면 메인 서버 시각). 전체 종합은 메인 서버 시각입니다.' : '전체 종합과 법인 메일을 메인 서버 시각에 함께 보냅니다.'}</span>
        </div>
        <label className="muted">넣을 내용</label>
        <div className="flex gap wrap">
          {(d.sections || []).map(([k, l]) => <label key={k} className="flex gap" style={{ alignItems: 'center', fontSize: 12.5 }}><input type="checkbox" checked={f.sections[k] !== false} onChange={(e) => set({ sections: { ...f.sections, [k]: e.target.checked } })} />{l}</label>)}
        </div>
        <label className="muted">가득 찬 대역</label>
        <span className="flex gap" style={{ alignItems: 'center' }}><input className="input" type="number" min={50} max={100} aria-label="가득 찬 대역 기준(%)" value={f.fullPct} onChange={(e) => set({ fullPct: e.target.value })} style={{ width: 80 }} /><span className="muted">% 이상(점유 = 대장 + 예약 + DHCP)</span></span>
        <label className="muted">전체 종합 받는 사람</label>
        <div style={{ minWidth: 0 }}>
          <label className="flex gap" style={{ alignItems: 'center', fontSize: 13 }}><input type="checkbox" checked={f.includeAdmin} onChange={(e) => set({ includeAdmin: e.target.checked })} />통합 관리자(설정 › 메일 발송의 기본 받는 사람)</label>
          <input className="input" aria-label="전체 종합 추가 받는 사람" placeholder="추가 주소 — 쉼표로 구분" value={f.toText} onChange={(e) => set({ toText: e.target.value })} style={{ width: '100%', boxSizing: 'border-box', marginTop: 4 }} />
        </div>
      </div>
      <h4 style={{ margin: '14px 0 6px', fontSize: 13.5 }}>법인별 받는 사람{f.clock === 'corp' ? ' · 시간대' : ''}</h4>
      <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>받는 사람이 없는 법인은 전체 종합에만 실립니다. 법인 메일에는 그 법인 것만 싣습니다.</div>
      <STable className="v3-table" minWidth={620}>
        <thead><tr><th>법인</th><th>vCenter</th><th>받는 사람</th>{f.clock === 'corp' && <th>시간대(IANA)</th>}</tr></thead>
        <tbody>
          {(d.datacenters || []).map((c) => (
            <tr key={c.id}>
              <td data-sort={c.name}>{c.name}</td>
              <td className="muted" style={{ fontSize: 12, whiteSpace: 'normal' }}>{c.vcenters.join(', ') || '—'}</td>
              <td style={{ minWidth: 220 }}><input className="input" aria-label={`${c.name} 받는 사람`} placeholder="주소 — 쉼표로 구분" value={f.corps[c.id]?.toText || ''} onChange={(e) => setCorp(c.id, { toText: e.target.value })} style={{ width: '100%', boxSizing: 'border-box' }} /></td>
              {f.clock === 'corp' && <td><input className="input" aria-label={`${c.name} 시간대`} placeholder="예: Europe/Warsaw" value={f.corps[c.id]?.tz || ''} onChange={(e) => setCorp(c.id, { tz: e.target.value })} style={{ width: 170 }} /></td>}
            </tr>
          ))}
          {!(d.datacenters || []).length && <tr><td colSpan={4} className="center muted" style={{ padding: 14 }}>등록된 법인(DataCenter)이 없습니다 — 전체 종합만 보냅니다.</td></tr>}
        </tbody>
      </STable>
      <div className="flex gap wrap" style={{ alignItems: 'center', marginTop: 12 }}>
        <button className="login-btn" style={{ flex: 'none', padding: '7px 16px' }} disabled={!!busy || !!d.settingsError} onClick={save}>{busy === 'save' ? '저장 중…' : '저장'}</button>
        <button className="logout-btn" style={{ padding: '7px 14px' }} disabled={!!busy} onClick={preview}>{busy === 'preview' ? '만드는 중…' : '미리 보기'}</button>
        <button className="logout-btn" style={{ padding: '7px 14px' }} disabled={!!busy || !!d.settingsError} onClick={sendNow}>{busy === 'send' ? '보내는 중…' : '지금 보내기(전체 종합)'}</button>
        {msg && <span style={{ fontSize: 12.5, color: msg.ok ? 'var(--green)' : 'var(--red)' }}>{msg.text}</span>}
      </div>
      <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
        다음 발송(메인 서버 시각): {st.enabled && (st.next || []).length ? st.next.map((t) => fmtDt(t)).join(' · ') : '꺼짐'} · 전체 종합 받는 사람 {st.overallRecipients ?? 0}명
      </div>
      {pv && (
        <div className="card" style={{ padding: 10, marginTop: 12, minWidth: 0 }}>
          <div className="flex gap wrap" style={{ alignItems: 'center', marginBottom: 6 }}>
            <b style={{ fontSize: 13 }}>미리 보기</b>
            <button type="button" className={`tab${pvPick === 'overall' ? ' active' : ''}`} style={{ flex: 'none', padding: '3px 9px', fontSize: 12 }} onClick={() => setPvPick('overall')}>전체 종합</button>
            {pv.corps.map((c) => <button key={c.id || 'none'} type="button" className={`tab${pvPick === c.id ? ' active' : ''}`} style={{ flex: 'none', padding: '3px 9px', fontSize: 12 }} onClick={() => setPvPick(c.id)}>{c.name}{c.mock ? '(데모)' : ''}</button>)}
            {pv.demoCorps > 0 && <span className="muted" style={{ fontSize: 11.5 }}>데모 법인 {pv.demoCorps}곳은 실제 메일에 넣지 않습니다.</span>}
          </div>
          {pvMail && <><div style={{ fontSize: 12.5, marginBottom: 6 }}>제목: <b>{pvMail.subject}</b></div>
            <iframe title="보고 메일 미리 보기" sandbox="" srcDoc={pvMail.html} style={{ width: '100%', height: 420, border: '1px solid var(--border)', borderRadius: 6, background: '#fff' }} /></>}
        </div>
      )}
      <h4 style={{ margin: '14px 0 6px', fontSize: 13.5 }}>발송 기록</h4>
      {(st.history || []).length === 0 ? <div className="muted" style={{ fontSize: 12 }}>기록이 없습니다.</div> : (
        <STable className="v3-table" minWidth={560} limit={40}>
          <thead><tr><th>시각</th><th>대상</th><th>결과</th><th>내용</th></tr></thead>
          <tbody>
            {st.history.map((h, i) => (
              <tr key={i}>
                <td data-sort={h.at} style={{ fontSize: 12 }}>{fmtDt(h.at)}</td>
                <td>{targetText(h.target, corpName)}{h.kind === 'manual' ? <span className="muted"> (지금 보내기)</span> : null}</td>
                <td data-sort={h.state}><span className={`badge ${HISTORY_STATE[h.state]?.tone || 'gray'}`}>{HISTORY_STATE[h.state]?.label || h.state}</span></td>
                <td style={{ whiteSpace: 'normal', fontSize: 12 }}>{h.reason || (h.to != null ? `받는 사람 ${h.to}명` : '—')}</td>
              </tr>
            ))}
          </tbody>
        </STable>
      )}
    </section>
  );
}
