// V3 전사 현황(v2.490) — 아트보드 1면: 도메인 타일 6 · 그리드 지도 + 지금 주목 · 전사 용량 헤드룸 + 사이트 표. 전부 실 API.
import React from 'react';
import { StateBadge } from '../../components/ui.jsx';
import { STable } from '../../components/STable.jsx';
import { Panel, Bar, PctCell, Badge, Empty, PollState } from '../ui.jsx';
import { attentionList, regionCounts, siteMarkers, REGION_COLORS, DOMAIN_LABEL, domainOf, ageText, fmtInt, fmtPct, textColor, levelBar, rowMatches, alarmCountColor, SEV_COLOR, WARN_PCT, CRIT_PCT } from '../data.js';

export default function Overview({ tiles, global: g, ov, sitesAll, alarmsAll, scope, go, polls }) {
  const now = Date.now();
  const sites = scope.scoped(sitesAll, 'id').filter((s) => rowMatches(s, scope.q));
  const alarms = scope.scoped(alarmsAll).filter((a) => rowMatches(a, scope.q));
  const attention = attentionList(alarms, 6);
  const rc = regionCounts(sites);
  const { markers, skipped } = siteMarkers(scope.scoped(sitesAll, 'id'));
  const phys = ov?.physical || null;

  return (
    <>
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
          <PollState poll={polls.ov}>
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
          <PollState poll={polls.al}>
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
          <PollState poll={polls.ov}>
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
          <PollState poll={polls.ov}>
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
                      <td className="num" data-sort={s.alarmsCritical + s.alarmsWarning} style={{ color: alarmCountColor(s.alarmsCritical + s.alarmsWarning) }}>{s.alarmsCritical + s.alarmsWarning}</td>
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
      <div className="v3-note">타일의 C/W/I 는 vCenter 활성 알람을 대상 유형(호스트·VM → {DOMAIN_LABEL.COMPUTE}, 데이터스토어 → {DOMAIN_LABEL.STORAGE})으로 나눈 건수이고, 설비·BMC·서비스 점검은 각 수집기의 위반/무응답/실패 수입니다.</div>
    </>
  );
}
