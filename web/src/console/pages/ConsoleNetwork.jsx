// 네트워크(v2.487) — 포트그룹(/networks) · NSX 매니저·트랜스포트 노드(/nsx) · IPAM /24 사용률(/tools/ipam/subnets).
// 사이트 간 백본 회선 사용률·RTT 는 수집 API 가 없어 표시하지 않는다(시안의 '백본 10구간' 패널 제외).
import React from 'react';
import { usePolling, toolAllowed } from '../../api.js';
import { StateBadge } from '../../components/ui.jsx';
import { STable } from '../../components/STable.jsx';
import { Panel, KpiCard, Bar, PollState, Empty } from '../ui.jsx';
import { nsxManagerRows, networkTypeCounts, portgroupsByVc, ipamTop, ipamStats, fmtInt, fmtPct, colorOf, rowMatches, REGION_COLORS } from '../consoleData.js';

export default function ConsoleNetwork({ global: g, sitesAll, scope, polls }) {
  const nets = usePolling('/networks', {}, 60_000);
  const canIpam = toolAllowed('ipam');
  const ipam = usePolling(canIpam ? '/tools/ipam/subnets' : null, {}, 60_000);
  const netItems = scope.scoped(nets.data?.items || []);
  const tc = networkTypeCounts(netItems);
  const r = polls.nsx.data?.rollup || null;
  const managers = nsxManagerRows(polls.nsx.data).filter((m) => (!m.vcenterId || scope.inScope(m.vcenterId)) && rowMatches(m, scope.q));
  const tnDown = managers.reduce((a, m) => a + m.nodes.down, 0);
  const subnets = ipam.data?.subnets || [];
  const ist = ipamStats(subnets);
  const top = ipamTop(subnets.filter((s) => rowMatches(s, scope.q)), 8);
  // vCenter 별 포트그룹 집계 — /networks 는 상태가 없어 유형·VM 수만 보여준다.
  // v2.598 VC2598-04: VM 수를 모르는 네트워크(null)를 0 으로 더하지 않는다 — portgroupsByVc 가 판정한다.
  const byVc = portgroupsByVc(netItems);
  const siteName = new Map(sitesAll.map((s) => [s.id, s]));
  const pgRows = byVc.map((x) => ({ ...x, vlans: x.vlans.size, name: siteName.get(x.vcenterId)?.name || x.vcenterId, region: siteName.get(x.vcenterId)?.region || '' })).filter((x) => rowMatches(x, scope.q)).sort((a, b) => b.total - a.total);

  return (
    <>
      <div className="dvc-kpis">
        <KpiCard label="포트그룹" value={fmtInt(g?.networks)} accent="#0f172a" meta={nets.data ? `Distributed ${tc.distributed} · Standard ${tc.standard}${tc.other ? ` · 기타 ${tc.other}` : ''}` : '수집 대기'} />
        <KpiCard label="NSX 매니저" value={r ? `${r.managersUp} / ${r.managers}` : '—'} accent="#7c3aed" meta={r ? `T0 ${r.t0} · T1 ${r.t1}${r.managersDegraded ? ` · 저하 ${r.managersDegraded}` : ''}${(polls.nsx.data.collectionErrors || []).length ? ` · 수집 오류 ${polls.nsx.data.collectionErrors.length}` : ''}` : 'NSX 수집 대기'} />
        <KpiCard label="세그먼트" value={fmtInt(r?.segments)} accent="#0891b2" meta={r ? `Overlay ${r.overlaySegments} · VLAN ${r.vlanSegments}` : 'NSX 수집 대기'} />
        <KpiCard label="트랜스포트 노드" value={r ? fmtInt(r.hostNodes + r.edgeNodes) : '—'} accent={tnDown ? '#ef4444' : '#22c55e'} meta={r ? `호스트 ${r.hostNodes} · 엣지 ${r.edgeNodes} · DOWN ${tnDown}` : 'NSX 수집 대기'} />
        <KpiCard label="IPAM /24 대역" value={ipam.data ? fmtInt(ist.count) : '—'} accent="#3b82f6" meta={ipam.data ? (ist.count ? `평균 사용 ${fmtPct(ist.avgPct)} · 90% 초과 ${ist.over90}` : '대역 없음') : canIpam ? '수집 대기' : "권한 필요('tools')"} />
      </div>

      <div className="dvc-grid2 wide">
        <Panel title={`NSX 매니저 ${managers.length}`} sub="상태 → 이름 순 · TN = 트랜스포트 노드 UP/DOWN · DFW = 분산 방화벽 규칙" bodyPad={false}>
          <PollState poll={polls.nsx}>
            {managers.length === 0 ? <Empty>{polls.nsx.data?.managers?.length ? '범위 안에 NSX 매니저가 없습니다.' : 'NSX 매니저가 등록되어 있지 않습니다(설정 › NSX).'}</Empty> : (
              <div className="dvc-tablewrap">
                <STable minWidth={1040} wrap={false} className="dvc-table">
                  <thead><tr><th>매니저</th><th>리전</th><th>vCenter</th><th>버전</th><th className="num">노드</th><th className="num">게이트웨이</th><th className="num">세그먼트</th><th className="num">TN UP/DOWN</th><th className="num">DFW 규칙</th><th>상태</th></tr></thead>
                  <tbody>
                    {managers.map((m) => (
                      <tr key={m.id} className={m.level === 2 ? 'crit' : ''}>
                        <td><div className="dvc-mono" style={{ fontSize: 12, fontWeight: 600 }}>{m.name}</div><div className="dvc-cellsub">{m.host}</div></td>
                        <td style={{ color: REGION_COLORS[m.region] || '#6b7280', fontSize: 11.5 }}>{m.region || '—'}</td>
                        <td className="dvc-dim">{m.vcenterId || '—'}</td>
                        <td className="dvc-dim dvc-mono" style={{ fontSize: 11 }}>{m.version || '—'}</td>
                        <td className="num">{fmtInt(m.nodeCount)}</td>
                        <td className="num">{fmtInt(m.gateways)}</td>
                        <td className="num">{fmtInt(m.segments)}</td>
                        <td className="num" data-sort={m.nodes.down}><span style={{ color: '#16a34a' }}>{m.nodes.up}</span> / <span style={{ color: m.nodes.down ? '#dc2626' : '#9ca3af' }}>{m.nodes.down}</span></td>
                        <td className="num">{fmtInt(m.firewall?.rules)}</td>
                        <td><StateBadge state={m.status} />{m.collectError && <span className="dvc-badge lv1" style={{ marginLeft: 6 }}>수집 오류</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </STable>
              </div>
            )}
          </PollState>
        </Panel>
        <div className="dvc-col">
          <Panel title="vCenter 별 포트그룹" sub="/networks · 유형·VLAN·연결 VM" bodyPad={false}>
            <PollState poll={nets}>
              {pgRows.length === 0 ? <Empty>범위 안에 포트그룹이 없습니다.</Empty> : (
                <div className="dvc-tablewrap">
                  <STable minWidth={720} wrap={false} className="dvc-table">
                    <thead><tr><th>vCenter</th><th className="num">포트그룹</th><th className="num">Dist.</th><th className="num">Std.</th><th className="num">VLAN</th><th className="num">VM</th></tr></thead>
                    <tbody>
                      {pgRows.map((x) => (
                        <tr key={x.vcenterId}>
                          <td><div className="dvc-mono" style={{ fontSize: 12, fontWeight: 600 }}>{x.name}</div><div className="dvc-cellsub" style={{ color: REGION_COLORS[x.region] || '#9ca3af' }}>{x.region}</div></td>
                          <td className="num">{x.total}</td><td className="num dvc-dim">{x.distributed}</td><td className="num dvc-dim">{x.standard}</td><td className="num dvc-dim">{x.vlans}</td><td className="num" title={x.vmsUnknown ? `VM 수를 수집하지 않은 포트그룹 ${x.vmsUnknown}개 — 합계에 넣지 않았습니다(0 이 아니라 모름)` : undefined}>{fmtInt(x.vms)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </STable>
                </div>
              )}
            </PollState>
          </Panel>
          <Panel title="IPAM 서브넷 사용률" sub={ipam.data ? `${ist.count} 대역 · /24 기준 254 · 상위 8` : ''}>
            <PollState poll={ipam} skipped={canIpam ? null : "IP 관리('ipam') 권한이 없어 조회하지 않습니다."}>
              {top.length === 0 ? <Empty>IPAM 대역이 없습니다.</Empty> : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
                  {top.map((s) => (
                    <div key={s.subnet} style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                      <span className="dvc-mono" style={{ fontSize: 11, width: 120 }}>{s.subnet}</span>
                      <Bar pct={s.pct} />
                      <span className="dvc-num" style={{ fontSize: 11, color: colorOf(s.pct), width: 64, textAlign: 'right' }}>{s.used}/254</span>
                    </div>
                  ))}
                </div>
              )}
            </PollState>
          </Panel>
          <div className="dvc-note">사이트 간 백본 회선 사용률·RTT·손실은 이 포탈에 수집 API 가 없어 표시하지 않습니다. 중계 경로 상태는 특수 기능 › HAProxy 경로 점검에서 확인하세요.</div>
        </div>
      </div>
    </>
  );
}
