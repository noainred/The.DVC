import React, { useEffect, useRef, useState } from 'react';
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, Legend } from 'recharts';
import { fetchJson } from '../api.js';
import { Loading, ErrorBox } from '../components/ui.jsx';

const LEVEL_COLOR = { error: '#f87171', warn: '#fbbf24', info: '#93c5fd' };

// 메모리 추세 판정 배지 색 — 서버(/admin/memtrack) verdict.level 기준.
const VERDICT_BADGE = {
  stable: { cls: 'badge green', icon: '✓' },
  watch: { cls: 'badge amber', icon: '👀' },
  growing: { cls: 'badge red', icon: '⚠️' },
  insufficient: { cls: 'badge gray', icon: '⏳' },
};

const fmtUptime = (sec) => {
  if (sec == null) return '—';
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  return d > 0 ? `${d}일 ${h}시간` : h > 0 ? `${h}시간 ${m}분` : `${m}분`;
};

const fmtMemTick = (ts, win) => {
  const d = new Date(ts);
  if (win === '7d' || win === '30d') return `${d.getMonth() + 1}.${d.getDate()} ${String(d.getHours()).padStart(2, '0')}시`;
  return d.toLocaleTimeString('ko-KR', { hour12: false, hour: '2-digit', minute: '2-digit' });
};

