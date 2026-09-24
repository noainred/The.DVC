// V3 네트워크(v2.490) — KPI 5 · NSX 매니저 표(/nsx) · vCenter 별 포트그룹(/networks) · IPAM 서브넷(/tools/ipam/subnets).
// 아트보드의 '사이트 간 백본(회선 사용률·RTT·손실)' 패널은 이 포탈에 수집 API 가 없어 '수집 없음' 으로 정직하게 표시한다.
import React from 'react';
import { usePolling, toolAllowed } from '../../api.js';
import { StateBadge } from '../../components/ui.jsx';
import { STable } from '../../components/STable.jsx';
import { Panel, Kpi, Bar, PollState, Empty } from '../ui.jsx';
import { nsxManagerRows, networkTypeCounts, portgroupsByVc, ipamTop, ipamStats, fmtInt, fmtPct, textColor, rowMatches, REGION_COLORS } from '../data.js';
import { nsxCount, nsxAdd, nsxFailedShort } from '../../views/nsxLimitText.js'; // v2.600 COL-2600-06: 조회 실패 합계(null)를 0·'null' 로 그리지 않는다

export default function Network({ global: g, sitesAll, scope, polls, phase, phaseText, health }) {
  // 수집이 끝나기 전 KPI 메타 문구(v2.509) — 예전에는 전부 '수집 대기' 라 **기다리면 되는 상황과
  // 조치가 필요한 상황이 같은 말**이었다. 셸이 /health 로 판정한 phase 를 쓴다.
  // ⚠ NSX 는 vCenter 수집과 **다른 수집기**(/nsx)라 이 문구를 쓰지 않는다 — vCenter 대수로
  //   NSX 상태를 말하면 확인하지 않은 것을 말하는 셈이다.
  const waitText = phaseText?.short || '수집 대기';
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
  const top = ipamTop(subnets.filter((s) => rowMatches(s, scope.q)), 6);
  // v2.598 VC2598-04: VM 수를 모르는 네트워크(null)를 0 으로 더하지 않는다 — portgroupsByVc 가 판정한다.
  const byVc = portgroupsByVc(netItems);
  const siteOf = new Map(sitesAll.map((s) => [s.id, s]));
  const pgRows = byVc.map((x) => ({ ...x, vlans: x.vlans.size, name: siteOf.get(x.vcenterId)?.name || x.vcenterId, region: siteOf.get(x.vcenterId)?.region || '' })).filter((x) => rowMatches(x, scope.q)).sort((a, b) => b.total - a.total);

  return (
    <>
      <div className="v3-kpis">
        <Kpi label="포트그룹" value={fmtInt(g?.networks)} accent="#1a2130" meta={nets.data ? `Distributed ${tc.distributed} · Standard ${tc.standard}${tc.other ? ` · 기타 ${tc.other}` : ''}` : waitText} />
        <Kpi label="NSX" value={r ? `${r.managersUp} / ${r.managers}` : '—'} accent="#7c3aed" meta={r ? `매니저 UP/전체 · T0 ${nsxCount(r.t0)} · T1 ${nsxCount(r.t1)}${r.managersDegraded ? ` · 저하 ${r.managersDegraded}` : ''}${nsxFailedShort(r) ? ` · ${nsxFailedShort(r)}` : ''}` : 'NSX 수집 대기'} />
        <Kpi label="세그먼트" value={fmtInt(r?.segments)} accent="#0e7490" meta={r ? `Overlay ${nsxCount(r.overlaySegments)} · VLAN ${nsxCount(r.vlanSegments)}` : 'NSX 수집 대기'} />
        <Kpi label="트랜스포트 노드" value={r ? fmtInt(nsxAdd(r.hostNodes, r.edgeNodes)) : '—'} accent={tnDown ? '#dc2626' : '#16a34a'} meta={r ? `호스트 ${nsxCount(r.hostNodes)} · 엣지 ${nsxCount(r.edgeNodes)} · DOWN ${tnDown}` : 'NSX 수집 대기'} />
        <Kpi label="IPAM" value={ipam.data ? fmtInt(ist.count) : '—'} accent="#2563eb" meta={ipam.data ? (ist.count ? `대역 · 평균 사용 ${fmtPct(ist.avgPct)} · 90% 초과 ${ist.over90}` : '대역 없음') : canIpam ? waitText : "권한 필요('tools')"} />
      </div>

      <div className="v3-grid2 wide">
        <div className="v3-col">
          <Panel title={`NSX 매니저 · 엣지`} sub={r ? `${r.managers} 매니저 · ${nsxCount(r.edgeNodes)} 엣지 · TN = 트랜스포트 노드 UP/DOWN` : ''} bodyPad={false}>
            <PollState poll={polls.nsx}>
              {managers.length === 0 ? <Empty>{polls.nsx.data?.managers?.length ? '범위 안에 NSX 매니저가 없습니다.' : 'NSX 매니저가 등록되어 있지 않습니다(설정 › NSX 관리).'}</Empty> : (
                <div className="v3-tablewrap">
                  <STable className="v3-table">
                    <thead><tr><th>매니저</th><th>리전</th><th>vCenter</th><th>버전</th><th className="num">노드</th><th className="num">게이트웨이</th><th className="num">세그먼트</th><th className="num">TN UP/DOWN</th><th className="num">DFW 규칙</th><th>상태</th></tr></thead>
                    <tbody>
                      {managers.map((m) => (
                        <tr key={m.id} className={m.level === 2 ? 'crit' : ''}>
                          <td><div className="v3-mono" style={{ fontSize: 12, fontWeight: 600 }}>{m.name}</div><div className="v3-cellsub">{m.host}</div></td>
                          <td style={{ color: REGION_COLORS[m.region] || '#526075', fontSize: 11.5 }}>{m.region || '—'}</td>
                          <td className="v3-dim">{m.vcenterId || '—'}</td>
                          <td className="v3-dim v3-mono" style={{ fontSize: 11 }}>{m.version || '—'}</td>
                          <td className="num">{fmtInt(m.nodeCount)}</td>
                          <td className="num">{fmtInt(m.gateways)}</td>
                          <td className="num">{fmtInt(m.segments)}</td>
                          <td className="num" data-sort={m.nodes.down}><span style={{ color: '#15803d' }}>{m.nodes.up}</span> / <span style={{ color: m.nodes.down ? '#dc2626' : '#68738a' }}>{m.nodes.down}</span></td>
                          <td className="num">{fmtInt(m.firewall?.rules)}</td>
                          <td><StateBadge state={m.status} />{m.collectError && <span className="v3-badge lv1" style={{ marginLeft: 6 }}>수집 오류</span>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </STable>
                </div>
              )}
            </PollState>
          </Panel>
          <Panel title="사이트 간 백본" sub="회선 사용률 · RTT · 손실 · 이중화">
            <Empty><b>이 포탈에는 백본 회선 계측 수집이 없습니다.</b><br />중계 경로 상태는 특수 기능 › HAProxy 경로 점검, 링크 도달성·RTT 는 네트워크 › Ping 모니터링에서 확인하세요. 수집 API 가 생기면 이 패널에 사용률 막대·24h 추세를 표시합니다.</Empty>
          </Panel>
        </div>
        <div className="v3-col">
          <Panel title="vCenter 별 포트그룹" sub="/networks · 유형 · VLAN · 연결 VM" bodyPad={false}>
            <PollState poll={nets}>
              {pgRows.length === 0 ? <Empty>범위 안에 포트그룹이 없습니다.</Empty> : (
                <div className="v3-tablewrap">
                  <STable className="v3-table">
                    <thead><tr><th>vCenter</th><th className="num">포트그룹</th><th className="num">Dist.</th><th className="num">Std.</th><th className="num">VLAN</th><th className="num">VM</th></tr></thead>
                    <tbody>
                      {pgRows.map((x) => (
                        <tr key={x.vcenterId}>
                          <td><div className="v3-mono" style={{ fontSize: 12, fontWeight: 600 }}>{x.name}</div><div className="v3-cellsub" style={{ color: REGION_COLORS[x.region] || '#68738a' }}>{x.region}</div></td>
                          <td className="num">{x.total}</td><td className="num v3-dim">{x.distributed}</td><td className="num v3-dim">{x.standard}</td><td className="num v3-dim">{x.vlans}</td><td className="num" title={x.vmsUnknown ? `VM 수를 수집하지 않은 포트그룹 ${x.vmsUnknown}개 — 합계에 넣지 않았습니다(0 이 아니라 모름)` : undefined}>{fmtInt(x.vms)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </STable>
                </div>
              )}
            </PollState>
          </Panel>
          <Panel title="IPAM 서브넷 사용률" sub={ipam.data ? `${ist.count} 대역 · /24 기준 254 · 상위 6` : ''}>
            <PollState poll={ipam} skipped={canIpam ? null : "IP 관리('ipam') 권한이 없어 조회하지 않습니다."}>
              {top.length === 0 ? <Empty>IPAM 대역이 없습니다.</Empty> : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
                  {top.map((s) => (
                    <div key={s.subnet} style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                      <span className="v3-mono" style={{ fontSize: 11, width: 120 }}>{s.subnet}</span>
                      <span className="v3-faint" style={{ fontSize: 10.5, width: 44, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.vcenterId || s.site || ''}</span>
                      <Bar pct={s.pct} />
                      <span className="v3-num" style={{ fontSize: 11, color: textColor(s.pct), width: 60, textAlign: 'right' }}>{s.used}/254</span>
                    </div>
                  ))}
                </div>
              )}
            </PollState>
          </Panel>
        </div>
      </div>
    </>
  );
}
