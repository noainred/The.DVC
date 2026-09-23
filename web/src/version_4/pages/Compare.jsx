/**
 * V4 ③ 법인 비교 · 용량(v2.508, 경영 보기 중심) — 시안 ExecCompare.dc.html.
 * "어느 법인이 먼저 한계에 닿는가" 를 한 화면에서 본다. 전부 실 API 다.
 *
 * 폴링 주기가 긴 이유: /tools/capacity-forecast 는 실측 약 1.5초(CLAUDE.md v2.503)이고
 * /compare/matrix 는 전 클러스터를 훑는다. 28 vCenter · 고RTT 환경에서 15초 폴링은 금물이다.
 */
import React, { useState } from 'react';
import { usePolling, can, toolAllowed } from '../../api.js';
import { STable } from '../../components/STable.jsx';
import { Panel, Bar, PctCell, Empty, PollState, Spark } from '../ui.jsx';
import { fmtInt, fmtPct, textColor, barColor, REGION_COLORS, WARN_PCT, CRIT_PCT } from '../data.js';

const NEED_TOOLS = '이 패널은 “특수 기능(tools)” 권한이 필요합니다 — 관리자에게 요청하세요.';

export default function Compare({ scope, sitesAll, spec, go }) {
  const [axis, setAxis] = useState('cluster');
  const [normalize, setNormalize] = useState(false);
  const canTools = can('tools');
  const canFc = canTools && toolAllowed('forecast') /* v2.583 #38: 서버는 capacity-forecast 경로를 forecast 키로 집행한다 */;
  const canCap = canTools && toolAllowed('capacity');
  const canTrack = canTools && toolAllowed('vm-track');
  const canInsights = can('insights'); // /insights/* 는 requirePerm('insights') 아래다(index.js:229)

  const mx = usePolling('/compare/matrix', { axis, normalize: normalize ? '1' : '' }, 120_000);
  const cap = usePolling(canCap ? '/tools/capacity' : null, {}, 120_000);
  const fc = usePolling(canFc ? '/tools/capacity-forecast' : null, {}, 120_000);
  const fore = usePolling(canInsights ? '/insights/forecast' : null, {}, 120_000);
  const track = usePolling(canTrack ? '/tools/vm-track' : null, { days: spec.days }, 120_000);

  const sites = scope.scoped(sitesAll, 'id');
  // 지역 롤업은 이미 받은 /overview 로 계산한다 — 같은 값을 위해 API 를 한 번 더 부르지 않는다.
  const byRegion = [];
  for (const s of sites) {
    let r = byRegion.find((x) => x.region === s.region);
    if (!r) { r = { region: s.region, vcenters: 0, hosts: 0, vms: 0 }; byRegion.push(r); }
    r.vcenters += 1; r.hosts += s.hosts || 0; r.vms += s.vms || 0;
  }
  byRegion.sort((a, b) => b.vms - a.vms);
  const maxVms = Math.max(1, ...byRegion.map((r) => r.vms));

  const vcs = mx.data?.vcenters || [];
  const rows = mx.data?.rows || [];
  const metricKey = axis === 'cluster' ? 'cpuUsagePct' : 'usagePct';

  const fcRows = (fc.data?.items || [])
    .filter((d) => scope.inScope(d.vcenterId))
    .filter((d) => d.daysToFull != null)
    .sort((a, b) => a.daysToFull - b.daysToFull)
    .slice(0, spec.rows);

  const capRows = (cap.data?.clusters || [])
    .filter((c) => scope.inScope(c.vcenterId))
    .sort((a, b) => (a.ramHeadroomGB || 0) - (b.ramHeadroomGB || 0))
    .slice(0, spec.rows);

  const dsPoints = (track.data?.points || []).map((p) => ({ x: p.ts, y: p.dsUsedGB == null ? null : p.dsUsedGB / 1024 }));

  return (
    <>
      <Panel title="비교 매트릭스" sub={`셀 = ${axis === 'cluster' ? '클러스터 평균 CPU 사용률' : '데이터스토어 사용률'} · 열 제목 클릭 정렬`}
        right={<>
          <span className="v3-tag">/compare/matrix</span>
          <div className="v4-modes">
            {[['cluster', '클러스터'], ['datastore', '데이터스토어']].map(([k, l]) => (
              <button key={k} type="button" className={`v4-mode${axis === k ? ' on' : ''}`} onClick={() => setAxis(k)}>{l}</button>
            ))}
          </div>
          <label className="v3-chip" style={{ cursor: 'pointer' }}>
            <input type="checkbox" checked={normalize} onChange={(e) => setNormalize(e.target.checked)} /> 이름 정규화
          </label>
        </>} bodyPad={false}>
        <PollState poll={mx}>
          <div className="v3-tablewrap">
            <STable className="v3-table">
              <thead><tr><th>{axis === 'cluster' ? '클러스터' : '데이터스토어'}</th>{vcs.map((v) => <th key={v.id} className="num" title={v.name}>{v.name.replace(/^(vcenter|vc)[-_.]/i, '')}</th>)}<th className="num">합계</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.name}>
                    <td><div className="v3-cellname">{r.name}</div></td>
                    {vcs.map((v) => {
                      const cell = r.cells?.[v.id];
                      const val = cell?.[metricKey];
                      return (
                        <td key={v.id} className="num" data-sort={val ?? ''}>
                          {val == null ? <span className="v3-faint">—</span>
                            : <span className="v4-heat" style={{ background: `${barColor(val)}22`, color: textColor(val) }}>{Math.round(val)}</span>}
                        </td>
                      );
                    })}
                    <td className="num" data-sort={r.total?.[metricKey] ?? ''} style={{ fontWeight: 700, color: textColor(r.total?.[metricKey]) }}>{fmtPct(r.total?.[metricKey])}</td>
                  </tr>
                ))}
              </tbody>
            </STable>
            {rows.length === 0 && <Empty>비교할 행이 없습니다.</Empty>}
          </div>
          <div className="v3-note" style={{ padding: '10px 18px 14px' }}>
            <b>—</b> 는 <b>그 법인에 그 이름의 {axis === 'cluster' ? '클러스터' : '데이터스토어'}가 없다</b>는 뜻입니다 — 0% 로 채우지 않습니다(희소 매트릭스).
            {' '}‘이름 정규화’는 접미 번호·구분자를 무시해 묶는 <b>휴리스틱</b>이라 서로 다른 대상이 한 행에 묶일 수 있습니다.
            {mx.data?.truncated && <> 행이 많아 <b>{fmtInt(mx.data.truncatedRows)}개를 잘라냈습니다</b>(상한 {fmtInt(mx.data.maxRows)}).</>}
          </div>
        </PollState>
      </Panel>

      <div className="v3-grid2">
        <Panel title="스토리지 소진 임박" sub={`증가 추세 기준 · 상위 ${spec.rows}`} right={<span className="v3-tag">/tools/capacity-forecast</span>} bodyPad={false}>
          <PollState poll={canFc ? fc : null} skipped={!canFc ? NEED_TOOLS : undefined}>
            <div className="v3-tablewrap">
              <STable className="v3-table">
                <thead><tr><th>데이터스토어</th>{spec.rawCols && <th>vCenter</th>}<th>사용률</th><th className="num">일 증가</th><th className="num">소진</th></tr></thead>
                <tbody>
                  {fcRows.map((d) => (
                    <tr key={d.id} className={d.daysToFull <= 30 ? 'crit' : undefined}>
                      <td><div className="v3-cellname">{d.name} {d.synthesized && <span className="v3-tag">합성</span>}</div></td>
                      {spec.rawCols && <td className="v3-dim" style={{ fontSize: 11 }}>{d.vcenterId}</td>}
                      <td data-sort={d.usagePct ?? ''}><PctCell pct={d.usagePct} /></td>
                      <td className="num" data-sort={d.growthGBperDay ?? ''}>{d.growthGBperDay == null ? '—' : `${d.growthGBperDay} GB`}</td>
                      <td className="num" data-sort={d.daysToFull ?? ''} style={{ color: d.daysToFull <= 30 ? '#dc2626' : '#526075', fontWeight: 700 }}>D-{d.daysToFull}</td>
                    </tr>
                  ))}
                </tbody>
              </STable>
              {fcRows.length === 0 && <Empty>소진 예상일을 계산할 수 있는 데이터스토어가 범위 안에 없습니다.</Empty>}
            </div>
            <div className="v3-note" style={{ padding: '10px 18px 14px' }}>
              소진일이 <b>—</b> 인 항목은 목록에 넣지 않았습니다 — 그건 <b>증가 추세를 계산할 표본이 부족하다</b>는 뜻이지 소진하지 않는다는 뜻이 아닙니다.
              {fc.data?.mock && <> 데모(mock) 환경이라 <b>합성</b> 배지가 붙습니다.</>}
            </div>
          </PollState>
        </Panel>

        <Panel title="클러스터 여력" sub={`RAM 여유 적은 순 · 상위 ${spec.rows}`} right={<span className="v3-tag">/tools/capacity</span>} bodyPad={false}>
          <PollState poll={canCap ? cap : null} skipped={!canCap ? NEED_TOOLS : undefined}>
            <div className="v3-tablewrap">
              <STable className="v3-table">
                <thead><tr><th>법인 · 클러스터</th><th className="num">호스트</th><th className="num">vCPU/코어</th><th className="num">RAM 오버커밋</th><th className="num">RAM 여유</th></tr></thead>
                <tbody>
                  {capRows.map((c) => (
                    <tr key={`${c.vcenterId}:${c.cluster}`}>
                      <td><div className="v3-cellname">{c.cluster}</div><div className="v3-cellsub">{c.vcenterId}</div></td>
                      <td className="num" data-sort={c.hosts ?? ''}>{fmtInt(c.hosts)}</td>
                      <td className="num" data-sort={c.vcpuPerCore ?? ''}>{c.vcpuPerCore ?? '—'}</td>
                      <td className="num" data-sort={c.ramOvercommitPct ?? ''} style={{ color: textColor(c.ramOvercommitPct) }}>{fmtPct(c.ramOvercommitPct)}</td>
                      <td className="num" data-sort={c.ramHeadroomGB ?? ''}>{c.ramHeadroomGB == null ? '—' : `${fmtInt(c.ramHeadroomGB)} GB`}</td>
                    </tr>
                  ))}
                </tbody>
              </STable>
              {capRows.length === 0 && <Empty>범위 안에 클러스터가 없습니다.</Empty>}
            </div>
            <div className="v3-note" style={{ padding: '10px 18px 14px' }}>
              <b>현재 스냅샷의 할당 대비 용량 비율</b>입니다 — 시계열 추세 예측이 아니고, <b>N+1 여력(호스트 1대 장애 시 수용 가능 여부)은 수집 항목이 아니라 계산하지 않습니다</b>.
            </div>
          </PollState>
        </Panel>
      </div>

      <div className="v3-grid2">
        <Panel title="지역별 롤업" sub={`${fmtInt(sites.length)}개 vCenter · /overview 집계`} right={<span className="v3-tag">rollups.sites</span>}>
          {byRegion.length === 0 ? <Empty>범위 안에 사이트가 없습니다.</Empty> : (
            <div className="v4-blist">
              {byRegion.map((r) => (
                <div className="v4-brow" key={r.region}>
                  <span className="nm" style={{ color: REGION_COLORS[r.region] || '#1a2130' }}>{r.region}</span>
                  <span className="v3-bar lg"><i style={{ width: `${(r.vms / maxVms) * 100}%`, background: REGION_COLORS[r.region] || '#2563eb' }} /></span>
                  <span className="vl">VM {fmtInt(r.vms)} · 호스트 {fmtInt(r.hosts)} · vC {r.vcenters}</span>
                </div>
              ))}
            </div>
          )}
        </Panel>

        <Panel title="스토리지 사용량 추이" sub={`최근 ${spec.days}일 · 하루 2회 스냅샷 · 변경분만 저장`} right={<span className="v3-tag">/tools/vm-track</span>}>
          <PollState poll={canTrack ? track : null} skipped={!canTrack ? NEED_TOOLS : undefined}>
            {dsPoints.filter((p) => p.y != null).length < 2 ? (
              <Empty>
                추이를 그릴 표본이 <b>{fmtInt(dsPoints.length)}개</b>뿐입니다. 추적은 하루 2회 적재하므로 선이 그려지려면 최소 2회 관측이 필요합니다 —
                <b> 첫 관측 이전 구간은 소급해서 그리지 않습니다</b>.
              </Empty>
            ) : (
              <>
                <Spark points={dsPoints} color="#0e7490" height={140} />
                <div className="v3-note" style={{ marginTop: 8 }}>
                  단위 TB(사용량 합계). 표본 {fmtInt(dsPoints.length)}개 · 값이 없는 구간은 선을 잇지 않습니다.
                </div>
              </>
            )}
          </PollState>
        </Panel>
      </div>

      <Panel title="증가 추세로 본 포화 예상" sub={`회귀 R² 기준 미만은 목록에 넣지 않는다`} right={<span className="v3-tag">/insights/forecast</span>}>
        <PollState poll={canInsights ? fore : null} skipped={!canInsights ? '이 패널은 “인사이트(insights)” 권한이 필요합니다 — 관리자에게 요청하세요.' : undefined}>
          {(fore.data?.soon || []).length === 0 ? (
            <Empty>
              기준을 넘는 항목이 없습니다. 스캔한 데이터스토어 <b>{fmtInt(fore.data?.scannedDatastores)}</b>개 중 결정계수 R²가
              <b> {fore.data?.config?.minR2 ?? '—'}</b> 이상인 추세선을 만들지 못한 것은 <b>표본이 부족하거나 증가가 일정하지 않다</b>는 뜻입니다 — 포화하지 않는다는 뜻이 아닙니다.
            </Empty>
          ) : (
            <div className="v3-rows">
              {(fore.data.soon || []).map((s) => (
                <div className="v3-row" key={s.id || s.name}>
                  <span className="v3-grow"><div className="v3-row-title">{s.name}</div><div className="v3-row-meta">{s.vcenterId}</div></span>
                  <span className="v3-num" style={{ color: '#dc2626', fontWeight: 700 }}>{s.daysToFull != null ? `D-${s.daysToFull}` : '—'}</span>
                </div>
              ))}
            </div>
          )}
        </PollState>
      </Panel>

      <div className="v3-note">
        판정 기준: 사용률 <b>{WARN_PCT}% 주의 · {CRIT_PCT}% 위험</b> — 포탈 공용 임계값이며 모드(경영/엔지니어)에 따라 달라지지 않습니다.
        {' '}<button type="button" className="v3-kbd" style={{ cursor: 'pointer' }} onClick={() => go('overview')}>전사 현황으로</button>
      </div>
    </>
  );
}
