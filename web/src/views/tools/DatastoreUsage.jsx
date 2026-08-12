// DatastoreUsage.jsx — SpecialTools.jsx(구 5,070줄)에서 분리(v2.282 대형 파일 분할). 본문은 원본 그대로 이동.
import React, { useEffect, useState } from 'react';
import { fetchJson, usePolling } from '../../api.js';
import { Loading, ErrorBox } from '../../components/ui.jsx';
import { Card } from './shared.jsx';


// vCenter별/DataCenter별 데이터스토어(스토리지) 용량 현황. 각 vCenter에 어떤 스토리지가
// 연결돼 있고 전체/여유 용량이 얼마인지 한눈에. 1차 DataCenter → 2차 vCenter(스토리지는
// baremetal 개념이 없어 vCenter 하위만). /datastores(스냅샷)를 vCenter/DataCenter로 그룹핑.
function dsFmtGB(gb) {
  const g = Number(gb) || 0;
  if (g >= 1000) { const t = g / 1000; return `${t % 1 === 0 ? t : t.toFixed(1)} TB`; } // 1000GB=1TB(사용자 선호)
  return `${Math.round(g)} GB`;
}
function dsSum(arr, k) { return arr.reduce((a, d) => a + (Number(d[k]) || 0), 0); }
function dsUsageColor(pct) { return pct >= 90 ? 'var(--red)' : pct >= 75 ? 'var(--amber)' : 'var(--green)'; }

