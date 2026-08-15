import React, { useEffect, useState } from 'react';
import { fetchJson, postJson, delJson } from '../api.js';
import { Loading, ErrorBox } from '../components/ui.jsx';

/**
 * 설정 › NFS 마운트(백업 대상)(v2.299, admin 전용) — 사용자 요구사항:
 * VM 복제(백업)의 NFS 대상을 위해, 이 포탈이 도는 Edge 노드에 NFS 를 **웹 UI 에서**
 * 마운트/해제하고 결과·로그·트러블슈팅을 본다. 실행 자체는 서버(system/nfsMounts.js)가
 * 화이트리스트 검증 + execFile(셸 미경유)로 수행하고 전 과정을 감사로그에 남긴다.
 */
export default function NfsMounts() {
  const [d, setD] = useState(null);        // { mounts, logs, tips, platform }
  const [err, setErr] = useState(null);
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ server: '', exportPath: '', options: '' });
  const [showTips, setShowTips] = useState(false);

  const load = () => fetchJson('/admin/nfs-mounts').then((r) => { setD(r); setErr(null); }).catch((e) => setErr(e.message));
  useEffect(() => { load(); const t = setInterval(load, 15_000); return () => clearInterval(t); }, []);
  if (err && !d) return <ErrorBox message={err} />;
  if (!d) return <Loading />;

  const act = async (fn) => { setBusy(true); setMsg(null); try { await fn(); await load(); } catch (e) { setMsg(`오류: ${e.message}`); } finally { setBusy(false); } };
  const add = () => act(async () => {
    const r = await postJson('/admin/nfs-mounts', form);
    if (r.ok === false) throw new Error(r.reason);
    setForm({ server: '', exportPath: '', options: '' });
    setMsg('등록됨 — [마운트] 버튼으로 연결하세요.');
  });
  const doMount = (id) => act(async () => { const r = await postJson(`/admin/nfs-mounts/${encodeURIComponent(id)}/mount`, {}); setMsg(r.ok ? (r.already ? '이미 마운트되어 있습니다.' : `마운트됨: ${r.mountPoint}`) : `마운트 실패: ${r.reason}`); });
  const doUmount = (id) => act(async () => { const r = await postJson(`/admin/nfs-mounts/${encodeURIComponent(id)}/umount`, {}); setMsg(r.ok ? '해제됨' : `해제 실패: ${r.reason}`); });
  const doDelete = (m) => { if (window.confirm(`'${m.server}:${m.exportPath}' 항목을 삭제할까요? (마운트 중이면 먼저 해제 필요)`)) act(async () => { const r = await delJson(`/admin/nfs-mounts/${encodeURIComponent(m.id)}`); if (r.ok === false) throw new Error(r.reason); }); };

  return (
    <div style={{ maxWidth: 980 }}>
      <div className="section-title" style={{ marginTop: 0 }}>🗄 NFS 마운트(백업 대상) — Edge 노드</div>
      <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>
        VM 복제(백업)의 <b>NFS 대상</b>으로 쓸 공유를 이 서버(Edge 노드)에 마운트합니다. 마운트 지점은
        <code> /mnt/portal-nfs/&lt;id&gt;</code> 아래로 고정되며(임의 경로 마운트 차단), 모든 실행은 감사 로그에 남습니다.
        {d.platform !== 'linux' && <span style={{ color: 'var(--amber)' }}> ⚠ 현재 서버 OS({d.platform})에서는 마운트 실행이 지원되지 않습니다(Linux Edge 노드 전용) — 등록/조회만 가능합니다.</span>}
      </p>

      {/* 등록 폼 */}
      <div className="card" style={{ padding: 14, marginBottom: 12 }}>
        <div className="flex gap wrap" style={{ alignItems: 'flex-end' }}>
          <label style={{ fontSize: 12 }}>NFS 서버(IP/호스트명)<br /><input className="input" style={{ width: 180 }} placeholder="10.0.10.5" value={form.server} onChange={(e) => setForm({ ...form, server: e.target.value })} /></label>
          <label style={{ fontSize: 12 }}>Export 경로<br /><input className="input" style={{ width: 220 }} placeholder="/volume1/vm-backup" value={form.exportPath} onChange={(e) => setForm({ ...form, exportPath: e.target.value })} /></label>
          <label style={{ fontSize: 12 }}>옵션(선택)<br /><input className="input" style={{ width: 180 }} placeholder="vers=3,nolock" value={form.options} onChange={(e) => setForm({ ...form, options: e.target.value })} /></label>
          <button className="login-btn" style={{ flex: 'none', padding: '8px 16px' }} disabled={busy || !form.server || !form.exportPath} onClick={add}>+ 등록</button>
          {msg && <span className="muted" style={{ fontSize: 12.5 }}>{msg}</span>}
        </div>
      </div>

      {/* 마운트 목록 */}
      <div className="table-wrap" style={{ maxHeight: '30vh', marginBottom: 12 }}>
        <table>
          <thead><tr><th>서버:경로</th><th>옵션</th><th>마운트 지점</th><th>상태</th><th className="right">작업</th></tr></thead>
          <tbody>
            {d.mounts.length === 0 && <tr><td colSpan={5} className="center muted" style={{ padding: 18 }}>등록된 NFS 마운트가 없습니다.</td></tr>}
            {d.mounts.map((m) => (
              <tr key={m.id}>
                <td><b>{m.server}</b>:{m.exportPath}</td>
                <td className="muted" style={{ fontSize: 12 }}>{m.options || '—'}</td>
                <td className="muted" style={{ fontSize: 12, fontFamily: 'ui-monospace, monospace' }}>{m.mountPoint}</td>
                <td>{m.mounted ? <span className="badge green">마운트됨</span> : <span className="badge gray">해제됨</span>}</td>
                <td className="right" style={{ whiteSpace: 'nowrap' }}>
                  {m.mounted
                    ? <button className="logout-btn" style={{ padding: '4px 10px', fontSize: 12 }} disabled={busy} onClick={() => doUmount(m.id)}>해제</button>
                    : <button className="logout-btn" style={{ padding: '4px 10px', fontSize: 12, color: 'var(--green)' }} disabled={busy} onClick={() => doMount(m.id)}>마운트</button>}
                  {' '}<button className="logout-btn" style={{ padding: '4px 10px', fontSize: 12, color: 'var(--red)' }} disabled={busy} onClick={() => doDelete(m)}>삭제</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* 실행 로그(요구사항: 결과·로그 보기) */}
      <div className="section-title" style={{ fontSize: 14 }}>실행 로그(최근 50)</div>
      <div className="table-wrap" style={{ maxHeight: '24vh', marginBottom: 12 }}>
        <table>
          <thead><tr><th>시각</th><th>항목</th><th>동작</th><th>결과</th><th>상세(stderr 요약)</th></tr></thead>
          <tbody>
            {(d.logs || []).length === 0 && <tr><td colSpan={5} className="center muted" style={{ padding: 14 }}>아직 실행 이력이 없습니다.</td></tr>}
            {(d.logs || []).map((l, i) => (
              <tr key={i}>
                <td className="muted" style={{ fontSize: 11.5, whiteSpace: 'nowrap' }}>{new Date(l.at).toLocaleString('ko-KR')}</td>
                <td className="muted" style={{ fontSize: 12 }}>{l.mountId}</td>
                <td>{l.action}</td>
                <td>{l.ok ? <span className="badge green">성공</span> : <span className="badge red">실패</span>}</td>
                <td style={{ fontSize: 11.5, fontFamily: 'ui-monospace, monospace', wordBreak: 'break-all', color: l.ok ? undefined : 'var(--amber)' }}>{l.detail}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* 트러블슈팅(요구사항) */}
      <button className="tab" style={{ padding: '6px 12px' }} onClick={() => setShowTips((v) => !v)}>{showTips ? '▾' : '▸'} 트러블슈팅 가이드</button>
      {showTips && (d.tips || []).map((t, i) => (
        <div key={i} className="card" style={{ padding: '10px 14px', marginTop: 8 }}>
          <b style={{ fontSize: 13 }}>{t.t}</b>
          <pre className="muted" style={{ fontSize: 12, whiteSpace: 'pre-wrap', margin: '6px 0 0', fontFamily: 'ui-monospace, monospace' }}>{t.d}</pre>
        </div>
      ))}
    </div>
  );
}
