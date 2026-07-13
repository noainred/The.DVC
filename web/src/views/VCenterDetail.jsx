import React, { useMemo, useState } from 'react';
import { usePolling } from '../api.js';
import { Loading, ErrorBox, StateBadge, UsageCell, EntityDetail, DataTable, SearchBox } from '../components/ui.jsx';
import EscClose from '../components/EscClose.jsx';

const VIEWS = [
  { k: 'hosts', label: '호스트 및 클러스터', icon: '🖥️' },
  { k: 'vms', label: 'VM 및 폴더', icon: '🧊' },
  { k: 'storage', label: '데이터스토어', icon: '💾' },
  { k: 'network', label: '네트워크', icon: '🌐' },
];

// Backing-storage categories for the datastore view filter.
const STORAGE_KINDS = [
  { k: '', label: '전체', icon: '💾' },
  { k: 'local', label: '로컬 디스크', icon: '🟢' },
  { k: 'san', label: 'SAN', icon: '🔵' },
  { k: 'nas', label: 'NAS', icon: '🟡' },
  { k: 'vsan', label: 'vSAN', icon: '🟣' },
  { k: 'vvol', label: 'vVol', icon: '🟠' },
  { k: 'other', label: '기타', icon: '⚪' },
];
const STORAGE_LABEL = Object.fromEntries(STORAGE_KINDS.map((s) => [s.k, s.label]));
const STORAGE_BADGE = { local: 'green', san: 'blue', nas: 'amber', vsan: 'purple', vvol: 'amber', other: 'gray' };

