// 알람 센터(v2.487) — /alarms 활성 알람 · 심각도 카드(클릭 필터) · 도메인 칩 · 표 · 상관 그룹(같은 vCenter·유형·메시지 묶음) · /alarm-mutes.
import React, { useState } from 'react';
import { usePolling } from '../../api.js';
import { SeverityBadge } from '../../components/ui.jsx';
import { STable } from '../../components/STable.jsx';
import { Panel, PollState, Empty } from '../ui.jsx';
import { severityCounts, sortAlarms, correlateAlarms, domainOf, DOMAIN_LABEL, ageText, fmtInt, rowMatches } from '../consoleData.js';

const SEV = [['critical', 'Critical', '#ef4444', 'rgba(239,68,68,.08)', 'rgba(239,68,68,.4)'], ['warning', 'Warning', '#f59e0b', 'rgba(245,158,11,.07)', 'rgba(245,158,11,.35)'], ['info', 'Info', '#3b82f6', 'rgba(59,130,246,.07)', 'rgba(59,130,246,.35)']];

export default function ConsoleAlarms({ alarmsAll, scope, polls }) {
  const [sev, setSev] = useState('');       // '' = 전체
  const [domain, setDomain] = useState('ALL');
  const mutes = usePolling('/alarm-mutes', {}, 60_000);
  const now = Date.now();
  const scoped = scope.scoped(alarmsAll);
  const counts = severityCounts(scoped);
  const domCounts = {};
  for (const a of scoped) { const d = domainOf(a.entityType); domCounts[d] = (domCounts[d] || 0) + 1; }
  const rows = sortAlarms(scoped.filter((a) => (!sev || a.severity === sev) && (domain === 'ALL' || domainOf(a.entityType) === domain) && rowMatches(a, scope.q)));
  const groups = correlateAlarms(rows, 8);
  const unacked = counts.total ? scoped.filter((a) => a.severity === 'critical' && !a.acknowledged).length : 0;

  return (
    <>
      <div className="dvc-sevs">
        {SEV.map(([key, label, color, bg, border]) => (
          <button key={key} className={`dvc-sev${sev === key ? ' on' : ''}`} style={{ background: bg, borderColor: border }} onClick={() => setSev(sev === key ? '' : key)} title="클릭하면 이 심각도만 표시">
            <div className="dvc-sev-stripe" style={{ background: color }} />
            <div className="dvc-sev-count" style={{ color }}>{polls.al.data ? fmtInt(counts[key]) : '—'}</div>
            <div><div className="dvc-sev-label">{label}</div><div className="dvc-sev-meta">{key === 'critical' ? `미확인 ${unacked}` : key === 'warning' ? '활성 경고' : '정보'}</div></div>
          </button>
        ))}
        <div className="dvc-sev" style={{ cursor: 'default' }}>
          <div className="dvc-sev-stripe" style={{ background: '#8b9bb4' }} />
          <div className="dvc-sev-count" style={{ color: '#8b9bb4' }}>{mutes.data ? fmtInt(mutes.data.mutes.length) : '—'}</div>
          <div><div className="dvc-sev-label">무시 규칙</div><div className="dvc-sev-meta">알람 뮤트 규칙 · 총계에 미포함</div></div>
        </div>
      </div>

      <div className="dvc-grid2 wide">
        <Panel bodyPad={false}>
          <div className="dvc-filters">
            <button className={`dvc-filter${domain === 'ALL' ? ' on' : ''}`} onClick={() => setDomain('ALL')}>전체 {counts.total}</button>
            {Object.keys(DOMAIN_LABEL).filter((d) => domCounts[d]).map((d) => (
              <button key={d} className={`dvc-filter${domain === d ? ' on' : ''}`} onClick={() => setDomain(domain === d ? 'ALL' : d)}>{DOMAIN_LABEL[d]} {domCounts[d]}</button>
            ))}
            <span style={{ flex: 1 }} />
            <span className="dvc-dim" style={{ fontSize: 12 }}>심각도 → 최신 순 · 표시 {rows.length}건 · 제목 클릭 정렬</span>
          </div>
          <PollState poll={polls.al}>
            {rows.length === 0 ? <Empty>조건에 맞는 활성 알람이 없습니다.</Empty> : (
              <div className="dvc-tablewrap">
                <STable className="dvc-table">
                  <thead><tr><th>심각도</th><th>도메인</th><th>메시지</th><th>대상</th><th>사이트</th><th className="num">경과</th><th className="num">확인</th></tr></thead>
                  <tbody>
                    {rows.map((a) => (
                      <tr key={a.id} className={a.severity === 'critical' && !a.acknowledged ? 'crit' : ''}>
                        <td data-sort={a.severity === 'critical' ? 0 : a.severity === 'warning' ? 1 : 2}><SeverityBadge severity={a.severity} /></td>
                        <td className="dvc-mono dvc-dim" style={{ fontSize: 10 }}>{domainOf(a.entityType)}</td>
                        <td className="ellipsis" style={{ fontSize: 12.5, fontWeight: 600 }} title={a.message}>{a.message}</td>
                        <td className="dvc-mono dvc-dim ellipsis" style={{ fontSize: 10.5, maxWidth: 180 }} title={a.entity}>{a.entity}</td>
                        <td className="dvc-dim" style={{ fontSize: 11.5 }}>{a.vcenterId}</td>
                        <td className="num" data-sort={Date.parse(a.time) || ''} style={{ color: a.severity === 'critical' ? '#f87171' : '#8b9bb4' }}>{ageText(a.time, now)}</td>
                        <td className="num" style={{ fontSize: 10.5, color: a.acknowledged ? '#5d6b85' : '#fbbf24' }}>{a.acknowledged ? '✓ 확인' : '미확인'}</td>
                      </tr>
                    ))}
                  </tbody>
                </STable>
              </div>
            )}
          </PollState>
        </Panel>
        <Panel title="상관 그룹" sub={`${rows.length}건 → ${groups.length}그룹 · 같은 vCenter · 대상 유형 · 메시지 유형`}>
          {groups.length === 0 ? <Empty>묶을 알람이 없습니다.</Empty> : (
            <div className="dvc-rows">
              {groups.map((g) => (
                <div key={g.key} style={{ padding: '11px 0', borderBottom: '1px solid rgba(36,48,73,.5)' }}>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                    <span style={{ width: 8, height: 8, borderRadius: 2, background: g.severity === 'critical' ? '#ef4444' : g.severity === 'warning' ? '#f59e0b' : '#3b82f6', flex: 'none' }} />
                    <span style={{ fontSize: 12.5, fontWeight: 600, flex: 1 }}>{g.sample}</span>
                    <span className="dvc-num" style={{ fontSize: 10.5, color: g.severity === 'critical' ? '#f87171' : g.severity === 'warning' ? '#fbbf24' : '#60a5fa' }}>{g.count}건</span>
                  </div>
                  <div className="dvc-mono dvc-faint" style={{ fontSize: 10.5, marginTop: 4 }}>{g.vcenterId} · {DOMAIN_LABEL[g.domain]} · {g.entities.join(', ')}{g.count > g.entities.length ? ` 외 ${g.count - g.entities.length}` : ''}</div>
                </div>
              ))}
              <div className="dvc-note" style={{ marginTop: 8 }}>근본 원인 분석이 아니라 같은 조건이 반복되는 대상을 묶은 단순 집계입니다(메시지의 숫자는 무시).</div>
            </div>
          )}
        </Panel>
      </div>
    </>
  );
}
