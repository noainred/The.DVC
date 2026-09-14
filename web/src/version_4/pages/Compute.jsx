// V3 컴퓨트(v2.490) — KPI 5 · vCenter 표(/overview.sites) · 클러스터 주의 목록 · 용량 어드바이저(/tools/capacity, 규칙 기반).
import React from 'react';
import { usePolling, toolAllowed } from '../../api.js';
import { StateBadge } from '../../components/ui.jsx';
import { STable } from '../../components/STable.jsx';
import { Panel, Kpi, PctCell, PollState, Empty } from '../ui.jsx';
import { clusterRows, clusterCountByVc, capacityAdvice, fmtInt, fmtPct, textColor, rowMatches, LEVEL_BAR } from '../data.js';

export default function Compute({ global: g, ov, sitesAll, scope, polls, phase, phaseText, health }) {
  // 수집이 끝나기 전 KPI 메타 문구(v2.509) — 예전에는 전부 '수집 대기' 라 **기다리면 되는 상황과
  // 조치가 필요한 상황이 같은 말**이었다. 셸이 /health 로 판정한 phase 를 쓴다.
  // ⚠ NSX 는 vCenter 수집과 **다른 수집기**(/nsx)라 이 문구를 쓰지 않는다 — vCenter 대수로
  //   NSX 상태를 말하면 확인하지 않은 것을 말하는 셈이다.
  const waitText = phaseText?.short || '수집 대기';
  const canCap = toolAllowed('capacity');
  const cap = usePolling(canCap ? '/tools/capacity' : null, {}, 30_000);
  const clusters = scope.scoped(cap.data?.clusters || []);
  const byVc = clusterCountByVc(cap.data?.clusters || []);
  const sites = scope.scoped(sitesAll, 'id').filter((s) => rowMatches(s, scope.q));
  const hot = clusterRows(clusters.filter((c) => rowMatches(c, scope.q)), 6);
  const advice = capacityAdvice(clusters);
  const unreach = g ? Math.max(0, g.vcenters - g.vcentersConnected - (g.vcentersMaintenance || 0)) : 0;
  const phys = ov?.physical || null;

  return (
    <>
      <div className="v3-kpis">
        <Kpi label="vCenter" value={g ? `${g.vcentersConnected}/${g.vcenters}` : '—'} accent="#0e7490" meta={g ? `연결 불가 ${unreach}${g.vcentersMaintenance ? ` · 점검중 ${g.vcentersMaintenance}` : ''}` : waitText} />
        <Kpi label="물리 서버" value={phys?.servers ? fmtInt(phys.servers) : fmtInt(g?.hosts)} accent="#1a2130" meta={g ? (phys?.servers ? `iDRAC 인식 · ESXi ${fmtInt(g.hosts)} · 끊김 ${fmtInt(g.hostsDisconnected)}` : `ESXi ${fmtInt(g.hosts)} · 정상 ${fmtInt(g.hostsConnected)} · 끊김 ${fmtInt(g.hostsDisconnected)}`) : waitText} />
        <Kpi label="가상머신" value={fmtInt(g?.vms)} accent="#16a34a" meta={g ? `구동 ${fmtInt(g.vmsPoweredOn)} · 정지 ${fmtInt(g.vmsPoweredOff)}` : waitText} />
        <Kpi label="클러스터" value={cap.data ? fmtInt(cap.data.totals?.clusters) : '—'} accent="#d97706" meta={cap.data ? `vCPU/코어 ${cap.data.totals?.vcpuPerCore} · RAM 여유 ${fmtInt(cap.data.totals?.ramHeadroomGB)} GB` : canCap ? '용량 집계 대기' : "권한 필요('tools')"} />
        <Kpi label="GPU" value={ov ? `${fmtInt(ov.gpuCards)}장` : '—'} accent="#7c3aed" meta={ov ? `GPU VM ${fmtInt(ov.gpuVms)} · 활용 ${ov.gpuUtilHosts ? `${ov.gpuUtilPct}%` : '보고 없음'}` : waitText} />
      </div>

      <div className="v3-grid2 wide">
        <Panel title={`vCenter ${sites.length}`} sub="Platform · CPU/메모리 최대 사용률 내림차순 · 제목 클릭 정렬" bodyPad={false}>
          <PollState poll={polls.ov} phase={phase} health={health}>
            <div className="v3-tablewrap">
              <STable className="v3-table">
                <thead><tr><th>vCenter</th><th>사이트</th><th className="num">호스트</th><th className="num">VM</th><th className="num">클러스터</th><th>CPU</th><th>메모리</th><th>상태</th></tr></thead>
                <tbody>
                  {sites.map((s) => (
                    <tr key={s.id} className={scope.focusVc === s.id ? 'focus' : ''}>
                      <td><div className="v3-mono" style={{ fontSize: 12, fontWeight: 600 }}>{s.name}</div><div className="v3-cellsub">{s.id}{s.version ? ` · ${s.version}` : ''}</div></td>
                      <td className="v3-dim" style={{ fontSize: 12 }}>{s.city}{s.country ? `, ${s.country}` : ''}</td>
                      <td className="num" data-sort={s.hosts ?? ''}>{fmtInt(s.hosts)}</td>
                      <td className="num" data-sort={s.vms ?? ''}>{fmtInt(s.vms)}</td>
                      <td className="num v3-dim" data-sort={byVc[s.id] ?? ''}>{cap.data ? fmtInt(byVc[s.id] ?? 0) : '—'}</td>
                      <td data-sort={s.cpu ?? ''}><PctCell pct={s.cpu} /></td>
                      <td data-sort={s.mem ?? ''}><PctCell pct={s.mem} /></td>
                      <td><StateBadge state={s.status} /></td>
                    </tr>
                  ))}
                </tbody>
              </STable>
              {sites.length === 0 && <Empty>범위 안에 vCenter 가 없습니다.</Empty>}
            </div>
          </PollState>
        </Panel>
        <div className="v3-col">
          <Panel title="클러스터 주의 목록" sub="CPU/메모리 사용률 최대 기준 상위 6">
            <PollState poll={cap} skipped={canCap ? null : "특수 기능('tools') 권한이 없어 /tools/capacity 를 조회하지 않습니다."}>
              <div className="v3-rows">
                {hot.length === 0 && <Empty>범위 안에 클러스터가 없습니다.</Empty>}
                {hot.map((c) => (
                  <div className="v3-row" key={c.key}>
                    <div className="v3-grow">
                      <div className="v3-row-title">{c.name} <span className="v3-faint" style={{ fontWeight: 400 }}>· {c.vcenterId}</span></div>
                      <div className="v3-row-meta">{c.hosts} 호스트 · VM {fmtInt(c.vms)} (구동 {fmtInt(c.vmsOn)}) · vCPU/코어 {c.vcpuPerCore} · RAM 오버커밋 {fmtPct(c.ramOvercommitPct)}</div>
                    </div>
                    <span className="v3-num" style={{ fontSize: 12.5, fontWeight: 700, color: textColor(c.load) }}>{fmtPct(c.load)}</span>
                  </div>
                ))}
              </div>
            </PollState>
          </Panel>
          <Panel title="용량 어드바이저" sub="/tools/capacity 집계에 규칙 적용 · 예측 아님">
            <PollState poll={cap} skipped={canCap ? null : '권한 없음'}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {advice.length === 0 && <Empty>규칙(사용률 ≥ 90% · RAM 오버커밋 ≥ 100% · 배치 후보)에 해당하는 클러스터가 없습니다.</Empty>}
                {advice.map((a, i) => (
                  <div className="v3-advice" key={i} style={{ borderLeftColor: LEVEL_BAR[a.level] }}>
                    <div className="v3-advice-title">{a.title}</div>
                    <div className="v3-advice-meta">{a.meta}</div>
                  </div>
                ))}
              </div>
            </PollState>
          </Panel>
        </div>
      </div>
    </>
  );
}
