import React, { useEffect, useRef, useState } from 'react';
import { fetchJson, putJson, postJson, usePolling, getToken } from '../api.js';
import { Loading, ErrorBox } from '../components/ui.jsx';

const fmtTime = (ts) => (ts ? new Date(ts).toLocaleString('ko-KR') : '—');
const fmtNum = (n) => (n == null ? '—' : Number(n).toLocaleString());
const fmtMB = (b) => (b == null ? '—' : b < 1048576 ? `${Math.round(b / 1024)} KB` : `${(b / 1048576).toFixed(1)} MB`);
const SEV = { error: ['위험', 'red'], warning: ['경고', 'amber'], info: ['정보', 'gray'] };

/** 설정 → vCenter 로그 보관 — 보관 정책 + 장기 보관된 이벤트 뷰어. */
export default function VcenterLogs() {
  const [st, setSt] = useState(null);
  const [s, setS] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState(null);

  const loadStatus = () => fetchJson('/admin/vclogs/status').then((r) => { setSt(r); setS((c) => c || r.settings); setErr(null); }).catch((e) => setErr(e.message));
  useEffect(() => { loadStatus(); const t = setInterval(loadStatus, 30_000); return () => clearInterval(t); }, []);

  if (err) return <ErrorBox message={err} />;
  if (!st || !s) return <Loading />;

  const save = async () => { setBusy('save'); setMsg(null); try { const r = await putJson('/admin/vclogs/settings', s); setS(r); setMsg('저장됨'); await loadStatus(); } catch (e) { setMsg(`오류: ${e.message}`); } finally { setBusy(''); } };
  const collect = async () => { setBusy('collect'); setMsg(null); try { const r = await postJson('/admin/vclogs/collect', {}); setMsg(`수집 완료: ${r.collected ?? 0}건`); await loadStatus(); } catch (e) { setMsg(`오류: ${e.message}`); } finally { setBusy(''); } };

  return (
    <div style={{ maxWidth: 1080 }}>
      <div className="section-title" style={{ marginTop: 0 }}>🗂 vCenter 로그 보관</div>
      <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>
        vCenter는 이벤트를 단기간만 보관합니다. 포탈이 주기적으로 수집해 <b>장기 보관</b>합니다.
        데이터는 <b>중앙 집중 저장이 아니라, 이 포탈(해당 지역 엣지)에 로컬 보관</b>됩니다 — 각 지역 로그는 그 지역 엣지 포탈에서 보세요.
        <br />현재 보관 <b>{fmtNum(st.store?.count)}</b>건 · {st.dbKind === 'sqlite' ? 'SQLite' : 'NDJSON'} · {fmtMB(st.dbSizeBytes)}
        {st.store?.firstTs && ` · ${fmtTime(st.store.firstTs)} ~ ${fmtTime(st.store.lastTs)}`}
        {st.dbPath && <><br /><span style={{ fontSize: 11 }}>경로: <code>{st.dbPath}</code></span></>}
      </p>

      {/* 보관 정책 */}
      <div className="card" style={{ padding: 16, marginBottom: 14 }}>
        <div className="flex gap wrap" style={{ alignItems: 'center', gap: 18 }}>
          <label className="flex gap" style={{ alignItems: 'center', cursor: 'pointer' }}>
            <input type="checkbox" checked={s.enabled} onChange={(e) => setS({ ...s, enabled: e.target.checked })} /> <b>로그 수집·보관</b>
          </label>
          <span className="muted">수집 주기</span>
          <input className="input" type="number" min="1" style={{ width: 80 }} value={s.pollIntervalMin} onChange={(e) => setS({ ...s, pollIntervalMin: e.target.value })} /> <span className="muted">분</span>
          <span className="muted" style={{ marginLeft: 8 }}><b>보관 기간</b></span>
          <input className="input" type="number" min="0" style={{ width: 90 }} value={s.retentionDays} onChange={(e) => setS({ ...s, retentionDays: e.target.value })} /> <span className="muted">일 (0=무제한)</span>
          <span className="muted" style={{ marginLeft: 8 }}><b>용량 제한</b></span>
          <input className="input" type="number" min="0" style={{ width: 90 }} value={s.maxSizeMB} onChange={(e) => setS({ ...s, maxSizeMB: e.target.value })} /> <span className="muted">MB (0=무제한)</span>
          <span className="muted" style={{ marginLeft: 8 }}>최소 심각도</span>
          <select className="select" value={s.minSeverity} onChange={(e) => setS({ ...s, minSeverity: e.target.value })}>
            <option value="info">정보 이상(전체)</option><option value="warning">경고 이상</option><option value="error">위험만</option>
          </select>
        </div>
        <div className="flex gap wrap" style={{ alignItems: 'center', gap: 12, marginTop: 12 }}>
          <span className="muted"><b>저장 경로</b></span>
          <input className="input" placeholder="비우면 기본(CONFIG_DIR)" style={{ flex: 1, minWidth: 280 }} value={s.storagePath || ''} onChange={(e) => setS({ ...s, storagePath: e.target.value })} />
          <span className="muted" style={{ fontSize: 11 }}>서버의 디렉터리 경로. 변경 시 새 위치에 저장(기존 파일은 이동되지 않음).</span>
        </div>
        <div className="flex gap" style={{ marginTop: 12, alignItems: 'center' }}>
          <button className="login-btn" style={{ padding: '8px 16px' }} disabled={busy === 'save'} onClick={save}>{busy === 'save' ? '저장 중…' : '정책 저장'}</button>
          <button className="logout-btn" style={{ padding: '8px 16px' }} disabled={busy === 'collect'} onClick={collect}>{busy === 'collect' ? '수집 중…' : '⟳ 지금 수집'}</button>
          <span className="muted" style={{ fontSize: 12 }}>{st.lastRun ? `최근 수집 ${fmtTime(st.lastRun.at)} · ${st.lastRun.collected ?? 0}건` : '아직 수집 안 함'}{msg ? ` · ${msg}` : ''}</span>
        </div>
        {(st.store?.vcenters || []).length > 0 && (
          <div className="flex gap wrap" style={{ marginTop: 10 }}>
            {st.store.vcenters.map((v) => <span key={v.vcenterId} className="badge gray" style={{ fontSize: 11 }} title={`최근 ${fmtTime(v.lastTs)}`}>{v.vcenterId}: {fmtNum(v.count)}</span>)}
          </div>
        )}
      </div>

      <LogViewer />
    </div>
  );
}

