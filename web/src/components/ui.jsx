import React, { useMemo, useState } from 'react';

export function usageColor(pct) {
  if (pct >= 90) return 'var(--red)';
  if (pct >= 75) return 'var(--amber)';
  return 'var(--green)';
}

export function Kpi({ label, value, unit, meta, pct, accent, onClick }) {
  return (
    <div
      className={`card kpi${onClick ? ' kpi-click' : ''}`}
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } } : undefined}
      title={onClick ? '클릭하여 보기' : undefined}
    >
      <div className="label">{label}</div>
      <div className="value" style={accent ? { color: accent } : undefined}>
        {value}
        {unit && <small> {unit}</small>}
      </div>
      {typeof pct === 'number' && (
        <div className="usage-bar">
          <span style={{ width: `${Math.min(pct, 100)}%`, background: usageColor(pct) }} />
        </div>
      )}
      {meta && <div className="meta">{meta}</div>}
    </div>
  );
}

export function UsageCell({ pct }) {
  return (
    <span className="nowrap">
      <span className="mini-bar">
        <span style={{ width: `${Math.min(pct, 100)}%`, background: usageColor(pct) }} />
      </span>{' '}
      <span className="pct tabular">{pct}%</span>
    </span>
  );
}

export function StateBadge({ state }) {
  const map = {
    CONNECTED: ['green', '정상'],
    POWERED_ON: ['green', 'On'],
    MAINTENANCE: ['amber', '점검'],
    POWERED_OFF: ['gray', 'Off'],
    DISCONNECTED: ['red', '연결끊김'],
    SUSPENDED: ['amber', '일시중지'],
    connected: ['green', 'Connected'],
    unreachable: ['red', 'Unreachable'],
    RUNNING: ['green', 'Running'],
    OUTDATED: ['amber', 'Outdated'],
    NOT_RUNNING: ['gray', '미실행'],
  };
  const [cls, label] = map[state] || ['gray', state];
  return <span className={`badge ${cls}`}>{label}</span>;
}

export function SeverityBadge({ severity }) {
  const map = { critical: ['red', 'Critical'], warning: ['amber', 'Warning'], info: ['blue', 'Info'] };
  const [cls, label] = map[severity] || ['gray', severity];
  return <span className={`badge ${cls}`}>{label}</span>;
}

