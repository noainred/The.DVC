// V3 알람 센터(v2.490) — 심각도 카드 4(클릭 필터) · 도메인 칩 · 알람 표(/alarms) · 상관 그룹(같은 vCenter·대상 유형·메시지 유형 묶음) · 무시 규칙(/alarm-mutes).
import React, { useState } from 'react';
import { usePolling } from '../../api.js';
import { STable } from '../../components/STable.jsx';
import { Panel, PollState, Empty } from '../ui.jsx';
import { severityCounts, sortAlarms, correlateAlarms, domainOf, DOMAIN_LABEL, ageText, fmtInt, rowMatches, SEV_COLOR, SEV_TEXT } from '../data.js';

const SEV = [
  ['critical', 'Critical', 'CRIT', 'rgba(239,68,68,.08)', 'rgba(239,68,68,.4)'],
  ['warning', 'Warning', 'WARN', 'rgba(245,158,11,.07)', 'rgba(245,158,11,.35)'],
  ['info', 'Info', 'INFO', 'rgba(59,130,246,.07)', 'rgba(59,130,246,.35)'],
];
const SEV_TAG = { critical: 'CRIT', warning: 'WARN', info: 'INFO' };

export default function Alarms({ alarmsAll, scope, polls }) {
  const [sev, setSev] = useState('');
  const [domain, setDomain] = useState('ALL');
  const mutes = usePolling('/alarm-mutes', {}, 60_000);
  const now = Date.now();
  const scoped = scope.scoped(alarmsAll);
  const counts = severityCounts(scoped);
  const domCounts = {};
  for (const a of scoped) { const d = domainOf(a.entityType); domCounts[d] = (domCounts[d] || 0) + 1; }
  const rows = sortAlarms(scoped.filter((a) => (!sev || a.severity === sev) && (domain === 'ALL' || domainOf(a.entityType) === domain) && rowMatches(a, scope.q)));
  const groups = correlateAlarms(rows, 6);
  const unacked = scoped.filter((a) => a.severity === 'critical' && !a.acknowledged).length;

  return (
    <>
      <div className="v3-sevs">
        {SEV.map(([key, label, , bg, border]) => (
          <button key={key} type="button" className={`v3-sev${sev === key ? ' on' : ''}`} style={{ background: bg, borderColor: border }} onClick={() => setSev(sev === key ? '' : key)} title="클릭하면 이 심각도만 표시">
            <div className="v3-sev-stripe" style={{ background: SEV_COLOR[key] }} />
            <div className="v3-sev-count" style={{ color: SEV_TEXT[key] }}>{polls.al.data ? fmtInt(counts[key]) : '—'}</div>
            <div style={{ minWidth: 0 }}><div className="v3-sev-label">{label}</div><div className="v3-sev-meta">{key === 'critical' ? `미확인 ${unacked}` : key === 'warning' ? '활성 경고' : '정보'}</div></div>
          </button>
        ))}
        <div className="v3-sev" style={{ cursor: 'default', background: 'rgba(139,155,180,.06)' }}>
          <div className="v3-sev-stripe" style={{ background: '#526075' }} />
          <div className="v3-sev-count" style={{ color: '#526075' }}>{mutes.data ? fmtInt(mutes.data.mutes.length) : '—'}</div>
          <div style={{ minWidth: 0 }}><div className="v3-sev-label">억제 · 뮤트</div><div className="v3-sev-meta">알람 뮤트 규칙 · 총계에 미포함</div></div>
        </div>
      </div>

      <div className="v3-grid2 wide">
        <Panel bodyPad={false}>
          <div className="v3-filters">
            <button type="button" className={`v3-filter${domain === 'ALL' ? ' on' : ''}`} onClick={() => setDomain('ALL')}>전체 {counts.total}</button>
            {Object.keys(DOMAIN_LABEL).filter((d) => domCounts[d]).map((d) => (
              <button key={d} type="button" className={`v3-filter${domain === d ? ' on' : ''}`} onClick={() => setDomain(domain === d ? 'ALL' : d)}>{d} {domCounts[d]}</button>
            ))}
            <span style={{ flex: 1 }} />
            <span className="v3-dim" style={{ fontSize: 12 }}>심각도 → 최신 순 · 표시 {rows.length}건 · 제목 클릭 정렬</span>
          </div>
          <PollState poll={polls.al}>
            {rows.length === 0 ? <Empty>조건에 맞는 활성 알람이 없습니다.</Empty> : (
              <div className="v3-tablewrap">
                <STable className="v3-table">
                  <thead><tr><th>심각도</th><th>도메인</th><th>메시지</th><th>대상</th><th>사이트</th><th className="num">경과</th><th className="num">확인</th></tr></thead>
                  <tbody>
                    {rows.map((a) => (
                      <tr key={a.id} className={a.severity === 'critical' && !a.acknowledged ? 'crit' : ''}>
                        <td data-sort={a.severity === 'critical' ? 0 : a.severity === 'warning' ? 1 : 2}><span className="v3-badge" style={{ background: `${SEV_COLOR[a.severity] || '#526075'}22`, color: SEV_TEXT[a.severity] || '#526075' }}>{SEV_TAG[a.severity] || String(a.severity || '').toUpperCase()}</span></td>
                        <td className="v3-mono v3-dim" style={{ fontSize: 10 }}>{domainOf(a.entityType)}</td>
                        <td className="ellipsis" style={{ fontSize: 12.5, fontWeight: 600 }} title={a.message}>{a.message}</td>
                        <td className="v3-mono v3-dim ellipsis" style={{ fontSize: 10.5, maxWidth: 180 }} title={a.entity}>{a.entity}</td>
                        <td className="v3-dim" style={{ fontSize: 11.5 }}>{a.vcenterId}</td>
                        <td className="num" data-sort={Date.parse(a.time) || ''} style={{ color: a.severity === 'critical' ? '#dc2626' : '#526075' }}>{ageText(a.time, now)}</td>
                        <td className="num" style={{ fontSize: 10.5, color: a.acknowledged ? '#68738a' : '#b45309' }}>{a.acknowledged ? '✓ 확인' : '미확인'}</td>
                      </tr>
                    ))}
                  </tbody>
                </STable>
              </div>
            )}
          </PollState>
        </Panel>
        <Panel title="상관 그룹" sub={`${rows.length}건 → ${groups.length}그룹 · 억제 ${mutes.data ? mutes.data.mutes.length : '—'}`}>
          {groups.length === 0 ? <Empty>묶을 알람이 없습니다.</Empty> : (
            <div className="v3-rows">
              {groups.map((g) => (
                <div key={g.key} style={{ padding: '11px 0', borderBottom: '1px solid #e6eaf0' }}>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                    <span style={{ width: 8, height: 8, borderRadius: 2, background: SEV_COLOR[g.severity] || '#526075', flex: 'none' }} />
                    <span style={{ fontSize: 12.5, fontWeight: 600, flex: 1 }}>{g.sample}</span>
                    <span className="v3-num" style={{ fontSize: 10.5, color: SEV_TEXT[g.severity] || '#526075' }}>{g.count}</span>
                  </div>
                  <div className="v3-mono v3-faint" style={{ fontSize: 10.5, marginTop: 4 }}>{g.vcenterId} · {DOMAIN_LABEL[g.domain]} · {g.entities.join(', ')}{g.count > g.entities.length ? ` 외 ${g.count - g.entities.length}` : ''}</div>
                </div>
              ))}
              <div className="v3-note" style={{ marginTop: 8 }}>근본 원인 분석이 아니라 같은 vCenter · 대상 유형 · 메시지 유형(숫자 무시)이 반복되는 대상을 묶은 단순 집계입니다.</div>
            </div>
          )}
        </Panel>
      </div>
    </>
  );
}
