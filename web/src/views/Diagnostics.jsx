import React, { useEffect, useRef, useState } from 'react';
import { fetchJson } from '../api.js';
import { Loading, ErrorBox } from '../components/ui.jsx';

const LEVEL_COLOR = { error: '#f87171', warn: '#fbbf24', info: '#93c5fd' };

export default function Diagnostics() {
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);

  // log viewer state
  const [logs, setLogs] = useState([]);
  const [level, setLevel] = useState('all');
  const [paused, setPaused] = useState(false);
  const [autoscroll, setAutoscroll] = useState(true);
  const sinceRef = useRef(0);
  const pausedRef = useRef(false);
  const levelRef = useRef('all');
  const consoleRef = useRef(null);
  pausedRef.current = paused;
  levelRef.current = level;

  // poll collection status (vCenter connection reasons)
  useEffect(() => {
    let on = true;
    const tick = async () => {
      try { const s = await fetchJson('/admin/status'); if (on) { setStatus(s); setError(null); } }
      catch (e) { if (on) setError(e.message); }
    };
    tick();
    const t = setInterval(tick, 10_000);
    return () => { on = false; clearInterval(t); };
  }, []);

  // poll server logs incrementally
  useEffect(() => {
    let on = true;
    const tick = async () => {
      if (pausedRef.current) return;
      try {
        const r = await fetchJson('/admin/logs', { since: sinceRef.current });
        if (!on) return;
        sinceRef.current = r.lastId;
        if (r.items?.length) {
          setLogs((prev) => [...prev, ...r.items].slice(-600));
        }
      } catch { /* ignore transient */ }
    };
    tick();
    const t = setInterval(tick, 3000);
    return () => { on = false; clearInterval(t); };
  }, []);

  // autoscroll to bottom when new logs arrive
  useEffect(() => {
    if (autoscroll && consoleRef.current) consoleRef.current.scrollTop = consoleRef.current.scrollHeight;
  }, [logs, autoscroll]);

  if (error) return <ErrorBox message={error} />;
  if (!status) return <Loading />;

  const errs = status.collectionErrors || [];
  const shown = level === 'all' ? logs : logs.filter((l) => l.level === level);

  return (
    <>
      <div className="section-title">vCenter 연결 진단</div>
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="flex between wrap" style={{ marginBottom: 10 }}>
          <span className="muted">데이터 소스: <b style={{ color: 'var(--text)' }}>{status.dataSource}</b> · vCenter {status.vcenters}개
            {status.generatedAt && <> · 갱신 {new Date(status.generatedAt).toLocaleTimeString('ko-KR')}</>}
          </span>
        </div>

        {status.dataSource === 'mock' && (
          <div className="muted" style={{ fontSize: 13 }}>
            현재 <code>mock</code>(데모) 모드라 실제 연결 시도가 없습니다. 실제 진단을 보려면
            서버를 <code>DATA_SOURCE=live</code> 또는 <code>auto</code> 로 실행하세요.
          </div>
        )}

        {status.dataSource !== 'mock' && errs.length === 0 && (
          <div className="badge green" style={{ fontSize: 13, padding: '6px 12px' }}>✓ 모든 vCenter 연결 정상</div>
        )}

        {errs.map((e) => (
          <div key={e.vcenterId} className="diag-err">
            <div className="diag-err-head">
              <span className="badge red">연결 실패</span>
              <b>{e.name}</b> <span className="muted">({e.vcenterId})</span>
              {e.fallback && <span className="badge amber" style={{ marginLeft: 6 }}>데모 데이터로 대체 중</span>}
            </div>
            <div className="diag-err-msg">{e.message}</div>
            {e.hint && <div className="diag-err-hint">💡 {e.hint}</div>}
          </div>
        ))}
      </div>

      <div className="section-title">서버 로그</div>
      <div className="card">
        <div className="flex between wrap gap" style={{ marginBottom: 10 }}>
          <div className="flex gap">
            <select className="select select-sm" value={level} onChange={(e) => setLevel(e.target.value)}>
              <option value="all">전체</option>
              <option value="info">info</option>
              <option value="warn">warn</option>
              <option value="error">error</option>
            </select>
            <label className="muted flex gap" style={{ alignItems: 'center', fontSize: 12 }}>
              <input type="checkbox" checked={autoscroll} onChange={(e) => setAutoscroll(e.target.checked)} /> 자동 스크롤
            </label>
          </div>
          <div className="flex gap">
            <button className="logout-btn" onClick={() => setPaused((p) => !p)}>{paused ? '▶ 재개' : '⏸ 일시정지'}</button>
            <button className="logout-btn" onClick={() => setLogs([])}>지우기</button>
          </div>
        </div>

        <div className="log-console" ref={consoleRef}>
          {shown.length === 0 && <div className="muted" style={{ padding: 16 }}>로그가 없습니다.</div>}
          {shown.map((l) => (
            <div key={l.id} className="log-line">
              <span className="log-time">{new Date(l.time).toLocaleTimeString('ko-KR', { hour12: false })}</span>
              <span className="log-level" style={{ color: LEVEL_COLOR[l.level] || '#93c5fd' }}>{l.level.toUpperCase().padEnd(5)}</span>
              <span className="log-msg">{l.msg}</span>
            </div>
          ))}
        </div>
        <div className="muted" style={{ marginTop: 8, fontSize: 12 }}>
          최근 {logs.length}줄 (서버 메모리 버퍼, 3초마다 갱신) · 전체 로그는 호스트에서
          <code> journalctl -u vmware-portal -f</code> 로도 볼 수 있습니다.
        </div>
      </div>
    </>
  );
}
