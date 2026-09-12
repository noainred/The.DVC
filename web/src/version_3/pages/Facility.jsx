// V3 물리 · 설비(v2.490) — KPI 5 · 사이트별 전력·온도(/hosts, /overview) · BMC(iDRAC) 건전성(/hosts + /admin/idrac) · PDU(/tools/pdu).
import React from 'react';
import { usePolling } from '../../api.js';
import { STable } from '../../components/STable.jsx';
import { Panel, Kpi, Bar, PctCell, Badge, PollState, Empty } from '../ui.jsx';
import { hostFacilityRows, pduSummary, tempCellColor, tempTextColor, fmtInt, fmtPct, rowMatches, REGION_COLORS } from '../data.js';

export default function Facility({ global: g, ov, sitesAll, scope, polls, perms }) {
  const hosts = usePolling('/hosts', {}, 60_000);
  const rows = hostFacilityRows(scope.scoped(hosts.data?.items || []), sitesAll).filter((r) => rowMatches(r, scope.q));
  const maxKw = Math.max(0, ...rows.map((r) => r.powerKw ?? 0));
  const measured = rows.reduce((a, r) => a + r.measured, 0), hostN = rows.reduce((a, r) => a + r.hosts, 0);
  const maxT = rows.reduce((a, r) => (r.maxTemp != null && (a == null || r.maxTemp > a) ? r.maxTemp : a), null);
  const hot = rows.reduce((a, r) => a + r.temps.filter((t) => t.t != null && t.t >= 26).length, 0);
  const idracN = rows.reduce((a, r) => a + r.idracBacked, 0);
  const ps = polls.pdu.data ? pduSummary(polls.pdu.data) : null;
  const lr = polls.idrac.data?.poller?.lastRun || null;
  const phys = ov?.physical || null;
  const pduDevs = (polls.pdu.data?.devices || []).map((d) => ({ id: d.id, name: d.name || d.host, dc: d.datacenterId || '', ok: d.snapshot ? d.snapshot.ok !== false : null, powerW: d.snapshot?.summary?.powerW ?? null, tempMaxC: d.snapshot?.summary?.tempMaxC ?? null, sensors: d.snapshot?.summary?.sensors ?? 0, violations: (d.snapshot?.violations || []).length })).filter((d) => rowMatches(d, scope.q));

  return (
    <>
      <div className="v3-kpis">
        <Kpi label="총 소비전력" value={g?.powerReporting ? `${(g.powerKw / 1000).toFixed(2)} MW` : '—'} accent="#d97706" meta={g ? `${fmtInt(g.powerKw)} kW · 전력 보고 ${fmtInt(g.powerReporting)}대${g.powerUnmappedKw ? ` · 미매핑 ${g.powerUnmappedKw} kW` : ''}` : '수집 대기'} />
        <Kpi label="PDU" value={ps ? fmtInt(ps.devices) : '—'} accent="#1a2130" meta={ps ? (ps.devices ? `보고 ${ps.ok} · 무응답 ${ps.failed} · 임계 위반 ${ps.violations}` : '등록된 PDU 없음') : perms.pdu ? '수집 대기' : "권한 필요('tools')"} />
        <Kpi label="온도 센서" value={hosts.data ? fmtInt(measured) : '—'} accent={maxT == null ? '#526075' : maxT >= 26 ? '#dc2626' : maxT >= 24 ? '#d97706' : '#16a34a'} meta={hosts.data ? `호스트 흡기 측정 · 최고 ${maxT != null ? `${maxT}°C` : '—'} · 26°C 초과 ${hot}` : '호스트 수집 대기'} />
        <Kpi label="BMC 응답" value={lr ? fmtPct(((lr.ok || 0) / Math.max(1, (lr.ok || 0) + (lr.failed || 0))) * 100) : '—'} accent="#16a34a" meta={polls.idrac.data ? `iDRAC ${fmtInt(polls.idrac.data.poller?.servers)}대 · 무응답 ${fmtInt(lr?.failed)}${phys?.servers ? ` · 인식 ${fmtInt(phys.servers)}대` : ''}` : perms.idrac ? '폴러 상태 대기' : '관리자 권한 필요 (/admin/idrac)'} />
        <Kpi label="iDRAC 연동 호스트" value={hosts.data && hostN ? fmtPct((idracN / hostN) * 100) : '—'} accent="#0e7490" meta={hosts.data ? `${fmtInt(idracN)} / ${fmtInt(hostN)}대 (호스트 ↔ iDRAC 매핑)` : '호스트 수집 대기'} />
      </div>

      <div className="v3-grid2">
        <Panel title="사이트별 전력 · 흡기 온도" sub="막대 = 측정 전력(최대 사이트 대비) · 셀 = 호스트 온도 센서(점선 = 미측정)" bodyPad={false}>
          <PollState poll={hosts}>
            {rows.length === 0 ? <Empty>범위 안에 호스트가 없습니다.</Empty> : (
              <div style={{ padding: '6px 18px 14px' }}>
                {rows.map((r) => (
                  <div key={r.vcenterId} style={{ display: 'grid', gridTemplateColumns: 'minmax(150px, 1.1fr) minmax(70px, 1fr) 74px minmax(100px, 1.4fr) 60px', gap: 12, alignItems: 'center', padding: '8px 0', borderBottom: '1px solid #e6eaf0' }}>
                    <div style={{ minWidth: 0 }}><div style={{ fontSize: 12.5, fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.name} <span className="v3-dim" style={{ fontWeight: 400, fontSize: 11 }}>{r.hosts} 호스트</span></div><div className="v3-cellsub" style={{ color: REGION_COLORS[r.region] || '#68738a', fontSize: 10.5 }}>{r.city || r.vcenterId}{r.disconnected ? ` · 끊김 ${r.disconnected}` : ''}</div></div>
                    <div style={{ display: 'flex' }}><Bar pct={maxKw ? ((r.powerKw ?? 0) / maxKw) * 100 : 0} color={r.powerKw != null && maxKw && r.powerKw / maxKw >= 0.85 ? '#dc2626' : r.powerKw != null && maxKw && r.powerKw / maxKw >= 0.7 ? '#d97706' : '#2563eb'} large /></div>
                    <div className="v3-num" style={{ textAlign: 'right', fontSize: 11.5, color: '#b45309' }}>{r.powerKw != null ? `${r.powerKw} kW` : '—'}</div>
                    <div className="v3-temps" title={`측정 ${r.measured}/${r.hosts}대`}>
                      {r.temps.slice(0, 40).map((t) => <i key={t.name} className={t.t != null ? 'has' : ''} style={t.t != null ? { background: tempCellColor(t.t) } : undefined} title={`${t.name} · ${t.t != null ? `${t.t}°C` : '미측정'}`} />)}
                    </div>
                    <div className="v3-num" style={{ textAlign: 'right', fontSize: 11.5, color: tempTextColor(r.maxTemp) }}>{r.maxTemp != null ? `${r.maxTemp}°C` : '—'}</div>
                  </div>
                ))}
                <div style={{ display: 'flex', gap: 16, marginTop: 10, flexWrap: 'wrap' }} className="v3-note"><span>막대 = 측정 전력(최대 사이트 대비)</span><span>셀 = 온도 센서 · 파랑 &lt;22 · 회색 22–24 · 노랑 24–26 · 빨강 ≥26°C · 40대 초과 사이트는 앞 40대만</span></div>
              </div>
            )}
          </PollState>
        </Panel>
        <div className="v3-col">
          <Panel title="BMC (iDRAC) 건전성" sub="사이트별 · iDRAC 연동 비율 · 미연동 · 전력 보고 · 끊김" bodyPad={false}>
            <PollState poll={hosts}>
              {rows.length === 0 ? <Empty>범위 안에 호스트가 없습니다.</Empty> : (
                <div className="v3-tablewrap">
                  <STable className="v3-table">
                    <thead><tr><th>사이트</th><th>응답</th><th className="num">미연동</th><th className="num">전력 보고</th><th className="num">끊김</th><th className="num">최고 온도</th></tr></thead>
                    <tbody>
                      {rows.map((r) => (
                        <tr key={r.vcenterId}>
                          <td><div className="v3-cellname" style={{ fontSize: 12 }}>{r.name}</div></td>
                          <td data-sort={r.idracPct ?? ''}><PctCell pct={r.idracPct} color={r.idracPct >= 90 ? '#16a34a' : r.idracPct >= 50 ? '#d97706' : '#dc2626'} /></td>
                          <td className="num" style={{ color: r.hosts - r.idracBacked ? '#b45309' : '#68738a' }}>{r.hosts - r.idracBacked}</td>
                          <td className="num">{r.powerReporting}</td>
                          <td className="num" style={{ color: r.disconnected ? '#dc2626' : '#68738a' }}>{r.disconnected}</td>
                          <td className="num" data-sort={r.maxTemp ?? ''} style={{ color: tempTextColor(r.maxTemp) }}>{r.maxTemp != null ? `${r.maxTemp}°C` : '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </STable>
                  <div className="v3-note" style={{ padding: '10px 18px 12px' }}>응답 = 호스트 ↔ iDRAC 매핑 비율. 하드웨어 경고·펌웨어 기준선·보증 만료는 특수 기능 › 하드웨어·펌웨어에서 확인하세요(이 화면에 수집 요약 API 없음).</div>
                </div>
              )}
            </PollState>
          </Panel>
          <Panel title="PDU" sub={ps ? `${ps.devices}대 · 전력 W · 최고 온도 · 임계 위반` : ''} bodyPad={false}>
            <PollState poll={polls.pdu} skipped={perms.pdu ? null : "특수 기능('tools') 권한이 없어 /tools/pdu 를 조회하지 않습니다."}>
              {pduDevs.length === 0 ? <Empty><b>등록된 PDU 가 없습니다.</b><br />특수 기능 › PDU 정보에서 PDU 를 등록하면 전력·온도·임계 위반이 표시됩니다.</Empty> : (
                <div className="v3-tablewrap">
                  <STable className="v3-table">
                    <thead><tr><th>PDU</th><th>사이트</th><th className="num">전력</th><th className="num">온도</th><th className="num">센서</th><th className="num">위반</th><th>상태</th></tr></thead>
                    <tbody>
                      {pduDevs.map((d) => (
                        <tr key={d.id}>
                          <td className="v3-mono" style={{ fontSize: 12, fontWeight: 600 }}>{d.name}</td>
                          <td className="v3-dim">{d.dc || '—'}</td>
                          <td className="num" style={{ color: '#b45309' }}>{d.powerW != null ? `${fmtInt(d.powerW)} W` : '—'}</td>
                          <td className="num" style={{ color: tempTextColor(d.tempMaxC) }}>{d.tempMaxC != null ? `${d.tempMaxC}°C` : '—'}</td>
                          <td className="num v3-dim">{d.sensors}</td>
                          <td className="num" style={{ color: d.violations ? '#dc2626' : '#68738a' }}>{d.violations}</td>
                          <td><Badge level={d.ok === true ? (d.violations ? 1 : 0) : d.ok === false ? 2 : null} label={d.ok === true ? (d.violations ? '임계 위반' : '정상') : d.ok === false ? '수집 실패' : '미수집'} /></td>
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
