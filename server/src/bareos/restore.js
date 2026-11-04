/**
 * bareos/restore.js — 복원 판정(순수 함수, v2.820). 복원은 **파괴적**(원래 VM 덮어쓰기)일 수 있어 판정을 한곳에 둔다.
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
import { capacityShortfall, shortfallText } from '../vmclone/capacity.js';

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
/**
 * v2.822(검토 S3·I5 — 재현): 등록 뒤 VM 의 이름·데이터센터·폴더가 바뀌었는가. 잡의 플러그인 옵션은 등록 때의 dc·folder·vmname 으로
 *   고정돼 있어(Bareos 에 잡 수정 명령이 없다) 바뀌면 백업은 실패하고, 덮어쓰기 복원은 **그 이름·위치의 다른 VM** 을 겨눌 수 있다.
 *   못 읽은 위치(null — REST 폴백 인벤토리)는 바뀐 것으로 세지 않는다(모르는 것을 단정하지 않는다). 순수 함수.
 * @returns {null|'missing'|string[]}  null = 그대로 · 'missing' = 인벤토리에 없음 · 배열 = 바뀐 항목 이름
 */
export function placementDrift(job, vm) {
  if (!vm) return 'missing';
  const d = [];
  if (String(vm.name) !== String(job.vmName)) d.push('이름');
  if (vm.vcDcPath && String(vm.vcDcPath) !== String(job.dc)) d.push('데이터센터');
  if (vm.folderPath && String(vm.folderPath) !== String(job.folder)) d.push('폴더');
  return d.length ? d : null;
}

/**
 * v2.847 D2-1: 그 복원 지점(jobid)이 백업될 때의 이름 · 위치 — 카탈로그를 유지한 다시 묶기 뒤의 옛 지점은 원장 placements(그 jobid 까지의 옛 위치)를 쓴다.
 * jobid 를 모르면 지금 원장 값(예전 동작). 카탈로그 시각은 Director 현지 시각이라 jobid 로만 비교한다.
 */
export function placementAt(job, jobid) {
  const id = Number(jobid);
  if (Number.isInteger(id) && id > 0) {
    for (const p of (Array.isArray(job?.placements) ? job.placements : []).slice().sort((a, b) => a.upToJobid - b.upToJobid)) {
      if (Number.isInteger(p?.upToJobid) && id <= p.upToJobid) return { ...job, vmName: p.vmName, dc: p.dc, folder: p.folder };
    }
  }
  return job;
}

/**
 * v2.861 allowDisksMismatch(덮어쓰기만 — 기본 꺼짐): Bareos 23.1+ 의 restore_allow_disks_mismatch=yes(PR #1876 — 지금 VM 의 디스크 수 · 크기가
 *   백업 때와 달라도 덮어쓴다 · vSAN 에서 필요). 새 VM 은 디스크를 백업에서 새로 만들어 해당 없다. 옛 Director 는 모르는 옵션으로 거부한다(추정).
 */
/**
 * v2.866(실환경 — 복원 잡 'python3-fd-mod: Option vcuser not defined'): 백업 잡의 플러그인 옵션은 잡 수준 FdPluginOptions 라 복원 때 FD 로 다시 오지 않는다.
 *   그래서 복원 명령에 백업과 같은 기본 키(vcserver · dc · folder · vmname · config_file)를 싣는다 — 값은 **그 복원 지점의 백업 때 위치**(placementAt)와
 *   사이트 매핑(vCenter 주소 · FD 의 INI 경로). 자격증명 값은 싣지 않는다(INI 가 갖는다). 매핑이 덜 됐으면 복원하지 않는다(그대로 보내면 FD 에서 실패한다).
 * @param {{ vcserver?: string, configFile?: string }|null} base  null 이면 기본 키 없음(옛 호출 · 순수 판정 시험용 — 실제 라우트는 늘 넘긴다)
 */
