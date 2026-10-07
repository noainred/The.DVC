import React, { useState } from 'react';
import { usePolling } from '../../api.js';
import { Loading, ErrorBox } from '../../components/ui.jsx';
import STable from '../../components/STable.jsx';
import { GuestOsVmsModal } from '../../views/SpecialTools.jsx';
import { capacityCards, totalTiles, osRows, corpContribution, contribNote, contribTotalLabel, dsUnknownMark } from '../v6Data.js';
import Select from '../../components/Select.jsx';

/**
 * V6 Summary(v2.623) — **자원 총량과 할당**만 둔다(핸드오프: 물리 vs 할당 · 오버커밋 · OS별 할당 · 법인별 기여도).
 * vCenter·호스트·VM·알람 개수와 물리 사용률 바는 Overview 가 소유한다. 폴링: /summary 15초(법인 필터 = vcenterId).
 */
const fmt = (v, d = 0) => (v == null || !Number.isFinite(Number(v)) ? '—' : Number(v).toLocaleString('en-US', { maximumFractionDigits: d }));
const OS_COLORS = ['var(--accent)', 'var(--accent-2)', 'var(--green)', 'var(--amber)', 'var(--purple)', 'var(--mint)', 'var(--red)', 'var(--text-dim)'];

export default function V6Summary({ vcenters }) {
  const [corp, setCorp] = useState('');
  const [osDrill, setOsDrill] = useState(null);
  const { data: s, error } = usePolling('/summary', corp ? { vcenterId: corp } : {}, 15_000);
  if (error && !s) return <ErrorBox message={error} />;
  if (!s) return <Loading label="Summary" />;
  const cards = capacityCards(s);
  const tiles = totalTiles(s);
  const os = osRows(s);
  const contrib = corpContribution(s);
  const corpName = corp ? ((vcenters || []).find((v) => v.id === corp)?.name || corp) : '';
  return (
    <div className="v6-sum">
      <div className="v6-sum-head">
        <h2>자원 총량과 할당</h2>
        <Select className="select" aria-label="법인 필터" value={corp} onChange={(e) => setCorp(e.target.value)}>
          <option value="">전체 법인</option>
          {(vcenters || []).map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
        </Select>
      </div>
      {error && <div className="v6-banner warn">갱신 실패(직전 데이터 표시 중): {String(error?.message || error)}</div>}

      <div className="v6-caps">
        {cards.map((c) => (
          <div key={c.id} className={`v6-cap${c.warn ? ' warn' : ''}`}>
            <div className="v6-cap-top"><b>{c.label}</b><span className="v6-cap-ratio">{c.ratio ?? '—'}<small>{c.ratioLabel}</small></span></div>
            <div className="v6-cap-row"><span>물리</span><div className="v6-cap-bar phys"><i style={{ width: '100%' }} /></div><em>{c.phys}</em></div>
            <div className="v6-cap-row"><span>할당</span><div className="v6-cap-bar alloc"><i style={{ width: `${Math.min(100, c.allocPct ?? 0)}%` }} /></div><em>{c.alloc}</em></div>
            {c.used && <div className="v6-cap-used">{c.used}</div>}
            {c.warn && <div className="v6-warn">{c.id === 'cpu' ? 'vCPU:코어 4:1 초과' : c.id === 'mem' ? '물리 대비 할당 150% 초과' : '프로비저닝이 용량을 넘었습니다'}</div>}
          </div>
        ))}
      </div>

      <div className="v6-totals">
        {tiles.map((t) => <div key={t.label} className="v6-total-tile"><span>{t.label}</span><b>{t.value}</b>{t.note && <small className="v6-note">{t.note}</small>}</div>)}
      </div>

      <div className="v6-panel">
        <div className="v6-panel-head"><b>OS별 할당</b><span>계열을 누르면 그 OS 의 VM 목록</span></div>
        <div className="v6-stack" aria-label="OS 비중">
          {os.map((r, i) => <i key={r.name} title={`${r.name} ${r.share == null ? '—' : `${r.share}%`}`} style={{ width: `${r.share ?? 0}%`, background: OS_COLORS[i % OS_COLORS.length] }} />)}
        </div>
        <STable className="v6-table" minWidth={620}>
          <thead><tr><th>Guest OS</th><th className="right">VM</th><th className="right">비중</th><th className="right">vCPU</th><th className="right">메모리(GB)</th><th className="right">디스크(TB)</th></tr></thead>
          <tbody>
            {os.map((r, i) => (
              <tr key={r.name}>
                <td><button type="button" className="v6-link" onClick={() => setOsDrill(r.name)}><i className="v6-dot" style={{ background: OS_COLORS[i % OS_COLORS.length] }} />{r.name}</button></td>
                <td className="right">{fmt(r.vms)}</td><td className="right">{r.share == null ? '—' : `${r.share}%`}</td><td className="right">{fmt(r.vcpu)}</td>
                <td className="right">{fmt(r.ramGB)}</td><td className="right">{fmt(r.diskTB, 1)}</td>
              </tr>
            ))}
          </tbody>
        </STable>
      </div>

      <div className="v6-panel">
        <div className="v6-panel-head"><b>법인(vCenter)별 기여도</b>{/* v2.721(감사 R2-04): 표시 조건은 안내 문장 자체 — 전력만 빠진 경우(excluded·carried·dsUnknown 모두 0)도 말한다. */}{contribNote(contrib) && <span>{contribNote(contrib)}</span>}</div>
        <STable className="v6-table" minWidth={900}>
          <thead><tr><th>법인</th><th className="right">호스트</th><th className="right">VM</th><th className="right">코어</th><th className="right">메모리(GB)</th><th className="right">스토리지(TB)</th><th className="right">vCPU 할당</th><th className="right">RAM 할당(GB)</th><th className="right">프로비저닝(TB)</th><th className="right">전력(kW)</th></tr></thead>
          <tbody>
            {contrib.rows.map((r) => (
              <tr key={r.id}><td>{r.name || r.id}{r.statusLabel && <span className="v6-note"> · {r.statusLabel}</span>}</td><td className="right">{fmt(r.hosts)}</td><td className="right">{fmt(r.vms)}</td><td className="right">{fmt(r.cpuCores)}</td>
                <td className="right">{fmt(r.memTotalGB)}</td><td className="right" data-sort={r.storageTotalTB ?? ''}>{fmt(r.storageTotalTB, 1)}{dsUnknownMark(r) && <span className="v6-note" title="사용량을 못 읽은 데이터스토어는 이 값에서 뺐습니다"> · {dsUnknownMark(r)}</span>}</td><td className="right">{fmt(r.vcpuAllocated)}</td>
                <td className="right">{fmt(r.ramAllocatedGB)}</td><td className="right">{fmt(r.provisionedTB, 1)}</td><td className="right">{fmt(r.powerKw, 1)}</td></tr>
            ))}
            <tr data-pin className="v6-total"><td>{contribTotalLabel(contrib)}</td><td className="right">{fmt(contrib.total.hosts)}</td><td className="right">{fmt(contrib.total.vms)}</td><td className="right">{fmt(contrib.total.cpuCores)}</td>
              <td className="right">{fmt(contrib.total.memTotalGB)}</td><td className="right">{fmt(contrib.total.storageTotalTB, 1)}</td><td className="right">{fmt(contrib.total.vcpuAllocated)}</td>
              <td className="right">{fmt(contrib.total.ramAllocatedGB)}</td><td className="right">{fmt(contrib.total.provisionedTB, 1)}</td><td className="right">{fmt(contrib.total.powerKw, 1)}</td></tr>
          </tbody>
        </STable>
      </div>
      {osDrill && <GuestOsVmsModal label={`${osDrill}${corp ? ` — ${corpName}` : ''}`} params={{ family: osDrill, ...(corp ? { vcenterId: corp } : {}) }} onClose={() => setOsDrill(null)} />}
    </div>
  );
}
