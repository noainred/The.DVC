import React, { useEffect, useState } from 'react';
import { fetchJson, postJson, putJson, delJson, getToken } from '../api.js';
import { Loading, ErrorBox, Modal } from '../components/ui.jsx';

const fmtBytes = (n) => { if (!n) return '0 B'; const u = ['B', 'KB', 'MB', 'GB']; let i = 0; let v = n; while (v >= 1024 && i < 3) { v /= 1024; i++; } return `${v.toFixed(i ? 1 : 0)} ${u[i]}`; };
const fmtTime = (ts) => (ts ? new Date(ts).toLocaleString('ko-KR') : '—');
const REASON = { manual: '수동', schedule: '정기', change: '변경감지', startup: '시작', 'pre-restore': '복원전' };

/** 설정 → 포탈 백업 — 중앙+엣지 통합 설정 백업, 정기/변경 자동 + 다운로드/복원. */
export default function PortalBackup() {
  const [d, setD] = useState(null);
  const [error, setError] = useState(null);
  const [s, setS] = useState(null);      // 편집 중 설정
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState(null);
  const [view, setView] = useState(null); // 상세 모달

  const load = () => fetchJson('/admin/backup/status').then((r) => { setD(r); setS((cur) => cur || r.settings); setError(null); }).catch((e) => setError(e.message));
  useEffect(() => { load(); const t = setInterval(load, 20_000); return () => clearInterval(t); }, []);
  if (error) return <ErrorBox message={error} />;
  if (!d || !s) return <Loading />;

  const saveSettings = async () => {
    setBusy('save'); setMsg(null);
    try { const r = await putJson('/admin/backup/settings', s); setS(r); setMsg('설정 저장됨'); await load(); }
    catch (e) { setMsg(`오류: ${e.message}`); } finally { setBusy(''); }
  };
  const backupNow = async () => {
    setBusy('now'); setMsg(null);
    try { const r = await postJson('/admin/backup/now', {}); setMsg(`백업 완료: ${r.name} (${fmtBytes(r.size)}, 중앙 ${r.centralFiles}개 · 엣지 ${r.edges}개)`); await load(); }
    catch (e) { setMsg(`오류: ${e.message}`); } finally { setBusy(''); }
  };
  const download = async (name) => {
    try {
      const res = await fetch(`/api/admin/backup/download/${encodeURIComponent(name)}`, { headers: { Authorization: `Bearer ${getToken()}` } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = name; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) { setMsg(`다운로드 오류: ${e.message}`); }
  };
  const restore = async (name) => {
    if (!window.confirm(`'${name}' 으로 중앙 설정을 복원합니다.\n현재 설정은 자동 백업(pre-restore)되며, 적용에는 포탈 재시작이 필요합니다. 계속할까요?`)) return;
    setBusy(name); setMsg(null);
    try { const r = await postJson(`/admin/backup/restore/${encodeURIComponent(name)}`, {}); setMsg(r.note || `복원 완료(${r.restored}개)`); await load(); }
    catch (e) { setMsg(`복원 오류: ${e.message}`); } finally { setBusy(''); }
  };
  const remove = async (name) => {
    if (!window.confirm(`'${name}' 백업을 삭제할까요?`)) return;
    try { await delJson(`/admin/backup/${encodeURIComponent(name)}`); await load(); } catch (e) { setMsg(`삭제 오류: ${e.message}`); }
  };
  const openView = async (name) => { try { setView(await fetchJson(`/admin/backup/view/${encodeURIComponent(name)}`)); } catch (e) { setMsg(e.message); } };

  return (
    <div style={{ maxWidth: 980 }}>
      <div className="section-title" style={{ marginTop: 0 }}>💾 포탈 백업</div>
      <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>
        중앙 포탈 + 엣지 포탈(에이전트)의 <b>모든 설정을 통합</b>해 백업합니다(수집 데이터/대용량 DB는 제외).
        정기 백업과 설정 변경 시 자동 백업을 지원합니다. <b>백업에는 자격증명이 포함</b>되므로 안전하게 보관하세요.
      </p>

      {/* 설정 */}
      <div className="card" style={{ padding: 16, marginBottom: 14 }}>
        <div className="section-title" style={{ marginTop: 0, fontSize: 15 }}>백업 정책</div>
        <div className="flex gap wrap" style={{ alignItems: 'center', gap: 18 }}>
          <label className="flex gap" style={{ alignItems: 'center', cursor: 'pointer' }}>
            <input type="checkbox" checked={s.scheduleEnabled} onChange={(e) => setS({ ...s, scheduleEnabled: e.target.checked })} /> <b>정기 백업</b>
          </label>
          <span className="muted">매</span>
          <input className="input" type="number" min="1" style={{ width: 80 }} value={s.every} onChange={(e) => setS({ ...s, every: e.target.value })} disabled={!s.scheduleEnabled} />
          <select className="select" value={s.unit} onChange={(e) => setS({ ...s, unit: e.target.value })} disabled={!s.scheduleEnabled}>
            <option value="minute">분</option><option value="hour">시간</option><option value="day">일</option>
          </select>
          <span style={{ width: 16 }} />
          <label className="flex gap" style={{ alignItems: 'center', cursor: 'pointer' }}>
            <input type="checkbox" checked={s.autoOnChange} onChange={(e) => setS({ ...s, autoOnChange: e.target.checked })} /> <b>설정 변경 시 자동 백업</b>
          </label>
          <span style={{ width: 16 }} />
          <span className="muted">보관 개수</span>
          <input className="input" type="number" min="1" style={{ width: 80 }} value={s.retention} onChange={(e) => setS({ ...s, retention: e.target.value })} />
        </div>
        <div className="flex gap" style={{ marginTop: 12 }}>
          <button className="login-btn" style={{ padding: '8px 16px' }} disabled={busy === 'save'} onClick={saveSettings}>{busy === 'save' ? '저장 중…' : '정책 저장'}</button>
          <button className="logout-btn" style={{ padding: '8px 16px' }} disabled={busy === 'now'} onClick={backupNow}>{busy === 'now' ? '백업 중…' : '⬇ 지금 백업'}</button>
          <span className="muted" style={{ alignSelf: 'center', fontSize: 12 }}>
            {d.scheduleActive ? '정기 백업 동작 중' : '정기 백업 꺼짐'} · {d.watching ? '변경 감시 켜짐' : '변경 감시 꺼짐'}
            {d.lastRun && ` · 최근: ${REASON[d.lastRun.reason] || d.lastRun.reason} ${fmtTime(d.lastRun.at)}`}
          </span>
        </div>
        {msg && <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>{msg}</div>}
      </div>

      {/* 엣지 수신 현황 */}
      <div className="card" style={{ padding: 14, marginBottom: 14 }}>
        <div className="section-title" style={{ marginTop: 0, fontSize: 15 }}>엣지 포탈 설정 수신 ({d.edges.length})</div>
        {d.edges.length === 0
          ? <div className="muted" style={{ fontSize: 12 }}>아직 엣지 포탈(에이전트)이 설정을 push하지 않았습니다. 에이전트에 CENTRAL_URL/TOKEN이 설정되면 자동 수신됩니다.</div>
          : <div className="flex gap wrap">{d.edges.map((e) => <span key={e.agent} className="badge green" title={`설정 ${e.files}개 · ${fmtTime(e.at)}`}>🛰 {e.agent} · {e.files}개 · {fmtTime(e.at)}</span>)}</div>}
      </div>

      {/* 백업 목록 */}
      <div className="card" style={{ padding: 14 }}>
        <div className="section-title" style={{ marginTop: 0, fontSize: 15 }}>백업 목록 ({d.backups.length})</div>
        {d.backups.length === 0 ? <div className="muted" style={{ fontSize: 12 }}>백업이 없습니다. ‘지금 백업’으로 첫 백업을 생성하세요.</div> : (
          <div className="table-wrap" style={{ maxHeight: '46vh' }}>
            <table><thead><tr><th>파일</th><th>시각</th><th style={{ textAlign: 'right' }}>크기</th><th>작업</th></tr></thead>
              <tbody>
                {d.backups.map((b) => (
                  <tr key={b.name}>
                    <td style={{ fontSize: 12 }}><button className="cell-link" onClick={() => openView(b.name)}>{b.name}</button></td>
                    <td className="muted" style={{ fontSize: 12 }}>{fmtTime(b.at)}</td>
                    <td style={{ textAlign: 'right' }}>{fmtBytes(b.size)}</td>
                    <td>
                      <div className="flex gap">
                        <button className="tab" style={{ padding: '3px 9px', fontSize: 12 }} onClick={() => download(b.name)}>다운로드</button>
                        <button className="tab" style={{ padding: '3px 9px', fontSize: 12 }} disabled={busy === b.name} onClick={() => restore(b.name)}>복원</button>
                        <button className="tab" style={{ padding: '3px 9px', fontSize: 12, color: 'var(--red)' }} onClick={() => remove(b.name)}>삭제</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody></table>
          </div>
        )}
      </div>

      {view && (
        <Modal title="백업 내용" onClose={() => setView(null)} width={640}>
          <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>{fmtTime(view.createdAt)} · {REASON[view.reason] || view.reason} · 중앙 v{view.centralVersion}</div>
          <div className="section-title" style={{ fontSize: 14 }}>중앙 설정 ({view.centralFiles.length})</div>
          <div className="flex gap wrap" style={{ marginBottom: 10 }}>{view.centralFiles.map((f) => <span key={f} className="badge gray" style={{ fontSize: 11 }}>{f}</span>)}</div>
          <div className="section-title" style={{ fontSize: 14 }}>엣지 설정 ({view.edges.length})</div>
          {view.edges.length === 0 ? <div className="muted" style={{ fontSize: 12 }}>엣지 설정 없음</div>
            : view.edges.map((e) => <div key={e.agent} style={{ marginBottom: 6 }}><b style={{ fontSize: 13 }}>🛰 {e.agent}</b> <span className="muted" style={{ fontSize: 11 }}>{fmtTime(e.at)}</span><div className="flex gap wrap" style={{ marginTop: 3 }}>{e.files.map((f) => <span key={f} className="badge gray" style={{ fontSize: 11 }}>{f}</span>)}</div></div>)}
        </Modal>
      )}
    </div>
  );
}