export function restoreBaseKv(base, at) {
  if (!base) return { kv: {} };
  if (!base.vcserver || !base.configFile) return { issue: '이 vCenter 의 사이트 매핑에 vCenter 주소 · FD 자격증명 파일(INI) 경로가 없습니다 — 설정 › vCenter 관리 › Bareos 백업 서버 › 법인별 설정에서 채운 뒤 복원하세요(FD 가 vCenter 계정을 모르면 복원이 실패합니다).' };
  return { kv: { vcserver: base.vcserver, dc: at?.dc, folder: at?.folder, vmname: at?.vmName, config_file: base.configFile } };
}

export function restorePlan({ mode, job, snapshot, newVm = {}, confirmName = '', pluginName = 'python3', jobid = null, allowDisksMismatch = false, base = null }) {
  if (!RESTORE_MODES.includes(mode)) return { ok: false, issue: '복원 방식을 고르세요(원래 VM 덮어쓰기 · 새 VM · 로컬 VMDK).' };
  const baseKv = restoreBaseKv(base, placementAt(job, jobid));
  if (baseKv.issue) return { ok: false, issue: baseKv.issue };
  const vms = (snapshot?.vms || []).filter((v) => String(v.vcenterId) === String(job.vcenterId));

  if (mode === 'original') {
    if (String(confirmName) !== String(job.vmName)) return { ok: false, issue: `덮어쓸 VM 이름을 정확히 다시 입력하세요(‘${job.vmName}’).` };
    const vm = vms.find((v) => v.id === job.vmId);
    if (!vm) return { ok: false, issue: '원래 VM 이 인벤토리에 없습니다 — 새 VM 으로 복원하세요.' };
    // 플러그인은 vmname·dc·folder 로 VM 을 찾는다 — 등록 때와 같고, 그 자리에 같은 이름의 VM 이 하나뿐일 때만 덮어쓴다(S3)
    if (!vm.vcDcPath || !vm.folderPath) return { ok: false, issue: 'VM 의 데이터센터·폴더 경로를 읽지 못했습니다 — 덮어쓸 대상을 확인할 수 없어 진행하지 않습니다(새 VM 으로 복원하세요).' };
    const at = placementAt(job, jobid);
    const drift = placementDrift(at, vm);
    if (drift) {
      return { ok: false, issue: at !== job
        ? `이 복원 지점은 다시 등록하기 전(VM ${drift.join('·')}이(가) 다를 때)에 백업됐습니다 — 플러그인은 백업 때의 이름·위치를 가리키므로 덮어쓰기를 진행하지 않습니다(새 VM 으로 복원하세요).`
        : `등록 뒤 VM 의 ${drift.join('·')}이(가) 바뀌었습니다 — 백업 잡은 등록 때의 이름·위치를 가리키므로 덮어쓰기를 진행하지 않습니다(새 VM 으로 복원하세요).` };
    }
    const twins = vms.filter((v) => v.id !== vm.id && String(v.name) === String(vm.name) && v.vcDcPath === vm.vcDcPath && v.folderPath === vm.folderPath);
    if (twins.length) return { ok: false, issue: `같은 폴더에 ‘${vm.name}’ 이름의 VM 이 ${twins.length + 1}대 있습니다 — 플러그인이 어느 VM 을 덮어쓸지 정할 수 없어 진행하지 않습니다(새 VM 으로 복원하세요).` };
    if (vm.powerState !== 'POWERED_OFF') {
      return { ok: false, issue: vm.powerState === 'POWERED_ON' ? 'VM 이 켜져 있습니다 — 끈 뒤 다시 시도하세요(덮어쓰기 전제).' : 'VM 전원 상태를 읽지 못했습니다 — 덮어쓰기를 진행하지 않습니다.' };
    }
    const snaps = numOrNull(vm.snapshotCount);
    if (snaps === null) return { ok: false, issue: 'VM 의 스냅샷 개수를 읽지 못했습니다 — 덮어쓰기를 진행하지 않습니다(0 으로 보지 않습니다).' };
    if (snaps > 0) return { ok: false, issue: `VM 에 스냅샷이 ${snaps}개 있습니다 — 모두 지운 뒤 다시 시도하세요(덮어쓰기 전제).` };
    const r = restorePluginOptions({ ...baseKv.kv, restore_powerstate: 'off', ...(allowDisksMismatch === true ? { restore_allow_disks_mismatch: 'yes' } : {}) }, pluginName);
    return r.issue ? { ok: false, issue: r.issue } : { ok: true, pluginOptions: r.value, target: { name: job.vmName, overwrite: true, ...(allowDisksMismatch === true ? { allowDisksMismatch: true } : {}) } };
  }

  if (mode === 'localVmdk') {
    const r = restorePluginOptions({ ...baseKv.kv, localvmdk: 'yes' }, pluginName);
    return r.issue ? { ok: false, issue: r.issue } : { ok: true, pluginOptions: r.value, target: { localVmdk: true } };
  }

  // newVm
  const name = String(newVm?.name ?? '').trim();
  const ni = pluginValueIssue(name, '새 VM 이름');
  if (ni) return { ok: false, issue: ni };
  if (vms.some((v) => String(v.name).toLowerCase() === name.toLowerCase())) return { ok: false, issue: `같은 vCenter 에 ‘${name}’ VM 이 이미 있습니다 — 다른 이름을 쓰세요.` };
  const kv = { ...baseKv.kv, vmname: name, restore_powerstate: 'off' };
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
  const ok = (rows || []).filter(okRow);
  const target = ok.find((r) => r.jobid === jobid);
  if (!target) return null;
  // 순서는 시작 시각(같으면 jobid) — Migration 된 Full 은 새 jobid(더 큼)를 받지만 시작 시각은 원래 실행의 것이다(C9-2 — Bareos 동작은 추정).
  //   시각을 못 읽은 행이 있으면 예전처럼 jobid 순(모르는 시각으로 순서를 지어내지 않는다).
  const byTime = ok.every((r) => Number.isFinite(r.startedAt));
  const cmp = byTime ? (a, b) => (a.startedAt - b.startedAt) || (a.jobid - b.jobid) : (a, b) => a.jobid - b.jobid;
  const list = ok.filter((r) => cmp(r, target) <= 0).sort(cmp);
  if (target.level === 'F') return [target.jobid];
  const fullIdx = list.map((r) => r.level).lastIndexOf('F');
  if (fullIdx < 0) return null;
  const full = list[fullIdx];
  const after = list.slice(fullIdx + 1);
  if (target.level === 'D') return [full.jobid, target.jobid];
  const diffs = after.filter((r) => r.level === 'D');
  const diff = diffs.length ? diffs[diffs.length - 1] : null;
  const from = diff ? diff.jobid : full.jobid;
  const incs = (diff ? after.slice(after.indexOf(diff) + 1) : after).filter((r) => r.level === 'I');
  return [full.jobid, ...(diff ? [diff.jobid] : []), ...incs.map((r) => r.jobid)];
}

