import React, { useEffect, useRef, useState } from 'react';
import { fetchJson, putJson } from '../../api.js';
import { Loading, ErrorBox } from '../../components/ui.jsx';
import Select from '../../components/Select.jsx';
import { requireChanged } from '../changeResult.js';
import { periodText } from './syncLogic.js';

/**
 * Monitoring 설정 › **알림**(v2.915 · 개선안 ②) — 점검이 연속 N회 실패하면 포탈 알림(설정 › 알림 채널: 메일·Slack·Teams·웹훅)으로 보낸다.
 * 판정은 서버 `svcmon/transitions.js` 하나(전이 때만 1번 · 복구 1번 · 묶음 창 안에 상한을 넘으면 요약 1건 — 창·건수는 API batch 값). 기본 꺼짐.
 * 저장은 admin + 전체 범위(서버 adminOnly + fullScopeOnly) — 버튼도 그 기준으로 잠근다.
 */
export default function AlertTab({ isAdmin = false }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const [form, setForm] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const seq = useRef(0);

  const load = async () => {
    const my = ++seq.current;
    try {
      const r = await fetchJson('/svcmon/alert-settings');
      if (my !== seq.current) return;
      setD(r); setForm(r.settings); setErr(null);
    } catch (e) { if (my === seq.current) setErr(e); }
  };
  useEffect(() => { load(); }, []);

  if (err && !d) return <ErrorBox error={err} />;
  if (!d || !form) return <Loading label="알림 설정" />;
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const save = async () => {
    setBusy(true); setMsg('');
    try { const r = requireChanged(await putJson('/svcmon/alert-settings', form), '알림 설정을 저장하지 못했습니다.'); setForm(r.settings); setMsg('저장했습니다.'); load(); }
    catch (e) { setMsg(e.message); } finally { setBusy(false); }
  };
  const st = d.stats || {};
  // v2.930(점검 D1-08): 요약 묶음 창·기준 건수는 서버 값(/alert-settings batch) — 못 받으면 숫자 없이 말한다.
  const win = periodText(d.batch?.batchMs);
  const from = Number.isInteger(d.batch?.summaryFrom) && d.batch.summaryFrom > 0 ? d.batch.summaryFrom : null;
  const batchText = win && from ? `${win} 안에 ${from}건 이상 몰리면(회선·엣지 장애)` : '짧은 시간에 한꺼번에 몰리면(회선·엣지 장애)';
  return (
    <div className="card" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 760 }}>
      <div style={{ fontSize: 13, lineHeight: 1.6 }}>
        점검이 <b>연속 N회 실패</b>하면 포탈 알림 채널(설정 › 알림)로 보냅니다. 상태가 바뀔 때 한 번만 보내고, 정상으로 돌아오면 복구 알림을 한 번 보냅니다.{' '}
        {batchText} 요약 1건으로 묶습니다. 엣지 무보고 알림은 지금처럼 따로 나갑니다.
      </div>
      <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <input type="checkbox" checked={form.enabled} disabled={!isAdmin} onChange={(e) => set('enabled', e.target.checked)} />
        <b>점검 실패 알림 켜기</b><span className="muted" style={{ fontSize: 12 }}>(기본 꺼짐)</span>
      </label>
      <label style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        연속
        <input type="number" min={1} max={100} value={form.failCount} disabled={!isAdmin} style={{ width: 72 }}
          onChange={(e) => set('failCount', e.target.value === '' ? '' : Number(e.target.value))} aria-label="연속 실패 횟수" />
        회 실패(ALERT)하면 알림
      </label>
      <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <input type="checkbox" checked={form.recover} disabled={!isAdmin} onChange={(e) => set('recover', e.target.checked)} />정상으로 돌아오면 복구 알림
      </label>
      <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <input type="checkbox" checked={form.warn} disabled={!isAdmin} onChange={(e) => set('warn', e.target.checked)} />경고(WARN)도 같은 횟수로 알림(임계치 근접은 잦아 기본 끔)
      </label>
      <label htmlFor="al-scope" style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        대상 범위
        <Select sort={false} className="select" id="al-scope" value={form.scope} disabled={!isAdmin} onChange={(e) => set('scope', e.target.value)}>
          <option value="all">전체 점검</option>
          <option value="settings">설정 연동 대상만(‘설정 연동’ 폴더)</option>
        </Select>
      </label>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <button type="button" className="btn primary" disabled={!isAdmin || busy} title={isAdmin ? '' : '저장은 관리자(전체 범위)만'} onClick={save}>저장</button>
        {!isAdmin && <span className="muted" style={{ fontSize: 12 }}>조회만 가능합니다 — 저장은 관리자(전체 범위)만 할 수 있습니다.</span>}
        {msg && <span className="muted" style={{ fontSize: 12 }}>{msg}</span>}
      </div>
      <div className="muted" style={{ fontSize: 12, fontFamily: 'var(--mono)' }}>
        {`지금 알린 상태: 실패 ${st.alerted ?? 0} · 경고 ${st.warned ?? 0} · 대기 ${st.queued ?? 0} · 보낸 개별 ${st.individual ?? 0} · 요약 ${st.summaries ?? 0} · 엣지 이름을 아직 몰라 판정 보류 중 ${st.metaPending ?? 0}`}
        {' — 메모리 기준(재시작하면 다시 셉니다: 실패가 계속되면 재시작 뒤 한 번 더 알릴 수 있습니다)'}
      </div>
    </div>
  );
}
