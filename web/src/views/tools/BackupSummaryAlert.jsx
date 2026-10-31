/**
 * Backup › Summary '이 조건을 알림으로(메일)'(v2.838 — 시안 ① · 사용자 결정 '일일 메일로 구현').
 *   GET/PUT /tools/backup-summary/alert · POST …/alert/send. 저장 · 지금 보내기는 **전체 범위 관리자만**(서버가 판정 — 버튼을 숨기는 것은 UX).
 *   범위 계정에는 서버가 설정을 싣지 않는다(hidden) — 그때는 버튼도 그리지 않는다.
 *   메일 본문 · 수신자는 서버(veeam/staleAlert.js · 설정 › 메일 발송의 '백업 안 된 VM(매일)' 수신자)가 정한다.
 */
import React, { useState } from 'react';
import { putJson, postJson } from '../../api.js';
import { alertQueryOf, alertCondText, sameAlertQuery, alertStatusText } from './backupSummaryPlan.js';

const TONE = { ok: '#86efac', bad: '#fca5a5', warn: '#fcd34d' };

export default function BackupSummaryAlert({ alert, finder, vcName, onChanged }) {
  const s = alert?.settings || null;
  const [time, setTime] = useState(s?.time || '08:30');
  const [enabled, setEnabled] = useState(s?.savedAt ? s.enabled : true);   // 처음 저장이면 켜 둔 채로 시작
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  if (!alert || alert.hidden) return null;
  const same = s && sameAlertQuery(s.q, finder);
  const finderOk = Number.isInteger(Number(finder?.n)) && Number(finder.n) >= 1 && Number(finder.n) <= 999;
  const save = async () => {
    setBusy(true); setMsg(null);
    try {
      const r = await putJson('/tools/backup-summary/alert', { enabled, time, q: alertQueryOf(finder) });
      if (r?.ok === false) setMsg({ tone: 'bad', text: r.reason || '저장하지 못했습니다.' });
      else { setMsg({ tone: 'ok', text: `저장했습니다 — ${enabled ? `매일 ${time} 에 보냅니다` : '꺼 두었습니다'}.` }); onChanged?.(); }
    } catch (e) { setMsg({ tone: 'bad', text: String(e?.message || e).slice(0, 200) }); }
    finally { setBusy(false); }
  };
  const sendNow = async () => {
    setBusy(true); setMsg(null);
    try {
      const r = await postJson('/tools/backup-summary/alert/send', {});
      setMsg(r?.ok ? { tone: 'ok', text: `보냈습니다 — ${r.n}대(저장된 조건 기준).` } : { tone: 'bad', text: `보내지 못했습니다 — ${r?.reason || '사유 모름'}${Number.isFinite(r?.n) ? ` · 계산은 ${r.n}대` : ''}` });
    } catch (e) { setMsg({ tone: 'bad', text: String(e?.message || e).slice(0, 200) }); }
    finally { setBusy(false); onChanged?.(); }
  };
  const mail = alert.mail;
  return (
    <div role="region" aria-label="이 조건을 알림으로(메일)" data-backup-alert="" style={{ margin: '0 14px 10px', padding: '10px 12px', border: '1px solid rgba(34,211,238,.45)', borderRadius: 10, background: 'rgba(34,211,238,.05)', display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12.5, minWidth: 0 }}>
      <div className="flex wrap" style={{ alignItems: 'center', gap: '4px 10px' }}>
        <b style={{ color: '#67e8f9' }}>이 조건을 알림으로(메일) — 하루 한 번</b>
        <span className="muted" style={{ fontSize: 12 }}>정한 시각(포탈 시각)에 전 법인에서 찾아 수와 목록(앞 200대)을 메일로 보냅니다 · 수신자는 설정 › 메일 발송의 ‘백업 안 된 VM(매일)’</span>
      </div>
      {alert.unreadable && <div style={{ color: TONE.bad }}>메일 설정 파일을 읽지 못해 보내지 않고 저장도 막았습니다 — 손상본(backup-stale-alert.json.corrupt.*)을 확인하세요.</div>}
      <div style={{ overflowWrap: 'anywhere' }}>
        <span className="muted">저장된 설정: </span>
        {s ? <><b style={{ color: s.enabled ? TONE.ok : 'var(--text-dim)' }}>{s.enabled ? `켜짐 · 매일 ${s.time}` : '꺼짐'}</b> · {alertCondText(s.q, vcName)}{s.savedBy ? <span className="muted"> · {s.savedBy} 저장</span> : null}</> : '—'}
        {s && <span style={{ color: same ? TONE.ok : TONE.warn }}> · {same ? '지금 찾기 조건과 같음' : '지금 찾기 조건과 다름'}</span>}
      </div>
      <div className="muted">마지막 발송: {alertStatusText(alert.status)}</div>
      {mail && !mail.enabled && <div style={{ color: TONE.warn }}>메일 발송이 꺼져 있어 보내지 않습니다 — 설정 › 메일 발송에서 켜세요.</div>}
      {mail && mail.enabled && !mail.kindEnabled && <div style={{ color: TONE.warn }}>메일 종류 ‘백업 안 된 VM(매일)’ 이 꺼져 있어 보내지 않습니다 — 설정 › 메일 발송.</div>}
      {alert.canEdit ? (
        <div className="flex wrap" style={{ alignItems: 'center', gap: '6px 10px' }}>
          <label className="flex" style={{ alignItems: 'center', gap: 5 }}><input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> 켜기</label>
          <label className="flex" style={{ alignItems: 'center', gap: 6 }}><span className="muted">매일</span><input className="input" type="time" value={time} onChange={(e) => setTime(e.target.value)} aria-label="보낼 시각" style={{ width: 132, minWidth: 0 }} /></label>
          <button type="button" className="tab active" disabled={busy || !finderOk || alert.unreadable} onClick={save} title="위 찾기 조건(기간 · 법인 · 기준 · 체크) 그대로 저장합니다" style={{ padding: '3px 12px', fontSize: 12 }}>{busy ? '처리 중…' : '지금 찾기 조건으로 저장'}</button>
          <button type="button" className="tab" disabled={busy || !s || alert.unreadable} onClick={sendNow} title="저장된 조건으로 지금 한 번 보냅니다(1분에 한 번 · 오늘 정한 시각 메일은 그대로 갑니다)" style={{ padding: '3px 12px', fontSize: 12 }}>지금 보내 보기</button>
        </div>
      ) : <div className="muted">저장 · 보내기는 전체 범위 관리자만 할 수 있습니다(전 법인 자료를 메일로 보내는 설정).</div>}
      {msg && <div role="status" style={{ color: TONE[msg.tone], overflowWrap: 'anywhere' }}>{msg.text}</div>}
    </div>
  );
}
