// 데이터스토어 운영 점검(v2.700 — A17) · 순수 파서·판정. 모양(ds.dcfg — 없으면 '미수집', 판정하지 않는다):
//   { at, maintenance: 'normal'|'enteringMaintenance'|'inMaintenance'|null, uncommittedGB: number|null, sioc: bool|null,
//     vmCount: int|null, inSdrs: bool|null, mounts: { total, notAccessible, notMounted, hosts?, bad?, hostsOmitted? }|null }
//   v2.901: mounts.hosts = 마운트한 호스트 moref(정상 · 문제 모두 · DS_MOUNT_HOSTS_MAX 까지) · bad = 접근 불가 · 미마운트 호스트 [{h, accessible, mounted}]
//     (DS_MOUNT_BAD_MAX 까지) · hostsOmitted = 상한으로 뺀 수. 이미 받는 'host' 속성(DatastoreHostMount)을 넓혀 읽는다(새 호출 없음).
//     hosts 키가 없으면 이전 판 수집 — 호스트별 마운트는 모른다(화면이 그렇게 말한다).
// 못 읽은 값은 null(0·false 가 아니다).
import { xmlUnescape } from '../vcenter/soapParse.js';

/** 전부 vSphere 5.0+ 경로. */
export const DS_CFG_PATHS = Object.freeze(['summary.maintenanceMode', 'summary.uncommitted', 'iormConfiguration', 'vm', 'host', 'parent']);
const tag = (xml, name) => { const m = new RegExp(`<${name}>([^<]*)</${name}>`).exec(xml || ''); return m ? xmlUnescape(m[1]) : null; };
const boolOf = (v) => (v === 'true' ? true : v === 'false' ? false : null);
const MAINT = new Set(['normal', 'enteringMaintenance', 'inMaintenance']);

export const DS_MOUNT_HOSTS_MAX = 64;
export const DS_MOUNT_BAD_MAX = 16;
const HOST_KEY_RE = /<key type="HostSystem">([\w.:-]{1,64})<\/key>/;
export function parseMounts(xml) {
  if (typeof xml !== 'string') return null;
  let total = 0; let notAccessible = 0; let notMounted = 0; let i = 0;
  const hosts = []; const bad = []; let hostsOmitted = 0;
  for (;;) {
    const s = xml.indexOf('<mountInfo>', i);
    if (s < 0) break;
    const e = xml.indexOf('</mountInfo>', s);
    if (e < 0) break;
    const blk = xml.slice(s, e);
    // DatastoreHostMount 원소 순서는 key → mountInfo 다 — 직전 mountInfo 끝부터 이 mountInfo 앞까지에서 호스트 키를 찾는다(앞 원소의 키를 줍지 않게 · 선형).
    const h = HOST_KEY_RE.exec(xml.slice(i, s))?.[1] || null;
    i = e + 12;
    total += 1;
    const acc = boolOf(tag(blk, 'accessible')); const mnt = boolOf(tag(blk, 'mounted'));
    if (acc === false) notAccessible += 1;
    if (mnt === false) notMounted += 1;
    if (h) {
      if (hosts.length < DS_MOUNT_HOSTS_MAX) hosts.push(h); else hostsOmitted += 1;
      if ((acc === false || mnt === false) && bad.length < DS_MOUNT_BAD_MAX) bad.push({ h, accessible: acc, mounted: mnt });
    }
  }
  return { total, notAccessible, notMounted, hosts, bad, hostsOmitted };
}

export function parseDsCfgProps(props = {}, at = Date.now()) {
  const p = props || {};
  const mm = typeof p['summary.maintenanceMode'] === 'string' ? p['summary.maintenanceMode'].trim() : null;
  const unc = p['summary.uncommitted'];
  const uncN = typeof unc === 'string' && /^\d+$/.test(unc.trim()) ? Number(unc) : null;
  const iorm = typeof p.iormConfiguration === 'string' ? p.iormConfiguration : null;
  const vm = p.vm;
  const parent = typeof p.parent === 'string' ? p.parent.trim() : null;
  return {
    at,
    maintenance: mm && MAINT.has(mm) ? mm : null,
    uncommittedGB: uncN == null ? null : Math.round(uncN / 1024 ** 3),
    sioc: iorm == null ? null : boolOf(tag(iorm, 'enabled')),
    vmCount: typeof vm === 'string' ? (vm.match(/<ManagedObjectReference\b/g) || []).length : null,
    // StoragePod(SDRS) 부모의 moref 는 'group-p' 로 시작한다(vCenter 관례 — 다르면 false 로 보이는 한계를 화면이 말한다).
    inSdrs: parent ? parent.startsWith('group-p') : null,
    mounts: Object.hasOwn(p, 'host') ? parseMounts(p.host) : null,
  };
}

