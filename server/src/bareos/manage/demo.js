/**
 * bareos/manage/demo.js — 법인별 Bareos 설정 쓰기의 데모(mock + 실제 Director 미등록 — 장비에 닿지 않는다).
 * 데모 Director 의 메모리 설정(mock/demo/bareos.js demoCorpConfig)을 바꿔 `show …` 조회에 그대로 보이게 한다. 판정은 실제 planManage 를 지난 plan.
 * 규칙은 실제 경로와 같게 흉내 낸다: 포탈 표지 리소스만 바꾸고 지운다 · 마지막 스토리지 · 볼륨 파일이 있는 스토리지는 지우지 않는다.
 */
import { demoCorpConfig } from '../../mock/demo/bareos.js';
import { passwordIssue } from './apply.js';
import { effectiveSettings } from '../service.js';

const fail = (code, message) => Object.assign(new Error(message), { code });
const lc = (s) => String(s ?? '').toLowerCase();
const _pools = new Map();   // directorId → { pools, schedule }
const _volFiles = new Map(); // `${dir}|${storage}` → 볼륨 파일 수(데모 — 처음부터 있던 PortalFile 은 12개)

export function _resetDemoManage() { _pools.clear(); _volFiles.clear(); }

function scanOf(directorId, c) {
  const devs = c.storages.map((s) => ({ file: `${s.device}.conf`, portal: !!s.portal, name: s.device, archiveDevice: s.path || '/var/lib/bareos/storage', count: s.mcj ?? 10 }));
  const files = [
    ...c.consoles.filter((x) => x.name !== 'bareos-mon').map((x) => ({ type: 'console', name: x.name, portal: !!x.portal || !!x.portalOwn })),
    ...c.storages.map((s) => ({ type: 'storage', name: s.name, portal: !!s.portal })),
  ];
  const paths = [...new Set(devs.map((d) => d.archiveDevice))];
  const disks = paths.map((p, i) => {
    const size = (4 + i * 2) * 1024 ** 4;
    const n = c.storages.filter((s) => (s.path || '/var/lib/bareos/storage') === p).reduce((a, s) => a + (_volFiles.get(`${directorId}|${s.name}`) ?? (s.name === 'PortalFile' ? 12 : 0)), 0);
    const used = Math.round(size * (0.18 + 0.11 * i)) + n * 5 * 1024 ** 3;
    return { path: p, files: n, usedBytes: used, availBytes: Math.max(0, size - used), sizeBytes: size, mount: i === 0 ? '/var' : p.split('/').slice(0, 3).join('/') || '/' };
  });
  return { complete: true, devices: devs, files, disks };
}

