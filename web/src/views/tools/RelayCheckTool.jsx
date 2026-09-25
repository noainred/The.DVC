import React, { useEffect, useState } from 'react';
import { fetchJson, postJson, putJson } from '../../api.js';
import { agoText } from './relTime.js';
import { Loading, ErrorBox, Kpi } from '../../components/ui.jsx';
import { STable } from '../../components/STable.jsx';
import { blankOr } from '../blankOr.js';

/**
 * HAProxy 경로 점검(v2.429, 사용자 요구 '특수기능에 haproxy 설정을 주기적으로 점검해서 알람으로 알려주고 해결방안도 제시').
 * 구성도: 중앙 → Edge DVC(HAProxy :4000/4065/4066/4067/4068/4001) → IRS. 호스트 × 포트 프로파일로 대상을 자동 생성해 주기 점검하고,
 * 실패 시 원인 후보·조치·haproxy.cfg 예시를 보여준다. 상태 전이(연속 N회)에 알림 채널로 발화한다.
 */
// v2.613 DEPS2613-11: 상대시각은 공용 코어 relTime.agoText 하나다(로컬 ago 사본 제거).
const PHASE = { ok: '정상', refused: '리스너 없음', timeout: '무응답', unreach: '경로 없음', tls: 'TLS 무응답', http: 'HTTP 무응답', identity: '대상 불일치', auth: '토큰 거부', hq: '중앙 아님', banner: 'SSH 아님', unknown: '오류' };

