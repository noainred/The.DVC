// 데모(mock) vCenter 의 알람 · 최근 작업 · 권한 목록(v2.897) — vcinfo/parse.js 와 같은 모양. 인벤토리(그 vCenter 의 호스트 · VM · DS 이름)에서
// 결정적으로 만든다(같은 vCenter 는 같은 목록). 시각만 '지금' 기준으로 움직인다. 실데이터와 섞이지 않는다(라우트가 mock vCenter 일 때만 부른다).
const MIN = 60_000;
const refOf = (id) => String(id || '').split(':').pop();

export function mockVcInfo(kind, vcId, snap, now = Date.now()) {
  const hosts = (snap?.hosts || []).filter((h) => h.vcenterId === vcId);
  const vms = (snap?.vms || []).filter((v) => v.vcenterId === vcId && !v.template);
  const dss = (snap?.datastores || []).filter((d) => d.vcenterId === vcId);
  const seed = [...String(vcId)].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
  const pickN = (arr, n, k = 0) => (arr.length ? Array.from({ length: Math.min(n, arr.length) }, (_, i) => arr[(seed + k + i * 7) % arr.length]) : []);
  if (kind === 'alarms') {
    const items = [];
    for (const h of pickN(hosts.filter((x) => x.connectionState !== 'CONNECTED' || x.cpuUsagePct > 70), 3)) {
      items.push({ alarm: 'alarm-12', name: h.connectionState === 'DISCONNECTED' ? 'Host connection and power state' : 'Host CPU usage', entityType: 'HostSystem', entity: refOf(h.id), entityName: h.name, status: h.connectionState === 'DISCONNECTED' ? 'red' : 'yellow', time: now - ((seed % 50) + 5) * MIN, ack: false, ackBy: null, ackTime: null });
    }
    for (const d of pickN(dss.filter((x) => x.usagePct > 85), 2, 3)) {
      items.push({ alarm: 'alarm-27', name: 'Datastore usage on disk', entityType: 'Datastore', entity: refOf(d.id), entityName: d.name, status: d.usagePct > 95 ? 'red' : 'yellow', time: now - ((seed % 300) + 40) * MIN, ack: d.usagePct <= 95, ackBy: d.usagePct <= 95 ? 'VSPHERE.LOCAL\\infra-ops' : null, ackTime: d.usagePct <= 95 ? now - 30 * MIN : null });
    }
    for (const v of pickN(vms.filter((x) => (x.snapshotCount || 0) > 0), 2, 5)) {
      items.push({ alarm: 'alarm-41', name: 'Virtual machine consolidation needed status', entityType: 'VirtualMachine', entity: refOf(v.id), entityName: v.name, status: 'yellow', time: now - ((seed % 900) + 120) * MIN, ack: false, ackBy: null, ackTime: null });
    }
    items.push({ alarm: 'alarm-3', name: 'vSphere Health detected new issues', entityType: 'Folder', entity: 'group-d1', entityName: 'Datacenters', status: 'yellow', time: now - 26 * 60 * MIN, ack: false, ackBy: null, ackTime: null });
    items.sort((a, b) => b.time - a.time);
    return { at: now - (seed % 4) * MIN, items, omitted: 0, error: null };
  }
  if (kind === 'tasks') {
    const ops = [
      ['VirtualMachine.powerOn', 'success', 'VSPHERE.LOCAL\\infra-ops'], ['VirtualMachine.createSnapshot', 'success', 'CORP\\svc-veeam'],
      ['VirtualMachine.removeSnapshot', 'success', 'CORP\\svc-veeam'], ['VirtualMachine.reconfigure', 'error', 'CORP\\kim.ops'],
      ['Drm.ExecuteVMotionLRO', 'success', null], ['VirtualMachine.migrate', 'running', 'VSPHERE.LOCAL\\infra-ops'],
      ['HostSystem.enterMaintenanceMode', 'success', 'CORP\\lee.infra'], ['VirtualMachine.clone', 'queued', 'CORP\\svc-provision'],
    ];
    const targets = [...pickN(vms, 10, 1)];
    const items = ops.concat(ops).slice(0, Math.max(6, Math.min(14, targets.length))).map(([op, state, user], i) => {
      const host = op.startsWith('HostSystem');
      const t = host ? pickN(hosts, 1, i)[0] : targets[i % Math.max(1, targets.length)];
      const started = now - (i * 17 + 2) * MIN;
      return {
        key: `task-${4000 + i}`, op, entityType: host ? 'HostSystem' : 'VirtualMachine', entity: t ? refOf(t.id) : null, entityName: t?.name || null,
        state, progress: state === 'running' ? 45 : null, queued: started - 2000, started: state === 'queued' ? null : started,
        completed: state === 'success' || state === 'error' ? started + ((i % 5) + 1) * 9000 : null,
        user, reason: user ? 'user' : 'system', error: state === 'error' ? 'A specified parameter was not correct: spec.deviceChange.device' : null,
      };
    });
    return { at: now - (seed % 3) * MIN, items, error: null };
  }
  if (kind === 'perms') {
    const roles = [
      { id: -1, name: 'Admin', label: 'Administrator', system: true, privileges: 712 },
      { id: -2, name: 'ReadOnly', label: 'Read-only', system: true, privileges: 3 },
      { id: -5, name: 'NoAccess', label: 'No access', system: true, privileges: 0 },
      { id: 1001, name: 'Portal Monitoring', label: 'Portal Monitoring', system: false, privileges: 6 },
      { id: 1002, name: 'Backup Operator', label: 'Backup Operator', system: false, privileges: 41 },
    ];
    const role = (id) => roles.find((r) => r.id === id)?.label || null;
    const [h0] = pickN(hosts, 1); const [v0, v1] = pickN(vms, 2, 2);
    const items = [
      { entityType: 'Folder', entity: 'group-d1', entityName: 'Datacenters', principal: 'VSPHERE.LOCAL\\Administrators', group: true, roleId: -1, propagate: true },
      { entityType: 'Folder', entity: 'group-d1', entityName: 'Datacenters', principal: 'CORP\\vm-portal-ro', group: false, roleId: 1001, propagate: true },
      { entityType: 'Folder', entity: 'group-d1', entityName: 'Datacenters', principal: 'CORP\\svc-veeam', group: false, roleId: 1002, propagate: true },
      { entityType: 'Datacenter', entity: 'datacenter-21', entityName: `${vcId}-dc`, principal: 'CORP\\Infra-Team', group: true, roleId: -1, propagate: true },
      ...(h0 ? [{ entityType: 'HostSystem', entity: refOf(h0.id), entityName: h0.name, principal: 'CORP\\lee.infra', group: false, roleId: -2, propagate: false }] : []),
      ...(v0 ? [{ entityType: 'VirtualMachine', entity: refOf(v0.id), entityName: v0.name, principal: 'CORP\\app-owners', group: true, roleId: -1, propagate: false }] : []),
      ...(v1 ? [{ entityType: 'VirtualMachine', entity: refOf(v1.id), entityName: v1.name, principal: 'CORP\\contractor01', group: false, roleId: -5, propagate: false }] : []),
    ].map((p) => ({ ...p, role: role(p.roleId) }));
    return { at: now - ((seed % 300) + 10) * MIN, items, roles, omitted: 0, error: null };
  }
  return null;
}
