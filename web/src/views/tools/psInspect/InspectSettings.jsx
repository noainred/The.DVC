/**
 * InspectSettings — 점검 일정 · 보고서 메일 · 기준값(관리자 · 전체 범위만 저장 — 서버 fullRwOnly). 조회 실패 상태로는 저장 버튼을 열지 않는다.
 *  · 비관리자에게는 서버가 받는 사람을 개수로만 준다(toHidden) — 화면은 그 사실을 말하고 입력을 잠근다.
 */
import React, { useEffect, useState } from 'react';
import { putJson } from '../../../api.js';
import Select from '../../../components/Select.jsx';
import { WEEKDAYS, mailList, scheduleText, kstText } from './psInspectText.js';

const formOf = (s, corps) => ({
  enabled: !!s?.enabled, weekday: s?.weekday ?? 1, time: s?.time || '09:00', mailEnabled: !!s?.mailEnabled, mailDelayMin: s?.mailDelayMin ?? 30,
  to: (s?.to || []).join(', '), corpTo: Object.fromEntries((corps || []).map((c) => [c.key, (s?.corpTo?.[c.key] || []).join(', ')])),
  capWarnPct: s?.thresholds?.capWarnPct ?? 80, capBadPct: s?.thresholds?.capBadPct ?? 90, snapMaxPct: s?.thresholds?.snapMaxPct ?? 10, busyMaxPct: s?.thresholds?.busyMaxPct ?? 90, skewFactor: s?.thresholds?.skewFactor ?? 1.5,
});

