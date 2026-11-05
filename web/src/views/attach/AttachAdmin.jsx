/**
 * AttachAdmin — 첨부 관리(v2.889 · C-4): 사용량 · 전체 상한 설정(사용자 결정: 설정에서 · 기본 2GB) · 전체 내려받기(포탈 백업에 넣지 않는 대신 — 사용자 결정).
 * 관리자 + 전체 범위만(서버 /attach/admin/* 이 같은 기준). 이슈 › 설정 탭에 붙는다.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { fetchJson, putJson, downloadFile } from '../../api.js';
import { attachSizeText } from './attachText.js';
import { unitText } from '../unitText.js';

export default function AttachAdmin() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [cap, setCap] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const load = useCallback(() => {
    fetchJson('/attach/admin/usage').then((r) => { setData(r); setErr(null); setCap(String(r.settings?.maxTotalMB ?? '')); }).catch(setErr);
  }, []);
  useEffect(() => { load(); }, [load]);
  if (err && !data) return <div className="card iss-editor"><h3 className="iss-h3">첨부 파일</h3><div className="muted">첨부 사용량을 읽지 못했습니다 — {err.message || String(err)}</div></div>;
  if (!data) return null;
  const u = data.usage || {};
  const max = (u.maxTotalMB || 0) * 1024 * 1024;
  const pct = max > 0 ? Math.min(100, Math.round((u.bytes / max) * 100)) : null;
  const save = async () => {
    setBusy(true); setMsg('');
    try { const r = await putJson('/attach/admin/settings', { maxTotalMB: Number(cap) }); setMsg(r?.ok === false ? (r.reason || '저장하지 못했습니다') : '저장했습니다.'); load(); } catch (e) { setMsg(String(e?.message || e)); } finally { setBusy(false); }
  };
  const archive = async () => {
    setBusy(true); setMsg('');
    try { const name = await downloadFile('/attach/admin/archive'); setMsg(`받았습니다 — ${name}`); } catch (e) { setMsg(`받지 못했습니다 — ${e?.message || e}`); } finally { setBusy(false); }
  };
  return (
    <div className="card iss-editor">
      <h3 className="iss-h3">첨부 파일(위키 · 이슈)</h3>
      {err && <div className="banner warn" style={{ whiteSpace: 'normal' }}>사용량을 새로 읽지 못했습니다 — 아래는 직전에 읽은 값입니다({err.message || String(err)}).</div>}{/* v2.904 점검 W-9 */}
      {data.loadError && <div className="banner bad" style={{ whiteSpace: 'normal' }}>첨부 설정 파일(attach-settings.json)을 읽지 못해 기본 상한으로 동작 중입니다 — 손상본은 옆에 보존했습니다. 원인: {data.loadError}</div>}
      <div>
        사용 <b>{attachSizeText(u.bytes)}</b> / 상한 {attachSizeText(max)}{pct != null ? ` (${pct}%)` : ''} · 파일 {unitText(u.count, '개')}(위키 {unitText(u.wiki?.count, '개')} · 이슈 {unitText(u.issue?.count, '개')})
        {u.missing > 0 && <span className="iss-chip iss-sla warn" style={{ marginLeft: 6 }} title="목록에는 있지만 파일 본체가 없는 첨부 — 백업에서 되살린 포탈이면 첨부를 따로 옮겨야 합니다">본체 없음 {u.missing}</span>}
        {u.orphan > 0 && <span className="iss-chip iss-sla mute" style={{ marginLeft: 6 }} title="첨부 폴더에 있지만 목록에 없는 파일(목록 손상 · 손으로 넣은 파일)">목록 밖 파일 {u.orphan}</span>}
      </div>
      <div className="muted" style={{ fontSize: 12.5 }}>파일당 {attachSizeText(data.limits?.fileBytes)} · 문서 · 이슈마다 {data.limits?.perOwner ?? 20}개 · 받는 형식 {(data.exts || []).join(' · ')}. 첨부는 <b>포탈 백업에 들어가지 않습니다</b> — 아래 ‘전체 내려받기’ 로 따로 보관하세요(tar.gz · 원래 이름은 안의 index.json).</div>
      <div className="iss-checks">
        <label className="iss-inline">전체 상한(MB)<input className="input iss-num" type="number" min={1} max={data.limits?.maxTotalMBMax ?? 102400} value={cap} onChange={(e) => setCap(e.target.value)} /></label>
        <button type="button" className="btn" disabled={busy || !cap} onClick={save}>상한 저장</button>
        <button type="button" className="btn" disabled={busy || !u.count} onClick={archive}>{busy ? '처리 중…' : '전체 내려받기'}</button>
      </div>
      {msg && <div className="banner">{msg}</div>}
    </div>
  );
}
