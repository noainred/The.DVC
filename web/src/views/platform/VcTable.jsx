// views/platform/VcTable.jsx — vCenter 탭 '표' 보기(v2.915 · 설계 docs/design/virt-platform-menu 시안 ⑨): 한 줄에 한 법인 — 상태 · 호스트 · 확인 대상 · VM · 조치 필요 ·
//   CPU · 메모리 · 스토리지 · 알람 · Veeam / Bareos · 수집 경로 · 버전 + 합계 줄. 숫자는 /vcenters(카드와 같은 metrics) + 허브 요약(/platform/summary byVc) + 백업 수 —
//   새 집계 없음. 행을 누르면 그 법인의 상세(카드와 같다) · 호스트 · VM 수를 누르면 그 법인 범위로 탭 이동. 못 읽은 값은 '—'(STable 은 null 을 뒤로 정렬).
//   2차: 호스트 탭 '법인별'(HostsCorp) · VM 탭 '법인별'(VmsByCorp) 의 열을 이 표의 열 묶음으로 흡수(README §4.0-12).
import React from 'react';
import { STable } from '../../components/STable.jsx';
import { usageColor } from '../../components/ui.jsx';
import { VcStateBadge } from '../VCenters.jsx';
import { storageBarInfo } from '../vcCardText.js';
import { alarmsUnknown } from '../restFallbackText.js';
import { fmtN } from './platformText.js';

function Pct({ pct, title }) {
  if (pct == null) return <span className="muted">—</span>;
  return (
    <span className="flex gap" style={{ alignItems: 'center', minWidth: 110 }} title={title}>
      <span className="usage-bar" style={{ flex: 1 }}><span style={{ width: `${Math.min(pct, 100)}%`, background: usageColor(pct) }} /></span>
      <b className="tabular" style={{ width: 36, textAlign: 'right' }}>{pct}%</b>
    </span>
  );
}

