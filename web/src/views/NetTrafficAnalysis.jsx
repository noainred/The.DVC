import React, { useEffect, useState } from 'react';
import { fetchJson, postJson, putJson, delJson, usePolling } from '../api.js';
import { ErrorBox, Modal } from '../components/ui.jsx';

const DOT = { ok: '#22c55e', warning: '#f59e0b', error: '#ef4444' };
const SevDot = ({ s }) => <span style={{ display: 'inline-block', width: 9, height: 9, borderRadius: '50%', background: DOT[s] || '#64748b', marginRight: 7 }} />;
const Issue = ({ it }) => (
  <div className="card" style={{ padding: '10px 12px', borderLeft: `3px solid ${DOT[it.sev] || '#64748b'}`, marginBottom: 6 }}>
    <b style={{ fontSize: 13 }}><SevDot s={it.sev} />{it.title}</b>
    <div className="muted" style={{ fontSize: 12, marginTop: 3 }}>{it.detail}</div>
  </div>
);

const fmtTime = (ts) => (ts ? new Date(ts).toLocaleString('ko-KR') : '—');
const worstBadge = (w) => <span className={`badge ${w === 'error' ? 'red' : w === 'warning' ? 'amber' : 'green'}`}>{w === 'error' ? '이슈' : w === 'warning' ? '주의' : '정상'}</span>;

function History() {
  const [d, setD] = useState(null); const [sel, setSel] = useState(null);
  const load = () => fetchJson('/admin/net/history').then((r) => setD(r.captures || [])).catch(() => setD([]));
  useEffect(() => { load(); }, []);
  const view = async (id) => { try { setSel(await fetchJson(`/admin/net/history/${id}`)); } catch { /* */ } };
  return (
    <div className="card" style={{ padding: 14 }}>
      <div className="flex between" style={{ alignItems: 'center', marginBottom: 8 }}>
        <div className="section-title" style={{ marginTop: 0, fontSize: 15 }}>캡처 이력</div>
        <button className="logout-btn" style={{ padding: '6px 12px' }} onClick={load}>⟳</button>
      </div>
      {!d ? <div className="muted">불러오는 중…</div> : d.length === 0 ? <div className="muted" style={{ fontSize: 12 }}>저장된 캡처가 없습니다.</div> : (
        <div className="table-wrap" style={{ maxHeight: '54vh' }}>
          <table><thead><tr><th>시각</th><th>구분</th><th>모드</th><th>A ↔ B</th><th>결과</th><th>진단</th></tr></thead>
            <tbody>{d.map((c) => (
              <tr key={c.id} style={{ cursor: 'pointer' }} onClick={() => view(c.id)}>
                <td className="muted" style={{ fontSize: 11, whiteSpace: 'nowrap' }}>{fmtTime(c.at)}</td>
                <td style={{ fontSize: 12 }}>{c.source === 'monitor' ? `모니터${c.monitorName ? `(${c.monitorName})` : ''}` : '수동'}{c.via === 'agent' ? '·위임' : ''}</td>
                <td style={{ fontSize: 12 }}>{c.mode === 'dual' ? '동시' : '단일'}</td>
                <td style={{ fontSize: 12 }}>{c.hostA} ↔ {c.hostB}</td>
                <td>{worstBadge(c.worst)}</td>
                <td className="muted" style={{ fontSize: 12 }}>{(c.issues || [])[0]?.title || '—'}</td>
              </tr>
            ))}</tbody></table>
        </div>
      )}
      {sel && (
        <Modal title={`캡처 상세 — ${fmtTime(sel.at)}`} onClose={() => setSel(null)} width={680}>
          <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>{sel.hostA} ↔ {sel.hostB} · {sel.mode === 'dual' ? '동시' : '단일'} · {sel.source === 'monitor' ? '모니터' : '수동'}</div>
          {(sel.issues || []).map((it, i) => <Issue key={i} it={it} />)}
          {sel.detail?.stat && <StatGrid st={sel.detail.stat} />}
          {sel.detail?.a && <><div className="muted" style={{ fontSize: 12, fontWeight: 600 }}>A</div><StatGrid st={sel.detail.a} /><div className="muted" style={{ fontSize: 12, fontWeight: 600 }}>B</div><StatGrid st={sel.detail.b} /></>}
        </Modal>
      )}
    </div>
  );
}