export default function RelayCheckTool() {
  // ⚠ 훅은 전부 조기 return 위에(React #310 회귀 방지).
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [form, setForm] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [open, setOpen] = useState(null);      // 펼친 결과 key
  const [newHost, setNewHost] = useState('');
  const [newProfile, setNewProfile] = useState({ port: '', kind: 'irs-portal' });

  const load = async () => {
    try { const d = await fetchJson('/tools/relaycheck'); setData(d); setForm((f) => f || d.settings); setError(null); }
    catch (e) { setError(e.message); }
  };
  useEffect(() => { load(); const t = setInterval(load, 15_000); return () => clearInterval(t); }, []);

  if (error && !data) return <ErrorBox message={error} />;
  if (!data || !form) return <Loading />;

  const set = (k, v) => setForm((p) => ({ ...p, [k]: v }));
  // v2.604(감사 LEFT2604-02): 빈 칸은 보내지 않는다(undefined → JSON 에서 빠진다) — `Number('')*1000 = 0` 이 저장값을
  //   기본값으로 떨어뜨렸다. 서버도 빈 값·0 을 '미지정(이전 값 유지)' 으로 받는다.
  const secToMs = (v) => { const n = blankOr(v); return n == null ? undefined : n * 1000; };
  const secText = (ms) => (ms == null ? '' : Math.round(ms / 1000));
  const save = async () => {
    setBusy(true); setMsg(null);
    try { const r = await putJson('/tools/relaycheck/settings', form); if (r.ok === false) throw new Error(r.reason); setForm(r.settings); setMsg('저장되었습니다. 다음 점검부터 적용됩니다.'); await load(); }
    catch (e) { setMsg(`저장 실패: ${e.message}`); }
    finally { setBusy(false); }
  };
  const runNow = async () => {
    setBusy(true); setMsg(null);
    try { const r = await postJson('/tools/relaycheck/run', {}); setMsg(r.ok ? `점검 완료 — 대상 ${r.total} · 정상 ${r.ok === true ? r.ok : r.ok} · 실패 ${r.fail} (${Math.round((r.durationMs || 0) / 1000)}초)` : `점검 실패: ${r.reason}`); await load(); }
    catch (e) { setMsg(`점검 실패: ${e.message}`); }
    finally { setBusy(false); }
  };
  const results = data.results || [];
  const failN = results.filter((r) => !r.ok).length;
  const L = data.limits;
  const kinds = data.kinds || {};

  return (
    <div>
      <div className="card" style={{ marginBottom: 12, fontSize: 13, lineHeight: 1.7 }}>
        <b>무엇을 점검하나</b> — 중앙이 각 중계 엣지(Edge DVC) 호스트의 포워딩 포트에 직접 접속해 단계별로 확인합니다:
        TCP(리스너/방화벽) → 프로토콜(SSH 배너 · TLS/HTTP · 포탈 ping) → <b>정체 대조</b>(IRS 포트가 IRS 에 닿는지, 중계 엣지 자신으로 되돌아오지 않는지,
        HQ 포트가 이 중앙에 닿는지). 호스트는 수집 서버 URL 에서 자동으로 뽑고(아래 '수동 호스트'로 추가 가능), 포트 프로파일은 모든 호스트에 같이 적용됩니다.
        연속 {form.failStreak}회 실패하면 알림 채널(설정 › 알림)로 발화하고 복구 시 한 번 더 알립니다. 실패 행을 펼치면 원인 후보·조치·haproxy.cfg 예시가 보입니다.
        <div className="muted" style={{ marginTop: 4 }}>정직한 한계: 중앙에서 보이는 결과만 판정합니다(중계 엣지 내부의 haproxy 로그는 읽지 않음). '무응답'은 방화벽·경로·호스트 다운을 구분하지 못하므로 조치 목록의 순서대로 확인하세요.</div>
      </div>

      <div className="kpis" style={{ marginBottom: 12, gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))' }}>
        <Kpi label="점검 대상" value={(data.targets || []).length} meta={`호스트 ${new Set((data.targets || []).map((t) => t.host)).size} × 프로파일 ${form.profile.length}`} />
        <Kpi label="정상" value={results.filter((r) => r.ok).length} accent="var(--green)" />
        <Kpi label="실패" value={failN} accent={failN ? 'var(--red)' : 'var(--green)'} />
        <Kpi label="마지막 점검" value={agoText(data.last?.at)} meta={data.busy ? '진행 중' : data.last?.durationMs ? `${Math.round(data.last.durationMs / 1000)}초 소요` : ''} />
      </div>

      <div className="card" style={{ marginBottom: 12 }}>
        <label className="flex gap" style={{ alignItems: 'center', fontSize: 14, marginBottom: 10 }}>
          <input type="checkbox" checked={form.enabled} onChange={(e) => set('enabled', e.target.checked)} /><b>주기 점검 사용</b>
          <span className="muted" style={{ fontSize: 12 }}>(꺼도 '지금 점검'은 됩니다)</span>
        </label>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 12 }}>
          <label style={{ fontSize: 12 }}>점검 주기(초)<input className="input" type="number" min={L.intervalMs.min / 1000} max={L.intervalMs.max / 1000} value={secText(form.intervalMs)} onChange={(e) => set('intervalMs', secToMs(e.target.value))} /></label>
          <label style={{ fontSize: 12 }}>대상당 타임아웃(초)<input className="input" type="number" min={L.timeoutMs.min / 1000} max={L.timeoutMs.max / 1000} value={secText(form.timeoutMs)} onChange={(e) => set('timeoutMs', secToMs(e.target.value))} /></label>
          <label style={{ fontSize: 12 }} title="이 횟수만큼 연속 실패해야 알림을 보냅니다(일시적 흔들림 무시).">알림 연속 실패 횟수<input className="input" type="number" min={L.failStreak.min} max={L.failStreak.max} value={form.failStreak ?? ''} onChange={(e) => set('failStreak', blankOr(e.target.value))} /></label>
          <label className="flex gap" style={{ alignItems: 'center', fontSize: 12 }}><input type="checkbox" checked={form.autoHosts} onChange={(e) => set('autoHosts', e.target.checked)} />수집 서버 URL 호스트 자동 포함</label>
          <label className="flex gap" style={{ alignItems: 'center', fontSize: 12 }}><input type="checkbox" checked={form.alerts} onChange={(e) => set('alerts', e.target.checked)} />상태 전이 알림 발화</label>
        </div>
        <div style={{ marginTop: 10, fontSize: 12 }}>
          <b>포트 프로파일</b> <span className="muted">(모든 중계 엣지 호스트에 공통 적용)</span>
          <div className="flex gap wrap" style={{ marginTop: 6 }}>
            {form.profile.map((p, i) => (
              <span key={`${p.port}-${i}`} className="badge blue" title={kinds[p.kind]?.desc || ''} style={{ cursor: 'default' }}>
                :{p.port} {kinds[p.kind]?.label || p.kind}
                <button type="button" className="tab" style={{ marginLeft: 6, padding: '0 6px' }} onClick={() => set('profile', form.profile.filter((_, j) => j !== i))} title="이 포트를 프로파일에서 제거">✕</button>
              </span>
            ))}
            <input className="input" style={{ width: 90 }} placeholder="포트" value={newProfile.port} onChange={(e) => setNewProfile({ ...newProfile, port: e.target.value })} />
            <select className="input" style={{ width: 170 }} value={newProfile.kind} onChange={(e) => setNewProfile({ ...newProfile, kind: e.target.value })}>
              {Object.entries(kinds).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
            </select>
            <button className="tab" style={{ flex: 'none' }} onClick={() => { const port = Number(newProfile.port); if (port > 0) { set('profile', [...form.profile, { port, kind: newProfile.kind }]); setNewProfile({ port: '', kind: newProfile.kind }); } }}>추가</button>
            <button className="tab" style={{ flex: 'none' }} onClick={() => set('profile', data.defaultProfile)} title="구성도 기본값(4000/4065/4066/4067/4068/4001)으로 되돌립니다">기본값</button>
          </div>
          <div style={{ marginTop: 8 }}><b>수동 호스트</b> <span className="muted">(수집 서버에 없는 중계 엣지)</span>
            <div className="flex gap wrap" style={{ marginTop: 4 }}>
              {form.hosts.map((h, i) => <span key={h.host} className="badge gray">{h.host}{h.label ? ` (${h.label})` : ''}<button type="button" className="tab" style={{ marginLeft: 6, padding: '0 6px' }} onClick={() => set('hosts', form.hosts.filter((_, j) => j !== i))}>✕</button></span>)}
              <input className="input" style={{ width: 220 }} placeholder="IP 또는 호스트명" value={newHost} onChange={(e) => setNewHost(e.target.value)} />
              <button className="tab" style={{ flex: 'none' }} onClick={() => { if (newHost.trim()) { set('hosts', [...form.hosts, { host: newHost.trim() }]); setNewHost(''); } }}>추가</button>
            </div>
          </div>
        </div>
        <div className="flex gap" style={{ marginTop: 12, alignItems: 'center' }}>
          <button className="login-btn" style={{ flex: 'none', padding: '8px 18px' }} disabled={busy} onClick={save}>저장</button>
          <button className="tab" style={{ flex: 'none', padding: '8px 14px' }} disabled={busy || data.busy} onClick={runNow}>🔎 지금 점검</button>
          {msg && <span className="muted" style={{ fontSize: 12 }}>{msg}</span>}
        </div>
      </div>

      <div className="table-wrap">
        <STable>
          <thead><tr><th>사이트</th><th>호스트</th><th>포트</th><th>종류</th><th>기대 대상</th><th>상태</th><th>결과</th><th>응답(ms)</th><th>마지막 정상</th><th>점검</th></tr></thead>
          <tbody>
            {results.length === 0 && <tr><td colSpan={10} className="center muted" style={{ padding: 20 }}>{(data.targets || []).length ? '아직 점검 전입니다 — "지금 점검"을 누르세요.' : '점검 대상이 없습니다 — 수집 서버를 등록하거나 수동 호스트를 추가하세요.'}</td></tr>}
            {results.map((r) => (
              <React.Fragment key={r.target.key}>
                <tr style={{ cursor: r.ok ? 'default' : 'pointer', background: r.ok ? undefined : 'rgba(239,68,68,.08)' }} onClick={() => !r.ok && setOpen(open === r.target.key ? null : r.target.key)}>
                  <td>{r.target.site || <span className="muted">—</span>}</td>
                  <td><code>{r.target.host}</code></td>
                  <td data-sort={r.target.port}>:{r.target.port}</td>
                  <td title={kinds[r.target.kind]?.desc || ''}>{r.target.label}</td>
                  <td className="muted">{r.target.expectAgent || (r.target.kind === 'hq-portal' ? '이 중앙' : '—')}</td>
                  <td data-sort={r.ok ? 1 : 0}><span className={`badge ${r.ok ? 'green' : 'red'}`}>{PHASE[r.phase] || r.phase}</span>{!r.ok && r.failStreak > 1 ? <span className="muted" style={{ fontSize: 10.5, marginLeft: 4 }}>연속 {r.failStreak}</span> : null}{r.alerted ? <span className="badge amber" style={{ marginLeft: 4, fontSize: 10 }}>알림됨</span> : null}</td>
                  <td style={{ fontSize: 12, maxWidth: 360, whiteSpace: 'normal' }}>{r.ok ? <span className="muted">{r.detail}</span> : <span style={{ color: 'var(--red)' }}>{r.error}</span>}</td>
                  <td data-sort={r.ms}>{r.ms ?? '—'}</td>
                  <td>{agoText(r.lastOkAt)}</td>
                  <td>{agoText(r.at)}</td>
                </tr>
                {!r.ok && open === r.target.key && r.remedy && (
                  <tr><td colSpan={10} style={{ background: 'rgba(245,158,11,.06)' }}>
                    <div style={{ fontSize: 13, lineHeight: 1.7 }}>
                      <div><b>💡 {r.remedy.title}</b></div>
                      <div>원인 후보: {r.remedy.cause}</div>
                      <ol style={{ margin: '4px 0 4px 18px' }}>{r.remedy.steps.map((s, i) => <li key={i}><code style={{ whiteSpace: 'pre-wrap' }}>{s}</code></li>)}</ol>
                      {r.remedy.haproxy && <pre style={{ fontSize: 11.5, margin: '4px 0 0', whiteSpace: 'pre-wrap' }}>{r.remedy.haproxy}</pre>}
                    </div>
                  </td></tr>
                )}
              </React.Fragment>
            ))}
          </tbody>
        </STable>
      </div>
    </div>
  );
}