export default function InspectSettings({ schedule, corps, isAdmin, unreadable, onSaved }) {
  // lastRunSlot 은 처음 기동 때 기준으로도 잡힌다(돌리지 않은 회차) — 실제로 시작한 정기 회차만 적는다.
  const lastRun = (schedule?.history || []).find((h) => h?.type === 'run' && h.kind === 'schedule' && h.state === 'started') || null;
  const s = schedule?.settings;
  const [f, setF] = useState(() => formOf(s, corps));
  const [msg, setMsg] = useState(null);
  const [saving, setSaving] = useState(false);
  const sig = JSON.stringify([s?.updatedAt ?? null, (corps || []).map((c) => c.key)]);
  useEffect(() => { setF(formOf(s, corps)); }, [sig]); // eslint-disable-line react-hooks/exhaustive-deps
  const hidden = !!s?.toHidden;
  const canSave = isAdmin && !hidden && !unreadable && !!s;
  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  const save = async () => {
    setSaving(true); setMsg(null);
    try {
      const body = { enabled: f.enabled, weekday: Number(f.weekday), time: f.time, mailEnabled: f.mailEnabled, mailDelayMin: Number(f.mailDelayMin), to: mailList(f.to),
        corpTo: Object.fromEntries(Object.entries(f.corpTo).map(([k, v]) => [k, mailList(v)]).filter(([k]) => k)),
        thresholds: { capWarnPct: Number(f.capWarnPct), capBadPct: Number(f.capBadPct), snapMaxPct: Number(f.snapMaxPct), busyMaxPct: Number(f.busyMaxPct), skewFactor: Number(f.skewFactor) } };
      const r = await putJson('/tools/ps-inspect/settings', body);
      if (r?.ok === false) setMsg({ ok: false, text: r.reason || '저장하지 못했습니다' });
      else { setMsg({ ok: true, text: '저장했습니다' }); onSaved?.(); }
    } catch (e) { setMsg({ ok: false, text: String(e?.message || e) }); }
    finally { setSaving(false); }
  };
  return (
    <div className="psi-panel">
      <h3>점검 일정 · 보고서 메일 · 기준값</h3>
      <div className="psi-note">지금: {scheduleText(schedule)}{lastRun ? ` · 마지막 정기 점검 ${kstText(lastRun.slot)}` : ''}{s?.updatedAt ? ` · 바꾼 시각 ${kstText(s.updatedAt)}` : ''}</div>
      {unreadable && <div className="psi-banner amber">설정 파일을 읽지 못해 기본값으로 돌고 있습니다 — 저장을 막았습니다(손상본 storage-inspect.json.corrupt.* 확인).</div>}
      {hidden && <div className="psi-note">받는 사람은 관리자에게만 보입니다(지금 {s?.toCount ?? 0}명 · 법인판 {Object.keys(s?.corpToCount || {}).length}곳).</div>}
      <div className="psi-form">
        <label className="psi-check"><input type="checkbox" checked={f.enabled} onChange={set('enabled')} disabled={!canSave} />주간 점검 켜기</label>
        <label>요일<Select className="select select-sm" value={String(f.weekday)} onChange={set('weekday')} disabled={!canSave} aria-label="요일">{WEEKDAYS.map((w) => <option key={w.v} value={String(w.v)}>{w.l}요일</option>)}</Select></label>
        <label>시각(포탈 시각)<input type="time" value={f.time} onChange={set('time')} disabled={!canSave} /></label>
        <label className="psi-check"><input type="checkbox" checked={f.mailEnabled} onChange={set('mailEnabled')} disabled={!canSave} />보고서 메일 보내기</label>
        <label>점검 뒤 몇 분에 보낼지(엣지 결과가 오를 시간)<input type="number" min="10" max="360" value={f.mailDelayMin} onChange={set('mailDelayMin')} disabled={!canSave} /></label>
        <label>받는 사람(전 법인판 — 비우면 메일 설정의 기본 수신자)<textarea value={f.to} onChange={set('to')} disabled={!canSave} placeholder="ops@example.com, lead@example.com" /></label>
      </div>
      {!!(corps || []).length && (
        <details>
          <summary className="psi-lab" style={{ cursor: 'pointer' }}>법인판 받는 사람(그 법인 장비만 담긴 보고서)</summary>
          <div className="psi-form" style={{ marginTop: 8 }}>
            {corps.map((c) => <label key={c.key || '-'}>{c.name}<input value={f.corpTo[c.key] ?? ''} onChange={(e) => setF({ ...f, corpTo: { ...f.corpTo, [c.key]: e.target.value } })} disabled={!canSave || !c.key} placeholder={c.key ? '이메일, 이메일' : '법인 미지정 장비는 법인판이 없습니다'} /></label>)}
          </div>
        </details>
      )}
      <details>
        <summary className="psi-lab" style={{ cursor: 'pointer' }}>기준값(기본 = Dell 문서 숫자 · 편중만 포탈 기준)</summary>
        <div className="psi-form" style={{ marginTop: 8 }}>
          <label>용량 주의(%) — 증설 발주 [10]<input type="number" min="50" max="99" value={f.capWarnPct} onChange={set('capWarnPct')} disabled={!canSave} /></label>
          <label>용량 이상(%) — 유지 상한 [1][10]<input type="number" min="50" max="100" value={f.capBadPct} onChange={set('capBadPct')} disabled={!canSave} /></label>
          <label>스냅샷 최대(%) [1]<input type="number" min="1" max="90" value={f.snapMaxPct} onChange={set('snapMaxPct')} disabled={!canSave} /></label>
          <label>디스크 busy 주의(%) [12]<input type="number" min="50" max="100" value={f.busyMaxPct} onChange={set('busyMaxPct')} disabled={!canSave} /></label>
          <label>편중 배수(포탈 기준)<input type="number" min="1.1" max="5" step="0.1" value={f.skewFactor} onChange={set('skewFactor')} disabled={!canSave} /></label>
        </div>
      </details>
      <div className="psi-bar">
        {isAdmin ? <button type="button" className="psi-btn primary" onClick={save} disabled={!canSave || saving}>{saving ? '저장 중…' : '저장'}</button> : <span className="psi-note">설정은 전체 범위 관리자만 바꿉니다.</span>}
        {msg && <span className={msg.ok ? 'psi-muted' : ''} style={msg.ok ? undefined : { color: '#fcd34d', fontSize: 12.5 }}>{msg.text}</span>}
      </div>
    </div>
  );
}
