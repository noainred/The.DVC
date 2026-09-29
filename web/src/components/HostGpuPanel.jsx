// v2.650: 호스트 상세의 GPU 칸 — 사용률·온도·GPU 메모리 할당/사용·VM 별 동작(사용자 요청 "GPU 있는 서버는 GPU 사용율,
//   GPU 온도, GPU 메모리 할당/사용율 붙여줘"). 서버 GET /tools/gpu/host(스냅샷·오버레이만 — 왕복 0). 폴링하지 않는다(모달 열 때 1회).
import React, { useEffect, useState } from 'react';
import { fetchJson, toolAllowed } from '../api.js';
import { UsageCell } from './primitives.jsx';
import { STable } from './STable.jsx';
import BoldText from './boldText.jsx';
import {
  activityOf, memText, gbText, tempText, allocText, capacityNote, coverageText, activityRuleNote, activitySummary,
} from '../views/tools/gpuUsageText.js';

const GpuHistModal = React.lazy(() => import('../views/tools/GpuHistModal.jsx'));

function Stat({ label, children, sub }) {
  return (
    <div style={{ minWidth: 0, padding: '8px 12px', border: '1px solid var(--border)', borderRadius: 8, background: 'var(--panel)' }}>
      <div className="muted" style={{ fontSize: 11, marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 15, fontWeight: 700 }}>{children}</div>
      {sub && <div className="muted" style={{ fontSize: 11, marginTop: 3, overflowWrap: 'anywhere' }}>{sub}</div>}
    </div>
  );
}

