/**
 * V4 ④ 전력 · 비용 · 탄소(v2.508, 경영 보기 중심) — 시안 ExecPower.dc.html.
 * iDRAC 실측 전력을 경영 단위(요금·CO₂)로 환산한다. 환산 계수는 **설정값**이고 화면에 밝힌다.
 *
 * 이 화면이 일부러 만들지 않은 것(데이터가 없다):
 *   · 계약 전력 대비 %   — 계약 전력을 수집하는 API 가 없다. 실측 W 와 단가만 안다.
 *   · SLA · 가용률 %     — 가동/정지 이력 저장소가 없다.
 *   · ROI · TCO · 절감액 — 자원(GB·vCPU·RAM)을 금액으로 바꿀 단가가 없다. 전력만 환산 가능하다.
 */
import React from 'react';
import { usePolling, can } from '../../api.js';
import { STable } from '../../components/STable.jsx';
import { Panel, Kpi, Empty, PollState } from '../ui.jsx';
import { fmtInt, fmtPct, REGION_COLORS } from '../data.js';

const money = (cur, v) => (v == null || !Number.isFinite(Number(v)) ? '—' : `${cur || '₩'}${Math.round(Number(v)).toLocaleString('ko-KR')}`);
const millions = (cur, v) => (v == null || !Number.isFinite(Number(v)) ? '—' : `${cur || '₩'}${(Number(v) / 1_000_000).toFixed(1)} M`);
const NEED_INSIGHTS = '이 화면의 데이터는 “인사이트(insights)” 권한이 필요합니다 — 전력 실측을 요금·탄소로 환산하는 API 가 그 권한 아래에 있습니다. 관리자에게 요청하세요.';
const tons = (kg) => (kg == null || !Number.isFinite(Number(kg)) ? '—' : `${fmtInt(Math.round(Number(kg) / 1000))} t`);

