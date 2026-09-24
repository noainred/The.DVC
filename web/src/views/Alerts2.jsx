import React, { useEffect, useState } from 'react';
import { fetchJson, putJson, postJson } from '../api.js';
import { Loading, ErrorBox } from '../components/ui.jsx';
import { STable } from '../components/STable.jsx';
import { blankOr } from './blankOr.js';

const RULE_LABEL = {
  criticalAlarms: '위험(critical) 알람 발생',
  vcenterDown: 'vCenter 수집 실패(연결 불가)',
  hostDisconnected: '호스트 연결 끊김',
  datastorePct: '데이터스토어 사용률 ≥ (%)',
  ramOvercommitPct: '클러스터 RAM 오버커밋 ≥ (%)',
  vcpuPerCore: '클러스터 vCPU:코어 ≥',
};

/** 설정 → 알림: 임계치/조건 규칙 + Slack/Webhook 통지 채널. */
export default function Alerts2() {
  const [d, setD] = useState(null);
  const [error, setError] = useState(null);
  const [msg, setMsg] = useState(null);
  const load = () => fetchJson('/admin/alerts').then((r) => { setD(r); setError(null); }).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);
  if (error) return <ErrorBox message={error} />;
  if (!d) return <Loading />;
  const c = d.config;
  const flash = (ok, t) => { setMsg({ ok, t }); setTimeout(() => setMsg(null), 4000); };
  const setCh = (ch, k, v) => setD({ ...d, config: { ...c, channels: { ...c.channels, [ch]: { ...c.channels[ch], [k]: v } } } });
  const setRule = (r, k, v) => setD({ ...d, config: { ...c, rules: { ...c.rules, [r]: { ...c.rules[r], [k]: v } } } });
  // v2.605(감사 WEB2605-05): 숫자 칸은 **원문 문자열**을 상태에 두고 전송 때만 blankOr — 빈 칸은 보내지 않는다(서버가 이전 값 유지).
  //   예전 onChange 의 Number() 는 빈 칸을 0 으로 저장·표시했고 평가는 기본값(90 등)으로 판정해 화면과 실제 기준이 달랐다.
  const toBody = (cfg) => ({
    ...cfg,
    rules: Object.fromEntries(Object.entries(cfg.rules || {}).map(([k, v]) => [k,
      v && typeof v === 'object' && 'threshold' in v ? { ...v, threshold: blankOr(v.threshold) } : v])),
    cooldownMin: blankOr(cfg.cooldownMin),
    intervalSec: blankOr(cfg.intervalSec),
  });
  const save = async () => { const r = await putJson('/admin/alerts', toBody(c)).catch((e) => ({ error: e.message })); if (r.config) { await load(); flash(true, '저장했습니다.'); } else flash(false, r.error || '저장 실패'); };
  const test = async () => { const r = await postJson('/admin/alerts/test', {}).catch((e) => ({ ok: false, results: [e.message] })); flash(r.ok, `테스트 발송: ${(r.results || []).join(', ') || '활성 채널 없음'}`); };

  return (
    <>
      <div className="section-title" style={{ margin: '6px 0' }}>알림 / 임계치</div>
      {msg && <div style={{ marginBottom: 10, padding: '9px 12px', borderRadius: 8, fontSize: 13, background: msg.ok ? 'rgba(34,197,94,.12)' : 'rgba(239,68,68,.12)', color: msg.ok ? '#4ade80' : '#f87171' }}>{msg.t}</div>}

      <div className="card" style={{ marginBottom: 12 }}>
        <b style={{ fontSize: 14 }}>통지 채널</b>
        <div className="spec-grid" style={{ marginTop: 8 }}>
          <label className="flex gap" style={{ alignItems: 'center', fontSize: 13 }}><input type="checkbox" checked={!!c.channels.slack.enabled} onChange={(e) => setCh('slack', 'enabled', e.target.checked)} /> Slack 사용</label>
          <label style={{ gridColumn: '1 / -1' }}>Slack Incoming Webhook URL<input className="input" value={c.channels.slack.url} onChange={(e) => setCh('slack', 'url', e.target.value)} placeholder="https://hooks.slack.com/services/..." /></label>
          <label className="flex gap" style={{ alignItems: 'center', fontSize: 13 }}><input type="checkbox" checked={!!c.channels.webhook.enabled} onChange={(e) => setCh('webhook', 'enabled', e.target.checked)} /> Webhook 사용</label>
          <label style={{ gridColumn: '1 / -1' }}>Webhook URL (JSON POST)<input className="input" value={c.channels.webhook.url} onChange={(e) => setCh('webhook', 'url', e.target.value)} placeholder="https://your-endpoint/alerts" /></label>
          <label className="flex gap" style={{ alignItems: 'center', fontSize: 13 }}><input type="checkbox" checked={!!c.channels.email?.enabled} onChange={(e) => setCh('email', 'enabled', e.target.checked)} /> 메일 사용</label>
        </div>
        <div className="muted" style={{ fontSize: 11, marginTop: 6, lineHeight: 1.7 }}>
          ✉ 메일은 <b>설정 › 메일 발송</b>의 SMTP 설정과 수신자를 씁니다(v2.454) — 여기서는 이 채널을 쓸지만 정합니다.
          그 화면에서 <b>메일 발송 사용</b>과 <b>'알림' 종류</b>가 함께 켜져 있어야 실제로 나갑니다.
        </div>
        <div className="flex gap" style={{ marginTop: 10 }}>
          <button className="login-btn" style={{ flex: 'none', padding: '8px 16px' }} onClick={save}>저장</button>
          <button className="logout-btn" style={{ padding: '8px 14px' }} onClick={test}>테스트 발송</button>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 12 }}>
        <b style={{ fontSize: 14 }}>임계치 / 조건 규칙</b>
        <div style={{ marginTop: 8 }}>
          {Object.keys(RULE_LABEL).map((r) => (
            <div key={r} className="flex gap" style={{ alignItems: 'center', padding: '6px 0', borderBottom: '1px solid rgba(255,255,255,.06)' }}>
              <label className="flex gap" style={{ alignItems: 'center', fontSize: 13, flex: 1 }}>
                <input type="checkbox" checked={!!c.rules[r]?.enabled} onChange={(e) => setRule(r, 'enabled', e.target.checked)} /> {RULE_LABEL[r]}
              </label>
              {'threshold' in (c.rules[r] || {}) && (
                <input className="input" type="number" style={{ maxWidth: 100 }} value={c.rules[r].threshold} onChange={(e) => setRule(r, 'threshold', e.target.value)} />
              )}
            </div>
          ))}
        </div>
        <div className="flex gap wrap" style={{ marginTop: 10, alignItems: 'flex-end' }}>
          <label style={{ fontSize: 12 }}>재통지 쿨다운(분)<input className="input" type="number" style={{ maxWidth: 110 }} value={c.cooldownMin} onChange={(e) => setD({ ...d, config: { ...c, cooldownMin: e.target.value } })} /></label>
          <label style={{ fontSize: 12 }}>평가 주기(초)<input className="input" type="number" style={{ maxWidth: 110 }} value={c.intervalSec} onChange={(e) => setD({ ...d, config: { ...c, intervalSec: e.target.value } })} /></label>
          <button className="login-btn" style={{ flex: 'none', padding: '8px 16px' }} onClick={save}>저장</button>
          <span className="muted" style={{ fontSize: 11 }}>저장하면 바로 적용됩니다(재시작 불필요). 빈 칸은 이전 값을 유지합니다.</span>
        </div>
      </div>

      <div className="card">
        <b style={{ fontSize: 14 }}>현재 발생 중 ({d.firing.length})</b>
        <div className="table-wrap" style={{ marginTop: 8, maxHeight: '32vh' }}>
          <STable>
            <thead><tr><th>심각도</th><th>내용</th><th>상세</th><th>발생</th></tr></thead>
            <tbody>
              {d.firing.length === 0 && <tr><td colSpan={4} className="center muted" style={{ padding: 16 }}>발생 중인 알림이 없습니다.</td></tr>}
              {d.firing.map((a) => (
                <tr key={a.key}>
                  <td><span className={`badge ${a.severity === 'critical' ? 'red' : 'amber'}`}>{a.severity === 'critical' ? '위험' : '경고'}</span></td>
                  <td>{a.title}</td>
                  <td className="muted" style={{ fontSize: 12 }}>{a.detail || '—'}</td>
                  <td className="muted" style={{ fontSize: 12 }}>{new Date(a.since).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </STable>
        </div>
        {d.recent?.length > 0 && (
          <>
            <b style={{ fontSize: 13, display: 'block', marginTop: 12 }}>최근 통지</b>
            <div className="muted" style={{ fontSize: 12, marginTop: 4, maxHeight: '20vh', overflowY: 'auto' }}>
              {d.recent.map((r, i) => <div key={i}>{new Date(r.at).toLocaleTimeString()} · {r.title}{r.channels ? ` (${r.channels.join(', ')})` : ''}</div>)}
            </div>
          </>
        )}
      </div>
    </>
  );
}