/** 체인 검증 — 비어 있지 않고 대상으로 끝나며 중복 없음(순서는 chainFromHistory 가 시작 시각으로 정한다 — jobid 오름차순이 아닐 수 있다). */
export function chainIssue(chain, jobid) {
  if (!Array.isArray(chain) || !chain.length) return '복원에 필요한 백업 체인(Full 부터)을 찾지 못했습니다.';
  if (chain[chain.length - 1] !== jobid) return '복원 체인에 고른 백업이 없습니다.';
  if (new Set(chain).size !== chain.length) return '복원 체인 순서가 올바르지 않습니다(중복).';
  return '';
}

/* ───────────────────────── v2.861 묶음 복원(폴더에서 고른 VM 여러 대) ───────────────────────── */

/** 한 번에 고를 수 있는 VM 상한(사용자 결정 ⓑ — 시안 50대). ops.restores 의 세션 상한(RUN_JOBS_MAX)과 같다. */
export const BULK_RESTORE_MAX = 50;
/** 복원 뒤 네트워크 어댑터 — 'disconnect' = 만든 뒤 포탈이 모든 NIC 의 연결을 끊는다 · 'keep' = 백업 때 그대로. */
export const NIC_MODES = Object.freeze(['disconnect', 'keep']);
const GIB = 1024 ** 3;
const gbNum = (v) => { const n = numOrNull(v); return n !== null && n >= 0 ? n : null; };

