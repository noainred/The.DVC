/**
 * V4 ⑥ 물리 · 설비(v2.490 → v2.508) — 시안 EngFacility.dc.html.
 * KPI · 사이트별 전력·온도(/hosts, /overview) · BMC 건전성 · PDU(/tools/pdu)
 *  + v2.508 추가: 법인 전산실 운영 온도(/admin/room-temp) · 서버 온도 추이(v2.504).
 *
 * /admin/* 는 **관리자 전용**이다 — 비관리자에게는 호출하지 않고(403 을 만들지 않는다) 왜 비었는지 적는다.
 */
import React, { useEffect, useState } from 'react';
import { usePolling, fetchJson } from '../../api.js';
import { STable } from '../../components/STable.jsx';
import { Panel, Kpi, Bar, PctCell, Badge, PollState, Empty, Spark } from '../ui.jsx';
import { hostFacilityRows, pduSummary, tempCellColor, tempTextColor, fmtInt, fmtPct, rowMatches, REGION_COLORS } from '../data.js';

export default function Facility({ global: g, ov, sitesAll, scope, polls, perms, spec, isAdmin, phase, phaseText, health }) {
  // 수집이 끝나기 전 KPI 메타 문구(v2.509) — 예전에는 전부 '수집 대기' 라 **기다리면 되는 상황과
  // 조치가 필요한 상황이 같은 말**이었다. 셸이 /health 로 판정한 phase 를 쓴다.
  // ⚠ NSX 는 vCenter 수집과 **다른 수집기**(/nsx)라 이 문구를 쓰지 않는다 — vCenter 대수로
  //   NSX 상태를 말하면 확인하지 않은 것을 말하는 셈이다.
  const waitText = phaseText?.short || '수집 대기';
  const hosts = usePolling('/hosts', {}, 60_000);
  const room = usePolling(isAdmin ? '/admin/room-temp' : null, {}, 300_000);
  // 서버 온도 추이(v2.504) — 서버를 고른 뒤에만 1회 조회한다(시계열이라 폴링 대상이 아니다).
  const [tempSrv, setTempSrv] = useState('');
  const [tempDays, setTempDays] = useState(7);
  const [hist, setHist] = useState(null);
  const [histErr, setHistErr] = useState('');
  useEffect(() => {
    if (!isAdmin || !tempSrv) { setHist(null); return undefined; }
    let dead = false;
    setHist(null); setHistErr('');
    fetchJson(`/admin/idrac/${encodeURIComponent(tempSrv)}/temp-history`, { days: tempDays })
      .then((r) => { if (!dead) setHist(r); })
      .catch((e) => { if (!dead) setHistErr(e.message || String(e)); });
    return () => { dead = true; };
  }, [isAdmin, tempSrv, tempDays]);
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
        {/* 단위는 kW 로 통일한다(v2.508) — MW 표기는 79.1 kW 를 '0.08 MW' 로 보여 자릿수를 읽기 어렵게 했고,
            사이드바 푸터·전력 화면은 kW 라 같은 값이 두 단위로 보였다. 1,000 kW 를 넘으면 MW 를 덧붙인다. */}
        <Kpi label="총 소비전력" value={g?.powerReporting ? `${fmtInt(g.powerKw)} kW` : '—'} accent="#d97706"
          meta={g ? `${g.powerKw >= 1000 ? `${(g.powerKw / 1000).toFixed(2)} MW · ` : ''}전력 보고 ${fmtInt(g.powerReporting)}대${g.powerUnmappedKw ? ` · 미매핑 ${g.powerUnmappedKw} kW` : ''}` : waitText} />
        <Kpi label="PDU" value={ps ? fmtInt(ps.devices) : '—'} accent="#1a2130" meta={ps ? (ps.devices ? `보고 ${ps.ok} · 무응답 ${ps.failed} · 임계 위반 ${ps.violations}` : '등록된 PDU 없음') : perms.pdu ? waitText : "권한 필요('tools')"} />
        <Kpi label="온도 센서" value={hosts.data ? fmtInt(measured) : '—'} accent={maxT == null ? '#526075' : maxT >= 26 ? '#dc2626' : maxT >= 24 ? '#d97706' : '#16a34a'} meta={hosts.data ? `호스트 흡기 측정 · 최고 ${maxT != null ? `${maxT}°C` : '—'} · 26°C 초과 ${hot}` : waitText} />
        <Kpi label="BMC 응답" value={lr ? fmtPct(((lr.ok || 0) / Math.max(1, (lr.ok || 0) + (lr.failed || 0))) * 100) : '—'} accent="#16a34a" meta={polls.idrac.data ? `iDRAC ${fmtInt(polls.idrac.data.poller?.servers)}대 · 무응답 ${fmtInt(lr?.failed)}${phys?.servers ? ` · 인식 ${fmtInt(phys.servers)}대` : ''}` : perms.idrac ? '폴러 상태 대기' : '관리자 권한 필요 (/admin/idrac)'} />
        <Kpi label="iDRAC 연동 호스트" value={hosts.data && hostN ? fmtPct((idracN / hostN) * 100) : '—'} accent="#0e7490" meta={hosts.data ? `${fmtInt(idracN)} / ${fmtInt(hostN)}대 (호스트 ↔ iDRAC 매핑)` : waitText} />
      </div>

      <div className="v3-grid2">
        <Panel title="사이트별 전력 · 흡기 온도" sub="막대 = 측정 전력(최대 사이트 대비) · 셀 = 호스트 온도 센서(점선 = 미측정)" bodyPad={false}>
          <PollState poll={hosts}>
            {rows.length === 0 ? <Empty>범위 안에 호스트가 없습니다.</Empty> : (
              <div style={{ padding: '6px 18px 14px' }}>
                {/* 행의 열 정의는 v4.css 의 .v4-facrow 가 소유한다(v2.508) — 인라인 고정 5열이던 동안
                    최소폭 합이 502px 이라 400px 화면에서 172px 넘쳤다(변경 전 빌드와 A/B 로 확인했다). */}
                {rows.map((r) => (
                  <div key={r.vcenterId} className="v4-facrow">
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

      <div className="v3-grid2">
        <Panel title="법인 전산실 운영 온도" sub={room.data ? `ASHRAE 권장 ${room.data.thresholds?.recommendMin}~${room.data.thresholds?.recommendMax}℃ · ΔT = 배기 − 흡기` : '관리자 전용'}
          right={<span className="v3-tag">/admin/room-temp</span>}>
          <PollState poll={isAdmin ? room : null} skipped={!isAdmin ? '이 패널은 관리자 권한이 필요합니다 (/admin/room-temp).' : undefined}>
            {(room.data?.totals?.withData || 0) === 0 ? (
              <Empty>
                온도를 보고하는 서버가 <b>0대</b>입니다 — 등록 {fmtInt(room.data?.totals?.servers)}대 중
                {' '}<b>{fmtInt(room.data?.totals?.noSensor)}대가 온도 센서를 보고하지 않습니다</b>
                {room.data?.totals?.stale ? <>, {fmtInt(room.data.totals.stale)}대는 표본이 오래됐습니다</> : null}.
                {' '}값을 <b>0℃ 로 채우지 않습니다</b> — 0℃ 는 급냉으로 읽힙니다.
              </Empty>
            ) : (
              <div className="v4-facts">
                {(room.data?.groups || []).filter((r) => scope.inScope(r.id)).map((r) => (
                  <div className="v4-fact" key={r.id}>
                    <div className="v4-fact-label">{r.name}</div>
                    <div className="v4-fact-value" style={{ color: tempTextColor(r.inlet?.avg) }}>
                      {r.inlet?.avg != null ? `${r.inlet.avg}℃` : '—'}
                    </div>
                    <div className="v4-fact-meta">
                      흡기 {r.inlet?.min ?? '—'}~{r.inlet?.max ?? '—'} · 배기 {r.exhaust?.avg ?? '—'} · ΔT {r.deltaAvg ?? '—'}
                      <br />서버 {fmtInt(r.hostCount)}대 · 센서 없음 {fmtInt(r.noSensorCount)}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </PollState>
        </Panel>

        <Panel title="서버 온도 추이" sub="iDRAC 최고 온도 · 기본 서버당 1계열" right={<span className="v3-tag">/admin/idrac/:id/temp-history</span>}>
          {!isAdmin ? <Empty>이 패널은 관리자 권한이 필요합니다 (/admin/idrac).</Empty> : (
            <>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
                <label className="v3-chip" style={{ flex: 1, minWidth: 200 }}><span>서버</span>
                  <select value={tempSrv} onChange={(e) => setTempSrv(e.target.value)} style={{ flex: 1, minWidth: 0 }}>
                    <option value="">선택…</option>
                    {(polls.idrac.data?.servers || []).filter((sv) => scope.inScope(sv.mappedVcenterId || sv.vcenterId)).map((sv) => (
                      <option key={sv.id} value={sv.id}>{sv.name}</option>
                    ))}
                  </select>
                </label>
                <div className="v4-modes">
                  {[1, 7, 30, 90, 365].map((d) => (
                    <button key={d} type="button" className={`v4-mode${tempDays === d ? ' on' : ''}`} onClick={() => setTempDays(d)}>{d >= 365 ? '1년' : `${d}일`}</button>
                  ))}
                </div>
              </div>
              {histErr && <div className="v3-banner">온도 이력 조회 실패: {histErr}</div>}
              {!tempSrv && !histErr && <Empty>서버를 고르면 최근 {tempDays >= 365 ? '1년' : `${tempDays}일`} 최고 온도 추이를 보여 줍니다.</Empty>}
              {tempSrv && !histErr && !hist && <Empty>불러오는 중…</Empty>}
              {hist && ((hist.points || []).length < 2
                ? <Empty>
                    표본이 <b>{fmtInt((hist.points || []).length)}개</b>뿐이라 선을 그리지 않습니다. 온도 롤업은 시간당 1행이라
                    최근에 등록했거나 센서를 보고하지 않으면 비어 있습니다 — <b>수집 시작 이전 구간은 소급해서 그리지 않습니다</b>.
                  </Empty>
                : <>
                    <Spark points={(hist.points || []).map((pt) => ({ x: pt.ts ?? pt.h, y: pt.max ?? pt.v ?? null }))} color="#d97706" height={140} />
                    <div className="v3-note" style={{ marginTop: 8 }}>
                      표본 {fmtInt(hist.points.length)}개 · 단위 ℃(최고). 흡기·배기·CPU 4계열은 <b>옵트인 설정</b>으로만 켜집니다 — 켜면 적재 행 수가 4배가 됩니다.
                    </div>
                  </>)}
            </>
          )}
        </Panel>
      </div>

      <div className="v3-note">
        <b>‘펌웨어 기준선 준수율’은 만들지 않았습니다</b> — 설치된 버전 목록은 있지만 ‘기준선’ 을 정의해 두는 저장소가 없습니다.
        {!spec?.rawCols && <> 경영 보기에서는 서비스태그·moref 열을 숨깁니다.</>}
      </div>
    </>
  );
}