/** plan(planManage 결과) 적용. @returns scan 이면 scan 모양, 쓰기면 { ok, files, restarted, reloaded, demo } */
export function applyDemo(directorId, plan, { accountPassword = '' } = {}) {
  const st = effectiveSettings();   // 조회(demoPolicy)와 같은 인자로 — 먼저 쓰기가 오더라도 같은 데모 설정을 만든다
  const c = demoCorpConfig(directorId, (st.directors || [])[0]?.id === directorId, (st.sites || []).filter((x) => x.directorId === directorId).map((x) => x.storage));
  const res = (files, restarted = false) => ({ ok: true, files, restarted, reloaded: true, demo: true });
  const cpath = (n) => `/etc/bareos/bareos-dir.d/console/${n}.conf`;
  switch (plan.action) {
    case 'scan': {
      const r = scanOf(directorId, c);
      if (!plan.path) return r;
      const known = r.disks.find((d) => plan.path.startsWith(d.path));
      const nfs = plan.path.startsWith('/mnt/') || plan.path.startsWith('/srv/');
      return { ...r, pathCheck: { kind: known && known.path === plan.path ? 'dir' : 'none', canonical: true, parent: known ? known.path : plan.path.split('/').slice(0, 2).join('/') || '/',
        availBytes: nfs ? 6.1 * 1024 ** 4 : known?.availBytes ?? 1.2 * 1024 ** 4, sizeBytes: nfs ? 8 * 1024 ** 4 : known?.sizeBytes ?? 2 * 1024 ** 4, mount: nfs ? plan.path.split('/').slice(0, 3).join('/') : '/var',
        fsType: nfs ? 'nfs4' : 'xfs', files: known && known.path === plan.path ? known.files : null, selinux: 'Enforcing' } };
    }
    case 'console.add': {
      const pi = passwordIssue(accountPassword); if (pi) throw fail('invalid', pi);
      if (c.consoles.some((x) => lc(x.name) === lc(plan.name))) throw fail('conflict', `${cpath(plan.name)} 가 이미 있습니다 — 아무것도 바꾸지 않았습니다.`);
      c.consoles.push({ name: plan.name, profile: plan.profile, tls: false, portal: true });
      return res([{ path: cpath(plan.name), action: 'created' }]);
    }
    case 'console.password':
    case 'console.delete': {
      const i = c.consoles.findIndex((x) => lc(x.name) === lc(plan.name));
      if (i < 0) throw fail('conflict', `${cpath(plan.name)} 가 없습니다 — 포탈이 만든 리소스가 아닙니다.`);
      if (!c.consoles[i].portal) throw fail('conflict', `‘${plan.name}’ 계정은 포탈이 만든 파일이 아닙니다 — 사람이 만든 계정은 바꾸지 않습니다(데모).`);
      if (plan.action === 'console.delete') { c.consoles.splice(i, 1); return res([{ path: cpath(plan.name), action: 'deleted' }]); }
      const pi = passwordIssue(accountPassword); if (pi) throw fail('invalid', pi);
      return res([{ path: cpath(plan.name), action: 'updated' }]);
    }
    case 'storage.add': {
      if (c.storages.some((x) => lc(x.name) === lc(plan.name))) throw fail('conflict', '같은 이름의 스토리지 파일이 이미 있습니다.');
      c.storages.push({ name: plan.name, address: plan.address, device: plan.device, mediaType: plan.mediaType, mcj: plan.count, portal: true, path: plan.archiveDevice, ...(plan.description ? { description: plan.description } : {}) });
      return res([{ path: `/etc/bareos/bareos-sd.d/device/${plan.device}.conf`, action: 'created' }, { path: `/etc/bareos/bareos-dir.d/storage/${plan.name}.conf`, action: 'created' }], true);
    }
    case 'storage.edit':
    case 'storage.delete': {
      const i = c.storages.findIndex((x) => lc(x.name) === lc(plan.name));
      if (i < 0 || !c.storages[i].portal) throw fail('conflict', `‘${plan.name}’ 은 포탈이 만든 스토리지가 아닙니다 — 사람이 만든 설정은 바꾸지 않습니다(데모).`);
      const s = c.storages[i];
      const files = [{ path: `/etc/bareos/bareos-sd.d/device/${s.device}.conf` }, { path: `/etc/bareos/bareos-dir.d/storage/${s.name}.conf` }];
      if (plan.action === 'storage.edit') {
        s.mcj = plan.count; if (plan.description) s.description = plan.description; else delete s.description;
        return res(files.map((f) => ({ ...f, action: 'updated' })), true);
      }
      const n = _volFiles.get(`${directorId}|${s.name}`) ?? (s.name === 'PortalFile' ? 12 : 0);
      if (n > 0) throw fail('conflict', `볼륨 디렉터리(${s.path})에 볼륨 파일이 ${n}개 있습니다 — 백업 데이터가 있는 스토리지는 지우지 않습니다.`);
      c.storages.splice(i, 1);
      return res(files.map((f) => ({ ...f, action: 'deleted' })), true);
    }
    case 'pools.edit': {
      const cur = _pools.get(directorId) || {};
      _pools.set(directorId, { ...cur, ...(plan.pools ? { pools: plan.pools } : {}), ...(plan.schedule ? { schedule: plan.schedule } : {}) });
      return res([...(plan.pools ? ['PortalVmwareFull', 'PortalVmwareIncr'].map((n) => ({ path: `/etc/bareos/bareos-dir.d/pool/${n}.conf`, action: 'updated' })) : []),
        ...(plan.schedule ? [{ path: '/etc/bareos/bareos-dir.d/schedule/PortalVmwareNightly.conf', action: 'updated' }] : [])]);
    }
    default: throw fail('invalid', `알 수 없는 작업(${plan.action})`);
  }
}
export const demoPoolsOf = (directorId) => _pools.get(directorId) || null;
