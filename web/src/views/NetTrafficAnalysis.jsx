import React, { useEffect, useState } from 'react';
import { fetchJson, postJson, usePolling } from '../api.js';
import { ErrorBox } from '../components/ui.jsx';

const DOT = { ok: '#22c55e', warning: '#f59e0b', error: '#ef4444' };
const SevDot = ({ s }) => <span style={{ display: 'inline-block', width: 9, height: 9, borderRadius: '50%', background: DOT[s] || '#64748b', marginRight: 7 }} />;
const Issue = ({ it }) => (
  <div className="card" style={{ padding: '10px 12px', borderLeft: `3px solid ${DOT[it.sev] || '#64748b'}`, marginBottom: 6 }}>
    <b style={{ fontSize: 13 }}><SevDot s={it.sev} />{it.title}</b>
    <div className="muted" style={{ fontSize: 12, marginTop: 3 }}>{it.detail}</div>
  </div>
);

export default function NetTrafficAnalysis() {
  return (
    <div>
      <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>통신하는 두 서버 사이의 패킷을 tcpdump로 캡처해 핸드셰이크·재전송·RST 등으로 장애/이슈를 진단하고, 보관된 로그를 자체 분석해 문제 패턴을 찾습니다.</p>
      <Capture />
      <LogIssues />
    </div>
  );
}

function StatGrid({ st }) {
  if (!st) return null;
  const cells = [['패킷', st.packets], ['SYN/SYN-ACK', `${st.syn}/${st.synAck}`], ['RST', st.rst, st.rst ? '#ef4444' : ''], ['재전송', `${st.retransPct}%`, st.retransPct >= 5 ? '#f59e0b' : ''], ['RTT', st.rttMs != null ? `${st.rttMs} ms` : '—'], ['송신', `${st.toPeer.packets}p`], ['수신', `${st.fromPeer.packets}p`], ['기간', `${st.durSec}s`]];
  return (
    <div className="flex gap wrap" style={{ marginBottom: 8 }}>
      {cells.map(([l, v, c]) => <div key={l} className="card" style={{ padding: '6px 10px', minWidth: 76 }}><div className="muted" style={{ fontSize: 10 }}>{l}</div><div style={{ fontSize: 15, fontWeight: 700, color: c || 'inherit' }}>{v}</div></div>)}
    </div>
  );
}
const SingleResult = ({ res }) => {
  const st = res?.analysis?.stat; if (!st) return res?.reason ? <ErrorBox message={res.reason} /> : null;
  return (
    <div>
      {res.warn && <div className="badge red" style={{ whiteSpace: 'normal', marginBottom: 8 }}>경고: {res.warn}</div>}
      <StatGrid st={st} />
      {res.analysis.issues.map((it, i) => <Issue key={i} it={it} />)}
      {(st.topPorts || []).length > 0 && <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>주요 포트: {st.topPorts.map((p) => `${p.port}(${p.packets})`).join(', ')}</div>}
      {(res.sample || []).length > 0 && (
        <details style={{ marginTop: 8 }}><summary className="muted" style={{ fontSize: 12, cursor: 'pointer' }}>원본 패킷 샘플 ({res.sample.length})</summary>
          <pre style={{ fontSize: 11, maxHeight: '26vh', overflow: 'auto', background: 'rgba(148,163,184,.08)', padding: 8, borderRadius: 6, marginTop: 6 }}>{res.sample.join('\n')}</pre></details>
      )}
    </div>
  );
};
const DualResult = ({ res }) => (
  <div>
    <div className="section-title" style={{ fontSize: 14 }}>🔀 양방향 경로 비교</div>
    {(res.comparison?.issues || []).map((it, i) => <Issue key={i} it={it} />)}
    <div className="flex gap wrap" style={{ marginTop: 10 }}>
      <div style={{ flex: '1 1 340px' }}>
        <div className="muted" style={{ fontSize: 13, marginBottom: 6, fontWeight: 600 }}>A 관점 ({res.hostA}) {res.a?.captured != null && `· ${res.a.captured}패킷`}</div>
        <SingleResult res={res.a} />
      </div>
      <div style={{ flex: '1 1 340px' }}>
        <div className="muted" style={{ fontSize: 13, marginBottom: 6, fontWeight: 600 }}>B 관점 ({res.hostB}) {res.b?.captured != null && `· ${res.b.captured}패킷`}</div>
        <SingleResult res={res.b} />
      </div>
    </div>
  </div>
);

