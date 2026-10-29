/**
 * bareos/restore.js — 복원 판정(순수 함수, v2.747). 복원은 **파괴적**(원래 VM 덮어쓰기)일 수 있어 판정을 한곳에 둔다.
 *
 * 근거(Bareos VMware 플러그인 문서 VMwarePlugin.rst.inc):
 *  - 원래 VM 에 덮어쓰기: VM 이 **꺼져 있고 스냅샷이 없어야** 한다.
 *  - 다른 폴더·DC·호스트·데이터스토어 또는 다른 이름으로 복원하면 새 MAC·UUID 의 **새 VM** 을 만든다. 원래 VM 이 정적 IP 로
 *    켜져 있으면 충돌하므로 `restore_powerstate=off` 를 권한다 — 포탈은 새 VM 을 **항상 꺼진 채로** 만든다.
 *  - 로컬 VMDK(`localvmdk=yes`): FD 의 /tmp/bareos-restores/ 에 VMDK 로 푼다(vCenter 는 바꾸지 않는다).
 *  - 다른 vCenter 로의 복원은 지원하지 않는다(문서 'Current limitations') — 포탈은 원래 vCenter 로만 복원한다.
 *
 * 규칙: 못 읽은 값은 0 이 아니다(util/numOrNull.js) — 스냅샷 개수·전원 상태를 모르면 덮어쓰기를 **거부**한다.
 */
import { numOrNull } from '../util/numOrNull.js';
import { restorePluginOptions, pluginValueIssue } from './names.js';

export const RESTORE_MODES = Object.freeze(['original', 'newVm', 'localVmdk']);

/**
 * @param {object} p
 * @param {'original'|'newVm'|'localVmdk'} p.mode
 * @param {object} p.job          원장 job(vmId·vmName·vcenterId)
 * @param {object} p.snapshot     store 스냅샷(vms·hosts·datastores)
 * @param {object} [p.newVm]      { name, datastore?, cluster?, esxHost? }
 * @param {string} [p.confirmName] 덮어쓰기 확인용 VM 이름 재입력
 * @param {string} [p.pluginName]
 * @returns {{ ok: true, pluginOptions: string, target: object } | { ok: false, issue: string }}
 */