// 한 그룹(vCenter 또는 DataCenter 소계)의 용량 바 + 요약.
function DsCapBar({ capacityGB, freeGB }) {
  const cap = capacityGB || 0, free = freeGB || 0, used = Math.max(0, cap - free);
  const pct = cap > 0 ? Math.round((used / cap) * 100) : 0;
  return (
    <div style={{ minWidth: 220 }}>
      <div className="flex between" style={{ fontSize: 12, marginBottom: 3 }}>
        <span className="muted">사용 {dsFmtGB(used)} / 전체 {dsFmtGB(cap)}</span>
        <b style={{ color: dsUsageColor(pct) }}>{pct}%</b>
      </div>
      <div style={{ height: 7, borderRadius: 4, background: 'rgba(148,163,184,.15)', overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${Math.min(100, pct)}%`, background: dsUsageColor(pct) }} />
      </div>
      <div className="muted" style={{ fontSize: 11.5, marginTop: 3 }}>여유 {dsFmtGB(free)}</div>
    </div>
  );
}

// 한 vCenter의 데이터스토어 표(이름 정렬).
function DsVcTable({ items }) {
  const sorted = items.slice().sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), undefined, { numeric: true }));
  return (
    <table className="data-table" style={{ width: '100%', fontSize: 12.5, marginTop: 8 }}>
      <thead><tr>
        <th style={{ textAlign: 'left' }}>데이터스토어</th><th>유형</th>
        <th style={{ textAlign: 'right' }}>전체</th><th style={{ textAlign: 'right' }}>사용</th>
        <th style={{ textAlign: 'right' }}>여유</th><th style={{ minWidth: 120 }}>사용률</th>
      </tr></thead>
      <tbody>{sorted.map((d) => {
        const pct = d.usagePct != null ? d.usagePct : (d.capacityGB > 0 ? Math.round((d.usedGB || 0) / d.capacityGB * 100) : 0);
        return (
          <tr key={d.id || `${d.vcenterId}:${d.name}`}>
            <td><b>{d.name}</b></td>
            <td className="center"><span className="badge gray" style={{ fontSize: 11 }}>{d.type || '—'}</span></td>
            <td style={{ textAlign: 'right' }}>{dsFmtGB(d.capacityGB)}</td>
            <td style={{ textAlign: 'right' }}>{dsFmtGB(d.usedGB)}</td>
            <td style={{ textAlign: 'right', color: dsUsageColor(pct) }}>{dsFmtGB(d.freeGB)}</td>
            <td>
              <div style={{ height: 6, borderRadius: 4, background: 'rgba(148,163,184,.15)', overflow: 'hidden' }} title={`${pct}%`}>
                <div style={{ height: '100%', width: `${Math.min(100, pct)}%`, background: dsUsageColor(pct) }} />
              </div>
            </td>
          </tr>
        );
      })}</tbody>
    </table>
  );
}

export function DatastoreUsage({ scope }) {
  const { loading, data, error } = usePolling('/datastores', {}, 15_000);
  const { data: vcList } = usePolling('/vcenters', {}, 60_000);
  const [dc, setDc] = useState({ datacenters: [], assign: {} });
  const [view, setView] = useState('dc'); // 'dc'(1차 DataCenter) | 'vc'(vCenter 평면)
  const [q, setQ] = useState('');
  useEffect(() => { fetchJson('/admin/datacenters').then((r) => setDc({ datacenters: r.datacenters || [], assign: r.assign || {} })).catch(() => {}); }, []);
  if (loading && !data) return <Loading />;
  if (error) return <ErrorBox message={error} />;
  const vcName = new Map((vcList || []).map((v) => [v.id, v.name || v.id]));
  const dcName = new Map((dc.datacenters || []).map((x) => [x.id, x.name || x.id]));
  const assign = dc.assign || {};
  const dcOfVc = (vcId) => assign[String(vcId || '')] || '';
  const ql = q.trim().toLowerCase();
  let list = (data || []).filter((d) => !scope || d.vcenterId === scope);
  if (ql) list = list.filter((d) => [d.name, d.type, d.vcenterId].some((x) => String(x || '').toLowerCase().includes(ql)));

  const totCap = dsSum(list, 'capacityGB'), totFree = dsSum(list, 'freeGB'), totUsed = Math.max(0, totCap - totFree);
  const totPct = totCap > 0 ? Math.round(totUsed / totCap * 100) : 0;
  const vcIds = new Set(list.map((d) => d.vcenterId));

  // vCenter 단위 그룹.
  const byVc = new Map();
  for (const d of list) { const k = d.vcenterId || '(미지정)'; if (!byVc.has(k)) byVc.set(k, []); byVc.get(k).push(d); }
  const vcBlocks = [...byVc.entries()].map(([id, items]) => ({
    id, name: vcName.get(id) || id, items,
    capacityGB: dsSum(items, 'capacityGB'), freeGB: dsSum(items, 'freeGB'),
  })).sort((a, b) => b.capacityGB - a.capacityGB);

  return (
    <div>
      <div className="kpis" style={{ marginBottom: 14 }}>
        <Card label="전체 용량" value={dsFmtGB(totCap)} accent="var(--accent)" />
        <Card label="사용" value={`${dsFmtGB(totUsed)} (${totPct}%)`} accent={dsUsageColor(totPct)} />
        <Card label="여유" value={dsFmtGB(totFree)} accent="var(--green)" />
        <Card label="데이터스토어" value={list.length} meta={`${vcIds.size} vCenter`} />
      </div>

      <div className="flex between wrap gap" style={{ alignItems: 'center', marginBottom: 12 }}>
        <div className="flex gap">
          <button className={view === 'dc' ? 'login-btn' : 'tab'} style={{ flex: 'none', padding: '7px 14px' }} onClick={() => setView('dc')}>🏢 DataCenter별</button>
          <button className={view === 'vc' ? 'login-btn' : 'tab'} style={{ flex: 'none', padding: '7px 14px' }} onClick={() => setView('vc')}>🖥 vCenter별</button>
        </div>
        <input className="input" placeholder="데이터스토어/유형/vCenter 검색" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 260 }} />
      </div>

      {list.length === 0 && <div className="card" style={{ padding: 16 }}><span className="muted">표시할 데이터스토어가 없습니다.</span></div>}

      {view === 'vc' && vcBlocks.map((vc) => (
        <div key={vc.id} className="card" style={{ padding: 14, marginBottom: 14 }}>
          <div className="flex between wrap gap" style={{ alignItems: 'center' }}>
            <div style={{ fontWeight: 700, fontSize: 15 }}>🖥 {vc.name} <span className="muted" style={{ fontWeight: 400, fontSize: 13 }}>· {vc.items.length}개 · {dcName.get(dcOfVc(vc.id)) || dcOfVc(vc.id) || '법인 미지정'}</span></div>
            <DsCapBar capacityGB={vc.capacityGB} freeGB={vc.freeGB} />
          </div>
          <DsVcTable items={vc.items} />
        </div>
      ))}

      {view === 'dc' && (() => {
        // 1차: DataCenter(vCenter의 소속 법인). 2차: vCenter.
        const byDc = new Map();
        for (const vc of vcBlocks) { const k = dcOfVc(vc.id) || '__unassigned__'; if (!byDc.has(k)) byDc.set(k, []); byDc.get(k).push(vc); }
        const dcBlocks = [...byDc.entries()].map(([id, vcs]) => ({
          id, name: id === '__unassigned__' ? '⚠ 법인 미지정' : (dcName.get(id) || id), vcs,
          capacityGB: dsSum(vcs, 'capacityGB'), freeGB: dsSum(vcs, 'freeGB'),
        })).sort((a, b) => (a.id === '__unassigned__' ? 1 : 0) - (b.id === '__unassigned__' ? 1 : 0) || b.capacityGB - a.capacityGB);
        return dcBlocks.map((d) => (
          <div key={d.id} className="card" style={{ padding: 14, marginBottom: 16, borderLeft: '3px solid var(--accent, #60a5fa)' }}>
            <div className="flex between wrap gap" style={{ alignItems: 'center', marginBottom: 6 }}>
              <div style={{ fontWeight: 800, fontSize: 16 }}>🏢 {d.name} <span className="muted" style={{ fontWeight: 400, fontSize: 13 }}>· {d.vcs.length} vCenter · {dsSum(d.vcs.flatMap((v) => v.items), 'capacityGB') ? d.vcs.reduce((a, v) => a + v.items.length, 0) : 0}개 데이터스토어</span></div>
              <DsCapBar capacityGB={d.capacityGB} freeGB={d.freeGB} />
            </div>
            {d.vcs.map((vc) => (
              <div key={vc.id} style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid rgba(148,163,184,.15)' }}>
                <div className="flex between wrap gap" style={{ alignItems: 'center' }}>
                  <div style={{ fontWeight: 600, fontSize: 13.5 }}>🖥 {vc.name} <span className="muted" style={{ fontWeight: 400 }}>· {vc.items.length}개</span></div>
                  <DsCapBar capacityGB={vc.capacityGB} freeGB={vc.freeGB} />
                </div>
                <DsVcTable items={vc.items} />
              </div>
            ))}
          </div>
        ));
      })()}
    </div>
  );
}
