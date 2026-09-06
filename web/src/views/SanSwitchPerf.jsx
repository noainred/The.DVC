import React, { useEffect, useState } from 'react';
import { fetchJson, putJson, postJson } from '../api.js';
import { Loading, ErrorBox } from '../components/ui.jsx';

/**
 * 설정 › 수집 서버 › SAN 스위치 포트 사용량 수집(v2.411, 사용자 요구
 * '설정에서 주기적으로 portperfshow 를 수행해서 포트 사용량 수집하는 DB').
 *
 * 기본은 **꺼짐**이다 — 운영 중인 SAN 스위치에 주기적으로 SSH 세션을 붙이는 동작이라,
 * 관리자가 명시적으로 켜야 시작한다.
 */
export default function SanSwitchPerf() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [form, setForm] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  const load = async () => {
    try { const d = await fetchJson('/tools/sanswitch/perf/settings'); setData(d); setForm((f) => f || d.settings); setError(null); }
    catch (e) { setError(e.message); }
  };
  useEffect(() => { load(); const t = setInterval(load, 20_000); return () => clearInterval(t); }, []);

  if (error && !data) return <ErrorBox message={error} />;
  if (!data || !form) return <Loading />;

  const L = data.limits;
  const set = (k, v) => setForm((p) => ({ ...p, [k]: v }));
  const save = async () => {
    setBusy(true); setMsg(null);
    try { const r = await putJson('/tools/sanswitch/perf/settings', form); setData(r); setForm(r.settings); setMsg('저장되었습니다.'); }
    catch (e) { setMsg(`저장 실패: ${e.message}`); }
    finally { setBusy(false); }
  };
  const runNow = async () => {
    setBusy(true); setMsg(null);
    try {
      const r = await postJson('/tools/sanswitch/perf/collect', {});
      setMsg(r.ok ? `수집 완료 — 성공 ${r.collected} / 실패 ${r.failed}${r.errors?.length ? ` · ${r.errors.join(' / ')}` : ''}` : `수집 실패: ${r.reason}`);
      await load();
    } catch (e) { setMsg(`수집 실패: ${e.message}`); }
    finally { setBusy(false); }
  };

  const db = data.db || {};
  const st = data.status || {};
  const fmtTs = (t) => (t ? new Date(t).toLocaleString() : '—');

  return (
    <>
      <div className="section-title" style={{ marginTop: 0 }}>📊 SAN 스위치 포트 사용량 수집</div>

      <div className="card" style={{ marginBottom: 12, fontSize: 13, lineHeight: 1.7 }}>
        등록된 Brocade 스위치에 주기적으로 접속해 <code>portperfshow</code> 를 실행하고, 포트별 처리량을
        전용 DB(<code>sanswitch-perf.db</code>)에 시계열로 쌓습니다. 쌓인 데이터는
        특수기능 › SAN 스위치 모니터링의 포트 상세에서 <b>차트</b>로 보고, 연결된 스토리지별로 합산해
        <b> 어느 어레이가 얼마나 쓰이는지</b> 분석할 수 있습니다.
        <div className="muted" style={{ marginTop: 6 }}>
          • 기본은 <b>꺼짐</b>입니다 — 운영 스위치에 주기적으로 SSH 세션을 붙이는 동작이라 명시적으로 켜야 시작합니다.<br />
          • <code>portperfshow</code> 는 Ctrl-C 전까지 화면을 계속 갱신하는 명령이라, <b>표본 시간</b>만큼 받아쓴 뒤
            가장 최근 화면 1벌을 저장합니다.<br />
          • 값의 단위는 스위치가 주는 <b>바이트/초</b> 그대로 저장하고, 화면에서 bps 로 환산해 보여줍니다.<br />
          • SSH 수집 방식 장비만 대상입니다. REST 방식 장비는 포트 통계 카운터로 이미 처리량을 계산합니다.<br />
          • 엣지 위임 장비는 <b>그 엣지에서</b> 수집·저장됩니다(중앙은 엣지가 올린 요약만 봅니다).
        </div>
      </div>

      <div className="card" style={{ marginBottom: 12 }}>
        <label className="flex gap" style={{ alignItems: 'center', fontSize: 14, marginBottom: 12 }}>
          <input type="checkbox" checked={form.enabled} onChange={(e) => set('enabled', e.target.checked)} />
          <b>포트 사용량 수집 사용</b>
        </label>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
          <label style={{ fontSize: 12 }}>수집 주기(초)
            <input className="input" type="number" value={Math.round(form.intervalMs / 1000)}
              min={L.intervalMs.min / 1000} max={L.intervalMs.max / 1000}
              onChange={(e) => set('intervalMs', Number(e.target.value) * 1000)} />
            <span className="muted" style={{ fontSize: 11 }}>{L.intervalMs.min / 1000}~{L.intervalMs.max / 1000}초 · 기본 {L.intervalMs.def / 1000}초</span>
          </label>
          <label style={{ fontSize: 12 }}>표본 시간(초)
            <input className="input" type="number" value={form.sampleSeconds}
              min={L.sampleSeconds.min} max={L.sampleSeconds.max}
              onChange={(e) => set('sampleSeconds', Number(e.target.value))} />
            <span className="muted" style={{ fontSize: 11 }}>portperfshow 를 받아쓸 시간 · 기본 {L.sampleSeconds.def}초</span>
          </label>
          <label style={{ fontSize: 12 }}>보관 기간(일)
            <input className="input" type="number" value={form.retentionDays}
              min={L.retentionDays.min} max={L.retentionDays.max}
              onChange={(e) => set('retentionDays', Number(e.target.value))} />
            <span className="muted" style={{ fontSize: 11 }}>이보다 오래된 점은 삭제 · 기본 {L.retentionDays.def}일</span>
          </label>
        </div>
        <div className="flex gap" style={{ marginTop: 12, alignItems: 'center' }}>
          <button className="login-btn" style={{ flex: 'none', padding: '8px 18px' }} disabled={busy} onClick={save}>저장</button>
          <button className="tab" style={{ flex: 'none', padding: '8px 14px' }} disabled={busy} onClick={runNow}
            title="설정이 꺼져 있어도 한 번 수집해 동작을 확인합니다.">지금 1회 수집</button>
          {msg && <span className="muted" style={{ fontSize: 12 }}>{msg}</span>}
        </div>
      </div>

      <div className="card">
        <div style={{ fontWeight: 600, marginBottom: 6 }}>수집 현황</div>
        <div className="muted" style={{ fontSize: 12, lineHeight: 1.9 }}>
          마지막 수집: {fmtTs(st.at)} · 성공 {st.collected ?? 0} / 실패 {st.failed ?? 0}
          {st.busy ? ' · 수집 진행중' : ''}<br />
          DB: {db.available === false ? <span style={{ color: 'var(--amber)' }}>사용 불가(node:sqlite 미지원 — 수집·화면은 동작하고 이력만 비활성)</span>
            : <>{(db.rows ?? 0).toLocaleString()}행 · 스위치 {db.devices ?? 0}대 · {fmtTs(db.oldest)} ~ {fmtTs(db.newest)}</>}
          {db.file ? <><br />파일: <code>{db.file}</code></> : null}
          {st.errors?.length ? <><br /><span style={{ color: 'var(--amber)' }}>최근 오류: {st.errors.join(' / ')}</span></> : null}
        </div>
      </div>
    </>
  );
}