export function restorePlan({ mode, job, snapshot, newVm = {}, confirmName = '', pluginName = 'python3' }) {
  if (!RESTORE_MODES.includes(mode)) return { ok: false, issue: '복원 방식을 고르세요(원래 VM 덮어쓰기 · 새 VM · 로컬 VMDK).' };
  const vms = (snapshot?.vms || []).filter((v) => String(v.vcenterId) === String(job.vcenterId));

  if (mode === 'original') {
    if (String(confirmName) !== String(job.vmName)) return { ok: false, issue: `덮어쓸 VM 이름을 정확히 다시 입력하세요(‘${job.vmName}’).` };
    const vm = vms.find((v) => v.id === job.vmId);
    if (!vm) return { ok: false, issue: '원래 VM 이 인벤토리에 없습니다 — 새 VM 으로 복원하세요.' };
    if (vm.powerState !== 'POWERED_OFF') {
      return { ok: false, issue: vm.powerState === 'POWERED_ON' ? 'VM 이 켜져 있습니다 — 끈 뒤 다시 시도하세요(덮어쓰기 전제).' : 'VM 전원 상태를 읽지 못했습니다 — 덮어쓰기를 진행하지 않습니다.' };
    }
    const snaps = numOrNull(vm.snapshotCount);
    if (snaps === null) return { ok: false, issue: 'VM 의 스냅샷 개수를 읽지 못했습니다 — 덮어쓰기를 진행하지 않습니다(0 으로 보지 않습니다).' };
    if (snaps > 0) return { ok: false, issue: `VM 에 스냅샷이 ${snaps}개 있습니다 — 모두 지운 뒤 다시 시도하세요(덮어쓰기 전제).` };
    const r = restorePluginOptions({ restore_powerstate: 'off' }, pluginName);
    return r.issue ? { ok: false, issue: r.issue } : { ok: true, pluginOptions: r.value, target: { name: job.vmName, overwrite: true } };
  }

  if (mode === 'localVmdk') {
    const r = restorePluginOptions({ localvmdk: 'yes' }, pluginName);
    return r.issue ? { ok: false, issue: r.issue } : { ok: true, pluginOptions: r.value, target: { localVmdk: true } };
  }

  // newVm
  const name = String(newVm?.name ?? '').trim();
  const ni = pluginValueIssue(name, '새 VM 이름');
  if (ni) return { ok: false, issue: ni };
  if (vms.some((v) => String(v.name).toLowerCase() === name.toLowerCase())) return { ok: false, issue: `같은 vCenter 에 ‘${name}’ VM 이 이미 있습니다 — 다른 이름을 쓰세요.` };
  const kv = { vmname: name, restore_powerstate: 'off' };
  const ds = String(newVm?.datastore ?? '').trim();
  if (ds) {
    const known = (snapshot?.datastores || []).some((d) => String(d.vcenterId) === String(job.vcenterId) && d.name === ds);
    if (!known) return { ok: false, issue: `데이터스토어 ‘${ds}’ 이(가) 이 vCenter 인벤토리에 없습니다.` };
    kv.restore_datastore = ds;
  }
  const cluster = String(newVm?.cluster ?? '').trim();
  const esx = String(newVm?.esxHost ?? '').trim();
  if (cluster && esx) return { ok: false, issue: '클러스터와 호스트 중 하나만 고르세요.' };
  const hosts = (snapshot?.hosts || []).filter((h) => String(h.vcenterId) === String(job.vcenterId));
  if (cluster) {
    if (!hosts.some((h) => h.cluster === cluster)) return { ok: false, issue: `클러스터 ‘${cluster}’ 이(가) 이 vCenter 인벤토리에 없습니다.` };
    kv.restore_cluster = cluster;
  }
  if (esx) {
    if (!hosts.some((h) => h.name === esx)) return { ok: false, issue: `호스트 ‘${esx}’ 이(가) 이 vCenter 인벤토리에 없습니다.` };
    kv.restore_esxhost = esx;
  }
  const r = restorePluginOptions(kv, pluginName);
  if (r.issue) return { ok: false, issue: r.issue };
  return { ok: true, pluginOptions: r.value, target: { name, ...(ds ? { datastore: ds } : {}), ...(cluster ? { cluster } : {}), ...(esx ? { esxHost: esx } : {}), powerOn: false } };
}

const okRow = (r) => r && r.type === 'B' && (r.state === 'ok' || r.state === 'warning');

/**
 * 카탈로그 이력으로 복원 체인을 계산(Director 의 .bvfs_get_jobids 가 응답하지 않을 때의 대체 — 계획서 R8).
 * Full → (그 뒤 마지막 Differential) → 그 뒤 Incremental 들 → 대상. 성공(T·W)한 백업만 쓴다.
 * @param {object[]} rows  director.normalizeJobRow 결과(같은 잡 이름)
 * @returns {number[]|null}
 */
export function chainFromHistory(rows, jobid) {
  const list = (rows || []).filter(okRow).filter((r) => r.jobid <= jobid).sort((a, b) => a.jobid - b.jobid);
  const target = list.find((r) => r.jobid === jobid);
  if (!target) return null;
  if (target.level === 'F') return [target.jobid];
  const fullIdx = list.map((r) => r.level).lastIndexOf('F');
  if (fullIdx < 0) return null;
  const full = list[fullIdx];
  const after = list.slice(fullIdx + 1);
  if (target.level === 'D') return [full.jobid, target.jobid];
  const diffs = after.filter((r) => r.level === 'D');
  const diff = diffs.length ? diffs[diffs.length - 1] : null;
  const from = diff ? diff.jobid : full.jobid;
  const incs = after.filter((r) => r.level === 'I' && r.jobid > from);
  return [full.jobid, ...(diff ? [diff.jobid] : []), ...incs.map((r) => r.jobid)];
}

/** 체인 검증 — 비어 있지 않고 대상을 포함하며 오름차순·중복 없음. */
export function chainIssue(chain, jobid) {
  if (!Array.isArray(chain) || !chain.length) return '복원에 필요한 백업 체인(Full 부터)을 찾지 못했습니다.';
  if (!chain.includes(jobid)) return '복원 체인에 고른 백업이 없습니다.';
  for (let i = 1; i < chain.length; i++) if (!(chain[i] > chain[i - 1])) return '복원 체인 순서가 올바르지 않습니다.';
  return '';
}