/**
 * 묶음 복원 판정(순수 — Director 에 닿기 전). 한 항목이라도 막히면 묶음 전체를 보내지 않는다(일부만 보내면 사용자가 고른 것과 다른 일이 된다).
 *  · 1~50대 · 같은 대상을 두 번 고르지 않는다 · **2대 이상이면 덮어쓰기 금지**(사용자 결정 ⓐ — 되돌릴 수 없는 작업은 1대씩)
 *  · 같은 Director(= 같은 법인 · 법인:vCenter:Bareos 1:1:1) 만 — 다른 법인 Director 로 섞어 보내지 않는다
 *  · 새 VM 이름은 묶음 안에서도 겹치지 않는다(대소문자 무시) · 항목마다 restorePlan
 *  · 네트워크: 새 VM 기본 '끊기'(ⓓ) · 덮어쓰기 기본 '그대로' · 로컬 VMDK 는 해당 없음(null)
 *  · 데이터스토어 여유: 같은 DS 로 가는 새 VM 의 용량(committed — storageGB) 합 + 남겨 둘 여유(capacity.js — max(10GiB, 5%))보다 적으면 막는다.
 *    값을 못 읽으면(VM 용량 · DS 여유) 막지도 통과로 단정하지도 않고 'unknown' 으로 돌려준다. DS 를 고르지 않으면 원래 자리 — 어느 DS 인지 몰라 판정하지 않는다.
 * @param {object} p
 * @param {object[]} p.items  [{ id, jobid, mode, newVm?, confirmName?, nic?, allowDisksMismatch? }]
 * @param {(id:string)=>object|null} p.jobOf  원장 job 조회(범위 판정은 부르는 쪽이 먼저)
 * @param {(job:object)=>string} p.dirOf     그 job 의 Director id
 * @param {object} p.snapshot
 * @param {string} [p.pluginName]
 * @param {Set<string>} [p.reservedNames] `${vcenterId}\u0000${소문자 이름}` — 최근 · 진행 중 새 VM 복원이 쓰는 이름(아직 인벤토리에 없다 — 반증 검토)
 * @returns {{ ok:boolean, issue?:string, directorId?:string, items: object[], capacity: object[] }}
 */