export default function Power({ spec, scope, onExitToSettings }) {
  // 이 화면의 데이터는 전부 /insights/* 이고 requirePerm('insights') 아래다(index.js:229).
  // 권한이 없으면 호출하지 않고(403 을 만들지 않는다) 왜 비었는지 화면에 적는다.
  const canInsights = can('insights');
  const fin = usePolling(canInsights ? '/insights/finops' : null, {}, 120_000);
  const pb = usePolling(canInsights ? '/insights/power-breakdown' : null, {}, 120_000);

  const cfg = fin.data?.config || pb.data?.config || null;
  const cur = cfg?.currency || '₩';
  const T = fin.data?.totals || null;
  const measured = fin.data?.measuredHosts, total = fin.data?.totalHosts;
  const coverPct = measured != null && total ? (measured / total) * 100 : null;
  const missing = Math.max(0, (total || 0) - (measured || 0));

  const rows = (pb.data?.byVcenter || []).filter((r) => scope.inScope(r.vcId));
  const dcs = pb.data?.byDatacenter || [];
  const maxDc = Math.max(1, ...dcs.map((d) => d.watts || 0));
  const tops = (fin.data?.topHosts || []).filter((h) => scope.inScope(h.vcenterId)).slice(0, spec.rows);

  return (
    <>
      <div className="v4-band">
        <span><b>환산 전제</b> — 단가 {money(cur, cfg?.tariffPerKwh)} / kWh · PUE {cfg?.pue ?? '—'} · CO₂ {cfg?.co2KgPerKwh ?? '—'} kg / kWh.
          {' '}이 값들은 <b>설정값</b>입니다(기본값일 수 있습니다). 현장 계약 단가·실측 PUE 로 바꾸면 아래 금액이 모두 달라집니다.</span>
        <span className="v3-tag" style={{ marginLeft: 'auto' }}>/insights/finops/config</span>
      </div>

      <PollState poll={canInsights ? fin : null} skipped={canInsights ? undefined : NEED_INSIGHTS}>
        <>
          <div className={`v4-band${missing > 0 ? ' warn' : ''}`}>
            <span>
              {missing > 0
                ? <><b>총계는 전체가 아닙니다</b> — 전력을 보고하는 서버 <b>{fmtInt(measured)}</b>대 / 등록 <b>{fmtInt(total)}</b>대
                  {coverPct != null && <> ({fmtPct(coverPct)})</>}. 나머지 <b>{fmtInt(missing)}</b>대는 값을 올리지 않아 <b>합계에 들어 있지 않습니다</b> — 소비가 0 이라는 뜻이 아닙니다.</>
                : <>등록된 서버 <b>{fmtInt(total)}</b>대가 <b>모두</b> 전력을 보고하고 있습니다 — 아래 총계는 등록 서버 전체 기준입니다.</>}
              {fin.data?.unmappedServers > 0 && <> 법인 미매핑 <b>{fmtInt(fin.data.unmappedServers)}</b>대 · {fmtInt(Math.round((fin.data.unmappedWatts || 0) / 1000))} kW 는 법인별 표에서 빠집니다.</>}
            </span>
          </div>

          <div className="v3-kpis">
            <Kpi label="서버 실측 전력" value={T ? `${(T.watts / 1000).toFixed(1)} kW` : '—'} meta={`측정 서버 ${fmtInt(measured)}대 합계`} accent="#b45309" />
            <Kpi label={`설비 포함 (×PUE ${cfg?.pue ?? '—'})`} value={T ? `${(T.facilityWatts / 1000).toFixed(1)} kW` : '—'} meta="냉방·전원 손실 가정 — 실측이 아닙니다" accent="#d97706" />
            <Kpi label="월 전기요금 (추정)" value={millions(cur, T?.costMonth)} meta={`월 ${fmtInt(T?.kwhMonth)} kWh × ${money(cur, cfg?.tariffPerKwh)}`} accent="#2563eb" />
            <Kpi label="연 CO₂ (추정)" value={tons(T?.co2YearKg)} meta={`연 ${fmtInt(T?.kwhYear)} kWh × ${cfg?.co2KgPerKwh ?? '—'} kg`} accent="#0e7490" />
          </div>
        </>
      </PollState>

      <Panel title="법인별 전력 · 비용 · 탄소" sub="열 제목 클릭 정렬" right={<span className="v3-tag">/insights/power-breakdown</span>} bodyPad={false}>
        <PollState poll={canInsights ? pb : null} skipped={canInsights ? undefined : NEED_INSIGHTS}>
          <div className="v3-tablewrap">
            <STable className="v3-table">
              <thead><tr><th>법인</th><th>리전</th><th className="num">측정 서버</th><th className="num">전력</th><th className="num">월 전력량</th><th className="num">월 요금</th><th className="num">연 CO₂</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.vcId}>
                    <td><div className="v3-cellname">{r.vcId}</div></td>
                    <td style={{ color: REGION_COLORS[r.region] || '#526075', fontSize: 11.5 }}>{r.region}</td>
                    <td className="num" data-sort={r.servers ?? ''}>{fmtInt(r.servers)}</td>
                    <td className="num" data-sort={r.watts ?? ''} style={{ color: '#b45309' }}>{r.watts ? `${fmtInt(Math.round(r.watts / 1000))} kW` : '—'}</td>
                    <td className="num" data-sort={r.kwhMonth ?? ''}>{fmtInt(Math.round(r.kwhMonth))}</td>
                    <td className="num" data-sort={r.costMonth ?? ''}>{millions(cur, r.costMonth)}</td>
                    <td className="num" data-sort={r.co2YearKg ?? ''}>{tons(r.co2YearKg)}</td>
                  </tr>
                ))}
              </tbody>
            </STable>
            {rows.length === 0 && <Empty>범위 안에 전력을 보고하는 법인이 없습니다.</Empty>}
          </div>
          <div className="v3-note" style={{ padding: '10px 18px 14px' }}>
            표의 <b>월 전력량</b>(kWh)은 <b>PUE 를 포함하지 않은 서버 실측 기준</b>이고, 위 KPI 의 ‘설비 포함’ 만 ×PUE 입니다 — 두 수치를 더하지 마세요.
          </div>
        </PollState>
      </Panel>

      <div className="v3-grid2">
        <Panel title="DataCenter → 법인" sub="전력 귀속" right={<span className="v3-tag">byDatacenter</span>}>
          <PollState poll={canInsights ? pb : null} skipped={canInsights ? undefined : NEED_INSIGHTS}>
            {dcs.length === 0 ? <Empty>DataCenter 할당이 없습니다 — 설정 › DataCenter 관리에서 법인을 배정하면 여기에 나뉘어 보입니다.</Empty> : (
              <div className="v4-blist">
                {dcs.map((d) => (
                  <div className="v4-brow" key={d.datacenterId || d.datacenterName}>
                    <span className="nm">{d.datacenterName}</span>
                    <span className="v3-bar lg"><i style={{ width: `${((d.watts || 0) / maxDc) * 100}%`, background: '#d97706' }} /></span>
                    <span className="vl">{fmtInt(Math.round((d.watts || 0) / 1000))} kW · 서버 {fmtInt(d.servers)}</span>
                  </div>
                ))}
              </div>
            )}
          </PollState>
        </Panel>

        <Panel title="전력 상위 서버" sub={`상위 ${spec.rows}`} right={<span className="v3-tag">/insights/finops · topHosts</span>} bodyPad={false}>
          <PollState poll={canInsights ? fin : null} skipped={canInsights ? undefined : NEED_INSIGHTS}>
            <div className="v3-tablewrap">
              <STable className="v3-table">
                <thead><tr><th>서버</th><th>법인</th>{spec.rawCols && <th>모델</th>}<th className="num">W</th></tr></thead>
                <tbody>
                  {tops.map((h) => (
                    <tr key={`${h.vcenterId}:${h.host}`}>
                      <td><div className="v3-cellname">{h.host}</div></td>
                      <td className="v3-dim" style={{ fontSize: 11.5 }}>{h.vcenterId}</td>
                      {spec.rawCols && <td className="v3-dim ellipsis" style={{ fontSize: 11 }}>{h.model || '—'}</td>}
                      <td className="num" data-sort={h.watts ?? ''} style={{ color: '#b45309', fontWeight: 700 }}>{fmtInt(h.watts)}</td>
                    </tr>
                  ))}
                </tbody>
              </STable>
              {tops.length === 0 && <Empty>범위 안에 전력을 보고하는 서버가 없습니다.</Empty>}
            </div>
            {!spec.rawCols && <div className="v3-note" style={{ padding: '10px 18px 14px' }}>경영 보기에서는 모델·서비스태그 열을 숨깁니다 — 엔지니어 보기로 바꾸면 나옵니다.</div>}
          </PollState>
        </Panel>
      </div>

      <Panel title="이 화면에 넣지 않은 것" sub="데이터가 없어서다 — 임의 상수로 채우지 않는다">
        <div className="v3-rows">
          {[
            ['계약 전력 대비 %', '계약 전력 값을 수집하는 API 가 없습니다. 실측 W 와 단가만 압니다.'],
            ['SLA · 가용률 %', '가동/정지 이력을 남기는 저장소가 없습니다.'],
            ['ROI · TCO · 절감 금액', '자원(GB·vCPU·RAM)을 금액으로 바꿀 단가가 없습니다. 전력만 환산할 수 있습니다.'],
          ].map(([t, why]) => (
            <div className="v3-row" key={t}>
              <span className="v3-grow"><div className="v3-row-title">{t}</div><div className="v3-row-meta">{why}</div></span>
              <span className="v3-badge lvn">수집 없음</span>
            </div>
          ))}
        </div>
      </Panel>

      <div className="v3-note">
        <b>순간 전력 기준 추정</b>입니다. 실제 청구액과 다를 수 있습니다 — 요금제(계시별·기본요금)·역률 보정·설비 실측 PUE 를 반영하지 않습니다.
        {onExitToSettings && <> 단가·PUE·CO₂ 계수는 <button type="button" className="v3-kbd" style={{ cursor: 'pointer' }} onClick={onExitToSettings}>설정에서 변경</button>할 수 있습니다.</>}
      </div>
    </>
  );
}