export const DS_CFG_CODES = Object.freeze({
  'ds-inaccessible': 'crit',
  'ds-mount-partial': 'warn',
  'ds-maintenance': 'warn',
  'ds-overcommit': 'warn',
  'ds-vmfs-old': 'info',
  'ds-sioc-off': 'info',
  'ds-many-vms': 'info',
});
export const DS_OVERCOMMIT_PCT = 150;
export const DS_MANY_VMS = 40;

/** 데이터스토어 하나의 판정. 접근 불가는 dcfg 없이도 판정한다(30초 수집 값). */
export function dsCfgFindings(ds) {
  const out = [];
  if (!ds) return out;
  const add = (code, facts = {}) => out.push({ code, sev: DS_CFG_CODES[code], facts });
  if (ds.accessible === false) add('ds-inaccessible');
  if (Number.isFinite(ds.vmfsMajor) && ds.vmfsMajor > 0 && ds.vmfsMajor < 6) add('ds-vmfs-old', { version: ds.vmfsMajor });
  const d = ds.dcfg;
  if (!d) return out;
  if (d.mounts && (d.mounts.notAccessible > 0 || d.mounts.notMounted > 0)) add('ds-mount-partial', { total: d.mounts.total, notAccessible: d.mounts.notAccessible, notMounted: d.mounts.notMounted });   // v2.901: 호스트 목록은 판정 사실에 싣지 않는다
  if (d.maintenance === 'inMaintenance' || d.maintenance === 'enteringMaintenance') add('ds-maintenance', { mode: d.maintenance });
  if (Number.isFinite(d.uncommittedGB) && Number.isFinite(ds.usedGB) && ds.capacityGB > 0) {
    const pct = Math.floor(((ds.usedGB + d.uncommittedGB) / ds.capacityGB) * 100);
    if (pct >= DS_OVERCOMMIT_PCT) add('ds-overcommit', { pct, provisionedGB: ds.usedGB + d.uncommittedGB });
  }
  const shared = d.mounts ? d.mounts.total > 1 : false;
  if (d.sioc === false && shared && /vmfs|nfs/i.test(ds.type || '')) add('ds-sioc-off');
  if (Number.isFinite(d.vmCount) && d.vmCount > DS_MANY_VMS) add('ds-many-vms', { count: d.vmCount, limit: DS_MANY_VMS });
  return out;
}

const MOREF_RE = /^[\w.:-]{1,64}$/;
const n0 = (x) => (Number.isFinite(x) && x >= 0 ? Math.trunc(x) : null);
export function sanitizeDsCfg(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const m = v.mounts && typeof v.mounts === 'object' && !Array.isArray(v.mounts) ? v.mounts : null;
  return {
    at: n0(v.at),
    maintenance: typeof v.maintenance === 'string' && MAINT.has(v.maintenance) ? v.maintenance : null,
    uncommittedGB: n0(v.uncommittedGB),
    sioc: typeof v.sioc === 'boolean' ? v.sioc : null,
    vmCount: n0(v.vmCount),
    inSdrs: typeof v.inSdrs === 'boolean' ? v.inSdrs : null,
    mounts: m ? {
      total: n0(m.total) ?? 0, notAccessible: n0(m.notAccessible) ?? 0, notMounted: n0(m.notMounted) ?? 0,
      // v2.901: 호스트별 마운트 — 키가 없으면 싣지 않는다(이전 판 엣지 = 모름). moref 꼴만 · 상한.
      ...(Array.isArray(m.hosts) ? {
        hosts: m.hosts.filter((h) => typeof h === 'string' && MOREF_RE.test(h)).slice(0, DS_MOUNT_HOSTS_MAX),
        bad: (Array.isArray(m.bad) ? m.bad : []).filter((b) => b && typeof b === 'object' && typeof b.h === 'string' && MOREF_RE.test(b.h)).slice(0, DS_MOUNT_BAD_MAX)
          .map((b) => ({ h: b.h, accessible: typeof b.accessible === 'boolean' ? b.accessible : null, mounted: typeof b.mounted === 'boolean' ? b.mounted : null })),
        hostsOmitted: n0(m.hostsOmitted) ?? 0,
      } : {}),
    } : null,
  };
}
