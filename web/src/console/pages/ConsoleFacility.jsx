// 물리 · 설비(v2.487) — 서버 전력(/overview 측정 합계) · 호스트 온도·iDRAC 연동(/hosts) · PDU(/tools/pdu) · iDRAC 폴러(/admin/idrac, 관리자).
import React from 'react';
import { usePolling } from '../../api.js';
import { STable } from '../../components/STable.jsx';
import { Panel, KpiCard, Bar, PctCell, PollState, Empty, LevelBadge } from '../ui.jsx';
import { hostFacilityRows, pduSummary, tempColor, fmtInt, fmtPct, rowMatches, REGION_COLORS } from '../consoleData.js';

export default function ConsoleFacility({ global: g, sitesAll, scope, polls, perms }) {
  const hosts = usePolling('/hosts', {}, 60_000);
  const rows = hostFacilityRows(scope.scoped(hosts.data?.items || []), sitesAll).filter((r) => rowMatches(r, scope.q));
  const maxKw = Math.max(0, ...rows.map((r) => r.powerKw ?? 0));
  const measured = rows.reduce((a, r) => a + r.measured, 0), hostN = rows.reduce((a, r) => a + r.hosts, 0);
  const maxT = rows.reduce((a, r) => (r.maxTemp != null && (a == null || r.maxTemp > a) ? r.maxTemp : a), null);
  const hot = rows.reduce((a, r) => a + r.temps.filter((t) => t.t != null && t.t >= 26).length, 0);
  const idracN = rows.reduce((a, r) => a + r.idracBacked, 0);
  const ps = polls.pdu.data ? pduSummary(polls.pdu.data) : null;
  const lr = polls.idrac.data?.poller?.lastRun || null;
  const pduDevs = (polls.pdu.data?.devices || []).map((d) => ({ id: d.id, name: d.name || d.host, dc: d.datacenterId || '', ok: d.snapshot ? d.snapshot.ok !== false : null, powerW: d.snapshot?.summary?.powerW ?? null, tempMaxC: d.snapshot?.summary?.tempMaxC ?? null, sensors: d.snapshot?.summary?.sensors ?? 0, units: d.snapshot?.summary?.units ?? 0, violations: (d.snapshot?.violations || []).length, error: d.snapshot?.error || '' })).filter((d) => rowMatches(d, scope.q));

  return (
    <>
      <div className="dvc-kpis">
        <KpiCard label="서버 소비전력" value={g?.powerReporting ? `${fmtInt(g.powerKw)} kW` : '—'} accent="#f59e0b" meta={g ? `전력 보고 ${fmtInt(g.powerReporting)}대${g.powerRegistered ? ` / iDRAC 등록 ${fmtInt(g.powerRegistered)}대` : ''}${g.powerUnmappedKw ? ` · 미매핑 ${g.powerUnmappedKw} kW` : ''}` : '수집 대기'} />
        <KpiCard label="PDU" value={ps ? fmtInt(ps.devices) : '—'} accent="#0f172a" meta={ps ? (ps.devices ? `수집 정상 ${ps.ok} · 실패 ${ps.failed} · 임계 위반 ${ps.violations}${ps.powerW ? ` · ${(ps.powerW / 1000).toFixed(1)} kW` : ''}` : '등록된 PDU 없음') : perms.pdu ? '수집 대기' : "권한 필요('tools')"} />
        <KpiCard label="호스트 온도 (ESXi/iDRAC 보고)" value={maxT != null ? `${maxT}°C` : '—'} accent={maxT == null ? '#6b7280' : maxT >= 26 ? '#ef4444' : maxT >= 24 ? '#f59e0b' : '#22c55e'} meta={hosts.data ? `최고값 · 측정 ${fmtInt(measured)}/${fmtInt(hostN)}대 · 26°C 이상 ${hot}대` : '호스트 수집 대기'} />
        <KpiCard label="iDRAC 연동 호스트" value={hosts.data && hostN ? fmtPct((idracN / hostN) * 100) : '—'} accent="#0891b2" meta={hosts.data ? `${fmtInt(idracN)} / ${fmtInt(hostN)}대 (호스트 ↔ iDRAC 매핑)` : '호스트 수집 대기'} />
        <KpiCard label="BMC(iDRAC) 폴러" value={lr ? `${fmtInt(lr.ok)}/${fmtInt((lr.ok || 0) + (lr.failed || 0))}` : '—'} accent={lr ? (lr.failed ? '#f59e0b' : '#22c55e') : '#6b7280'} meta={polls.idrac.data ? `최근 실행 응답/전체 · 등록 ${fmtInt(polls.idrac.data.poller?.servers)}대${lr?.at ? ` · ${new Date(lr.at).toLocaleTimeString('ko-KR')}` : ''}` : perms.idrac ? '폴러 상태 대기' : '관리자 권한 필요 (/admin/idrac)'} />
      </div>

      <div className="dvc-grid2">
        <Panel title="사이트별 전력 · 호스트 온도" sub="막대 = 측정 전력(최대 사이트 대비) · 셀 = 호스트 온도(점선 = 미측정)" bodyPad={false}>
          <PollState poll={hosts}>
            {rows.length === 0 ? <Empty>범위 안에 호스트가 없습니다.</Empty> : (
              <div style={{ padding: '6px 18px 14px' }}>
                {rows.map((r) => (
                  <div key={r.vcenterId} style={{ display: 'grid', gridTemplateColumns: 'minmax(170px, 1.2fr) minmax(70px, 1fr) 70px minmax(100px, 1.4fr) 60px', gap: 12, alignItems: 'center', padding: '8px 0', borderBottom: '1px solid rgba(229,231,235,.5)' }}>
                    <div style={{ minWidth: 0 }}><div style={{ fontSize: 12.5, fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.name}</div><div className="dvc-cellsub" style={{ color: REGION_COLORS[r.region] || '#9ca3af', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.city || r.vcenterId} · {r.hosts} 호스트{r.disconnected ? ` · 끊김 ${r.disconnected}` : ''}</div></div>
                    <div style={{ display: 'flex' }}><Bar pct={maxKw ? ((r.powerKw ?? 0) / maxKw) * 100 : 0} color="#3b82f6" large /></div>
                    <div className="dvc-num" style={{ textAlign: 'right', fontSize: 11.5, color: '#d97706' }}>{r.powerKw != null ? `${r.powerKw} kW` : '—'}</div>
                    <div className="dvc-temps" title={`측정 ${r.measured}/${r.hosts}대`}>
                      {r.temps.slice(0, 40).map((t) => <i key={t.name} className={t.t != null ? 'has' : ''} style={t.t != null ? { background: tempColor(t.t) } : undefined} title={`${t.name} · ${t.t != null ? `${t.t}°C` : '미측정'}`} />)}
                    </div>
                    <div className="dvc-num" style={{ textAlign: 'right', fontSize: 11.5, color: r.maxTemp == null ? '#9ca3af' : r.maxTemp >= 26 ? '#dc2626' : r.maxTemp >= 24 ? '#d97706' : '#6b7280' }}>{r.maxTemp != null ? `${r.maxTemp}°C` : '—'}</div>
                  </div>
                ))}
                <div className="dvc-note" style={{ marginTop: 10 }}>온도 색: 파랑 &lt;22 · 회색 22–24 · 노랑 24–26 · 빨강 ≥26°C. 호스트가 40대를 넘는 사이트는 앞 40대만 셀로 표시하고 최고값은 전체 기준입니다.</div>
              </div>
            )}
          </PollState>
        </Panel>
        <div className="dvc-col">
          <Panel title="iDRAC 연동 · 전력 보고" sub="/hosts · vCenter 별" bodyPad={false}>
            <PollState poll={hosts}>
              {rows.length === 0 ? <Empty>범위 안에 호스트가 없습니다.</Empty> : (
                <div className="dvc-tablewrap">
                  <STable className="dvc-table">
                    <thead><tr><th>사이트</th><th>iDRAC 연동</th><th className="num">미연동</th><th className="num">전력 보고</th><th className="num">끊김</th><th className="num">최고 온도</th></tr></thead>
                    <tbody>
                      {rows.map((r) => (
                        <tr key={r.vcenterId}>
                          <td><div className="dvc-cellname" style={{ fontSize: 12 }}>{r.name}</div></td>
                          <td data-sort={r.idracPct ?? ''}><PctCell pct={r.idracPct} color={r.idracPct >= 90 ? '#22c55e' : r.idracPct >= 50 ? '#f59e0b' : '#ef4444'} /></td>
                          <td className="num" style={{ color: r.hosts - r.idracBacked ? '#d97706' : '#9ca3af' }}>{r.hosts - r.idracBacked}</td>
                          <td className="num">{r.powerReporting}</td>
                          <td className="num" style={{ color: r.disconnected ? '#dc2626' : '#9ca3af' }}>{r.disconnected}</td>
                          <td className="num" data-sort={r.maxTemp ?? ''} style={{ color: r.maxTemp == null ? '#9ca3af' : r.maxTemp >= 26 ? '#dc2626' : '#6b7280' }}>{r.maxTemp != null ? `${r.maxTemp}°C` : '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </STable>
                </div>
              )}
            </PollState>
          </Panel>
          <Panel title="PDU" sub={ps ? `${ps.devices}대 · 전력 W · 최고 온도 · 임계 위반` : ''} bodyPad={false}>
            <PollState poll={polls.pdu} skipped={perms.pdu ? null : "특수 기능('tools') 권한이 없어 /tools/pdu 를 조회하지 않습니다."}>
              {pduDevs.length === 0 ? <Empty><b>등록된 PDU 가 없습니다.</b><br />특수 기능 › PDU 정보에서 APC Rack PDU 를 등록하면 전력·온도·임계 위반이 표시됩니다.</Empty> : (
                <div className="dvc-tablewrap">
                  <STable className="dvc-table">
                    <thead><tr><th>PDU</th><th>법인</th><th className="num">전력</th><th className="num">온도</th><th className="num">센서</th><th className="num">위반</th><th>상태</th></tr></thead>
                    <tbody>
                      {pduDevs.map((d) => (
                        <tr key={d.id}>
                          <td className="dvc-mono" style={{ fontSize: 12, fontWeight: 600 }}>{d.name}</td>
                          <td className="dvc-dim">{d.dc || '—'}</td>
                          <td className="num" style={{ color: '#d97706' }}>{d.powerW != null ? `${fmtInt(d.powerW)} W` : '—'}</td>
                          <td className="num" style={{ color: d.tempMaxC == null ? '#9ca3af' : d.tempMaxC >= 26 ? '#dc2626' : '#6b7280' }}>{d.tempMaxC != null ? `${d.tempMaxC}°C` : '—'}</td>
                          <td className="num dvc-dim">{d.sensors}</td>
                          <td className="num" style={{ color: d.violations ? '#dc2626' : '#9ca3af' }}>{d.violations}</td>
                          <td><LevelBadge level={d.ok === true ? (d.violations ? 1 : 0) : d.ok === false ? 2 : null} label={d.ok === true ? (d.violations ? '임계 위반' : '정상') : d.ok === false ? '수집 실패' : '미수집'} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </STable>
                </div>
              )}
            </PollState>
          </Panel>
        </div>
      </div>
    </>
  );
}