/** vSphere-client-like inventory view for a single vCenter. */
export default function VCenterDetail({ site, onBack }) {
  const vcenterId = site.id;
  const [view, setView] = useState('hosts');
  const [sel, setSel] = useState(null);     // { type, item } for the detail popup
  const [open, setOpen] = useState({});      // expanded tree nodes
  const [q, setQ] = useState('');            // VM name search (hosts/vms views)
  const [dsKind, setDsKind] = useState('');  // datastore storage filter
  const [comparing, setComparing] = useState(false); // vCenter 2개 비교 모드
  const toggle = (k) => setOpen((o) => ({ ...o, [k]: !o[k] }));

  const { data: hostsD } = usePolling('/hosts', { vcenterId }, 20_000);
  const { data: vmsD } = usePolling('/vms', { vcenterId, limit: 5000 }, 20_000);
  const { data: dsD } = usePolling('/datastores', { vcenterId }, 30_000);
  const { data: netD } = usePolling('/networks', { vcenterId }, 30_000);

  const hosts = hostsD?.items || [];
  const vms = vmsD?.items || [];
  const datastores = dsD?.items || [];
  const networks = netD?.items || [];
  const m = site.metrics || {};

  // cluster -> hosts ; host -> vms
  const clusters = useMemo(() => {
    const map = new Map();
    for (const h of hosts) {
      const c = h.cluster || 'standalone';
      if (!map.has(c)) map.set(c, []);
      map.get(c).push(h);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [hosts]);
  const vmsByHost = useMemo(() => {
    const map = new Map();
    for (const v of vms) { const k = v.host || ''; if (!map.has(k)) map.set(k, []); map.get(k).push(v); }
    return map;
  }, [vms]);
  // 호스트별 할당 vCPU 합계(가상화율 = 할당 vCPU ÷ 물리 코어). VM은 host=호스트명으로 매핑.
  const vcpuByHost = useMemo(() => {
    const map = new Map();
    for (const v of vms) { const k = v.host || ''; map.set(k, (map.get(k) || 0) + (Number(v.cpuCount) || 0)); }
    return map;
  }, [vms]);
  // 호스트 묶음(클러스터·DC)의 할당 vCPU·물리 코어 합계.
  const virtSum = (list) => {
    let alloc = 0, cores = 0, vmc = 0;
    for (const h of list) { alloc += vcpuByHost.get(h.name) || 0; cores += Number(h.cpuCores) || 0; vmc += Number(h.vmCount) || 0; }
    return { alloc, cores, vmc };
  };

  // folder path -> vms (vSphere "VMs and Templates")
  const folderTree = useMemo(() => buildFolderTree(vms), [vms]);

  // VM name search — substring (case-insensitive), so a single character matches
  // every VM containing it. Capped so a broad query stays responsive.
  const SEARCH_CAP = 500;
  const query = q.trim().toLowerCase();
  const matches = useMemo(() => {
    if (!query) return [];
    return vms.filter((v) => (v.name || '').toLowerCase().includes(query));
  }, [vms, query]);
  // '호스트 및 클러스터' 탭 검색은 호스트 이름도 매칭한다(예: '26' → leshesxpma26). VM만 되던 버그 수정.
  const hostMatches = useMemo(() => {
    if (!query) return [];
    return hosts.filter((h) => (h.name || '').toLowerCase().includes(query));
  }, [hosts, query]);

  // Datastore storage-type filter + per-kind counts.
  const dsCounts = useMemo(() => {
    const c = {};
    for (const d of datastores) c[d.storageType || 'other'] = (c[d.storageType || 'other'] || 0) + 1;
    return c;
  }, [datastores]);
  const dsRows = dsKind ? datastores.filter((d) => (d.storageType || 'other') === dsKind) : datastores;

  return (
    <div className="vcd">
      <div className="flex between wrap" style={{ marginBottom: 12, alignItems: 'center' }}>
        <div className="flex gap" style={{ alignItems: 'center' }}>
          <button className="tab" onClick={onBack}>← 목록</button>
          <div>
            <div className="section-title" style={{ margin: 0 }}>🗄️ {site.name}</div>
            <div className="muted" style={{ fontSize: 12 }}>{site.location?.city}, {site.location?.country} · v{site.version || '—'} · {vcenterId}</div>
          </div>
          <StateBadge state={site.status} />
        </div>
        <div className="flex gap" style={{ fontSize: 12, alignItems: 'center' }}>
          <span className="muted">호스트 <b style={{ color: 'var(--text)' }}>{m.hosts ?? hosts.length}</b></span>
          <span className="muted">VM <b style={{ color: 'var(--text)' }}>{m.vms ?? vms.length}</b></span>
          <span className="muted">CPU <b style={{ color: 'var(--text)' }}>{m.cpuUsagePct ?? 0}%</b></span>
          <span className="muted">메모리 <b style={{ color: 'var(--text)' }}>{m.memUsagePct ?? 0}%</b></span>
          <button className="login-btn" style={{ flex: 'none', padding: '6px 14px', marginLeft: 6 }} onClick={() => setComparing(true)}>⇄ 비교하기</button>
        </div>
      </div>

      {comparing && <VCenterCompare site={site} onClose={() => setComparing(false)} />}

      <div className="vcd-views">
        {VIEWS.map((v) => (
          <button key={v.k} className={view === v.k ? 'login-btn' : 'tab'} style={{ flex: 'none', padding: '7px 13px' }} onClick={() => setView(v.k)}>
            {v.icon} {v.label}
          </button>
        ))}
      </div>

      {(view === 'hosts' || view === 'vms') && (
        <div className="flex gap" style={{ alignItems: 'center', margin: '10px 0' }}>
          <SearchBox value={q} onChange={setQ} placeholder={view === 'hosts' ? '🔍 호스트·VM 이름 검색 (한 글자만 입력해도 포함 표시)' : '🔍 VM 이름 검색 (한 글자만 입력해도 포함된 VM 표시)'}
            style={{ flex: 1, maxWidth: 420 }} />
          {query && <span className="muted" style={{ fontSize: 12 }}>{view === 'hosts' && hostMatches.length ? `호스트 ${hostMatches.length} · ` : ''}{matches.length} VM 일치{matches.length > SEARCH_CAP ? ` (처음 ${SEARCH_CAP}개 표시)` : ''}</span>}
          {q && <button className="tab" style={{ flex: 'none', padding: '6px 10px' }} onClick={() => setQ('')}>지우기</button>}
        </div>
      )}

      {view === 'storage' && (
        <div className="flex gap wrap" style={{ alignItems: 'center', margin: '10px 0' }}>
          {STORAGE_KINDS.map((s) => {
            const n = s.k ? (dsCounts[s.k] || 0) : datastores.length;
            return (
              <button key={s.k || 'all'} className={dsKind === s.k ? 'login-btn' : 'tab'}
                style={{ flex: 'none', padding: '6px 11px' }} onClick={() => setDsKind(s.k)}>
                {s.icon} {s.label} <b style={{ opacity: 0.7 }}>{n}</b>
              </button>
            );
          })}
        </div>
      )}

      <div className="vcd-tree card">
        {(view === 'hosts' || view === 'vms') && query && (() => {
          const hm = view === 'hosts' ? hostMatches : [];
          const empty = hm.length === 0 && matches.length === 0;
          return (
            <Node label="🔍 검색 결과" defaultOpen sub={view === 'hosts' ? `${hm.length} 호스트 · ${matches.length} VM` : `${matches.length} VM`}>
              {empty && <div className="vcd-node vcd-leaf"><span className="vcd-caret" /><span className="muted">일치하는 항목이 없습니다</span></div>}
              {hm.slice(0, SEARCH_CAP).map((h) => (
                <Leaf key={`h:${h.id}`} icon="🖥️" onClick={() => setSel({ type: 'host', item: h })}
                  label={<Highlight text={h.name} q={query} />} badge={<StateBadge state={h.connectionState} />}
                  sub={`🧩 ${h.cluster || 'standalone'} · CPU ${h.cpuUsagePct ?? '-'}% · MEM ${h.memUsagePct ?? '-'}% · VM ${h.vmCount ?? '-'}`} />
              ))}
              {matches.slice(0, SEARCH_CAP).map((vm) => (
                <Leaf key={vm.id} icon="🧊" onClick={() => setSel({ type: 'vm', item: vm })}
                  label={<Highlight text={vm.name} q={query} />} badge={<StateBadge state={vm.powerState} />}
                  sub={`🧩 ${vm.cluster || '—'} · 🖥️ ${vm.host || '—'} · 📁 ${vm.folder || 'vm'}`} />
              ))}
            </Node>
          );
        })()}

        {view === 'hosts' && !query && (() => { const dc = virtSum(hosts); return (
          <Node label={`🗄️ ${site.name}`} defaultOpen
            sub={<UsageBars lead={<span className="muted">{hosts.length} 호스트</span>} cpu={m.cpuUsagePct} mem={m.memUsagePct}
              tail={<VirtBadge alloc={dc.alloc} cores={dc.cores} />} />}>
            {clusters.map(([cl, chosts]) => {
              const n = chosts.length || 1;
              const avgCpu = Math.round(chosts.reduce((a, h) => a + (h.cpuUsagePct || 0), 0) / n);
              const avgMem = Math.round(chosts.reduce((a, h) => a + (h.memUsagePct || 0), 0) / n);
              const cv = virtSum(chosts);
              return (
              <Tree key={cl} k={`cl:${cl}`} open={open} toggle={toggle} icon="🧩" label={cl}
                sub={<UsageBars lead={<span className="muted">{chosts.length} 호스트</span>} cpu={avgCpu} mem={avgMem}
                  tail={<VirtBadge alloc={cv.alloc} cores={cv.cores} />} />}>
                {chosts.map((h) => (
                  <Tree key={h.id} k={`h:${h.id}`} open={open} toggle={toggle} icon="🖥️"
                    label={<span className="vcd-link" onClick={(e) => { e.stopPropagation(); setSel({ type: 'host', item: h }); }}>{h.name}</span>}
                    sub={<UsageBars lead={<StateBadge state={h.connectionState} />} cpu={h.cpuUsagePct} mem={h.memUsagePct} tail={<span className="muted" style={{ fontSize: 12, display: 'inline-flex', gap: 10, alignItems: 'center' }}><span>VM {h.vmCount}</span><VirtBadge alloc={vcpuByHost.get(h.name) || 0} cores={h.cpuCores} /></span>} />}>
                    {(vmsByHost.get(h.name) || []).map((vm) => (
                      <Leaf key={vm.id} icon="🧊" onClick={() => setSel({ type: 'vm', item: vm })}
                        label={vm.name} badge={<StateBadge state={vm.powerState} />}
                        sub={`${vm.guestOS} · ${vm.cpuCount}vCPU · ${Math.round(vm.memMB / 1024)}GB`} />
                    ))}
                  </Tree>
                ))}
              </Tree>
              );
            })}
          </Node>
          ); })()}

        {view === 'vms' && !query && (
          <Node label={`📁 ${site.name} / vm`} defaultOpen sub={`${vms.length} VM`}>
            <FolderNodes node={folderTree} path="" open={open} toggle={toggle} onSelect={(vm) => setSel({ type: 'vm', item: vm })} />
          </Node>
        )}

        {view === 'storage' && (
          <DataTable
            columns={[
              { key: 'name', label: '데이터스토어', render: (d) => <button className="cell-link" onClick={() => setSel({ type: 'datastore', item: d })}>💾 {d.name}</button> },
              { key: 'storageType', label: '스토리지', render: (d) => (
                <span className={`badge ${STORAGE_BADGE[d.storageType] || 'gray'}`}>
                  {STORAGE_LABEL[d.storageType] || '기타'}{d.ssd ? ' · SSD' : ''}{d.remoteHost ? ` · ${d.remoteHost}` : ''}
                </span>
              ) },
              { key: 'type', label: '유형', render: (d) => <span className="badge blue">{d.type}</span> },
              { key: 'capacityGB', label: '용량', align: 'right', render: (d) => tb(d.capacityGB) },
              { key: 'usedGB', label: '사용', align: 'right', render: (d) => tb(d.usedGB) },
              { key: 'usagePct', label: '사용률', render: (d) => <UsageCell pct={d.usagePct} /> },
            ]}
            rows={dsRows} initialSort={{ key: 'usagePct', dir: 'desc' }}
            emptyText={dsKind ? `${STORAGE_LABEL[dsKind]} 데이터스토어 없음` : '데이터스토어 없음'} />
        )}

        {view === 'network' && (
          <DataTable
            columns={[
              { key: 'name', label: '네트워크', render: (n) => <b>🌐 {n.name}</b> },
              { key: 'type', label: '유형', render: (n) => <span className="badge gray">{n.type}</span> },
              { key: 'hostCount', label: '호스트', align: 'right', render: (n) => n.hostCount ?? '—' },
            ]}
            rows={networks} initialSort={{ key: 'name', dir: 'asc' }} emptyText="네트워크 없음" />
        )}
      </div>

      {sel && <EntityDetail type={sel.type} item={sel.item} onClose={() => setSel(null)} />}
    </div>
  );
}

/* ---- tree primitives ---- */
function Node({ label, sub, children, defaultOpen }) {
  const [o, setO] = useState(defaultOpen);
  return (
    <div>
      <div className="vcd-node vcd-root" onClick={() => setO((v) => !v)}>
        <span className="vcd-caret">{o ? '▾' : '▸'}</span><b>{label}</b>{sub && <span className="muted vcd-sub">{sub}</span>}
      </div>
      {o && <div className="vcd-children">{children}</div>}
    </div>
  );
}
function Tree({ k, open, toggle, icon, label, sub, children }) {
  const o = open[k];
  const hasKids = React.Children.count(children) > 0;
  return (
    <div>
      <div className="vcd-node" onClick={() => toggle(k)}>
        <span className="vcd-caret">{hasKids ? (o ? '▾' : '▸') : ''}</span>
        <span>{icon}</span> <span className="vcd-nlabel">{label}</span> {sub && <span className="vcd-sub">{sub}</span>}
      </div>
      {o && hasKids && <div className="vcd-children">{children}</div>}
    </div>
  );
}
function Leaf({ icon, label, sub, badge, onClick }) {
  return (
    <div className="vcd-node vcd-leaf" onClick={onClick}>
      <span className="vcd-caret" /><span>{icon}</span> <span className="vcd-link">{label}</span> {badge} {sub && <span className="vcd-sub">{sub}</span>}
    </div>
  );
}

// 사용률 색상 임계값(승인): 초록 <60% · 주황 60~85% · 빨강 ≥85%.
const usageColor = (p) => (p >= 85 ? 'var(--red)' : p >= 60 ? 'var(--amber)' : 'var(--green)');

// 한 지표(CPU/MEM)의 인라인 미니 바 + 수치. 트리 한 줄에 들어가도록 inline-flex.
function MiniBar({ label, pct }) {
  const p = Math.max(0, Math.min(100, Math.round(Number(pct) || 0)));
  const c = usageColor(p);
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, verticalAlign: 'middle' }} title={`${label} ${p}%`}>
      <span className="muted" style={{ fontSize: 11 }}>{label}</span>
      <span style={{ display: 'inline-block', position: 'relative', width: 92, height: 7, borderRadius: 5, background: 'rgba(148,163,184,.15)', overflow: 'hidden', verticalAlign: 'middle' }}>
        <span style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${p}%`, background: c, borderRadius: 5 }} />
      </span>
      <b style={{ fontSize: 12, color: c, minWidth: 34, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{p}%</b>
    </span>
  );
}

// 가상화율(할당 vCPU : 물리 코어) 배지 — 과커밋 수준에 따라 색상. 물리코어/할당이 없으면 미표시.
function VirtBadge({ alloc, cores }) {
  if (!cores || !alloc) return null;
  const r = alloc / cores;
  const color = r >= 4 ? '#ef4444' : r >= 2.5 ? '#f59e0b' : '#22c55e'; // >4:1 위험 · 2.5~4 주의 · 이하 정상
  const txt = (Math.round(r * 10) / 10).toFixed(1);
  return (
    <span className="muted" style={{ fontSize: 12 }} title={`가상화율 = 할당 vCPU ${alloc} ÷ 물리 코어 ${cores} = ${txt}:1`}>
      가상화 <b style={{ color, fontVariantNumeric: 'tabular-nums' }}>{txt}:1</b>
    </span>
  );
}

// 호스트/클러스터/vCenter 행의 CPU·MEM 1줄 차트. lead=앞 배지/텍스트, tail=뒤 텍스트(VM 수 등).
function UsageBars({ cpu, mem, lead, tail }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
      {lead}
      <MiniBar label="CPU" pct={cpu} />
      <MiniBar label="MEM" pct={mem} />
      {tail}
    </span>
  );
}

// Highlight the matched substring inside a VM name.
function Highlight({ text, q }) {
  const s = String(text || '');
  if (!q) return <>{s}</>;
  const i = s.toLowerCase().indexOf(q);
  if (i < 0) return <>{s}</>;
  return (
    <>{s.slice(0, i)}<mark style={{ background: 'rgba(245,158,11,.35)', color: 'inherit', padding: 0 }}>{s.slice(i, i + q.length)}</mark>{s.slice(i + q.length)}</>
  );
}

function FolderNodes({ node, path, open, toggle, onSelect }) {
  const childFolders = Object.keys(node.folders).sort();
  return (
    <>
      {childFolders.map((name) => {
        const key = `f:${path}/${name}`;
        const f = node.folders[name];
        return (
          <Tree key={key} k={key} open={open} toggle={toggle} icon="📁" label={name} sub={`${f.count} VM`}>
            <FolderNodes node={f} path={`${path}/${name}`} open={open} toggle={toggle} onSelect={onSelect} />
            {f.vms.map((vm) => (
              <Leaf key={vm.id} icon="🧊" onClick={() => onSelect(vm)} label={vm.name} badge={<StateBadge state={vm.powerState} />}
                sub={`${vm.guestOS} · ${vm.cpuCount}vCPU · ${Math.round(vm.memMB / 1024)}GB`} />
            ))}
          </Tree>
        );
      })}
    </>
  );
}

function buildFolderTree(vms) {
  const root = { folders: {}, vms: [], count: 0 };
  for (const vm of vms) {
    const parts = String(vm.folder || 'vm').split('/').filter((p) => p && p !== 'vm');
    let node = root; root.count++;
    for (const part of parts) {
      if (!node.folders[part]) node.folders[part] = { folders: {}, vms: [], count: 0 };
      node = node.folders[part];
      node.count++;
    }
    node.vms.push(vm);
  }
  return root;
}

const tb = (gb) => (gb >= 1024 ? `${(gb / 1024).toFixed(1)} TB` : `${gb} GB`);

/* ---- vCenter 2개 비교 ---- */
// 비교 지표 정의. higher: 'bad'=높을수록 나쁨(사용률), 'neutral'=단순 규모, 'good'=높을수록 좋음.
const CMP_METRICS = [
  { key: 'hosts', label: '호스트', higher: 'neutral' },
  { key: 'vms', label: 'VM', higher: 'neutral' },
  { key: 'vmsPoweredOn', label: 'VM(On)', higher: 'neutral' },
  { key: 'cpuUsagePct', label: 'CPU 사용률', unit: '%', higher: 'bad' },
  { key: 'memUsagePct', label: '메모리 사용률', unit: '%', higher: 'bad' },
  { key: 'storageUsagePct', label: '스토리지 사용률', unit: '%', higher: 'bad' },
  { key: 'storageTotalTB', label: '스토리지 총량', unit: ' TB', higher: 'neutral' },
  { key: 'alarmsCritical', label: '심각 알람', higher: 'bad' },
  { key: 'alarmsWarning', label: '경고 알람', higher: 'bad' },
  { key: 'powerKw', label: '소비전력', unit: ' kW', higher: 'neutral' },
];

function VCenterCompare({ site, onClose }) {
  const { data } = usePolling('/vcenters', {}, 30_000);
  const sites = (data || []).filter((s) => s.id !== site.id);
  const [otherId, setOtherId] = useState('');
  const other = sites.find((s) => s.id === otherId);
  const A = site.metrics || {};
  const B = other?.metrics || {};
  const num = (v) => (typeof v === 'number' ? v : 0);
  const fmt = (v, u) => (v == null ? '—' : `${typeof v === 'number' ? v.toLocaleString() : v}${u || ''}`);
  // 더 나은 쪽 색: bad 지표는 낮은 값이 초록, neutral은 강조만.
  const colorFor = (metric, a, b, side) => {
    if (metric.higher === 'neutral' || a === b) return undefined;
    const aWins = metric.higher === 'bad' ? a < b : a > b;
    const isWinner = side === 'A' ? aWins : !aWins;
    return isWinner ? 'var(--green)' : 'var(--amber)';
  };
  return (
    <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <EscClose onClose={onClose} />
      <div className="modal card" style={{ maxWidth: 720, width: '94vw' }}>
        <div className="flex between" style={{ marginBottom: 12, alignItems: 'center' }}>
          <b style={{ fontSize: 15 }}>⇄ vCenter 비교</b>
          <button className="logout-btn" onClick={onClose}>닫기</button>
        </div>
        <div className="flex gap" style={{ alignItems: 'center', marginBottom: 14 }}>
          <div className="card" style={{ padding: '8px 14px', flex: 1, borderColor: 'var(--accent)' }}>
            <div style={{ fontWeight: 700 }}>{site.name}</div>
            <div className="muted" style={{ fontSize: 12 }}>{site.location?.country || ''} · v{site.version || '—'}</div>
          </div>
          <span style={{ fontSize: 20 }} className="muted">⇄</span>
          <div className="card" style={{ padding: '8px 14px', flex: 1 }}>
            <select className="select" value={otherId} onChange={(e) => setOtherId(e.target.value)} style={{ width: '100%' }}>
              <option value="">비교할 vCenter 선택…</option>
              {sites.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.id})</option>)}
            </select>
            {other && <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>{other.location?.country || ''} · v{other.version || '—'} · <StateBadge state={other.status} /></div>}
          </div>
        </div>
        {!other ? (
          <div className="muted" style={{ fontSize: 13, padding: 12 }}>오른쪽에서 비교할 vCenter를 선택하세요.</div>
        ) : (
          <table className="data-table" style={{ width: '100%', fontSize: 13 }}>
            <thead><tr><th style={{ textAlign: 'left' }}>지표</th><th style={{ textAlign: 'right' }}>{site.name}</th><th style={{ textAlign: 'right' }}>{other.name}</th><th style={{ textAlign: 'right' }}>차이</th></tr></thead>
            <tbody>
              {CMP_METRICS.map((mt) => {
                const a = num(A[mt.key]); const b = num(B[mt.key]);
                const diff = Math.round((a - b) * 10) / 10;
                return (
                  <tr key={mt.key}>
                    <td>{mt.label}</td>
                    <td style={{ textAlign: 'right', color: colorFor(mt, a, b, 'A'), fontWeight: 600 }}>{fmt(A[mt.key] ?? 0, mt.unit)}</td>
                    <td style={{ textAlign: 'right', color: colorFor(mt, a, b, 'B'), fontWeight: 600 }}>{fmt(B[mt.key] ?? 0, mt.unit)}</td>
                    <td style={{ textAlign: 'right' }} className="muted">{diff === 0 ? '=' : `${diff > 0 ? '+' : ''}${diff}${mt.unit || ''}`}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        <div className="muted" style={{ fontSize: 11, marginTop: 10 }}>초록=더 양호(사용률·알람이 낮은 쪽), 주황=상대적으로 높음. 규모 지표(호스트/VM/용량)는 색 없이 차이만 표시.</div>
      </div>
    </div>
  );
}