/** Sortable, client-side table. columns: [{key,label,render?,align?,sortValue?}] */
export function DataTable({ columns, rows, initialSort, emptyText = '데이터가 없습니다.' }) {
  const [sort, setSort] = useState(initialSort || { key: columns[0].key, dir: 'asc' });

  const sorted = useMemo(() => {
    const col = columns.find((c) => c.key === sort.key);
    const val = (r) => (col?.sortValue ? col.sortValue(r) : r[sort.key]);
    return [...rows].sort((a, b) => {
      const x = val(a), y = val(b);
      if (x == null) return 1;
      if (y == null) return -1;
      const cmp = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y));
      return sort.dir === 'asc' ? cmp : -cmp;
    });
  }, [rows, sort, columns]);

  const toggle = (key) =>
    setSort((s) => ({ key, dir: s.key === key && s.dir === 'asc' ? 'desc' : 'asc' }));

  return (
    <div className="table-wrap" style={{ maxHeight: '64vh' }}>
      <table>
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} onClick={() => toggle(c.key)} style={{ textAlign: c.align || 'left' }}>
                {c.label}{sort.key === c.key ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : ''}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.length === 0 && (
            <tr><td colSpan={columns.length} className="center muted" style={{ padding: 30 }}>{emptyText}</td></tr>
          )}
          {sorted.map((r, i) => (
            <tr key={r.id || i}>
              {columns.map((c) => (
                <td key={c.key} style={{ textAlign: c.align || 'left' }}>
                  {c.render ? c.render(r) : r[c.key]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Standard "총 N개 …" result count, with an indicator when a filter is active. */
export function ResultCount({ total = 0, shown, label, filtered }) {
  return (
    <div className="muted result-count" style={{ marginBottom: 10 }}>
      총 <b style={{ color: 'var(--text)' }}>{total.toLocaleString()}</b>개 {label}
      {shown != null && shown < total && <span> (상위 {shown.toLocaleString()}개 표시)</span>}
      {filtered && <span className="badge blue" style={{ marginLeft: 8 }}>필터 적용 중</span>}
    </div>
  );
}

/** Simple centered modal. Click the backdrop or 닫기 to close. */
export function Modal({ title, onClose, children, width = 560 }) {
  return (
    <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal card" style={{ maxWidth: width }}>
        <div className="flex between" style={{ marginBottom: 12 }}>
          <b style={{ fontSize: 15 }}>{title}</b>
          <button className="logout-btn" onClick={onClose}>닫기</button>
        </div>
        {children}
      </div>
    </div>
  );
}

function DRow({ label, children }) {
  return (
    <div className="flex between" style={{ padding: '8px 0', borderBottom: '1px solid rgba(36,48,73,.4)', gap: 16 }}>
      <span className="muted">{label}</span>
      <span style={{ textAlign: 'right', wordBreak: 'break-all' }}>{children}</span>
    </div>
  );
}

const gb = (mb) => `${Math.round((mb || 0) / 1024).toLocaleString()} GB`;
const tb = (g) => (g >= 1024 ? `${(g / 1024).toFixed(1)} TB` : `${g} GB`);

/** Detail popup for a host / VM / datastore. */
export function EntityDetail({ type, item, onClose }) {
  const titles = { vm: 'VM', host: '호스트', datastore: '데이터스토어' };
  return (
    <Modal title={`${titles[type] || ''} 상세 — ${item.name}`} onClose={onClose} width={640}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 24px' }}>
        {type === 'vm' && (
          <>
            <DRow label="이름"><b>{item.name}</b></DRow>
            <DRow label="전원"><StateBadge state={item.powerState} /></DRow>
            <DRow label="vCenter">{item.vcenterId}</DRow>
            <DRow label="호스트">{item.host || '—'}</DRow>
            <DRow label="클러스터">{item.cluster || '—'}</DRow>
            <DRow label="Guest OS">{item.guestOS}</DRow>
            <DRow label="IP">{item.ipAddress || '—'}</DRow>
            <DRow label="VMware Tools"><StateBadge state={item.toolsStatus} /></DRow>
            <DRow label="vCPU">{item.cpuCount} 코어</DRow>
            <DRow label="RAM">{gb(item.memMB)}</DRow>
            <DRow label="디스크">{item.storageGB} GB</DRow>
            <DRow label="CPU 사용률"><UsageCell pct={item.cpuUsagePct} /></DRow>
            <DRow label="메모리 사용률"><UsageCell pct={item.memUsagePct} /></DRow>
          </>
        )}
        {type === 'host' && (
          <>
            <DRow label="이름"><b>{item.name}</b></DRow>
            <DRow label="상태"><StateBadge state={item.connectionState} /></DRow>
            <DRow label="vCenter">{item.vcenterId}</DRow>
            <DRow label="클러스터">{item.cluster || '—'}</DRow>
            <DRow label="CPU 코어">{item.cpuCores}</DRow>
            <DRow label="CPU 사용률"><UsageCell pct={item.cpuUsagePct} /></DRow>
            <DRow label="메모리">{gb(item.memTotalMB)}</DRow>
            <DRow label="메모리 사용률"><UsageCell pct={item.memUsagePct} /></DRow>
            {item.powerWatts > 0 && <DRow label="소비전력">{(item.powerWatts / 1000).toFixed(2)} kW ({item.powerWatts} W)</DRow>}
            <DRow label="VM 수">{item.vmCount}</DRow>
          </>
        )}
        {type === 'datastore' && (
          <>
            <DRow label="이름"><b>{item.name}</b></DRow>
            <DRow label="유형"><span className="badge blue">{item.type}</span></DRow>
            <DRow label="vCenter">{item.vcenterId}</DRow>
            <DRow label="총 용량">{tb(item.capacityGB)}</DRow>
            <DRow label="사용">{tb(item.usedGB)}</DRow>
            <DRow label="여유">{tb(item.freeGB)}</DRow>
            <DRow label="사용률"><UsageCell pct={item.usagePct} /></DRow>
          </>
        )}
      </div>
    </Modal>
  );
}

export function Loading() { return <div className="loading">불러오는 중…</div>; }
export function ErrorBox({ message }) { return <div className="error-box">오류: {message}</div>; }