export default function HostGpuPanel({ hostId, hostName }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const [hist, setHist] = useState(null); // { level, key, title, metric }
  // v2.613 CATALOG2613-02 규약: 소유 화면(GPU 모니터링) 밖에서 /tools/gpu 를 부르므로 도구 허용을 먼저 본다 —
  //   허용 목록에 없는 계정은 요청 자체를 보내지 않고 이유를 말한다(403 을 매번 만들지 않는다).
  const allowed = toolAllowed('gpu');
  useEffect(() => {
    if (!allowed) return undefined;
    let alive = true;
    setD(null); setErr(null);
    fetchJson(`/tools/gpu/host?id=${encodeURIComponent(hostId)}`)
      .then((r) => { if (alive) setD(r); })
      .catch((e) => { if (alive) setErr(e); });
    return () => { alive = false; };
  }, [hostId, allowed]);
  if (!allowed) return <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>GPU 사용률·온도·메모리는 특수 기능 › GPU 모니터링 권한이 있어야 볼 수 있습니다.</div>;
  if (err) {
    // 권한이 없는 계정(특수 기능 GPU 모니터링)이면 조용히 사라지지 않고 이유를 말한다.
    const denied = err.status === 403;
    return <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>{denied ? 'GPU 사용률·온도·메모리는 특수 기능 › GPU 모니터링 권한이 있어야 볼 수 있습니다.' : `GPU 사용 정보를 불러오지 못했습니다: ${err.message || err}`}</div>;
  }
  if (!d) return <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>GPU 사용 정보 불러오는 중…</div>;
  if (!d.gpus) return null;
  const on = (d.vms || []).filter((v) => v.powerState === 'POWERED_ON');
  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(170px, 100%), 1fr))', gap: 8 }}>
        <Stat label="GPU 사용률" sub={d.utilSource === 'esxi' ? 'ESXi 성능 카운터' : d.utilSource === 'guest' ? '게스트 nvidia-smi 평균' : '미수집'}>
          {d.utilPct == null ? <span className="muted">—</span> : <UsageCell pct={d.utilPct} />}
        </Stat>
        <Stat label="GPU 온도(가장 높은 GPU)" sub={d.tempC == null ? '게스트 수집값 없음' : '게스트 nvidia-smi'}>
          {d.tempC == null ? <span className="muted">—</span> : tempText(d.tempC)}
        </Stat>
        <Stat label="GPU 메모리 사용" sub={d.memUsedMB == null ? '게스트 수집값 없음' : `켜진 VM ${d.memVms}대 합`}>
          {d.memUsedMB == null ? <span className="muted">—</span> : <span>{memText(d.memUsedMB, d.memTotalMB)} <span className="muted" style={{ fontWeight: 400 }}>({d.memUsedPct}%)</span></span>}
        </Stat>
        <Stat label="GPU 메모리 할당" sub={d.capacityGB != null ? `설치 용량 ${gbText(d.capacityGB)}${d.capacityEstimated ? '(모델명 추정)' : ''}` : '설치 용량 모름'}>
          <span style={{ fontSize: 13 }}>{allocText(d)}</span>
        </Stat>
      </div>
      {activitySummary(d.activity) && <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>켜진 GPU VM 동작: <b>{activitySummary(d.activity)}</b></div>}
      {(d.vms || []).length > 0 && (
        <STable minWidth={820} style={{ marginTop: 8 }}>
          <thead><tr><th>VM</th><th>방식 · 프로파일</th><th style={{ textAlign: 'right' }}>할당</th><th style={{ textAlign: 'right' }}>사용률</th><th style={{ textAlign: 'right' }}>메모리 사용</th><th style={{ textAlign: 'right' }}>온도</th><th>동작</th><th data-nosort>추이</th></tr></thead>
          <tbody>
            {d.vms.map((v) => {
              const a = activityOf(v.activity);
              return (
                <tr key={v.id}>
                  <td style={{ maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={v.name}><b>{v.name}</b></td>
                  <td className="muted" style={{ fontSize: 12 }}>{v.mode === 'vgpu' ? 'vGPU' : v.mode === 'passthrough' ? '패스스루' : v.mode === 'mixed' ? '혼합' : '—'}{v.profile ? ` · ${v.profile}` : ''}</td>
                  <td style={{ textAlign: 'right' }} data-sort={v.allocGB ?? ''}>{v.allocGB != null ? gbText(v.allocGB) : v.mode === 'passthrough' ? <span className="muted" title="패스스루는 GPU 한 장을 통째로 줍니다">한 장 전체</span> : <span className="muted">—</span>}</td>
                  <td style={{ textAlign: 'right' }} data-sort={v.utilPct ?? ''}>{v.utilNA ? <span className="muted" title="MIG 모드 — GPU 단위 사용률 없음(0% 가 아닙니다)">N/A(MIG)</span> : <UsageCell pct={v.utilPct} />}</td>
                  <td style={{ textAlign: 'right' }} data-sort={v.memUsedMB ?? ''}>{memText(v.memUsedMB, v.memTotalMB)}{v.memUsedPct != null && <span className="muted" style={{ fontSize: 11 }}> ({v.memUsedPct}%)</span>}</td>
                  <td style={{ textAlign: 'right' }} data-sort={v.tempC ?? ''}>{tempText(v.tempC)}</td>
                  <td><span className={`badge ${a.tone}`} title={a.title}>{a.label}</span></td>
                  <td>{v.powerState === 'POWERED_ON' ? <button className="tab" style={{ padding: '3px 8px', fontSize: 11 }} onClick={() => setHist({ level: 'vm', key: v.id, title: v.name })}>추이</button> : <span className="muted">—</span>}</td>
                </tr>
              );
            })}
          </tbody>
        </STable>
      )}
      <div className="flex gap" style={{ marginTop: 8, flexWrap: 'wrap', rowGap: 6 }}>
        {[['util', '사용률'], ['mem', '메모리'], ['temp', '온도']].map(([k, l]) => (
          <button key={k} className="tab" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => setHist({ level: 'host', key: d.hostId, title: hostName, metric: k })}>호스트 GPU {l} 추이</button>
        ))}
      </div>
      <div className="muted" style={{ fontSize: 11, marginTop: 8, lineHeight: 1.6 }}>
        <div><BoldText text={coverageText(d)} /></div>
        <div>{capacityNote(d)} vGPU 할당은 프로파일 이름(예: …-10c = 10 GB)에서 계산합니다.</div>
        <div>{activityRuleNote(d.activityRule)}</div>
        {d.vmsOmitted > 0 && <div>VM {d.vmsOmitted}대는 목록 상한(200)으로 표시하지 않았습니다.</div>}
        {on.length === 0 && <div>켜진 GPU VM 이 없습니다.</div>}
      </div>
      {hist && <React.Suspense fallback={null}><GpuHistModal level={hist.level} hkey={hist.key} title={hist.title} initialMetric={hist.metric || 'util'} onClose={() => setHist(null)} /></React.Suspense>}
    </div>
  );
}
