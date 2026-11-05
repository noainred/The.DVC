/**
 * views/vcd/MonitorTab.jsx — vCenter › 모니터(승인 시안 ② · 기본값 2: 예전 '추이' 는 모니터 › 성능).
 *   문제 및 알람 = vCenter 트리거 알람(v2.897 — vcinfo) + 포탈 알람(포탈 규칙 — 따로 보인다) · 이벤트 = 구성 변경 이력(이 vCenter) ·
 *   작업 = vCenter 최근 작업(v2.897 — vcinfo) · 성능 = TrendView 그대로.
 */
import React, { useState } from 'react';
import { usePolling, toolAllowed, can } from '../../api.js';
import { ErrorBox, Loading } from '../../components/ui.jsx';
import { STable } from '../../components/STable.jsx';
import { useOnce, toolDenied } from './useOnce.js';
import { Note, SubNav, ToolLink } from './VcdParts.jsx';
import { VcAlarmsCard, VcTasksCard } from './VcInfoParts.jsx';
import { EventRows } from './SummaryTab.jsx';
import { MONITOR_SUBS, alarmsOf, alarmCounts, SEV_LABEL, SEV_BADGE, PORTAL_ALARM_RULE_TEXT, shortTs } from './vcdTabs.js';

const EVENT_DAYS = [1, 7, 30];
const SEV_ORDER = { critical: 0, warning: 1, info: 2 };

export default function MonitorTab({ vcenterId, sub, onSub, perf }) {
  const alarmsP = usePolling(can('inv.alarms') ? '/alarms' : null, { vcenterId }, 60_000);
  const alarms = alarmsOf(alarmsP.data?.items, vcenterId);
  const ac = alarmCounts(alarms);
  const items = MONITOR_SUBS.map((s) => ({ ...s, n: s.k === 'alarms' ? (alarmsP.data ? ac.total : null) : null }));
  return (
    <div className="vcd-pane card" style={{ marginTop: 10 }}>
      <SubNav items={items} value={sub} onChange={onSub} label="모니터 하위 칸" />
      <div style={{ minWidth: 0 }}>
        {sub === 'alarms' && <><VcAlarmsCard vcenterId={vcenterId} embedded /><div style={{ borderTop: '1px solid var(--border)', marginTop: 6 }} /><AlarmsPane p={alarmsP} alarms={alarms} ac={ac} /></>}
        {sub === 'events' && <EventsPane vcenterId={vcenterId} />}
        {sub === 'tasks' && <VcTasksCard vcenterId={vcenterId} embedded />}
        {sub === 'perf' && <div style={{ padding: '10px 12px' }}>{perf}</div>}
      </div>
    </div>
  );
}

function AlarmsPane({ p, alarms, ac }) {
  const [sev, setSev] = useState('');
  if (!can('inv.alarms')) return <div style={{ padding: 12 }}><ErrorBox error={toolDenied('알람')} /></div>;
  if (!p.data && (p.error || p.errorInfo)) return <div style={{ padding: 12 }}><ErrorBox error={p.errorInfo || p.error} /></div>;
  if (!p.data) return <Loading label="알람" />;
  const rows = [...alarms].filter((a) => !sev || a.severity === sev)
    .sort((a, b) => (SEV_ORDER[a.severity] ?? 9) - (SEV_ORDER[b.severity] ?? 9) || String(b.time || '').localeCompare(String(a.time || '')));
  const chip = (k, label, n) => (
    <button key={k || 'all'} type="button" className={sev === k ? 'login-btn' : 'tab'} style={{ flex: 'none', padding: '5px 11px' }} onClick={() => setSev(k)}>{label} {n}</button>
  );
  return (
    <>
      <div className="vcd-card-h" style={{ flexWrap: 'wrap', rowGap: 6 }}>
        <b>포탈 알람</b><span className="badge amber">포탈 규칙</span>
        {chip('', '전체', ac.total)}{chip('critical', '심각', ac.critical)}{chip('warning', '경고', ac.warning)}{chip('info', '정보', ac.info)}
        <span className="muted" style={{ marginLeft: 'auto', fontSize: 11.5 }}>처음 본 시각 = 포탈이 처음 판정한 시각</span>
      </div>
      {rows.length ? (
        <STable className="v3-table" minWidth={760}>
          <thead><tr><th>심각도</th><th>대상</th><th>대상 종류</th><th>메시지</th><th>처음 본 시각</th></tr></thead>
          <tbody>
            {rows.map((a) => (
              <tr key={a.id}>
                <td data-sort={String(SEV_ORDER[a.severity] ?? 9)}><span className={`badge ${SEV_BADGE[a.severity] || 'gray'}`}>{SEV_LABEL[a.severity] || a.severity || '—'}</span></td>
                <td><b>{a.entity || '—'}</b></td>
                <td>{a.entityType === 'host' ? '호스트' : a.entityType === 'datastore' ? '데이터스토어' : (a.entityType || '—')}</td>
                <td style={{ whiteSpace: 'normal', minWidth: 220 }}>{a.message || '—'}</td>
                <td className="mono" data-sort={String(a.time || '')}>{shortTs(a.time)}</td>
              </tr>
            ))}
          </tbody>
        </STable>
      ) : <div className="muted" style={{ padding: '10px 14px', fontSize: 12.5 }}>{sev ? '이 심각도의 포탈 알람이 없습니다.' : '지금 발화 중인 포탈 알람이 없습니다.'}</div>}
      <Note>이 표는 vCenter 의 알람이 아닙니다 — {PORTAL_ALARM_RULE_TEXT}</Note>
    </>
  );
}

function EventsPane({ vcenterId }) {
  const [days, setDays] = useState(1);
  const ok = toolAllowed('change-history');
  const ev = useOnce('/tools/report/changes', { vcenterId, days, limit: 300 }, ok);
  return (
    <>
      <div className="vcd-card-h" style={{ flexWrap: 'wrap', rowGap: 6 }}>
        <b>이벤트</b>
        {EVENT_DAYS.map((d) => (
          <button key={d} type="button" className={days === d ? 'login-btn' : 'tab'} style={{ flex: 'none', padding: '5px 11px' }} onClick={() => setDays(d)}>{d}일</button>
        ))}
        {ok && <button type="button" className="tab" style={{ flex: 'none', padding: '5px 11px' }} onClick={ev.reload} disabled={ev.loading}>{ev.loading ? '불러오는 중…' : '다시 읽기'}</button>}
        <span style={{ marginLeft: 'auto' }}><ToolLink tool="change-history">구성 변경 이력에서 열기 →</ToolLink></span>
      </div>
      {!ok ? <div style={{ padding: 12 }}><ErrorBox error={toolDenied('구성 변경 이력')} /></div>
        : ev.error && !ev.data ? <div style={{ padding: 12 }}><ErrorBox error={ev.error} /></div>
          : !ev.data ? <Loading label="변경 이벤트" /> : (
            <>
              <div className="muted" style={{ padding: '6px 14px', fontSize: 12 }}>
                {ev.data.total != null ? `${Number(ev.data.total).toLocaleString()}건` : ''}{ev.data.total > (ev.data.rows || []).length ? ` · 처음 ${(ev.data.rows || []).length}건 표시` : ''}
              </div>
              <EventRows data={ev.data} vcenterId={vcenterId} />
            </>
          )}
      <Note>포탈이 EventManager 에서 모은 변경성 이벤트만(구성 변경 이력과 같은 출처 · 같은 분류). 로그인 · 알람 발화 같은 이벤트는 넣지 않습니다.</Note>
    </>
  );
}


