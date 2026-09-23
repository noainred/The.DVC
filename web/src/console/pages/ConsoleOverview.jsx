// 전사 현황(v2.487) — 도메인 타일 6 · 세계 지도 + 지금 주목 · 용량 헤드룸 + 사이트 표. 전부 /overview·/alarms 등 실 API.
import React from 'react';
import WorldMap from '../../components/WorldMap.jsx';
import ErrorBoundary from '../../components/ErrorBoundary.jsx';
import { StateBadge } from '../../components/ui.jsx';
import { STable } from '../../components/STable.jsx';
import { Panel, Bar, PctCell, LevelBadge, Empty, PollState, levelColor } from '../ui.jsx';
import { attentionList, regionCounts, REGION_COLORS, DOMAIN_LABEL, domainOf, ageText, fmtInt, fmtPct, colorOf, rowMatches, WARN_PCT, CRIT_PCT } from '../consoleData.js';

const SEV_COLOR = { critical: '#ef4444', warning: '#f59e0b', info: '#3b82f6' };

export default function ConsoleOverview({ tiles, global: g, ov, sitesAll, alarmsAll, scope, go, polls }) {
  const now = Date.now();
  const sites = scope.scoped(sitesAll, 'id').filter((s) => rowMatches(s, scope.q));
  const rawSites = scope.scoped(ov?.sites || [], 'id');
  const alarms = scope.scoped(alarmsAll).filter((a) => rowMatches(a, scope.q));
  const attention = attentionList(alarms, 6);
  const rc = regionCounts(sites);

  return (
    <>
      <div className="dvc-tiles">
        {tiles.map((t) => (
          <button key={t.name} className={`dvc-tile${t.level != null ? ` lv${t.level}` : ''}`} style={{ '--tile': levelColor(t.level), borderTopColor: levelColor(t.level) }} onClick={() => go(t.page)} title={`${t.name} 화면으로`}>
            <div className="dvc-tile-h"><span className="dvc-tile-name">{t.name}</span><span style={{ flex: 1 }} /><LevelBadge level={t.level} label={t.level == null ? '판정 불가' : undefined} /></div>
            <div className="dvc-tile-value">{t.value}</div>
            <div className="dvc-tile-meta">{t.meta}</div>
            <div className="dvc-tile-ci"><span style={{ color: '#dc2626' }}>C {t.crit}</span><span style={{ color: '#d97706' }}>W {t.warn}</span><span style={{ color: '#9ca3af' }}>I {t.info}</span></div>
          </button>
        ))}
      </div>

      <div className="dvc-grid2">
        <Panel title="전세계 데이터센터" sub="마커 = vCenter · 색 = 연결 상태/알람 · 클릭 → 사이트 드릴다운" bodyPad={false}
          right={Object.keys(REGION_COLORS).filter((r) => rc[r]).map((r) => <span key={r} className="dvc-legend"><i style={{ background: REGION_COLORS[r] }} />{r} {rc[r]}</span>)}>
          <PollState poll={polls.ov}>
            <div className="dvc-mapwrap">
              <ErrorBoundary fallback={<Empty>지도를 불러올 수 없습니다.</Empty>}>
                <WorldMap sites={rawSites} onSelect={(id) => go('compute', { vcenterId: id })} height={320} />
              </ErrorBoundary>
            </div>
          </PollState>
        </Panel>
        <Panel title="지금 주목" sub="활성 알람 · 심각도 → 최신 순 · 상위 6" bodyPad={false}>
          <PollState poll={polls.al}>
            <div style={{ padding: '4px 18px 10px' }}>
              {attention.length === 0 && <Empty>범위 안에 활성 알람이 없습니다.</Empty>}
              {attention.map((a) => (
                <div className="dvc-attn" key={a.id}>
                  <div className="dvc-attn-stripe" style={{ background: SEV_COLOR[a.severity] || '#9ca3af' }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="dvc-attn-title"><span className="dvc-tag">{DOMAIN_LABEL[domainOf(a.entityType)]}</span><span>{a.message}</span></div>
                    <div className="dvc-attn-meta">{a.entity} · {a.vcenterId}{a.acknowledged ? ' · 확인됨' : ''}</div>
                  </div>
                  <span className="dvc-num" style={{ fontSize: 10.5, color: SEV_COLOR[a.severity] || '#6b7280', flex: 'none' }}>{ageText(a.time, now)}</span>
                </div>
              ))}
            </div>
          </PollState>
        </Panel>
      </div>

      <div className="dvc-grid2 wide-r">
        <Panel title="전사 용량 헤드룸" sub={`세로선 = 주의 ${WARN_PCT}% · 위험 ${CRIT_PCT}%`}>
          <PollState poll={polls.ov}>
            {g && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 13 }}>
                {[
                  ['CPU', `${fmtInt(g.cpuUsedGhz)} / ${fmtInt(g.cpuTotalGhz)} GHz · ${fmtInt(g.cpuCores)} cores${g.hostsUsageExcluded ? ` · 끊긴 호스트 ${fmtInt(g.hostsUsageExcluded)}대 사용률 제외` : ''}`, g.cpuUsagePct],
                  ['메모리', `${fmtInt(g.memUsedGB)} / ${fmtInt(g.memTotalGB)} GB`, g.memUsagePct],
                  ['스토리지', `${g.storageUsedTB} / ${g.storageTotalTB} TB · ${fmtInt(g.datastores)} DS`, g.storageUsagePct],
                ].map(([label, meta, pct]) => (
                  <div key={label}>
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                      <span style={{ fontSize: 12.5, fontWeight: 600 }}>{label}</span>
                      <span className="dvc-num dvc-faint" style={{ fontSize: 10.5 }}>{meta}</span>
                      <span style={{ flex: 1 }} />
                      <span className="dvc-num" style={{ fontSize: 12.5, fontWeight: 700, color: colorOf(pct) }}>{fmtPct(pct)}</span>
                    </div>
                    <div style={{ marginTop: 6, display: 'flex' }}><Bar pct={pct} large marks={[WARN_PCT, CRIT_PCT]} /></div>
                  </div>
                ))}
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, borderTop: '1px solid rgba(229,231,235,.6)', paddingTop: 12 }}>
                  <span style={{ fontSize: 12.5, fontWeight: 600 }}>전력</span>
                  <span className="dvc-num dvc-faint" style={{ fontSize: 10.5 }}>측정 서버 {fmtInt(g.powerReporting)}대 합계{g.powerRegistered ? ` · iDRAC 등록 ${fmtInt(g.powerRegistered)}대` : ''}</span>
                  <span style={{ flex: 1 }} />
                  <span className="dvc-num" style={{ fontSize: 12.5, fontWeight: 700, color: '#d97706' }}>{g.powerReporting ? `${fmtInt(g.powerKw)} kW` : '—'}</span>
                </div>
                <div className="dvc-note">계약 전력·랙 용량은 수집 항목이 아니라 전력은 비율(%) 없이 측정 합계만 표시합니다. 사용률은 vCenter(ESXi) 실측입니다.</div>
              </div>
            )}
          </PollState>
        </Panel>
        <Panel title="사이트" sub="vCenter 단위 · 최대 사용률 내림차순 · 행 클릭 → 컴퓨트" bodyPad={false}>
          <PollState poll={polls.ov}>
            <div className="dvc-tablewrap">
              <STable minWidth={960} wrap={false} className="dvc-table">
                <thead><tr><th>사이트</th><th>리전</th><th className="num">호스트</th><th className="num">VM</th><th>컴퓨트</th><th>스토리지</th><th className="num">전력</th><th className="num">알람</th><th>상태</th></tr></thead>
                <tbody>
                  {sites.map((s) => (
                    <tr key={s.id} className={`click${scope.focusVc === s.id ? ' focus' : ''}`} onClick={() => go('compute', { vcenterId: s.id })}>
                      <td><div className="dvc-cellname">{s.name} <span className="dvc-dim" style={{ fontWeight: 400 }}>{s.city}</span></div></td>
                      <td style={{ color: REGION_COLORS[s.region] || '#6b7280', fontSize: 11.5 }}>{s.region}</td>
                      <td className="num" data-sort={s.hosts ?? ''}>{fmtInt(s.hosts)}</td>
                      <td className="num" data-sort={s.vms ?? ''}>{fmtInt(s.vms)}</td>
                      <td data-sort={s.cpu ?? ''}><PctCell pct={s.cpu} /></td>
                      <td data-sort={s.sto ?? ''}><PctCell pct={s.sto} /></td>
                      <td className="num" style={{ color: '#d97706' }} data-sort={s.powerKw ?? ''}>{s.powerKw != null ? `${s.powerKw} kW` : '—'}</td>
                      <td className="num" data-sort={s.alarmsCritical + s.alarmsWarning} style={{ color: s.alarmsCritical ? '#dc2626' : s.alarmsWarning ? '#d97706' : '#6b7280' }}>{s.alarmsCritical + s.alarmsWarning}</td>
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
      <div className="dvc-note">타일의 C/W/I 는 vCenter 활성 알람을 대상 유형(호스트·VM → 컴퓨트, 데이터스토어 → 스토리지)으로 나눈 건수이고, 설비·BMC·서비스 점검은 각 수집기의 위반/무응답/실패 수입니다.</div>
    </>
  );
}
