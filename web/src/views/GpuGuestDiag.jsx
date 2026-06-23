import React, { useEffect, useState } from 'react';
import { fetchJson } from '../api.js';
import { Loading, ErrorBox } from '../components/ui.jsx';

const fmtAgo = (ts) => {
  if (!ts) return '없음';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${s}초 전`;
  if (s < 3600) return `${Math.round(s / 60)}분 전`;
  return `${Math.round(s / 3600)}시간 전`;
};

// 선별 깔때기 한 줄 — 0으로 떨어지는 지점을 빨갛게 강조(여기서 막힘).
function Funnel({ c }) {
  if (!c) return null;
  const steps = [
    ['패스쓰루 호스트', c.passthruHosts], ['호스트 위 VM', c.vmsOnHost], ['패스쓰루 GPU 할당', c.passthroughGpuVms],
    ['On+Tools', c.onTools], ['수집 대상(계정O)', c.candidates],
  ];
  let stopped = false;
  return (
    <div className="flex gap wrap" style={{ alignItems: 'center', fontSize: 12, margin: '4px 0' }}>
      {steps.map(([label, n], i) => {
        const isStop = !stopped && (n === 0);
        if (isStop) stopped = true;
        const dim = stopped && n !== 0 && i > 0;
        return (
          <React.Fragment key={label}>
            {i > 0 && <span className="muted">→</span>}
            <span className={`badge ${isStop ? 'red' : (n > 0 ? 'green' : 'gray')}`} style={{ opacity: dim ? 0.4 : 1 }} title={label}>
              {label} <b>{n ?? '-'}</b>
            </span>
          </React.Fragment>
        );
      })}
    </div>
  );
}

function VcDiag({ d }) {
  const stageOk = d.stage === '완료';
  return (
    <div className="card" style={{ padding: 12, marginTop: 8, borderLeft: `3px solid ${stageOk ? 'var(--green)' : 'var(--amber,#f59e0b)'}` }}>
      <div className="flex between wrap" style={{ alignItems: 'center', gap: 8 }}>
        <div><b>{d.vcId}</b> <span className={`badge ${stageOk ? 'green' : 'amber'}`} style={{ marginLeft: 6 }}>{d.stage || '?'}</span>
          {d.collected != null && <span className="muted" style={{ marginLeft: 6, fontSize: 12 }}>수집 {d.collected}개</span>}</div>
        <span className="muted" style={{ fontSize: 11 }}>{fmtAgo(d.at)}</span>
      </div>
      <Funnel c={d.counts} />
      {d.error && <div className="badge red" style={{ marginTop: 4, whiteSpace: 'normal' }}>오류: {d.error}</div>}
      {(d.results || []).length > 0 && (
        <div className="table-wrap" style={{ maxHeight: '40vh', marginTop: 6 }}>
          <table><thead><tr><th>VM</th><th>호스트</th><th>결과</th></tr></thead>
            <tbody>
              {d.results.map((r, i) => (
                <tr key={i}>
                  <td><b>{r.vm}</b></td>
                  <td className="muted" style={{ fontSize: 12 }}>{r.host}</td>
                  <td style={{ fontSize: 12 }}>
                    {r.ok
                      ? <span className="badge green">✓ util {r.util}% · mem {r.mem ?? '-'}% · {r.gpus}GPU</span>
                      : <span className="badge red" style={{ whiteSpace: 'normal' }}>✗ {r.error}</span>}
                  </td>
                </tr>
              ))}
            </tbody></table>
        </div>
      )}
    </div>
  );
}

const STAGES = [
  ['0 인벤토리 폴링', 'Agent가 vCenter에서 호스트/VM을 가져오고 패스쓰루 GPU를 판별', '\'패스쓰루 호스트=0\' → vCenter 연결 실패(host에 https://? IP 도달?) 또는 패스쓰루 GPU 호스트 없음'],
  ['1 대상 선별', 'On + VMware Tools RUNNING + 패스쓰루 GPU 할당 + 계정 있는 VM만', '깔때기에서 0으로 떨어지는 지점이 원인(전원/Tools/계정)'],
  ['2 게스트 실행', 'vim25 게스트작업으로 nvidia-smi 실행', '\'로그인 실패\'=계정/비번 · \'command not found\'=드라이버/PATH'],
  ['3 결과 회수', 'InitiateFileTransferFromGuest URL을 vCenter실IP→ESXi IP→FQDN 순 HTTP GET', '\'ESXi IP=timeout\'=agent가 ESXi 망 도달 불가 · \'=HTTP404\'=그 호스트가 파일 안 줌'],
  ['4 파싱·저장', 'CSV 파싱 → 게스트 오버레이', '결과 비어있음=nvidia-smi stdout 없음'],
  ['5 중앙 push', 'POST /api/central/gpu-guest-data (X-Central-Token)', '403=토큰 불일치 · 404=중앙 토큰 미설정'],
  ['6 중앙 표시', '중앙 오버레이 → GPU 인벤토리(게스트 배지)', '수신 vms>0인데 화면 X = vCenter id 불일치(중앙↔agent)'],
];

/** 설정 → GPU 게스트 수집 진단 — 어느 단계에서 막혔는지 + 트러블슈팅 가이드. */
export default function GpuGuestDiag() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [guide, setGuide] = useState(true);
  const load = () => fetchJson('/admin/gpu-guest/diag').then((d) => { setData(d); setError(null); }).catch((e) => setError(e.message));
  useEffect(() => { load(); const t = setInterval(load, 15_000); return () => clearInterval(t); }, []);
  if (error) return <ErrorBox message={error} />;
  if (!data) return <Loading />;

  const blocks = [];
  if (data.local && (data.local.vcenters || []).length) blocks.push({ key: '_local', agent: '이 포탈(로컬 수집)', at: data.local.at, vcenters: data.local.vcenters });
  for (const a of (data.agents || [])) blocks.push({ key: a.agent, agent: `Agent: ${a.agent}`, at: a.receivedAt || a.at, vcenters: a.vcenters || [], counts: a.counts });

  return (
    <div style={{ maxWidth: 1100 }}>
      <div className="section-title" style={{ marginTop: 0 }}>🩺 GPU 게스트 수집 진단</div>
      <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>
        패스쓰루 GPU 사용률 수집이 <b>어느 단계에서 막혔는지</b> 보여줍니다. 깔때기에서 <span className="badge red">빨간 0</span>으로
        떨어지는 지점이 원인입니다. 수집은 보통 ESXi 망에 닿는 <b>agent</b>가 수행해 중앙으로 push합니다(15초마다 자동 새로고침).
      </p>

      {blocks.length === 0
        ? <div className="card" style={{ padding: 16 }}><span className="muted">아직 진단 데이터가 없습니다. agent에서 GPU 게스트 수집이 한 주기 돌고 push되면 표시됩니다(설정 › GPU 게스트 수집 사용 + agent의 CENTRAL_URL/TOKEN 확인).</span></div>
        : blocks.map((b) => (
          <div key={b.key} className="card" style={{ padding: 14, marginBottom: 12 }}>
            <div className="flex between" style={{ alignItems: 'center' }}>
              <b style={{ fontSize: 14 }}>{b.agent}</b>
              <span className="muted" style={{ fontSize: 11 }}>{b.counts ? `수신 호스트 ${b.counts.hosts ?? '-'} · VM ${b.counts.vms ?? '-'} · ` : ''}{fmtAgo(b.at)}</span>
            </div>
            {(b.vcenters || []).length === 0
              ? <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>수집 대상 vCenter 없음(설정 확인).</div>
              : b.vcenters.map((d, i) => <VcDiag key={i} d={d} />)}
          </div>
        ))}

      <div className="card" style={{ padding: 14, marginTop: 8 }}>
        <button className="logout-btn" style={{ padding: '6px 12px' }} onClick={() => setGuide((g) => !g)}>{guide ? '▼' : '▶'} 트러블슈팅 가이드 (단계별)</button>
        {guide && (
          <div className="table-wrap" style={{ marginTop: 10 }}>
            <table><thead><tr><th>단계</th><th>하는 일</th><th>막히면 흔한 원인/조치</th></tr></thead>
              <tbody>
                {STAGES.map(([s, w, c]) => <tr key={s}><td><b>{s}</b></td><td style={{ fontSize: 12 }}>{w}</td><td style={{ fontSize: 12 }}>{c}</td></tr>)}
              </tbody></table>
            <div className="muted" style={{ fontSize: 12, marginTop: 10, lineHeight: 1.7 }}>
              <b>서버별 점검 명령</b><br />
              · Agent: <code>journalctl -u vmware-portal -f | grep gpu-guest</code> (선별/실행/다운로드/push)<br />
              · Agent→중앙 push 직접 테스트: <code>{'curl -s -X POST $CENTRAL_URL/api/central/gpu-guest-data -H "X-Central-Token: $TOKEN" -H "Content-Type: application/json" -d \'{"agent":"manual","hosts":[{"hostId":"OC2:host-test","utilPct":50}],"vms":[]}\' -w "\\nHTTP %{http_code}\\n"'}</code> → HTTP 200 기대<br />
              · 중앙 수신: <code>journalctl -u vmware-portal -f | grep gpu-guest-data</code><br />
              · 게스트 VM: <code>nvidia-smi --query-gpu=utilization.gpu,memory.total --format=csv,noheader,nounits</code> · <code>systemctl is-active vmtoolsd</code><br />
              ※ <b>핵심</b>: 중앙↔agent의 vCenter <b>id가 동일</b>해야 수집값이 화면에 매칭됩니다.
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
