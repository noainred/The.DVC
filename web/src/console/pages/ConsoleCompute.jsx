// 컴퓨트(v2.487) — vCenter 표(/overview.sites) · 클러스터 주의 목록·용량 어드바이저(/tools/capacity, 규칙 기반).
import React from 'react';
import { usePolling, toolAllowed } from '../../api.js';
import { StateBadge } from '../../components/ui.jsx';
import { STable } from '../../components/STable.jsx';
import { Panel, KpiCard, PctCell, PollState, Empty } from '../ui.jsx';
import { clusterRows, clusterCountByVc, capacityAdvice, fmtInt, fmtPct, colorOf, rowMatches, LEVEL_COLOR, vcStatusMeta } from '../consoleData.js';

export default function ConsoleCompute({ global: g, ov, sitesAll, scope, polls }) {
  const canCap = toolAllowed('capacity');
  const cap = usePolling(canCap ? '/tools/capacity' : null, {}, 30_000);
  const clusters = scope.scoped(cap.data?.clusters || []);
  const byVc = clusterCountByVc(cap.data?.clusters || []);
  const sites = scope.scoped(sitesAll, 'id').filter((s) => rowMatches(s, scope.q));
  const hot = clusterRows(clusters.filter((c) => rowMatches(c, scope.q)), 6);
  const advice = capacityAdvice(clusters);

  return (
    <>
      <div className="dvc-kpis">
        <KpiCard label="vCenter" value={g ? `${g.vcentersConnected}/${g.vcenters}` : '—'} accent="#0891b2" meta={g ? vcStatusMeta(g) : '수집 대기'} />
        <KpiCard label="물리 서버 (ESXi)" value={fmtInt(g?.hosts)} accent="#0f172a" meta={g ? `정상 ${fmtInt(g.hostsConnected)} · 점검 ${fmtInt(g.hostsMaintenance)} · 끊김 ${fmtInt(g.hostsDisconnected)}${ov?.physical?.servers ? ` · iDRAC 등록 ${fmtInt(ov.physical.servers)}` : ''}` : '수집 대기'} />
        <KpiCard label="가상머신" value={fmtInt(g?.vms)} accent="#22c55e" meta={g ? `구동 ${fmtInt(g.vmsPoweredOn)} · 정지 ${fmtInt(g.vmsPoweredOff)}` : '수집 대기'} />
        <KpiCard label="클러스터" value={cap.data ? fmtInt(cap.data.totals?.clusters) : '—'} accent="#f59e0b" meta={cap.data ? `vCPU/코어 ${cap.data.totals?.vcpuPerCore} · RAM 여유 ${fmtInt(cap.data.totals?.ramHeadroomGB)} GB` : canCap ? '용량 집계 대기' : "권한 필요('tools')"} />
        <KpiCard label="GPU" value={ov ? `${fmtInt(ov.gpuCards)}장` : '—'} accent="#7c3aed" meta={ov ? `GPU VM ${fmtInt(ov.gpuVms)} · 활용 ${ov.gpuUtilHosts ? `${ov.gpuUtilPct}% (${ov.gpuUtilHosts} 호스트 보고)` : '보고 없음'}` : '수집 대기'} />
      </div>

      <div className="dvc-grid2 wide">
        <Panel title={`vCenter ${sites.length}`} sub="Platform · CPU/메모리 최대 사용률 내림차순 · 제목 클릭 정렬" bodyPad={false}>
          <PollState poll={polls.ov}>
            <div className="dvc-tablewrap">
              <STable minWidth={880} wrap={false} className="dvc-table">
                <thead><tr><th>vCenter</th><th>사이트</th><th className="num">호스트</th><th className="num">VM</th><th className="num">클러스터</th><th>CPU</th><th>메모리</th><th>상태</th></tr></thead>
                <tbody>
                  {sites.map((s) => (
                    <tr key={s.id} className={scope.focusVc === s.id ? 'focus' : ''}>
                      <td><div className="dvc-mono" style={{ fontSize: 12, fontWeight: 600 }}>{s.name}</div><div className="dvc-cellsub">{s.id}{s.version ? ` · ${s.version}` : ''}</div></td>
                      <td className="dvc-dim" style={{ fontSize: 12 }}>{s.city}{s.country ? `, ${s.country}` : ''}</td>
                      <td className="num" data-sort={s.hosts ?? ''}>{fmtInt(s.hosts)}</td>
                      <td className="num" data-sort={s.vms ?? ''}>{fmtInt(s.vms)}</td>
                      <td className="num dvc-dim" data-sort={byVc[s.id] ?? ''}>{cap.data ? fmtInt(byVc[s.id] ?? 0) : '—'}</td>
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
        <div className="dvc-col">
          <Panel title="클러스터 주의 목록" sub="CPU/메모리 사용률 최대 기준 상위 6">
            <PollState poll={cap} skipped={canCap ? null : "특수 기능('tools') 권한이 없어 /tools/capacity 를 조회하지 않습니다."}>
              <div className="dvc-rows">
                {hot.length === 0 && <Empty>범위 안에 클러스터가 없습니다.</Empty>}
                {hot.map((c) => (
                  <div className="dvc-row" key={c.key}>
                    <div className="dvc-grow">
                      <div className="dvc-row-title">{c.name} <span className="dvc-faint" style={{ fontWeight: 400 }}>· {c.vcenterId}</span></div>
                      <div className="dvc-row-meta">{c.hosts} 호스트 · VM {fmtInt(c.vms)} (구동 {fmtInt(c.vmsOn)}) · vCPU/코어 {c.vcpuPerCore} · RAM 오버커밋 {fmtPct(c.ramOvercommitPct)}</div>
                    </div>
                    <span className="dvc-num" style={{ fontSize: 12.5, fontWeight: 700, color: colorOf(c.load) }}>{fmtPct(c.load)}</span>
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
                  <div className="dvc-advice" key={i} style={{ borderLeftColor: LEVEL_COLOR[a.level] }}>
                    <div className="dvc-advice-title">{a.title}</div>
                    <div className="dvc-advice-meta">{a.meta}</div>
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