function LogViewer() {
  const { data: vcs } = usePolling('/vcenters', {}, 60_000);
  const [f, setF] = useState({ vcenterId: '', severity: '', q: '' });
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const [sources, setSources] = useState({ local: [], remote: [] });
  const [mode, setMode] = useState('local'); // 'local' | 'edge'
  const LIMIT = 200;
  const remoteAgent = (id) => sources.remote.find((r) => r.vcenterId === id)?.agent;

  useEffect(() => { fetchJson('/tools/vclogs/sources').then(setSources).catch(() => {}); }, []);

  // 엣지 보관 vCenter면 연합 조회(요청 큐잉 → 폴링). 데이터는 엣지에 남고 결과만 중계.
  // 세대 가드: 폴링 중 다른 vCenter로 전환/재조회하면 옛 루프 결과가 새 화면을 덮지 않게 무효화.
  const fedGen = useRef(0);
  const federate = async () => {
    const gen = ++fedGen.current;
    setMode('edge'); setLoading(true); setRows([]);
    try {
      const { reqId } = await postJson('/tools/vclogs/federate', { vcenterId: f.vcenterId, severity: f.severity, q: f.q, limit: LIMIT });
      for (let i = 0; i < 9; i++) {
        await new Promise((r) => setTimeout(r, 1500));
        if (gen !== fedGen.current) return; // 다른 조회로 대체됨 → 이 루프 폐기
        const d = await fetchJson(`/tools/vclogs/federate?reqId=${encodeURIComponent(reqId)}`);
        if (gen !== fedGen.current) return;
        if (d.state === 'done') { setRows(d.rows || []); setTotal(d.total || 0); setLoading(false); return; }
      }
      if (gen === fedGen.current) setLoading(false); // 타임아웃(엣지 미응답)
    } catch { if (gen === fedGen.current) setLoading(false); }
  };

  const load = (reset = true) => {
    if (f.vcenterId && remoteAgent(f.vcenterId)) return federate(); // 엣지 보관 → 연합 조회
    const gen = ++fedGen.current; // 진행 중이던 연합 폴링 무효화 + 이 로컬 조회의 세대
    setMode('local'); setLoading(true);
    const off = reset ? 0 : offset;
    const qs = new URLSearchParams({ limit: String(LIMIT), offset: String(off) });
    if (f.vcenterId) qs.set('vcenterId', f.vcenterId);
    if (f.severity) qs.set('severity', f.severity);
    if (f.q) qs.set('q', f.q);
    fetchJson(`/tools/vclogs?${qs}`).then((d) => {
      if (gen !== fedGen.current) return; // 더 새 조회로 대체됨
      setTotal(d.total); setRows((prev) => (reset ? d.rows : [...prev, ...d.rows])); setOffset(off + d.rows.length);
    }).catch(() => {}).finally(() => { if (gen === fedGen.current) setLoading(false); });
  };
  useEffect(() => { load(true); /* eslint-disable-next-line */ }, [f.vcenterId, f.severity, sources]);

  const exportCsv = async () => {
    const qs = new URLSearchParams();
    if (f.vcenterId) qs.set('vcenterId', f.vcenterId);
    if (f.severity) qs.set('severity', f.severity);
    if (f.q) qs.set('q', f.q);
    const res = await fetch(`/api/tools/vclogs/export.csv?${qs}`, { headers: { Authorization: `Bearer ${getToken()}` } });
    const blob = await res.blob(); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `vcenter-logs.csv`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  return (
    <div className="card" style={{ padding: 14 }}>
      <div className="flex between wrap gap" style={{ alignItems: 'center', marginBottom: 8 }}>
        <div className="flex gap wrap" style={{ alignItems: 'center' }}>
          <select className="select" value={f.vcenterId} onChange={(e) => setF({ ...f, vcenterId: e.target.value })}>
            <option value="">전체 vCenter</option>
            {(vcs || []).map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
          </select>
          <select className="select" value={f.severity} onChange={(e) => setF({ ...f, severity: e.target.value })}>
            <option value="">전체 심각도</option><option value="error">위험</option><option value="warning">경고</option><option value="info">정보</option>
          </select>
          <input className="input" placeholder="메시지/엔티티/사용자 검색…" style={{ width: 220 }} value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && load(true)} />
          <button className="tab" style={{ padding: '6px 12px' }} onClick={() => load(true)}>검색</button>
        </div>
        <div className="flex gap" style={{ alignItems: 'center' }}>
          {mode === 'edge' && <span className="badge amber" title="데이터는 엣지에 보관, 조회만 중계">엣지 조회: {remoteAgent(f.vcenterId) || '?'}</span>}
          <span className="muted" style={{ fontSize: 12 }}>{fmtNum(total)}건</span>
          <button className="logout-btn" style={{ padding: '6px 12px' }} onClick={exportCsv} disabled={mode === 'edge'} title={mode === 'edge' ? '엣지 조회는 CSV 미지원(엣지 포탈에서 받으세요)' : ''}>⬇ CSV</button>
        </div>
      </div>
      <div className="table-wrap" style={{ maxHeight: '52vh' }}>
        <table><thead><tr><th>시각</th><th>vCenter</th><th>심각도</th><th>유형</th><th>대상</th><th>사용자</th><th>메시지</th></tr></thead>
          <tbody>
            {rows.length === 0 && !loading && <tr><td colSpan={7} className="center muted" style={{ padding: 20 }}>보관된 로그가 없습니다.</td></tr>}
            {rows.map((r, i) => {
              const [lbl, cls] = SEV[r.severity] || ['정보', 'gray'];
              return (
                <tr key={i}>
                  <td className="muted" style={{ fontSize: 11, whiteSpace: 'nowrap' }}>{fmtTime(r.ts)}</td>
                  <td className="muted" style={{ fontSize: 12 }}>{r.vcenterId}</td>
                  <td><span className={`badge ${cls}`}>{lbl}</span></td>
                  <td style={{ fontSize: 12 }}>{r.type}</td>
                  <td style={{ fontSize: 12 }}>{r.entity || '—'}</td>
                  <td className="muted" style={{ fontSize: 12 }}>{r.user || '—'}</td>
                  <td style={{ fontSize: 12 }}>{r.message}</td>
                </tr>
              );
            })}
          </tbody></table>
      </div>
      {mode === 'local' && rows.length < total && <button className="tab" style={{ marginTop: 10, padding: '7px 16px' }} disabled={loading} onClick={() => load(false)}>{loading ? '불러오는 중…' : `더 보기 (${rows.length}/${fmtNum(total)})`}</button>}
      {mode === 'edge' && loading && <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>엣지 포탈에 조회 중… (응답 대기)</div>}
    </div>
  );
}
