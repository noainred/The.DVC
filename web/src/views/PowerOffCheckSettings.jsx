import React, { useEffect, useRef, useState } from 'react';
import { fetchJson, putJson, postJson } from '../api.js';
import { Loading, ErrorBox } from '../components/ui.jsx';

const PRESETS = [1, 3, 6, 12, 24];
const when = (ts) => (ts ? new Date(ts).toLocaleString('ko-KR') : '없음');

/** 전원 꺼짐 점검(v2.484) — 특수 기능 › Optimization '꺼진 지' 의 관측 출처. 몇 시간마다 점검할지 설정. */
export default function PowerOffCheckSettings() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [enabled, setEnabled] = useState(true);
  const [hours, setHours] = useState('6');
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState(null);
  const inited = useRef(false);

  const load = async () => {
    try {
      const d = await fetchJson('/tools/waste/off-check');
      setData(d);
      if (!inited.current) { inited.current = true; setEnabled(d.settings?.enabled !== false); setHours(String(d.settings?.intervalHours ?? 6)); }
      setError(null);
    } catch (e) { setError(e.message); }
  };
  useEffect(() => { load(); const t = setInterval(load, 20_000); return () => clearInterval(t); }, []);

  if (error && !data) return <ErrorBox error={error} />;
  if (!data) return <Loading />;

  const lim = data.limits || { minHours: 1, maxHours: 168 };
  const save = async () => {
    setBusy('save'); setMsg(null);
    try {
      const h = Math.min(lim.maxHours, Math.max(lim.minHours, Math.round(Number(hours) || 6)));
      const r = await putJson('/tools/waste/off-check/settings', { enabled, intervalHours: h });
      setHours(String(r.settings.intervalHours)); setEnabled(r.settings.enabled);
      setMsg({ ok: true, text: `저장됨 — ${r.settings.enabled ? `${r.settings.intervalHours}시간마다 점검` : '점검 꺼짐'}(재시작 없이 다음 틱부터 적용)` });
      load();
    } catch (e) { setMsg({ ok: false, text: e.message }); } finally { setBusy(''); }
  };
  const runNow = async () => {
    setBusy('run'); setMsg(null);
    try {
      const r = await postJson('/tools/waste/off-check/run', {});
      setMsg(r.ok ? { ok: true, text: `점검 완료 — 꺼진 VM ${r.offVms}대(새 구간 ${r.newStreaks} · 해제 ${r.cleared}) · ${r.ms}ms` } : { ok: false, text: r.reason || '실패' });
      load();
    } catch (e) { setMsg({ ok: false, text: e.message }); } finally { setBusy(''); }
  };
  const lr = data.lastResult;
  return (
    <div>
      <div className="card" style={{ marginBottom: 12 }}>
        <div style={{ fontWeight: 700, marginBottom: 6 }}>전원 꺼짐 점검 주기</div>
        <p className="muted" style={{ fontSize: 12.5, lineHeight: 1.6, margin: '0 0 10px' }}>
          설정한 시간마다 현재 스냅샷의 <b>전원 꺼진 VM</b> 을 기록해, 특수 기능 › Optimization › 전원 꺼짐 표의 <b>'꺼진 지 N일'</b> 에 씁니다.
          처음 꺼진 것으로 보이면 그 시각을 '현재 꺼짐 구간의 시작' 으로 남기고, 다시 켜지면 지웁니다. 실제 꺼진 시각은 직전 점검과 그 점검 사이이므로
          정밀도는 점검 주기와 같습니다(화면엔 '≥ N일 · 점검' 하한으로 표시, vCenter 전원 이벤트가 있으면 그쪽이 정확값으로 우선).
          vCenter 를 다시 조회하지 않고 스냅샷만 읽으므로 자주 돌려도 부하가 거의 없습니다.
        </p>
        <div className="flex gap wrap" style={{ alignItems: 'center', gap: 12 }}>
          <label className="flex gap" style={{ alignItems: 'center', gap: 6 }}>
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> 점검 사용
          </label>
          <label className="flex gap" style={{ alignItems: 'center', gap: 6 }}>
            주기(시간)
            <input className="input" style={{ width: 90 }} type="number" min={lim.minHours} max={lim.maxHours} value={hours} onChange={(e) => setHours(e.target.value)} />
          </label>
          <div className="flex gap" style={{ gap: 4 }}>
            {PRESETS.map((h) => <button key={h} className={Number(hours) === h ? 'login-btn' : 'tab'} style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => setHours(String(h))}>{h}시간</button>)}
          </div>
          <button className="login-btn" disabled={busy !== ''} onClick={save}>{busy === 'save' ? '저장 중…' : '저장'}</button>
          <button className="tab" disabled={busy !== ''} onClick={runNow}>{busy === 'run' ? '점검 중…' : '지금 점검'}</button>
        </div>
        <div className="muted" style={{ fontSize: 11.5, marginTop: 6 }}>허용 범위 {lim.minHours}~{lim.maxHours}시간. 기본 6시간.</div>
        {msg && <div style={{ marginTop: 8, fontSize: 12.5, color: msg.ok ? 'var(--green)' : 'var(--red)' }}>{msg.text}</div>}
      </div>
      <div className="card">
        <div style={{ fontWeight: 700, marginBottom: 6 }}>최근 점검</div>
        {lr ? (
          <div style={{ fontSize: 13, lineHeight: 1.7 }}>
            <div>시각 <b>{when(lr.at)}</b> · 실행 {lr.trigger === 'auto' ? '자동' : '수동'} · vCenter {lr.vcenters}개 · 소요 {lr.ms}ms</div>
            <div>꺼진 VM <b>{lr.offVms}</b>대 · 새 꺼짐 구간 {lr.newStreaks}대 · 다시 켜짐/삭제로 해제 {lr.cleared}대</div>
            <div className="muted">다음 자동 점검 {data.nextRunTs ? when(data.nextRunTs) : (data.settings?.enabled ? '첫 틱에' : '꺼짐')}</div>
          </div>
        ) : <div className="muted" style={{ fontSize: 13 }}>이 프로세스에서 아직 점검하지 않았습니다{data.lastRunTs ? ` (마지막 기록 ${when(data.lastRunTs)})` : ''}. 기동 후 첫 주기에 자동으로 돌거나 '지금 점검' 을 누르세요.</div>}
      </div>
    </div>
  );
}
