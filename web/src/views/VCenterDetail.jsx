import React, { useMemo, useState } from 'react';
import { usePolling } from '../api.js';
import { Loading, ErrorBox, StateBadge, UsageCell, EntityDetail, DataTable, SearchBox } from '../components/ui.jsx';

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
        <div className="flex gap" style={{ fontSize: 12 }}>
          <span className="muted">호스트 <b style={{ color: 'var(--text)' }}>{m.hosts ?? hosts.length}</b></span>
          <span className="muted">VM <b style={{ color: 'var(--text)' }}>{m.vms ?? vms.length}</b></span>
          <span className="muted">CPU <b style={{ color: 'var(--text)' }}>{m.cpuUsagePct ?? 0}%</b></span>
          <span className="muted">메모리 <b style={{ color: 'var(--text)' }}>{m.memUsagePct ?? 0}%</b></span>
        </div>
      </div>

      <div className="vcd-views">
        {VIEWS.map((v) => (
          <button key={v.k} className={view === v.k ? 'login-btn' : 'tab'} style={{ flex: 'none', padding: '7px 13px' }} onClick={() => setView(v.k)}>
            {v.icon} {v.label}
          </button>
        ))}
      </div>

      {(view === 'hosts' || view === 'vms') && (
        <div className="flex gap" style={{ alignItems: 'center', margin: '10px 0' }}>
          <SearchBox value={q} onChange={setQ} placeholder="🔍 VM 이름 검색 (한 글자만 입력해도 포함된 VM 표시)"
            style={{ flex: 1, maxWidth: 420 }} />
          {query && <span className="muted" style={{ fontSize: 12 }}>{matches.length}개 일치{matches.length > SEARCH_CAP ? ` (처음 ${SEARCH_CAP}개 표시)` : ''}</span>}
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
        {(view === 'hosts' || view === 'vms') && query && (
          <Node label="🔍 검색 결과" defaultOpen sub={`${matches.length} VM`}>
            {matches.length === 0
              ? <div className="vcd-node vcd-leaf"><span className="vcd-caret" /><span className="muted">일치하는 VM이 없습니다</span></div>
              : matches.slice(0, SEARCH_CAP).map((vm) => (
                <Leaf key={vm.id} icon="🧊" onClick={() => setSel({ type: 'vm', item: vm })}
                  label={<Highlight text={vm.name} q={query} />} badge={<StateBadge state={vm.powerState} />}
                  sub={`🧩 ${vm.cluster || '—'} · 🖥️ ${vm.host || '—'} · 📁 ${vm.folder || 'vm'}`} />
              ))}
          </Node>
        )}

        {view === 'hosts' && !query && (
          <Node label={`🗄️ ${site.name}`} defaultOpen sub={`${hosts.length} 호스트`}>
            {clusters.map(([cl, chosts]) => (
              <Tree key={cl} k={`cl:${cl}`} open={open} toggle={toggle} icon="🧩" label={cl} sub={`${chosts.length} 호스트`}>
                {chosts.map((h) => (
                  <Tree key={h.id} k={`h:${h.id}`} open={open} toggle={toggle} icon="🖥️"
                    label={<span className="vcd-link" onClick={(e) => { e.stopPropagation(); setSel({ type: 'host', item: h }); }}>{h.name}</span>}
                    sub={<><StateBadge state={h.connectionState} /> <span className="muted">CPU {h.cpuUsagePct}% · MEM {h.memUsagePct}% · VM {h.vmCount}</span></>}>
                    {(vmsByHost.get(h.name) || []).map((vm) => (
                      <Leaf key={vm.id} icon="🧊" onClick={() => setSel({ type: 'vm', item: vm })}
                        label={vm.name} badge={<StateBadge state={vm.powerState} />}
                        sub={`${vm.guestOS} · ${vm.cpuCount}vCPU · ${Math.round(vm.memMB / 1024)}GB`} />
                    ))}
                  </Tree>
                ))}
              </Tree>
            ))}
          </Node>
        )}

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
