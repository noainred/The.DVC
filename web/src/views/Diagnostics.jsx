import React, { useEffect, useRef, useState } from 'react';
import { fetchJson } from '../api.js';
import { Loading, ErrorBox } from '../components/ui.jsx';

const LEVEL_COLOR = { error: '#f87171', warn: '#fbbf24', info: '#93c5fd' };

// 검색어와 일치하는 부분을 강조(대소문자 무시). q가 비면 원문 그대로.
function highlight(msg, q) {
  const text = String(msg ?? '');
  if (!q) return text;
  const lower = text.toLowerCase();
  const out = [];
  let i = 0;
  let n = 0;
  while (i < text.length) {
    const idx = lower.indexOf(q, i);
    if (idx === -1) { out.push(text.slice(i)); break; }
    if (idx > i) out.push(text.slice(i, idx));
    out.push(<mark key={n++} className="log-hl">{text.slice(idx, idx + q.length)}</mark>);
    i = idx + q.length;
  }
  return out;
}

export default function Diagnostics() {
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);

  // log viewer state
  const [logs, setLogs] = useState([]);
  const [level, setLevel] = useState('all');
  const [query, setQuery] = useState('');
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
  const q = query.trim().toLowerCase();
  const shown = logs.filter((l) =>
    (level === 'all' || l.level === level) &&
    (!q || String(l.msg || '').toLowerCase().includes(q)),
  );

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
            <RelayTest vcenterId={e.vcenterId} />
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
            <input
              className="select select-sm"
              style={{ minWidth: 180 }}
              placeholder="🔍 검색어 포함 줄만…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            {query && (
              <button className="logout-btn" onClick={() => setQuery('')} title="검색어 지우기">✕</button>
            )}
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
          {shown.length === 0 && (
            <div className="muted" style={{ padding: 16 }}>
              {logs.length === 0 ? '로그가 없습니다.' : '검색/필터 조건에 맞는 로그가 없습니다.'}
            </div>
          )}
          {shown.map((l) => (
            <div key={l.id} className="log-line">
              <span className="log-time">{new Date(l.time).toLocaleTimeString('ko-KR', { hour12: false })}</span>
              <span className="log-level" style={{ color: LEVEL_COLOR[l.level] || '#93c5fd' }}>{l.level.toUpperCase().padEnd(5)}</span>
              <span className="log-msg">{highlight(l.msg, q)}</span>
            </div>
          ))}
        </div>
        <div className="muted" style={{ marginTop: 8, fontSize: 12 }}>
          {q || level !== 'all'
            ? <>표시 {shown.length}줄 / 최근 {logs.length}줄 (필터 적용)</>
            : <>최근 {logs.length}줄</>} (서버 메모리 버퍼, 3초마다 갱신) · 전체 로그는 호스트에서
          <code> journalctl -u vmware-portal -f</code> 로도 볼 수 있습니다.
        </div>
      </div>
    </>
  );
}

/** vCenter 중계 경로 단계별 진단 — TCP → TLS → HTTP 어디서 막혔는지 보여준다. */
function RelayTest({ vcenterId }) {
  const [busy, setBusy] = useState(false);
  const [r, setR] = useState(null);
  const run = async () => {
    setBusy(true); setR(null);
    try { setR(await fetchJson(`/admin/vcenter/relay-test?vcenterId=${encodeURIComponent(vcenterId)}`)); }
    catch (e) { setR({ ok: false, reason: e.message }); }
    setBusy(false);
  };
  const Step = ({ label, s }) => {
    if (!s) return <span className="badge gray" style={{ marginRight: 6 }}>{label} —</span>;
    return <span className={`badge ${s.ok ? 'green' : 'red'}`} style={{ marginRight: 6 }} title={s.error || ''}>{label} {s.ok ? '✓' : '✗'}{s.ms != null ? ` ${s.ms}ms` : ''}</span>;
  };
  return (
    <div style={{ marginTop: 8 }}>
      <button className="logout-btn" style={{ padding: '5px 12px', fontSize: 12 }} disabled={busy} onClick={run}>{busy ? '진단 중…' : '🔎 중계 경로 테스트 (TCP·TLS·HTTP)'}</button>
      {r && (r.ok === false ? (
        <div className="diag-err-msg" style={{ marginTop: 6 }}>{r.reason}</div>
      ) : (
        <div style={{ marginTop: 8, fontSize: 13 }}>
          <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>대상 {r.host}:{r.port}</div>
          <div style={{ marginBottom: 6 }}>
            <Step label="TCP 연결" s={r.steps.tcp} />
            <Step label="TLS 핸드셰이크" s={r.steps.tls} />
            <Step label="HTTP 응답" s={r.steps.http} />
          </div>
          <div className={`diag-err-hint`} style={{ color: r.verdict.state === 'ok' ? 'var(--green)' : 'var(--amber)' }}>
            {r.verdict.state === 'ok' ? '✅' : '⚠️'} {r.verdict.text}
          </div>
        </div>
      ))}
    </div>
  );
}
