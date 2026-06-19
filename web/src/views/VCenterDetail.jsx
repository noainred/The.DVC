import React, { useMemo, useState } from 'react';
import { usePolling } from '../api.js';
import { Loading, ErrorBox, StateBadge, UsageCell, EntityDetail } from '../components/ui.jsx';

const VIEWS = [
  { k: 'hosts', label: '호스트 및 클러스터', icon: '🖥️' },
  { k: 'vms', label: 'VM 및 폴더', icon: '🧊' },
  { k: 'storage', label: '데이터스토어', icon: '💾' },
  { k: 'network', label: '네트워크', icon: '🌐' },
];

/** vSphere-client-like inventory view for a single vCenter. */
export default function VCenterDetail({ site, onBack }) {
  const vcenterId = site.id;
  const [view, setView] = useState('hosts');
  const [sel, setSel] = useState(null);     // { type, item } for the detail popup
  const [open, setOpen] = useState({});      // expanded tree nodes
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

      <div className="vcd-tree card">
        {view === 'hosts' && (
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

        {view === 'vms' && (
          <Node label={`📁 ${site.name} / vm`} defaultOpen sub={`${vms.length} VM`}>
            <FolderNodes node={folderTree} path="" open={open} toggle={toggle} onSelect={(vm) => setSel({ type: 'vm', item: vm })} />
          </Node>
        )}

        {view === 'storage' && (
          <div className="table-wrap">
            <table>
              <thead><tr><th>데이터스토어</th><th>유형</th><th className="right">용량</th><th className="right">사용</th><th>사용률</th></tr></thead>
              <tbody>
                {datastores.map((d) => (
                  <tr key={d.id} className="vcd-row" onClick={() => setSel({ type: 'datastore', item: d })}>
                    <td><b>💾 {d.name}</b></td><td><span className="badge blue">{d.type}</span></td>
                    <td className="right tabular">{tb(d.capacityGB)}</td><td className="right tabular">{tb(d.usedGB)}</td>
                    <td><UsageCell pct={d.usagePct} /></td>
                  </tr>
                ))}
                {datastores.length === 0 && <tr><td colSpan={5} className="center muted" style={{ padding: 20 }}>데이터스토어 없음</td></tr>}
              </tbody>
            </table>
          </div>
        )}

        {view === 'network' && (
          <div className="table-wrap">
            <table>
              <thead><tr><th>네트워크</th><th>유형</th><th className="right">호스트</th></tr></thead>
              <tbody>
                {networks.map((n) => (
                  <tr key={n.id}><td><b>🌐 {n.name}</b></td><td><span className="badge gray">{n.type}</span></td><td className="right tabular">{n.hostCount ?? '—'}</td></tr>
                ))}
                {networks.length === 0 && <tr><td colSpan={3} className="center muted" style={{ padding: 20 }}>네트워크 없음</td></tr>}
              </tbody>
            </table>
          </div>
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
