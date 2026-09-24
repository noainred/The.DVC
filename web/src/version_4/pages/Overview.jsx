/**
 * V4 ② / ⑤ 전사 현황(v2.490 → v2.508) — 시안 Main.dc.html(경영) · EngOverview.dc.html(엔지니어).
 * **같은 URL(#/v4/overview)이고 모드만 다르다.**
 *
 * 두 모드 공통: 도메인 타일 6 · 지도 · 지금 주목 · 용량 헤드룸 · 사이트 표.
 *   경영 보기   에서만: 전사 KPI 밴드 · 용량 소진 임박 · 회수 가능 자원 · VM 추이 · 인시던트 추이
 *   엔지니어 보기에서만: 수집 상태 바 · 자주 쓰는 기능 · 표의 원시 열(vCenter ID · 수집 나이)
 *
 * 모드는 **권한 · 데이터 범위 · 임계값을 바꾸지 않는다.** 패널이 다르므로 호출하는 API 집합은
 * 다르지만, 모드를 바꿔서 접근 권한이 생기거나 사라지지는 않는다(mode.js 참고).
 */
import React from 'react';
import { StateBadge } from '../../components/ui.jsx';
import { STable } from '../../components/STable.jsx';
import { usePolling, can, toolAllowed } from '../../api.js';
import { TOOLS } from '../../views/specialToolsList.js';
import { Panel, Bar, PctCell, Badge, Empty, PollState, Kpi, Spark } from '../ui.jsx';
import { attentionList, regionCounts, siteMarkers, REGION_COLORS, DOMAIN_LABEL, domainOf, ageText, fmtInt, fmtPct, textColor, levelBar, rowMatches, alarmCountColor, SEV_COLOR, WARN_PCT, CRIT_PCT } from '../data.js';

