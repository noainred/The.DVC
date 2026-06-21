import React, { useMemo, useState, useEffect, useRef } from 'react';
import HostPowerPanel from './HostPowerPanel.jsx';
import { VmMetricButton } from './VmMetrics.jsx';
import { VmConsoleButton } from './VmConsole.jsx';
import { VmRemoteButton } from './VmRemote.jsx';
import EscClose from './EscClose.jsx';
import { fetchJson } from '../api.js';

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

/** Simple centered modal. Click the backdrop, press ESC, or 닫기 to close. */
export function Modal({ title, onClose, children, width = 560 }) {
  // Header stays pinned while the body scrolls, so long detail content (many
  // rows + action buttons) is always fully reachable by scrolling.
  return (
    <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <EscClose onClose={onClose} />
      <div className="modal card" style={{ maxWidth: width, maxHeight: '88vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div className="flex between" style={{ marginBottom: 12, flex: '0 0 auto' }}>
          <b style={{ fontSize: 15 }}>{title}</b>
          <button className="logout-btn" onClick={onClose}>닫기</button>
        </div>
        <div style={{ flex: '1 1 auto', minHeight: 0, overflowY: 'auto', overflowX: 'hidden', paddingRight: 4, marginRight: -4 }}>
          {children}
        </div>
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

// Backing-storage category badge for a datastore (로컬/SAN/NAS/vSAN/vVol).
const DS_KIND = { local: ['로컬 디스크', 'green'], san: ['SAN', 'blue'], nas: ['NAS', 'amber'], vsan: ['vSAN', 'purple'], vvol: ['vVol', 'amber'], other: ['기타', 'gray'] };
function dsStorageLabel(item) {
  const [label, cls] = DS_KIND[item.storageType] || DS_KIND.other;
  return <span className={`badge ${cls}`}>{label}{item.ssd ? ' · SSD' : ''}</span>;
}

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
            <DRow label={`IP${item.ipAddresses?.length > 1 ? ` (${item.ipAddresses.length})` : ''}`}>
              {(item.ipAddresses?.length ? item.ipAddresses : (item.ipAddress ? [item.ipAddress] : [])).map((ip, i) => <div key={i}>{ip}</div>)}
              {!(item.ipAddresses?.length || item.ipAddress) && '—'}
            </DRow>
            <DRow label="VMware Tools"><StateBadge state={item.toolsStatus} /></DRow>
            <DRow label="vCPU">{item.cpuCount} 코어</DRow>
            <DRow label="RAM">{gb(item.memMB)}</DRow>
            <DRow label="디스크">{item.storageGB} GB</DRow>
            <DRow label="CPU 사용률"><UsageCell pct={item.cpuUsagePct} /></DRow>
            <DRow label="메모리 사용률"><UsageCell pct={item.memUsagePct} /></DRow>
            <DRow label="Tools 버전">{item.toolsVersion || '—'}</DRow>
            <DRow label="스냅샷">{item.snapshotCount ? `${item.snapshotCount}개 · ${item.snapshotSizeGB || 0} GB` : '없음'}</DRow>
            <DRow label="태그">{item.tags?.length ? item.tags.map((t) => <span key={t} className="badge blue" style={{ marginLeft: 4 }}>{t}</span>) : '—'}</DRow>
            <DRow label="메모">{item.notes || '—'}</DRow>
          </>
        )}
        {type === 'host' && (
          <>
            <DRow label="이름"><b>{item.name}</b></DRow>
            <DRow label="상태"><StateBadge state={item.connectionState} /></DRow>
            <DRow label="vCenter">{item.vcenterId}</DRow>
            <DRow label="클러스터">{item.cluster || '—'}</DRow>
            <DRow label="전원">{item.powerState === 'POWERED_ON' ? 'On' : (item.powerState ? 'Off' : '—')}</DRow>
            <DRow label="제조사 / 모델">{[item.vendor, item.model].filter(Boolean).join(' / ') || '—'}</DRow>
            <DRow label="ESXi 버전">{item.version ? `${item.version}${item.build ? ` (build ${item.build})` : ''}` : '—'}</DRow>
            <DRow label="CPU">{item.cpuCores}코어{item.cpuThreads ? ` / ${item.cpuThreads}스레드` : ''}{item.cpuTotalMhz ? ` · ${(item.cpuTotalMhz / 1000).toFixed(1)}GHz` : ''}</DRow>
            <DRow label="CPU 사용률"><UsageCell pct={item.cpuUsagePct} /></DRow>
            <DRow label="메모리">{gb(item.memTotalMB)}{item.memUsageMB ? ` · 사용 ${gb(item.memUsageMB)}` : ''}</DRow>
            <DRow label="메모리 사용률"><UsageCell pct={item.memUsagePct} /></DRow>
            {item.powerWatts > 0 && <DRow label="소비전력">{(item.powerWatts / 1000).toFixed(2)} kW ({item.powerWatts} W){item.powerSource === 'idrac' ? ' · iDRAC' : ''}</DRow>}
            <DRow label="VM 수">{item.vmCount}</DRow>
            <DRow label="HBA / GPU">{(item.hbas?.length || 0)}개 / {(item.gpus?.length || 0)}개</DRow>
          </>
        )}
        {type === 'datastore' && (
          <>
            <DRow label="이름"><b>{item.name}</b></DRow>
            <DRow label="스토리지">{dsStorageLabel(item)}</DRow>
            <DRow label="유형"><span className="badge blue">{item.type}</span></DRow>
            {item.remoteHost && <DRow label="원격 호스트">{item.remoteHost}</DRow>}
            <DRow label="vCenter">{item.vcenterId}</DRow>
            <DRow label="총 용량">{tb(item.capacityGB)}</DRow>
            <DRow label="사용">{tb(item.usedGB)}</DRow>
            <DRow label="여유">{tb(item.freeGB)}</DRow>
            <DRow label="사용률"><UsageCell pct={item.usagePct} /></DRow>
          </>
        )}
      </div>
      {type === 'host' && item.hbas?.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>스토리지 어댑터 (HBA) — {item.hbas.length}</div>
          <div className="table-wrap" style={{ maxHeight: '28vh' }}>
            <table>
              <thead><tr><th>어댑터</th><th>유형</th><th>모델</th><th style={{ textAlign: 'right' }}>속도</th><th>WWN</th></tr></thead>
              <tbody>
                {item.hbas.map((h, i) => (
                  <tr key={i}>
                    <td><b>{h.name || '—'}</b></td>
                    <td><span className="badge blue">{h.type}</span></td>
                    <td className="muted" style={{ fontSize: 12 }}>{h.model || '—'}</td>
                    <td style={{ textAlign: 'right' }}>{h.speedGbps ? `${h.speedGbps} Gb` : '—'}</td>
                    <td className="muted" style={{ fontSize: 11 }}>{h.wwn || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {type === 'host' && item.gpus?.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>GPU — {item.gpus.length}</div>
          <div className="flex gap wrap">
            {item.gpus.map((g, i) => <span key={i} className="badge gray" style={{ fontSize: 12 }}>{g.model}{g.memGB ? ` · ${g.memGB}GB` : ''}{g.vgpuMode ? ' · vGPU' : ''}</span>)}
          </div>
        </div>
      )}
      {type === 'host' && <HostPowerPanel hostName={item.name} />}
      {type === 'vm' && (
        <div className="flex gap" style={{ marginTop: 14, justifyContent: 'flex-end' }}>
          <VmConsoleButton vmId={item.id} vmName={item.name} />
          <VmRemoteButton item={item} />
          <VmMetricButton vmId={item.id} vmName={item.name} />
        </div>
      )}
    </Modal>
  );
}

/**
 * 어디서나 VM 이름/IP/호스트명을 클릭하면 VM 상세(EntityDetail) 팝업을 띄우는 공용 링크.
 * 스냅샷에서 단건 조회(/vms/lookup) 후 모달을 연다. 못 찾으면 안내 모달.
 */
export function VmLink({ name, ip, vcenterId, label, className = 'cell-link', style }) {
  const [vm, setVm] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const open = async (e) => {
    e?.stopPropagation?.();
    setBusy(true); setMsg(null);
    try {
      const params = {};
      if (name) params.name = name;
      if (ip) params.ip = ip;
      if (vcenterId) params.vcenterId = vcenterId;
      const r = await fetchJson('/vms/lookup', params);
      if (r.vm) setVm(r.vm); else setMsg(`해당 VM을 찾을 수 없습니다 (${label || name || ip}).`);
    } catch (err) { setMsg(err.message); }
    finally { setBusy(false); }
  };
  return (
    <>
      <button className={className} style={style} disabled={busy} onClick={open} title="클릭하면 VM 상세 보기">{label ?? name ?? ip}</button>
      {vm && <EntityDetail type="vm" item={vm} onClose={() => setVm(null)} />}
      {msg && <Modal title="VM 조회" onClose={() => setMsg(null)} width={380}><div className="muted" style={{ padding: 4 }}>{msg}</div></Modal>}
    </>
  );
}

/**
 * IME(한글) 안전 검색 입력. Controlled 입력이 매 키 입력마다 부모를 리렌더하면
 * 한글 조합이 끊기므로, 로컬 상태로 표시하고 조합 중에는 부모로 onChange를 보내지
 * 않는다(조합 종료/비조합 입력 시에만 전파). 외부 값 변경(탭 전환·초기화)은 조합 중이
 * 아닐 때만 로컬에 반영한다.
 */
export function SearchBox({ value = '', onChange, placeholder, className = 'input', style, onKeyDown }) {
  const [local, setLocal] = useState(value);
  const composing = useRef(false);
  useEffect(() => { if (!composing.current) setLocal(value); }, [value]);
  return (
    <input
      className={className}
      style={style}
      placeholder={placeholder}
      value={local}
      onChange={(e) => { setLocal(e.target.value); if (!composing.current) onChange(e.target.value); }}
      onCompositionStart={() => { composing.current = true; }}
      onCompositionEnd={(e) => { composing.current = false; onChange(e.target.value); }}
      onKeyDown={onKeyDown}
    />
  );
}

export function Loading() { return <div className="loading">불러오는 중…</div>; }
export function ErrorBox({ message }) { return <div className="error-box">오류: {message}</div>; }
