/**
 * Placement options for VM provisioning — what cluster / host / datastore /
 * folder / resource pool / storage profile the new VMs can target. Cluster,
 * host and datastore come from the live snapshot (real inventory). Folders,
 * resource pools and storage profiles are not in the aggregated snapshot, so we
 * return common suggestions (editable on the client) — in mock these are demo
 * values; in live the operator can type the exact vCenter name.
 */

import { store } from '../store.js';
import { getDataSource } from '../runtime-settings.js';

const uniq = (arr) => [...new Set(arr.filter(Boolean))];

export function getPlacement(vcenterId) {
  const snap = store.get();
  const hosts = snap.hosts.filter((h) => !vcenterId || h.vcenterId === vcenterId);
  const datastores = snap.datastores.filter((d) => !vcenterId || d.vcenterId === vcenterId);

  const clusters = uniq(hosts.map((h) => h.cluster)).sort().map((c) => ({
    name: c,
    hosts: hosts.filter((h) => h.cluster === c).length,
  }));

  const hostsOut = hosts.map((h) => ({ id: h.id, name: h.name, cluster: h.cluster || '', connectionState: h.connectionState }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const datastoresOut = datastores.map((d) => ({ id: d.id, name: d.name, type: d.type, freeGB: d.freeGB, capacityGB: d.capacityGB }))
    .sort((a, b) => (b.freeGB || 0) - (a.freeGB || 0));

  const mock = getDataSource() === 'mock';
  // Editable suggestions (datalist) — not authoritative for live.
  const folders = mock ? ['vm', 'Production', 'Development', 'Infra', 'Templates'] : ['vm'];
  const resourcePools = mock ? ['Resources (기본)', 'Prod', 'Dev', 'Batch'] : ['Resources'];
  const profiles = mock
    ? ['Datastore Default', 'vSAN Default Storage Policy', 'Thin Provision', 'Thick Provision (Eager)']
    : ['Datastore Default'];

  return { clusters, hosts: hostsOut, datastores: datastoresOut, folders, resourcePools, profiles, editable: { folders: true, resourcePools: true, profiles: true } };
}

/** Normalize an incoming placement payload (all optional, trimmed strings). */
export function cleanPlacement(p = {}) {
  const s = (v) => String(v ?? '').trim();
  return {
    cluster: s(p.cluster), host: s(p.host), datastore: s(p.datastore),
    folder: s(p.folder), resourcePool: s(p.resourcePool), storageProfile: s(p.storageProfile),
  };
}