export function bulkRestorePlan({ items, jobOf, dirOf, snapshot, pluginName = 'python3', reservedNames = null, baseOf = null }) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return { ok: false, issue: '복원할 VM 을 고르세요.', items: [], capacity: [] };
  if (list.length > BULK_RESTORE_MAX) return { ok: false, issue: `한 번에 ${BULK_RESTORE_MAX}대까지 복원할 수 있습니다 — 나눠서 진행하세요.`, items: [], capacity: [] };
  const seen = new Set();
  const names = new Map();
  const out = [];
  let dir = null;
  for (const raw of list) {
    const it = raw && typeof raw === 'object' ? raw : {};
    const id = String(it.id ?? '');
    const job = id ? jobOf(id) : null;
    if (!job) { out.push({ id, ok: false, issue: '백업 대상을 찾지 못했습니다.' }); continue; }
    const row = { id, vmName: job.vmName, vcenterId: job.vcenterId, mode: it.mode };
    if (seen.has(id)) { out.push({ ...row, ok: false, issue: '같은 VM 을 두 번 골랐습니다.' }); continue; }
    seen.add(id);
    const d = String(dirOf(job) || '');
    if (dir === null) dir = d;
    else if (d !== dir) { out.push({ ...row, ok: false, issue: '다른 법인(Director)의 VM 입니다 — 복원은 한 법인씩 진행합니다.' }); continue; }
    if (list.length > 1 && it.mode === 'original') { out.push({ ...row, ok: false, issue: '여러 대를 함께 복원할 때는 원래 VM 덮어쓰기를 쓸 수 없습니다 — 덮어쓰기는 1대씩 진행하세요.' }); continue; }
    const jobid = Number(it.jobid);
    if (!Number.isInteger(jobid) || jobid <= 0) { out.push({ ...row, ok: false, issue: '복원 지점(jobid)을 고르세요.' }); continue; }
    const nic = it.mode === 'localVmdk' ? null : (it.nic === undefined || it.nic === null || it.nic === '') ? (it.mode === 'newVm' ? 'disconnect' : 'keep') : it.nic;
    if (nic !== null && !NIC_MODES.includes(nic)) { out.push({ ...row, ok: false, issue: '네트워크 어댑터 처리 값이 올바르지 않습니다.' }); continue; }
    const plan = restorePlan({ mode: it.mode, job, snapshot, newVm: it.newVm, confirmName: it.confirmName, pluginName, jobid, allowDisksMismatch: it.allowDisksMismatch === true, base: baseOf ? baseOf(job) : null });   // v2.866 기본 키(vcserver · config_file …)
    if (!plan.ok) { out.push({ ...row, ok: false, issue: plan.issue }); continue; }
    if (it.mode === 'newVm') {
      const k = String(plan.target.name).toLowerCase();
      if (reservedNames?.has(`${job.vcenterId}\u0000${k}`)) { out.push({ ...row, ok: false, issue: `최근 복원이 ‘${plan.target.name}’ 이름으로 VM 을 만들었거나 만드는 중입니다(아직 인벤토리에 없음) — 다른 이름을 쓰세요.` }); continue; }
      if (names.has(k)) { out.push({ ...row, ok: false, issue: `새 VM 이름 ‘${plan.target.name}’ 이(가) 이 묶음 안에서 겹칩니다.` }); continue; }
      names.set(k, id);
    }
    out.push({ ...row, ok: true, jobid, nic, plan });
  }
  // 데이터스토어 여유 — 같은 DS 로 가는 새 VM 을 합쳐서 본다. 키는 vCenter + 이름(반증 검토 M1 — 재현: Director 하나에 vCenter 여럿을 묶으면
  //   서로 다른 vCenter 의 같은 이름 DS 가 한 묶음이 되고 첫 항목 vCenter 의 여유로 판정해 부족한 DS 를 통과시켰다)
  const byDs = new Map();
  for (const r of out) {
    if (!r.ok || r.mode !== 'newVm' || !r.plan.target.datastore) continue;
    const ds = r.plan.target.datastore;
    const job = jobOf(r.id);
    const key = `${job.vcenterId}\u0000${ds}`;
    const vm = (snapshot?.vms || []).find((v) => v.id === job.vmId);
    const g = byDs.get(key) || { vcenterId: String(job.vcenterId), datastore: ds, ids: [], needGB: 0, unknownNeed: false };
    g.ids.push(r.id);
    const need = gbNum(vm?.storageGB);
    if (need === null) g.unknownNeed = true; else g.needGB += need;
    byDs.set(key, g);
  }
  const capacity = [];
  for (const g of byDs.values()) {
    const dsRow = (snapshot?.datastores || []).find((x) => String(x.vcenterId) === g.vcenterId && x.name === g.datastore);
    const freeGB = gbNum(dsRow?.freeGB); const capGB = gbNum(dsRow?.capacityGB);
    if (g.unknownNeed || freeGB === null) {
      capacity.push({ vcenterId: g.vcenterId, datastore: g.datastore, ids: g.ids, needGB: g.unknownNeed ? null : g.needGB, freeGB, capacityGB: capGB, verdict: 'unknown' });
      continue;
    }
    const short = capacityShortfall({ free: freeGB * GIB, capacity: capGB === null ? null : capGB * GIB, need: g.needGB * GIB });
    capacity.push({ vcenterId: g.vcenterId, datastore: g.datastore, ids: g.ids, needGB: g.needGB, freeGB, capacityGB: capGB, verdict: short ? 'short' : 'ok', ...(short ? { issue: shortfallText(`데이터스토어 ‘${g.datastore}’`, short, { tail: ' — 다른 데이터스토어를 고르거나 나눠서 복원하세요.' }) } : {}) });
  }
  for (const c of capacity) {
    if (c.verdict !== 'short') continue;
    for (const r of out) if (c.ids.includes(r.id) && r.ok) { r.ok = false; r.issue = c.issue; }
  }
  const bad = out.filter((r) => !r.ok);
  return { ok: !bad.length, ...(bad.length ? { issue: `${bad.length}대를 복원할 수 없습니다 — 항목별 사유를 확인하세요(묶음 전체를 보내지 않았습니다).` } : {}), directorId: dir || '', items: out, capacity };
}