function Monitors() {
  const [d, setD] = useState(null);
  const [form, setForm] = useState(null);
  const load = () => fetchJson('/admin/net/monitors').then((r) => setD(r.monitors || [])).catch(() => setD([]));
  useEffect(() => { load(); const t = setInterval(load, 30_000); return () => clearInterval(t); }, []);
  const blank = { name: '', mode: 'dual', intervalMin: 10, seconds: 10, maxPackets: 1000, iface: 'any', useSudo: true, enabled: true, hostA: { host: '', port: 22, username: 'root', password: '' }, hostB: { host: '', port: 22, username: 'root', password: '' }, peer: '' };
  const save = async () => { try { await putJson('/admin/net/monitors', form); } catch (e) { /* */ } setForm(null); load(); };
  const run = async (id) => { try { await postJson(`/admin/net/monitors/${id}/run`, {}); } catch { /* */ } load(); };
  const del = async (id) => { try { await delJson(`/admin/net/monitors/${id}`); } catch { /* */ } load(); };
  const toggle = async (m) => { try { await putJson('/admin/net/monitors', { id: m.id, name: m.name, mode: m.mode, intervalMin: m.intervalMin, seconds: m.seconds, maxPackets: m.maxPackets, iface: m.iface, hostA: { host: m.hostA }, peer: m.hostB, enabled: !m.enabled }); } catch { /* */ } load(); };
  return (
    <div className="card" style={{ padding: 14 }}>
      <div className="flex between" style={{ alignItems: 'center', marginBottom: 8 }}>
        <div className="section-title" style={{ marginTop: 0, fontSize: 15 }}>연속 모니터링 (주기 캡처 + 이슈 알림)</div>
        <button className="login-btn" style={{ padding: '6px 12px' }} onClick={() => setForm(blank)}>+ 모니터 추가</button>
      </div>
      <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>두 서버 간 캡처를 주기적으로 자동 실행해 이력에 기록하고, 경로 손실/미수신 등 이슈가 감지되면 알림(설정 › 알림 채널)을 보냅니다.</p>
      {!d ? <div className="muted">불러오는 중…</div> : d.length === 0 ? <div className="muted" style={{ fontSize: 12 }}>등록된 모니터가 없습니다.</div> : (
        <div className="table-wrap"><table><thead><tr><th>이름</th><th>모드</th><th>A ↔ B</th><th>주기</th><th>최근</th><th>상태</th><th>작업</th></tr></thead>
          <tbody>{d.map((m) => (
            <tr key={m.id}>
              <td><b>{m.name}</b></td><td style={{ fontSize: 12 }}>{m.mode === 'dual' ? '동시' : '단일'}</td>
              <td style={{ fontSize: 12 }}>{m.hostA} ↔ {m.hostB}</td><td style={{ fontSize: 12 }}>{m.intervalMin}분</td>
              <td className="muted" style={{ fontSize: 11 }}>{m.lastRun ? `${fmtTime(m.lastRun)} · ${m.lastDetail}` : '—'}</td>
              <td>{m.enabled ? worstBadge(m.lastWorst || 'ok') : <span className="badge gray">중지</span>}</td>
              <td><div className="flex gap">
                <button className="tab" style={{ padding: '3px 8px', fontSize: 11 }} onClick={() => run(m.id)}>지금</button>
                <button className="tab" style={{ padding: '3px 8px', fontSize: 11 }} onClick={() => toggle(m)}>{m.enabled ? '중지' : '시작'}</button>
                <button className="tab" style={{ padding: '3px 8px', fontSize: 11, color: 'var(--red)' }} onClick={() => del(m.id)}>삭제</button>
              </div></td>
            </tr>
          ))}</tbody></table></div>
      )}
      {form && (
        <Modal title="모니터 추가" onClose={() => setForm(null)} width={560}>
          <div className="flex gap wrap" style={{ flexDirection: 'column', gap: 10 }}>
            <input className="input" placeholder="이름" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            <div className="flex gap" style={{ alignItems: 'center' }}>
              <select className="select" value={form.mode} onChange={(e) => setForm({ ...form, mode: e.target.value })}><option value="dual">동시(양방향)</option><option value="single">단일</option></select>
              <span className="muted">주기</span><input className="input" type="number" style={{ width: 70 }} value={form.intervalMin} onChange={(e) => setForm({ ...form, intervalMin: e.target.value })} /><span className="muted">분</span>
              <span className="muted">시간</span><input className="input" type="number" style={{ width: 60 }} value={form.seconds} onChange={(e) => setForm({ ...form, seconds: e.target.value })} /><span className="muted">초</span>
            </div>
            <div className="muted" style={{ fontSize: 12 }}>A 서버</div>
            <div className="flex gap"><input className="input" placeholder="A 호스트" value={form.hostA.host} onChange={(e) => setForm({ ...form, hostA: { ...form.hostA, host: e.target.value } })} /><input className="input" style={{ width: 100 }} placeholder="사용자" value={form.hostA.username} onChange={(e) => setForm({ ...form, hostA: { ...form.hostA, username: e.target.value } })} /><input className="input" type="password" style={{ width: 120 }} placeholder="비번" value={form.hostA.password} onChange={(e) => setForm({ ...form, hostA: { ...form.hostA, password: e.target.value } })} /></div>
            <div className="muted" style={{ fontSize: 12 }}>{form.mode === 'dual' ? 'B 서버' : 'B 대상 IP'}</div>
            {form.mode === 'dual'
              ? <div className="flex gap"><input className="input" placeholder="B 호스트" value={form.hostB.host} onChange={(e) => setForm({ ...form, hostB: { ...form.hostB, host: e.target.value } })} /><input className="input" style={{ width: 100 }} placeholder="사용자" value={form.hostB.username} onChange={(e) => setForm({ ...form, hostB: { ...form.hostB, username: e.target.value } })} /><input className="input" type="password" style={{ width: 120 }} placeholder="비번" value={form.hostB.password} onChange={(e) => setForm({ ...form, hostB: { ...form.hostB, password: e.target.value } })} /></div>
              : <input className="input" placeholder="B 대상 IP" value={form.peer} onChange={(e) => setForm({ ...form, peer: e.target.value })} />}
            <button className="login-btn" style={{ padding: '8px 16px' }} onClick={save}>저장</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

export default function NetTrafficAnalysis() {
  const [tab, setTab] = useState('capture');
  const TABS = [['capture', '캡처 분석'], ['history', '이력'], ['monitor', '연속 모니터링']];
  return (
    <div>
      <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>통신하는 두 서버 사이의 패킷을 tcpdump로 캡처해 핸드셰이크·재전송·RST 등으로 장애/이슈를 진단하고, 보관된 로그를 자체 분석해 문제 패턴을 찾습니다.</p>
      <div className="vcd-views" style={{ marginBottom: 12 }}>{TABS.map(([k, l]) => <button key={k} className={tab === k ? 'login-btn' : 'tab'} style={{ flex: 'none', padding: '7px 14px' }} onClick={() => setTab(k)}>{l}</button>)}</div>
      {tab === 'capture' && <><Capture /><LogIssues /></>}
      {tab === 'history' && <History />}
      {tab === 'monitor' && <Monitors />}
    </div>
  );
}

function StatGrid({ st }) {
  if (!st) return null;
  const cells = [['패킷', st.packets], ['SYN/SYN-ACK', `${st.syn}/${st.synAck}`], ['RST', st.rst, st.rst ? '#ef4444' : ''], ['재전송', `${st.retransPct}%`, st.retransPct >= 5 ? '#f59e0b' : ''], ['RTT', st.rttMs != null ? `${st.rttMs} ms` : '—'], ['송신', `${st.toPeer?.packets ?? 0}p`], ['수신', `${st.fromPeer?.packets ?? 0}p`], ['기간', `${st.durSec}s`]];
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
  const [pcapBusy, setPcapBusy] = useState(false);
  const [pcapInfo, setPcapInfo] = useState(null);
  const runPcap = async () => {
    setPcapBusy(true); setErr(null); setPcapInfo(null);
    try {
      const r = await postJson('/admin/net/pcap', { hostA: { host: f.host, port: Number(f.port) || 22, username: f.username, password: f.password }, peer: f.peer, iface: f.iface, seconds: Number(f.seconds), maxPackets: Number(f.maxPackets), useSudo: f.useSudo });
      if (!r.ok) { setErr(r.reason || 'pcap 실패'); return; }
      const bin = atob(r.pcapBase64); const arr = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([arr], { type: 'application/vnd.tcpdump.pcap' })); a.download = r.fileName; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      setPcapInfo({ captured: r.captured, size: r.size, summary: r.summary });
    } catch (e) { setErr(e.message); } finally { setPcapBusy(false); }
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
        {mode === 'single' && via === 'central' && <button className="logout-btn" style={{ padding: '8px 14px' }} disabled={pcapBusy || !f.host || !f.peer} onClick={runPcap} title="pcap 파일로 저장해 다운로드(tshark/Wireshark 심층 분석)">{pcapBusy ? 'pcap 중…' : '⬇ pcap 저장'}</button>}
      </div>
      {pcapInfo && <div className="card" style={{ padding: 10, marginTop: 8 }}><div className="muted" style={{ fontSize: 12 }}>pcap 다운로드 완료 — {pcapInfo.captured ?? '?'}패킷 · {Math.round((pcapInfo.size || 0) / 1024)}KB</div>{pcapInfo.summary && <pre style={{ fontSize: 11, maxHeight: '24vh', overflow: 'auto', marginTop: 6, background: 'rgba(148,163,184,.08)', padding: 8, borderRadius: 6 }}>{pcapInfo.summary}</pre>}</div>}
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