export default function VcTable({ sites, byVc, backupText, onOpen, onGoHosts, onGoVms }) {
  const rows = Array.isArray(sites) ? sites : [];
  const sum = (f) => rows.reduce((a, s) => { const v = f(s); return v == null ? a : (a ?? 0) + v; }, null);
  const totHosts = sum((s) => (Number.isFinite(s.metrics?.hosts) ? s.metrics.hosts : null));
  const totVms = sum((s) => (Number.isFinite(s.metrics?.vms) ? s.metrics.vms : null));
  const totAtt = sum((s) => byVc.get(s.id)?.hosts?.attention ?? null);
  const totSig = sum((s) => byVc.get(s.id)?.vms?.attention ?? null);
  const stop = (e) => e.stopPropagation();
  return (
    <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
      <div className="flex between wrap" style={{ padding: '10px 14px', borderBottom: '1px solid var(--border-soft)', gap: 8, alignItems: 'center' }}>
        <b>법인별 비교</b><span className="badge blue">{rows.length} 법인</span>
        <span className="muted" style={{ fontSize: 12 }}>행을 누르면 그 법인 상세 · 호스트 · VM 수를 누르면 그 범위로 탭 이동 · 열 제목으로 정렬</span>
      </div>
      <div style={{ overflowX: 'auto' }}>
        <STable className="v3-table" minWidth={1100}>
          <thead><tr>
            <th>법인 · vCenter</th><th>상태</th><th style={{ textAlign: 'right' }}>호스트</th><th style={{ textAlign: 'right' }}>확인 대상</th><th style={{ textAlign: 'right' }}>VM</th><th style={{ textAlign: 'right' }}>조치 필요</th>
            <th>CPU</th><th>메모리</th><th>스토리지</th><th style={{ textAlign: 'right' }}>알람</th><th style={{ textAlign: 'right' }}>Veeam / Bareos</th><th>수집</th><th>버전</th>
          </tr></thead>
          <tbody>
            {rows.map((s) => {
              const m = s.metrics || {};
              const r = byVc.get(s.id) || null;
              const st = storageBarInfo(m);
              const alarmsNa = alarmsUnknown(s);
              const alarms = alarmsNa ? null : (m.alarmsCritical || 0) + (m.alarmsWarning || 0);
              const bk = backupText(s);
              return (
                <tr key={s.id} style={{ cursor: 'pointer' }} onClick={() => onOpen(s.id)} title="클릭 — 이 vCenter 상세">
                  <td data-sort={s.name}><b>{s.name}</b><div className="muted" style={{ fontSize: 11 }}>{s.location?.region || '—'} · {s.location?.city || '—'}</div></td>
                  <td data-sort={s.status || ''}><VcStateBadge s={s} /></td>
                  <td style={{ textAlign: 'right' }} data-sort={m.hosts ?? ''}>
                    {Number.isFinite(m.hosts) ? <button type="button" className="cell-link tabular" onClick={(e) => { stop(e); onGoHosts(s.id); }} title="호스트 탭을 이 법인 범위로">{fmtN(m.hosts)} →</button> : '—'}
                    {r?.hosts?.total != null && <div className="muted" style={{ fontSize: 11 }}>점검 {fmtN(r.hosts.maint)} · 끊김 {fmtN(r.hosts.down)}</div>}
                  </td>
                  <td style={{ textAlign: 'right', color: r?.hosts?.attention > 0 ? '#fbbf24' : undefined }} data-sort={r?.hosts?.attention ?? ''} className="tabular">{fmtN(r?.hosts?.attention)}</td>
                  <td style={{ textAlign: 'right' }} data-sort={m.vms ?? ''}>
                    {Number.isFinite(m.vms) ? <button type="button" className="cell-link tabular" onClick={(e) => { stop(e); onGoVms(s.id); }} title="VM 탭을 이 법인 범위로">{fmtN(m.vms)} →</button> : '—'}
                    {Number.isFinite(m.vmsPoweredOn) && <div className="muted" style={{ fontSize: 11 }}>{fmtN(m.vmsPoweredOn)} on</div>}
                  </td>
                  <td style={{ textAlign: 'right', color: r?.vms?.attention > 0 ? '#f87171' : undefined }} data-sort={r?.vms?.attention ?? ''} className="tabular">{fmtN(r?.vms?.attention)}</td>
                  <td data-sort={m.cpuUsagePct ?? ''}><Pct pct={m.cpuUsagePct ?? null} /></td>
                  <td data-sort={m.memUsagePct ?? ''}><Pct pct={m.memUsagePct ?? null} /></td>
                  <td data-sort={st.pct ?? ''}><Pct pct={st.pct} title={st.title} /></td>
                  <td style={{ textAlign: 'right', color: m.alarmsCritical ? 'var(--red)' : undefined }} data-sort={alarms ?? ''} className="tabular" title={alarmsNa ? 'REST 폴백 — 경보를 조회하지 않았습니다(0건이 아닙니다)' : undefined}>{alarms == null ? '—' : fmtN(alarms)}</td>
                  <td style={{ textAlign: 'right' }} data-sort={bk?.sort ?? ''} className="tabular" title={bk?.title || undefined}>{bk ? bk.text : '—'}</td>
                  <td data-sort={s.collectSource === 'site' ? 'site' : 'direct'}><span className={`badge ${s.collectSource === 'site' ? 'blue' : 'gray'}`}>{s.collectSource === 'site' ? '엣지' : '직접'}</span></td>
                  <td data-sort={s.version || ''} className="muted">{s.version ? `v${s.version}` : '—'}</td>
                </tr>
              );
            })}
            <tr data-pin="bottom" style={{ background: 'var(--panel-deep)', fontWeight: 700 }}>
              <td>합계 · {rows.length} 법인</td><td></td>
              <td style={{ textAlign: 'right' }} className="tabular">{fmtN(totHosts)}</td>
              <td style={{ textAlign: 'right' }} className="tabular">{fmtN(totAtt)}</td>
              <td style={{ textAlign: 'right' }} className="tabular">{fmtN(totVms)}</td>
              <td style={{ textAlign: 'right' }} className="tabular">{fmtN(totSig)}</td>
              <td colSpan={7} className="muted" style={{ fontWeight: 400, fontSize: 11.5 }}>합계는 수를 아는 법인만 더한 값(모르는 법인은 '—' · 0 으로 더하지 않음)</td>
            </tr>
          </tbody>
        </STable>
      </div>
    </div>
  );
}
