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

function Capture() {
  const [f, setF] = useState({ host: '', port: 22, username: 'root', password: '', peer: '', iface: 'any', seconds: 10, maxPackets: 2000, useSudo: true });
  const [res, setRes] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const run = async () => {
    setBusy(true); setErr(null); setRes(null);
    try {
      const r = await postJson('/admin/net/capture', {
        hostA: { host: f.host, port: Number(f.port) || 22, username: f.username, password: f.password },
        peer: f.peer, iface: f.iface, seconds: Number(f.seconds), maxPackets: Number(f.maxPackets), useSudo: f.useSudo,
      });
      setRes(r);
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  const st = res?.analysis?.stat;
  return (
    <div className="card" style={{ padding: 16, marginBottom: 16 }}>
      <div className="section-title" style={{ marginTop: 0, fontSize: 15 }}>🔎 tcpdump 캡처 & 분석</div>
      <div className="flex gap wrap" style={{ alignItems: 'center', gap: 10 }}>
        <input className="input" placeholder="A 서버 호스트/IP (SSH 접속)" style={{ width: 200 }} value={f.host} onChange={(e) => setF({ ...f, host: e.target.value })} />
        <input className="input" placeholder="포트" style={{ width: 70 }} value={f.port} onChange={(e) => setF({ ...f, port: e.target.value })} />
        <input className="input" placeholder="SSH 사용자" style={{ width: 110 }} value={f.username} onChange={(e) => setF({ ...f, username: e.target.value })} />
        <input className="input" type="password" placeholder="비밀번호" style={{ width: 130 }} value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} />
      </div>
      <div className="flex gap wrap" style={{ alignItems: 'center', gap: 10, marginTop: 10 }}>
        <input className="input" placeholder="대상 B 서버 IP (필터)" style={{ width: 200 }} value={f.peer} onChange={(e) => setF({ ...f, peer: e.target.value })} />
        <input className="input" placeholder="인터페이스" style={{ width: 90 }} value={f.iface} onChange={(e) => setF({ ...f, iface: e.target.value })} title="any 또는 eth0 등" />
        <span className="muted">시간</span><input className="input" type="number" style={{ width: 70 }} value={f.seconds} onChange={(e) => setF({ ...f, seconds: e.target.value })} /><span className="muted">초</span>
        <span className="muted">최대</span><input className="input" type="number" style={{ width: 90 }} value={f.maxPackets} onChange={(e) => setF({ ...f, maxPackets: e.target.value })} /><span className="muted">패킷</span>
        <label className="flex gap" style={{ alignItems: 'center', fontSize: 12, cursor: 'pointer' }}><input type="checkbox" checked={f.useSudo} onChange={(e) => setF({ ...f, useSudo: e.target.checked })} /> sudo(비root)</label>
        <button className="login-btn" style={{ padding: '8px 16px' }} disabled={busy || !f.host || !f.peer} onClick={run}>{busy ? '캡처 중…' : '캡처 & 분석'}</button>
      </div>
      <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>※ A 서버에서 <code>tcpdump host {f.peer || 'B'}</code>를 {f.seconds}초/{f.maxPackets}패킷 한도로 실행합니다. tcpdump는 root 권한 필요(비root는 무비밀번호 sudo).</div>
      {err && <div style={{ marginTop: 10 }}><ErrorBox message={err} /></div>}
      {res && (
        <div style={{ marginTop: 14 }}>
          {res.warn && <div className="badge red" style={{ whiteSpace: 'normal', marginBottom: 8 }}>경고: {res.warn}</div>}
          <div className="flex gap wrap" style={{ marginBottom: 10 }}>
            {[['패킷', st.packets], ['SYN/SYN-ACK', `${st.syn}/${st.synAck}`], ['RST', st.rst, st.rst ? '#ef4444' : ''], ['재전송', `${st.retransPct}%`, st.retransPct >= 5 ? '#f59e0b' : ''], ['RTT', st.rttMs != null ? `${st.rttMs} ms` : '—'], ['→B', `${st.toPeer.packets}p`], ['B→', `${st.fromPeer.packets}p`], ['기간', `${st.durSec}s`]].map(([l, v, c]) => (
              <div key={l} className="card" style={{ padding: '8px 12px', minWidth: 88 }}><div className="muted" style={{ fontSize: 11 }}>{l}</div><div style={{ fontSize: 17, fontWeight: 700, color: c || 'inherit' }}>{v}</div></div>
            ))}
          </div>
          <div className="section-title" style={{ fontSize: 14 }}>진단</div>
          {res.analysis.issues.map((it, i) => <Issue key={i} it={it} />)}
          {(st.topPorts || []).length > 0 && <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>주요 포트: {st.topPorts.map((p) => `${p.port}(${p.packets})`).join(', ')}</div>}
          {(res.sample || []).length > 0 && (
            <details style={{ marginTop: 8 }}>
              <summary className="muted" style={{ fontSize: 12, cursor: 'pointer' }}>원본 패킷 샘플 ({res.sample.length})</summary>
              <pre style={{ fontSize: 11, maxHeight: '30vh', overflow: 'auto', background: 'rgba(148,163,184,.08)', padding: 8, borderRadius: 6, marginTop: 6 }}>{res.sample.join('\n')}</pre>
            </details>
          )}
        </div>
      )}
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