export default function Overview({ tiles, global: g, ov, sitesAll, alarmsAll, scope, go, goAnywhere, polls, mode, spec, phase, phaseText, health }) {
  // 수집이 끝나기 전 KPI 메타 문구(v2.509) — 예전에는 전부 '수집 대기' 라 **기다리면 되는 상황과
  // 조치가 필요한 상황이 같은 말**이었다. 셸이 /health 로 판정한 phase 를 쓴다.
  // ⚠ NSX 는 vCenter 수집과 **다른 수집기**(/nsx)라 이 문구를 쓰지 않는다 — vCenter 대수로
  //   NSX 상태를 말하면 확인하지 않은 것을 말하는 셈이다.
  const waitText = phaseText?.short || '수집 대기';
  const now = Date.now();
  const exec = mode !== 'eng';
  const canTools = can('tools');
  const canFc = exec && canTools && toolAllowed('forecast') /* v2.583 #38: 서버는 capacity-forecast 경로를 forecast 키로 집행한다 */;
  const canWaste = exec && canTools && toolAllowed('waste');
  const canTrack = exec && canTools && toolAllowed('vm-track');
  const canInsights = exec && can('insights');
  // 경영 보기에서만 부르는 것들 — 주기가 긴 이유는 전부 스냅샷 집계이고 forecast 는 실측 1.5초라서다.
  const fc = usePolling(canFc ? '/tools/capacity-forecast' : null, {}, 120_000);
  const waste = usePolling(canWaste ? '/tools/waste' : null, {}, 120_000);
  const track = usePolling(canTrack ? '/tools/vm-track' : null, { days: spec?.days ?? 90 }, 120_000);
  const inc = usePolling(canInsights ? '/insights/incidents' : null, {}, 120_000);
  // 엔지니어 보기에서만 — 전체 사용자 누적 클릭 수(상한은 서버가 200 까지 준다, v2.508 F0-1).
  const usage = usePolling(mode === 'eng' ? '/tool-usage/top' : null, { n: 8 }, 300_000);
  const lastRun = polls.idrac.data?.poller?.lastRun || null;
  const sites = scope.scoped(sitesAll, 'id').filter((s) => rowMatches(s, scope.q));
  const alarms = scope.scoped(alarmsAll).filter((a) => rowMatches(a, scope.q));
  const attention = attentionList(alarms, 6);
  const rc = regionCounts(sites);
  const { markers, skipped } = siteMarkers(scope.scoped(sitesAll, 'id'));
  const phys = ov?.physical || null;

  const NEED_TOOLS = '이 패널은 “특수 기능(tools)” 권한이 필요합니다 — 관리자에게 요청하세요.';
  const fcSoon = (fc.data?.items || []).filter((d) => scope.inScope(d.vcenterId) && d.daysToFull != null)
    .sort((a, b) => a.daysToFull - b.daysToFull).slice(0, spec?.rows ?? 10);
  const W = waste.data || null;
  const trackPts = (track.data?.points || []).map((p) => ({ x: p.ts, y: p.total ?? null }));
  const days = inc.data?.byDay || [];

  return (
    <>
      {exec && (
        <div className="v3-kpis">
          <Kpi label="법인 (vCenter)" value={ov ? fmtInt(sitesAll.length) : '—'} accent="#2563eb" meta={ov ? `연결 ${fmtInt(sitesAll.filter((s) => s.status === 'connected').length)} / ${fmtInt(sitesAll.length)}` : waitText} />
          <Kpi label="물리 서버" value={fmtInt(ov?.physical?.servers || g?.hosts)} accent="#1a2130" meta={g ? `ESXi 호스트 ${fmtInt(g.hosts)}` : waitText} />
          <Kpi label="가상머신" value={fmtInt(g?.vms)} accent="#0e7490" meta={g ? `데이터스토어 ${fmtInt(g.datastores)}` : waitText} />
          <Kpi label="스토리지 사용률" value={fmtPct(g?.storageUsagePct)} accent={textColor(g?.storageUsagePct)} meta={g ? `${g.storageUsedTB} / ${g.storageTotalTB} TB` : waitText} />
          <Kpi label="측정 전력" value={g?.powerReporting ? `${fmtInt(g.powerKw)} kW` : '—'} accent="#b45309" meta={g ? `보고 서버 ${fmtInt(g.powerReporting)}대 합계 — 전체가 아닙니다` : waitText} />
          <Kpi label="활성 알람" value={polls.al.data ? fmtInt(alarmsAll.length) : '—'} accent={alarms.some((a) => a.severity === 'critical') ? '#dc2626' : '#526075'} meta={polls.al.data ? `위험 ${fmtInt(alarmsAll.filter((a) => a.severity === 'critical').length)}` : waitText} />
        </div>
      )}
      {!exec && (
        <div className="v4-band">
          <span><b>수집 상태</b> — vCenter 연결 <b>{fmtInt(sitesAll.filter((s) => s.status === 'connected').length)}</b>
            {' '}· 연결 아님 <b>{fmtInt(sitesAll.filter((s) => s.status && s.status !== 'connected').length)}</b>
            {' '}· 상태 미상 <b>{fmtInt(sitesAll.filter((s) => !s.status).length)}</b>
            {lastRun && <> · iDRAC 폴러 최근 실행 성공 {fmtInt(lastRun.ok)} / 실패 {fmtInt(lastRun.failed)}</>}
            {polls.idrac.data?.poller && <> · 주기 {Math.round((polls.idrac.data.poller.intervalMs || 0) / 1000)}초</>}
            . <b>‘연결 아님’ 과 ‘상태 미상’ 을 합치지 않습니다</b> — 원인이 다릅니다.</span>
        </div>
      )}
      <div className="v3-tiles">
        {tiles.map((t) => (
          <button key={t.name} className={`v3-tile${t.level != null ? ` lv${t.level}` : ''}`} style={{ '--tile': levelBar(t.level), borderTopColor: levelBar(t.level) }} onClick={() => go(t.page)} title={`${t.name} 화면으로`}>
            <div className="v3-tile-h"><span className="v3-tile-name">{t.name}</span><span style={{ flex: 1 }} /><Badge level={t.level} label={t.level == null ? '판정 불가' : undefined} /></div>
            <div className="v3-tile-value">{t.value}</div>
            <div className="v3-tile-meta">{t.meta}</div>
            <div className="v3-tile-ci"><span style={{ color: '#dc2626' }}>C {t.crit}</span><span style={{ color: '#b45309' }}>W {t.warn}</span><span style={{ color: '#68738a' }}>I {t.info}</span></div>
          </button>
        ))}
      </div>

      <div className="v3-grid2">
        <Panel title="전세계 데이터센터" sub="마커 크기 = 호스트 수 · 색 = 최대 사용률/연결 상태 · 클릭하면 사이트 드릴다운" bodyPad={false}
          right={Object.keys(REGION_COLORS).filter((r) => rc[r]).map((r) => <span key={r} className="v3-legend"><i style={{ background: REGION_COLORS[r] }} />{r} {rc[r]}</span>)}>
          <PollState poll={polls.ov} phase={phase} health={health}>
            <div className="v3-mapwrap">
              <div className="v3-map">
                <div className="v3-map-grid" />
                <div className="v3-map-eq" />
                {markers.map((m) => (
                  <button key={m.id} type="button" className="v3-marker" title={m.title} onClick={() => go('compute', { vcenterId: m.id })}
                    style={{ left: m.left, top: m.top, width: m.size, height: m.size, marginLeft: -m.size / 2, marginTop: -m.size / 2, background: m.fill, boxShadow: `0 0 16px ${m.glow}` }} />
                ))}
                {markers.map((m) => (
                  <div key={`${m.id}-l`} className="v3-marker-label" style={{ left: m.left, top: m.labelTop, color: m.labelColor }}>{m.code} · {m.hosts}</div>
                ))}
                {markers.length === 0 && <Empty>좌표(위도·경도)가 등록된 vCenter 가 없습니다 — 설정 › vCenter 등록·관리에서 위치를 입력하세요.</Empty>}
              </div>
              {skipped > 0 && <div className="v3-note" style={{ padding: '6px 18px 10px' }}>좌표 없는 vCenter {skipped}개는 지도에 표시하지 않습니다.</div>}
            </div>
          </PollState>
        </Panel>
        <Panel title="지금 주목" sub="활성 알람 · 심각도 → 최신 순 · 상위 6" bodyPad={false}>
          <PollState poll={polls.al} phase={phase} health={health}>
            <div style={{ padding: '4px 18px 10px' }}>
              {attention.length === 0 && <Empty>범위 안에 활성 알람이 없습니다.</Empty>}
              {attention.map((a) => (
                <div className="v3-attn" key={a.id}>
                  <div className="v3-attn-stripe" style={{ background: SEV_COLOR[a.severity] || '#68738a' }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="v3-attn-title"><span className="v3-tag">{domainOf(a.entityType)}</span><span>{a.message}</span></div>
                    <div className="v3-attn-meta">{a.entity} · {a.vcenterId}{a.acknowledged ? ' · 확인됨' : ''}</div>
                  </div>
                  <span className="v3-num" style={{ fontSize: 10.5, color: SEV_COLOR[a.severity] || '#526075', flex: 'none' }}>{ageText(a.time, now)}</span>
                </div>
              ))}
            </div>
          </PollState>
        </Panel>
      </div>

      <div className="v3-grid2 wide-r">
        <Panel title="전사 용량 헤드룸">
          <PollState poll={polls.ov} phase={phase} health={health}>
            {g && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 13 }}>
                {[
                  ['CPU', `${fmtInt(g.cpuCores)} cores (ESXi)${phys?.cores ? ` · 물리 ${fmtInt(phys.cores)}` : ''}`, g.cpuUsagePct],
                  ['메모리', `${fmtInt(g.memTotalGB)} GB (ESXi)${phys?.memGB ? ` · 물리 ${fmtInt(phys.memGB)} GB` : ''}`, g.memUsagePct],
                  ['스토리지', `${g.storageTotalTB} TB · ${fmtInt(g.datastores)} DS`, g.storageUsagePct],
                ].map(([label, meta, pct]) => (
                  <div key={label}>
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                      <span style={{ fontSize: 12.5, fontWeight: 600 }}>{label}</span>
                      <span className="v3-num v3-faint" style={{ fontSize: 10.5 }}>{meta}</span>
                      <span style={{ flex: 1 }} />
                      <span className="v3-num" style={{ fontSize: 12.5, fontWeight: 700, color: textColor(pct) }}>{fmtPct(pct)}</span>
                    </div>
                    <div style={{ marginTop: 6, display: 'flex' }}><Bar pct={pct} large marks={[WARN_PCT, CRIT_PCT]} /></div>
                  </div>
                ))}
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, borderTop: '1px solid #e6eaf0', paddingTop: 12 }}>
                  <span style={{ fontSize: 12.5, fontWeight: 600 }}>전력</span>
                  <span className="v3-num v3-faint" style={{ fontSize: 10.5 }}>측정 서버 {fmtInt(g.powerReporting)}대 합계{g.powerRegistered ? ` · iDRAC 등록 ${fmtInt(g.powerRegistered)}대` : ''}</span>
                  <span style={{ flex: 1 }} />
                  <span className="v3-num" style={{ fontSize: 12.5, fontWeight: 700, color: '#b45309' }}>{g.powerReporting ? `${fmtInt(g.powerKw)} kW` : '—'}</span>
                </div>
                <div className="v3-note">세로선은 주의 {WARN_PCT}% · 위험 {CRIT_PCT}%. 사용률은 vCenter(ESXi) 실측이며 계약 전력은 수집 항목이 아니라 전력은 비율 없이 측정 합계만 표시합니다.</div>
              </div>
            )}
          </PollState>
        </Panel>
        <Panel title="사이트" sub="vCenter 단위 · 최대 사용률 내림차순 · 행 클릭 → 컴퓨트 · 제목 클릭 정렬" bodyPad={false}>
          <PollState poll={polls.ov} phase={phase} health={health}>
            <div className="v3-tablewrap">
              <STable className="v3-table">
                <thead><tr><th>사이트</th><th>리전</th><th className="num">서버</th><th className="num">VM</th><th>컴퓨트</th><th>스토리지</th><th className="num">전력</th><th className="num">알람</th><th>상태</th></tr></thead>
                <tbody>
                  {sites.map((s) => (
                    <tr key={s.id} className={`click${scope.focusVc === s.id ? ' focus' : ''}`} onClick={() => go('compute', { vcenterId: s.id })}>
                      <td><div className="v3-cellname">{s.name} <span className="v3-dim" style={{ fontWeight: 400 }}>{s.city}</span></div></td>
                      <td style={{ color: REGION_COLORS[s.region] || '#526075', fontSize: 11.5 }}>{s.region}</td>
                      <td className="num" data-sort={s.hosts ?? ''}>{fmtInt(s.hosts)}</td>
                      <td className="num" data-sort={s.vms ?? ''}>{fmtInt(s.vms)}</td>
                      <td data-sort={s.cpu ?? ''}><PctCell pct={s.cpu} /></td>
                      <td data-sort={s.sto ?? ''}><PctCell pct={s.sto} /></td>
                      <td className="num" style={{ color: '#b45309' }} data-sort={s.powerKw ?? ''}>{s.powerKw != null ? `${s.powerKw}kW` : '—'}</td>
                      {s.alarmsUnknown
                        ? <td className="num" data-sort="" style={{ color: '#6b7280' }} title="REST 폴백 수집 — 경보를 조회하지 않았습니다(0건이 아닙니다)">— <span style={{ fontSize: 10 }}>REST 폴백</span></td>
                        : <td className="num" data-sort={s.alarmsCritical + s.alarmsWarning} style={{ color: alarmCountColor(s.alarmsCritical + s.alarmsWarning) }}>{s.alarmsCritical + s.alarmsWarning}</td>}
                      <td><StateBadge state={s.status} /></td>
                    </tr>
                  ))}
                </tbody>
              </STable>
              {sites.length === 0 && <Empty>범위 안에 사이트가 없습니다.</Empty>}
            </div>
          </PollState>
        </Panel>
      </div>
      {exec && (
        <div className="v3-grid2">
          <Panel title="용량 소진 임박" sub={`증가 추세 기준 · 상위 ${spec?.rows ?? 10}`} right={<span className="v3-tag">/tools/capacity-forecast</span>} bodyPad={false}>
            <PollState poll={canFc ? fc : null} skipped={!canFc ? NEED_TOOLS : undefined}>
              <div className="v3-tablewrap">
                <STable className="v3-table">
                  <thead><tr><th>데이터스토어</th><th>사용률</th><th className="num">일 증가</th><th className="num">소진</th></tr></thead>
                  <tbody>
                    {fcSoon.map((d) => (
                      <tr key={d.id} className="click" onClick={() => go('compare')}>
                        <td><div className="v3-cellname">{d.name} {d.synthesized && <span className="v3-tag">합성</span>}</div></td>
                        <td data-sort={d.usagePct ?? ''}><PctCell pct={d.usagePct} /></td>
                        <td className="num" data-sort={d.growthGBperDay ?? ''}>{d.growthGBperDay == null ? '—' : `${d.growthGBperDay} GB`}</td>
                        <td className="num" data-sort={d.daysToFull ?? ''} style={{ color: d.daysToFull <= 30 ? '#dc2626' : '#526075', fontWeight: 700 }}>D-{d.daysToFull}</td>
                      </tr>
                    ))}
                  </tbody>
                </STable>
                {fcSoon.length === 0 && <Empty>소진 예상일을 계산할 수 있는 데이터스토어가 범위 안에 없습니다 — <b>—</b> 는 추세 표본이 부족하다는 뜻이지 소진하지 않는다는 뜻이 아닙니다.</Empty>}
              </div>
            </PollState>
          </Panel>

          <Panel title="회수 가능 자원" sub="지금 되돌릴 수 있는 양" right={<span className="v3-tag">/tools/waste</span>}>
            <PollState poll={canWaste ? waste : null} skipped={!canWaste ? NEED_TOOLS : undefined}>
              <div className="v4-facts">
                <div className="v4-fact"><div className="v4-fact-label">미사용 CPU</div><div className="v4-fact-value">{W?.overAllocated?.cpu ? `${fmtInt(Math.round(W.overAllocated.cpu.idleGHz))} GHz` : '—'}</div><div className="v4-fact-meta">과할당 후보 VM {fmtInt(W?.overAllocated?.cpu?.candidates)}대</div></div>
                <div className="v4-fact"><div className="v4-fact-label">미사용 메모리</div><div className="v4-fact-value">{W?.overAllocated?.mem ? `${fmtInt(Math.round(W.overAllocated.mem.idleGB / 1024))} TB` : '—'}</div><div className="v4-fact-meta">과할당 후보 VM {fmtInt(W?.overAllocated?.mem?.candidates)}대</div></div>
                <div className="v4-fact"><div className="v4-fact-label">전원 꺼진 VM</div><div className="v4-fact-value">{W?.poweredOff ? `${fmtInt(Math.round(W.poweredOff.storageGB / 1024))} TB` : '—'}</div><div className="v4-fact-meta">{fmtInt(W?.poweredOff?.count)}대가 차지한 디스크</div></div>
                <div className="v4-fact"><div className="v4-fact-label">thin 회수가능</div><div className="v4-fact-value">{W?.thinReclaim ? `${fmtInt(Math.round(W.thinReclaim.reclaimableGB / 1024))} TB` : '—'}</div><div className="v4-fact-meta">디스크 {fmtInt(W?.thinReclaim?.count)}개</div></div>
              </div>
              <div className="v3-note" style={{ marginTop: 10 }}>
                <b>금액으로 환산하지 않습니다</b> — 자원(GB·vCPU·RAM) 단가 정보가 없습니다. 요금 환산이 가능한 것은 전력뿐입니다(전력 · 비용 화면).
              </div>
            </PollState>
          </Panel>
        </div>
      )}

      {exec && (
        <div className="v3-grid2">
          <Panel title="VM 수량 추이" sub={`최근 ${spec?.days ?? 90}일 · 하루 2회 스냅샷`} right={<span className="v3-tag">/tools/vm-track</span>}>
            <PollState poll={canTrack ? track : null} skipped={!canTrack ? NEED_TOOLS : undefined}>
              {trackPts.filter((p) => p.y != null).length < 2
                ? <Empty>추이를 그릴 표본이 <b>{fmtInt(trackPts.length)}개</b>뿐입니다 — 추적은 하루 2회 적재하므로 선이 그려지려면 최소 2회 관측이 필요합니다. <b>첫 관측 이전 구간은 소급해서 그리지 않습니다.</b></Empty>
                : <><Spark points={trackPts} color="#2563eb" height={140} /><div className="v3-note" style={{ marginTop: 8 }}>표본 {fmtInt(trackPts.length)}개 · 전원 상태와 무관한 전체 VM 수.</div></>}
            </PollState>
          </Panel>

          <Panel title="인시던트 발생 추이" sub="최근 14일" right={<span className="v3-tag">/insights/incidents</span>}>
            <PollState poll={canInsights ? inc : null} skipped={!canInsights ? '이 패널은 “인사이트(insights)” 권한이 필요합니다.' : undefined}>
              {days.length < 2
                ? <Empty>
                    일자별 집계가 <b>{fmtInt(days.length)}일치</b>뿐입니다. 이 집계는 <b>알림 엔진이 발화한 건을 메모리에 쌓은 것</b>이라
                    서버를 재시작하면 초기화되고 최근 100건 범위입니다 — <b>전체 vCenter 알람 추세가 아닙니다.</b>
                    {inc.data?.summary && <> 현재 열린 인시던트는 {fmtInt(inc.data.summary.open)}건(위험 {fmtInt(inc.data.summary.openCritical)})입니다.</>}
                  </Empty>
                : <><Spark points={days.map((d, i) => ({ x: i, y: (d.critical || 0) + (d.warning || 0) }))} color="#dc2626" height={140} yZero />
                    <div className="v3-note" style={{ marginTop: 8 }}>⚠ 알림 엔진 발화 기준 · 인메모리 · <b>해소는 집계하지 않습니다</b>.</div></>}
            </PollState>
          </Panel>
        </div>
      )}

      {!exec && (
        <Panel title="자주 쓰는 기능" sub="전체 사용자 누적 클릭" right={<span className="v3-tag">/tool-usage/top</span>}>
          <PollState poll={usage}>
            {(usage.data?.top || []).length === 0
              ? <Empty>아직 기록된 사용 이력이 없습니다 — 특수 기능을 열면 누적됩니다.</Empty>
              : <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {(usage.data.top || []).map((u) => {
                    const t = TOOLS.find((x) => x.k === u.k);
                    if (!t) return null;
                    return (
                      <button key={u.k} type="button" className="v3-exit" onClick={() => goAnywhere(`#/tools/${u.k}`)} title={`#/tools/${u.k}`}>
                        {t.icon} {t.label} <span className="v3-num v3-faint" style={{ fontSize: 10.5 }}>{fmtInt(u.count)}회</span>
                      </button>
                    );
                  })}
                </div>}
          </PollState>
        </Panel>
      )}

      <div className="v3-note">타일의 C/W/I 는 vCenter 활성 알람을 대상 유형(호스트·VM → {DOMAIN_LABEL.COMPUTE}, 데이터스토어 → {DOMAIN_LABEL.STORAGE})으로 나눈 건수이고, 설비·BMC·서비스 점검은 각 수집기의 위반/무응답/실패 수입니다.</div>
    </>
  );
}