// 추세 한 줄 표기: +2.1MB/일 (r²=0.82, 3.2일 관측)
const fmtTrend = (t) => {
  if (!t) return '표본 부족';
  const days = (t.spanMs / 86_400_000).toFixed(1);
  return `${t.mbPerDay >= 0 ? '+' : ''}${t.mbPerDay}MB/일 (r²=${t.r2}, ${days}일 관측)`;
};

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

  // 서버 메모리(누수 추적) 폴링 — 60초. 창 변경 시 즉시 재조회. 훅은 조기 return 위에(React #310).
  const [mem, setMem] = useState(null);
  const [memWin, setMemWin] = useState('24h');
  useEffect(() => {
    let on = true;
    const tick = async () => {
      try { const r = await fetchJson('/admin/memtrack', { window: memWin }); if (on) setMem(r); }
      catch { /* 일시 폴링 오류는 직전 데이터 유지(CLAUDE.md 폴링 뷰 원칙) */ }
    };
    tick();
    const t = setInterval(tick, 60_000);
    return () => { on = false; clearInterval(t); };
  }, [memWin]);

  if (error && !status) return <ErrorBox message={error} />; // 데이터 보유 중 일시 폴링 오류로 라이브 로그 콘솔까지 갈아치우지 않음(CLAUDE.md)
  if (!status) return <Loading />;

  // 시계열 병합(ts 기준) — rss/heapUsed/heapTotal 을 recharts 한 데이터셋으로.
  const memChart = (() => {
    if (!mem?.series) return [];
    const by = new Map();
    const put = (arr, key) => {
      for (const p of arr || []) { const o = by.get(p.ts) || { ts: p.ts }; o[key] = p.avg; by.set(p.ts, o); }
    };
    put(mem.series.rss, 'rss'); put(mem.series.heapUsed, 'heapUsed'); put(mem.series.heapTotal, 'heapTotal');
    return [...by.values()].sort((a, b) => a.ts - b.ts).map((o) => ({ ...o, label: fmtMemTick(o.ts, mem.window) }));
  })();
  const verdict = mem?.trend?.verdict;
  const vb = VERDICT_BADGE[verdict?.level] || VERDICT_BADGE.insufficient;

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

      <div className="section-title">서버 메모리 (누수 추적)</div>
      <div className="card" style={{ marginBottom: 16 }}>
        {!mem ? (
          <div className="muted" style={{ fontSize: 13 }}>메모리 추적 데이터를 불러오는 중…</div>
        ) : (
          <>
            <div className="flex between wrap gap" style={{ marginBottom: 10 }}>
              <span className={vb.cls} style={{ fontSize: 13, padding: '6px 12px' }} title={verdict?.text || ''}>
                {vb.icon} {verdict?.text || '판정 대기'}
              </span>
              <div className="flex gap" style={{ alignItems: 'center' }}>
                <span className="muted" style={{ fontSize: 12 }}>
                  표본 {(mem.meta?.count || 0).toLocaleString()}건
                  {mem.meta?.firstTs ? ` · 수집 개시 ${new Date(mem.meta.firstTs).toLocaleDateString('ko-KR')}` : ''}
                </span>
                <select className="select select-sm" value={memWin} onChange={(e) => setMemWin(e.target.value)}>
                  <option value="6h">최근 6시간</option>
                  <option value="24h">최근 24시간</option>
                  <option value="7d">최근 7일</option>
                  <option value="30d">최근 30일</option>
                </select>
              </div>
            </div>

            <div className="flex wrap gap" style={{ marginBottom: 10, rowGap: 8 }}>
              {[
                ['RSS(실점유)', `${(mem.current?.rssMB ?? 0).toLocaleString()} MB`],
                ['Heap 사용/예약', `${(mem.current?.heapUsedMB ?? 0).toLocaleString()} / ${(mem.current?.heapTotalMB ?? 0).toLocaleString()} MB`],
                ['External(네이티브)', `${(mem.current?.externalMB ?? 0).toLocaleString()} MB`],
                ['ArrayBuffer', `${(mem.current?.arrayBuffersMB ?? 0).toLocaleString()} MB`],
                ['프로세스 기동 후', fmtUptime(mem.uptimeSec)],
              ].map(([label, value]) => (
                <div key={label} style={{ minWidth: 130, marginRight: 14 }}>
                  <div className="muted" style={{ fontSize: 11.5 }}>{label}</div>
                  <div style={{ fontSize: 15, fontWeight: 600 }}>{value}</div>
                </div>
              ))}
            </div>

            <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
              추세(현재 기동 이후만 계산 — 재시작 리셋 구간 제외): 힙 사용 <b style={{ color: 'var(--text)' }}>{fmtTrend(mem.trend?.heapUsed)}</b>
              {' · '}RSS <b style={{ color: 'var(--text)' }}>{fmtTrend(mem.trend?.rss)}</b>
            </div>

            {memChart.length === 0 ? (
              <div className="muted" style={{ fontSize: 13 }}>
                아직 표본이 없습니다 — 메트릭 샘플러가 1분 주기(설정 가능)로 적재합니다. 잠시 후 다시 확인하세요.
              </div>
            ) : (
              <div style={{ width: '100%', height: 220 }}>
                <ResponsiveContainer>
                  <LineChart data={memChart} margin={{ top: 6, right: 16, bottom: 4, left: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(148,163,184,.18)" />
                    <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                    <YAxis tick={{ fontSize: 11 }} domain={['auto', 'auto']} unit=" MB" width={72} />
                    <Tooltip contentStyle={{ background: '#0f172a', border: '1px solid rgba(148,163,184,.3)', fontSize: 12 }}
                      formatter={(v, n) => [`${Number(v).toLocaleString()} MB`, n === 'rss' ? 'RSS(실점유)' : n === 'heapUsed' ? 'Heap 사용' : 'Heap 예약']} />
                    <Legend wrapperStyle={{ fontSize: 12 }} formatter={(v) => (v === 'rss' ? 'RSS(실점유)' : v === 'heapUsed' ? 'Heap 사용' : 'Heap 예약')} />
                    <Line type="monotone" dataKey="rss" stroke="#60a5fa" strokeWidth={2} dot={false} />
                    <Line type="monotone" dataKey="heapUsed" stroke="#22c55e" strokeWidth={2} dot={false} />
                    <Line type="monotone" dataKey="heapTotal" stroke="#94a3b8" strokeWidth={1} strokeDasharray="4 3" dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            )}
            <div className="muted" style={{ marginTop: 8, fontSize: 12 }}>
              판정은 최소자승 추세 기반의 <b>관찰 신호</b>이며 누수 확정이 아닙니다. 서버 로그에도 시간당 1줄씩
              <code> [memtrack] rss=… heap=…</code> 상태가 남습니다(아래 서버 로그에서 <code>memtrack</code> 검색).
            </div>
          </>
        )}
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
              <span className="log-level" style={{ color: LEVEL_COLOR[l.level] || '#93c5fd' }}>{String(l.level || 'info').toUpperCase().padEnd(5)}</span>
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