function Capture() {
  const [f, setF] = useState({ host: '', port: 22, username: 'root', password: '', peer: '', bHost: '', bPort: 22, bUser: 'root', bPass: '', iface: 'any', seconds: 10, maxPackets: 2000, useSudo: true });
  const [mode, setMode] = useState('single'); // 'single' | 'dual'
  const [via, setVia] = useState('central');  // 'central' | 'agent'
  const [agent, setAgent] = useState('');
  const [agents, setAgents] = useState([]);
  const [res, setRes] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  useEffect(() => { fetchJson('/admin/net/agents').then((d) => setAgents(d.agents || [])).catch(() => {}); }, []);

  const run = async () => {
    setBusy(true); setErr(null); setRes(null);
    const body = {
      via, agent, dual: mode === 'dual',
      hostA: { host: f.host, port: Number(f.port) || 22, username: f.username, password: f.password },
      iface: f.iface, seconds: Number(f.seconds), maxPackets: Number(f.maxPackets), useSudo: f.useSudo,
    };
    if (mode === 'dual') body.hostB = { host: f.bHost, port: Number(f.bPort) || 22, username: f.bUser, password: f.bPass };
    else body.peer = f.peer;
    try {
      const r = await postJson('/admin/net/capture', body);
      if (r.delegated && r.reqId) {
        // 에이전트 위임 → 결과 폴링.
        const maxTries = Math.ceil((Number(f.seconds) + 30) / 2);
        for (let i = 0; i < maxTries; i++) {
          await new Promise((x) => setTimeout(x, 2000));
          const p = await fetchJson(`/admin/net/capture?reqId=${encodeURIComponent(r.reqId)}`);
          if (p.state === 'done') { setRes(p.result); setBusy(false); return; }
        }
        setErr('에이전트 응답 시간 초과(엣지 캡처 워커 상태 확인).'); return;
      }
      setRes(r);
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  const canRun = f.host && (mode === 'dual' ? f.bHost : f.peer) && (via === 'central' || agent);

  return (
    <div className="card" style={{ padding: 16, marginBottom: 16 }}>
      <div className="flex between wrap" style={{ alignItems: 'center' }}>
        <div className="section-title" style={{ marginTop: 0, fontSize: 15 }}>🔎 tcpdump 캡처 & 분석</div>
        <div className="flex gap" style={{ alignItems: 'center' }}>
          <div className="flex gap" style={{ alignItems: 'center' }}>
            {[['single', '단일'], ['dual', '동시(양방향)']].map(([k, l]) => <button key={k} className={mode === k ? 'login-btn' : 'tab'} style={{ padding: '5px 11px' }} onClick={() => setMode(k)}>{l}</button>)}
          </div>
          <select className="select" value={via} onChange={(e) => setVia(e.target.value)} title="실행 위치">
            <option value="central">중앙 직접 실행</option>
            <option value="agent">엣지 에이전트 위임</option>
          </select>
          {via === 'agent' && <select className="select" value={agent} onChange={(e) => setAgent(e.target.value)}><option value="">에이전트 선택</option>{agents.map((a) => <option key={a} value={a}>{a}</option>)}</select>}
        </div>
      </div>
      {/* A 서버 */}
      <div className="muted" style={{ fontSize: 12, margin: '8px 0 4px' }}>A 서버 (SSH 접속해 캡처)</div>
      <div className="flex gap wrap" style={{ alignItems: 'center', gap: 10 }}>
        <input className="input" placeholder="A 호스트/IP" style={{ width: 190 }} value={f.host} onChange={(e) => setF({ ...f, host: e.target.value })} />
        <input className="input" placeholder="포트" style={{ width: 64 }} value={f.port} onChange={(e) => setF({ ...f, port: e.target.value })} />
        <input className="input" placeholder="사용자" style={{ width: 100 }} value={f.username} onChange={(e) => setF({ ...f, username: e.target.value })} />
        <input className="input" type="password" placeholder="비밀번호" style={{ width: 120 }} value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} />
      </div>
      {/* B 서버 */}
      <div className="muted" style={{ fontSize: 12, margin: '10px 0 4px' }}>{mode === 'dual' ? 'B 서버 (동시 캡처)' : 'B 대상 (필터 IP)'}</div>
      {mode === 'dual' ? (
        <div className="flex gap wrap" style={{ alignItems: 'center', gap: 10 }}>
          <input className="input" placeholder="B 호스트/IP" style={{ width: 190 }} value={f.bHost} onChange={(e) => setF({ ...f, bHost: e.target.value })} />
          <input className="input" placeholder="포트" style={{ width: 64 }} value={f.bPort} onChange={(e) => setF({ ...f, bPort: e.target.value })} />
          <input className="input" placeholder="사용자" style={{ width: 100 }} value={f.bUser} onChange={(e) => setF({ ...f, bUser: e.target.value })} />
          <input className="input" type="password" placeholder="비밀번호" style={{ width: 120 }} value={f.bPass} onChange={(e) => setF({ ...f, bPass: e.target.value })} />
        </div>
      ) : (
        <input className="input" placeholder="대상 B 서버 IP" style={{ width: 200 }} value={f.peer} onChange={(e) => setF({ ...f, peer: e.target.value })} />
      )}
      {/* 공통 옵션 */}
      <div className="flex gap wrap" style={{ alignItems: 'center', gap: 10, marginTop: 10 }}>
        <span className="muted">인터페이스</span><input className="input" style={{ width: 84 }} value={f.iface} onChange={(e) => setF({ ...f, iface: e.target.value })} />
        <span className="muted">시간</span><input className="input" type="number" style={{ width: 64 }} value={f.seconds} onChange={(e) => setF({ ...f, seconds: e.target.value })} /><span className="muted">초</span>
        <span className="muted">최대</span><input className="input" type="number" style={{ width: 84 }} value={f.maxPackets} onChange={(e) => setF({ ...f, maxPackets: e.target.value })} /><span className="muted">패킷</span>
        <label className="flex gap" style={{ alignItems: 'center', fontSize: 12, cursor: 'pointer' }}><input type="checkbox" checked={f.useSudo} onChange={(e) => setF({ ...f, useSudo: e.target.checked })} /> sudo(비root)</label>
        <button className="login-btn" style={{ padding: '8px 16px' }} disabled={busy || !canRun} onClick={run}>{busy ? (via === 'agent' ? '에이전트 캡처 중…' : '캡처 중…') : (mode === 'dual' ? '동시 캡처 & 비교' : '캡처 & 분석')}</button>
      </div>
      <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>※ tcpdump는 root 권한 필요(비root는 무비밀번호 sudo). {mode === 'dual' ? 'A·B에서 동시에 캡처해 양쪽 관점을 비교합니다.' : `A에서 host ${f.peer || 'B'} 필터로 캡처합니다.`}{via === 'agent' && ' 엣지 에이전트가 대신 실행(사설망).'}</div>
      {err && <div style={{ marginTop: 10 }}><ErrorBox message={err} /></div>}
      {res && <div style={{ marginTop: 14 }}>{res.dual ? <DualResult res={res} /> : <SingleResult res={res} />}</div>}
    </div>
  );
}

function LogIssues() {
  const { data: vcs } = usePolling('/vcenters', {}, 60_000);
  const [vc, setVc] = useState('');
  const [days, setDays] = useState(7);
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const load = () => fetchJson(`/admin/net/log-issues?days=${days}${vc ? `&vcenterId=${encodeURIComponent(vc)}` : ''}`).then((r) => { setD(r); setErr(null); }).catch((e) => setErr(e.message));
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [vc, days]);
  return (
    <div className="card" style={{ padding: 16 }}>
      <div className="flex between wrap" style={{ alignItems: 'center', marginBottom: 8 }}>
        <div className="section-title" style={{ marginTop: 0, fontSize: 15 }}>🩺 로그 자체 분석 (장애/이슈 탐지)</div>
        <div className="flex gap" style={{ alignItems: 'center' }}>
          <select className="select" value={vc} onChange={(e) => setVc(e.target.value)}><option value="">전체 vCenter</option>{(vcs || []).map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}</select>
          <select className="select" value={days} onChange={(e) => setDays(Number(e.target.value))}>{[1, 7, 30, 90].map((x) => <option key={x} value={x}>최근 {x}일</option>)}</select>
        </div>
      </div>
      {err ? <ErrorBox message={err} /> : !d ? <div className="muted">분석 중…</div> : (
        <>
          <div className="muted" style={{ fontSize: 12, marginBottom: 10 }}>오류 {d.summary.errors} · 경고 {d.summary.warnings} · 시간당 최대 {d.summary.peakPerHour}(평균 {d.summary.avgPerHour})</div>
          {d.patterns.map((p, i) => <Issue key={i} it={p} />)}
          <div className="flex gap wrap" style={{ marginTop: 10 }}>
            <div style={{ flex: '1 1 280px' }}>
              <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>오류 유형 Top</div>
              {(d.topTypes || []).map((t) => <div key={t.key} style={{ fontSize: 12 }}>{t.key} <b>{t.count}</b></div>)}
              {!(d.topTypes || []).length && <span className="muted" style={{ fontSize: 12 }}>—</span>}
            </div>
            <div style={{ flex: '1 1 280px' }}>
              <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>오류 집중 대상 Top</div>
              {(d.topEntities || []).map((t) => <div key={t.key} style={{ fontSize: 12 }}>{t.key} <b>{t.count}</b></div>)}
              {!(d.topEntities || []).length && <span className="muted" style={{ fontSize: 12 }}>—</span>}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
