/**
 * veeam/run/plan.js — 백업 실행 판정(순수, v2.818): ① VM 별 실행 가능 상태 ② 백업 방식 배정 ③ 포탈 전용 잡 이름.
 *
 * **새 대조를 만들지 않는다** — VM ↔ Veeam 대조는 모니터링 코어(veeam/parse.js matchToVcenter)의 byVm 이 이미 한다(moref 는 vCenter 이름과
 * 함께, 이름 일치는 같은 vCenter 안에서만, 다른 vCenter 이름은 별칭 학습 — 반증 검토 F4·F5 의 오판을 그 코어가 이미 막는다).
 * 여기서는 그 결과를 '실행할 수 있는가' 로 읽기만 한다. 라우트가 계산해 화면에 내려준다(웹에 판정 복제 금지).
 *
 * 상태(run.status):
 *  · 'protected'   Veeam 이 이 VM 을 백업한 근거(복원 지점·마지막 백업)가 있고, 그 백업을 한 B&R 서버가 등록부에 있다 → Quick Backup 대상
 *  · 'elsewhere'   백업 근거는 있지만 그 Veeam 서버가 B&R 등록부에 없다(EM 으로만 보임 등) — 어느 서버에 보낼지 몰라 보내지 않는다
 *  · 'in-job'      잡에는 있지만 복원 지점이 없다(첫 실행 전·실패) → Quick Backup 불가(전체 복원 지점 필요)
 *  · 'unprotected' 대조 결과를 읽었고 Veeam 에 이 VM 이 없다
 *  · 'unknown'     이 vCenter 의 Veeam 결과를 아직 못 읽었다(등록부 손상·결과 없음·인벤토리 없음) — 미보호로 단정하지 않는다
 *  · 'unmapped'    이 vCenter 를 맡는 B&R 서버가 등록부에 없다
 */
import crypto from 'node:crypto';

const lc = (s) => String(s ?? '').trim().toLowerCase();

/** VM id(`<vcenterId>:<moref>`) → moref. vcenterId 에 콜론이 있을 수 있어 split(':') 금지 — 알려진 접두 길이로 자른다. */
export function morefOf(vm) {
  const id = String(vm?.id ?? ''); const vc = String(vm?.vcenterId ?? '');
  if (!vc || !id.startsWith(`${vc}:`)) return '';
  const m = id.slice(vc.length + 1);
  return /^[A-Za-z0-9._-]{1,128}$/.test(m) ? m : '';
}

/**
 * Veeam 이 이 vCenter 를 부르는 이름(잡 includes 의 hostName). 직접 지정 > 대조가 배운 별칭(하나일 때만) > 포탈 등록 주소.
 * @returns {{ name:string, how:'manual'|'alias'|'host'|'' }}
 */
export function veeamHostFor(vc, { manual = '', aliasHosts = [] } = {}) {
  if (manual) return { name: manual, how: 'manual' };
  const al = Array.isArray(aliasHosts) ? aliasHosts.filter(Boolean) : [];
  if (al.length === 1) return { name: String(al[0]), how: 'alias' };
  if (vc?.host) return { name: String(vc.host), how: 'host' };
  return { name: '', how: '' };
}

/**
 * VM 1대의 실행 상태(순수).
 * @param {object} vm         포탈 VM(id·vcenterId·name)
 * @param {object} ctx
 * @param {object[]} ctx.servers   이 vCenter 를 맡는 B&R 등록 서버(enabled — veeam/registry.js serversForVcenter, 등록 순서)
 * @param {boolean} ctx.known      이 vCenter 의 대조 결과를 읽었는가(match 가 있다)
 * @param {object|undefined} ctx.entry  match.byVm[vm.id]
 */
export function runStatusOf(vm, { servers = [], known = false, entry } = {}) {
  const objectId = morefOf(vm);
  if (!servers.length) return { status: 'unmapped', objectId, reason: '이 vCenter 를 맡는 Veeam B&R 서버가 등록돼 있지 않습니다(Veeam 서버 설정의 연결 vCenter).' };
  if (!known) return { status: 'unknown', objectId, reason: '이 vCenter 의 Veeam 결과를 아직 읽지 못했습니다 — 미보호로 단정하지 않습니다.' };
  if (!entry) return { status: 'unprotected', objectId, serverId: servers[0].id, serverName: servers[0].name };
  const rp = typeof entry.rp === 'number' && Number.isFinite(entry.rp) ? entry.rp : null;
  const lb = typeof entry.lb === 'number' && Number.isFinite(entry.lb) ? entry.lb : null;
  const jobs = Array.isArray(entry.jobs) ? entry.jobs.slice(0, 10) : [];
  const names = new Set((Array.isArray(entry.servers) ? entry.servers : []).map(lc));
  const owner = servers.find((s) => names.has(lc(s.name))) || null;
  const base = { objectId, restorePoints: rp, lastBackup: lb, jobs, running: entry.run === 1 };
  if ((rp != null && rp > 0) || lb != null) {
    if (!owner) return { status: 'elsewhere', ...base, reason: '백업 기록은 있지만 그 Veeam 서버가 B&R 로 등록돼 있지 않아(EM 으로만 보임 등) 어느 서버에 보낼지 모릅니다.' };
    return { status: 'protected', ...base, serverId: owner.id, serverName: owner.name };
  }
  const tgt = owner || servers[0];
  if (jobs.length) return { status: 'in-job', ...base, serverId: tgt.id, serverName: tgt.name, reason: '잡에는 있지만 복원 지점이 없습니다(첫 실행 전이거나 실패) — Quick Backup 은 전체 복원 지점이 있어야 합니다.' };
  return { status: 'unprotected', ...base, serverId: tgt.id, serverName: tgt.name };
}

/**
 * 백업 방식 배정(순수). mode 'quick'(가능한 VM 은 Quick Backup) | 'portal'(전부 포탈 전용 잡). unprotected 'portal' | 'skip'.
 * @param {{vm:object, run:object, hostName:string}[]} items
 */
export function planBackup(items, { mode = 'quick', unprotected = 'portal' } = {}) {
  const vms = [];
  for (const { vm, run: p, hostName } of items) {
    const row = { vmId: vm.id, name: vm.name || vm.id, vcenterId: vm.vcenterId, objectId: p?.objectId || morefOf(vm), serverId: p?.serverId || '', serverName: p?.serverName || '', hostName: hostName || '' };
    const skip = (reason) => vms.push({ ...row, how: 'skip', reason });
    if (!row.objectId) { skip('VM 의 moref 를 알 수 없습니다.'); continue; }
    if (p?.status === 'unmapped' || p?.status === 'unknown' || p?.status === 'elsewhere') { skip(p.reason || '보낼 수 없습니다.'); continue; }
    if (!row.serverId) { skip('보낼 Veeam 서버를 정하지 못했습니다.'); continue; }
    if (!row.hostName) { skip('Veeam 이 이 vCenter 를 부르는 이름을 모릅니다 — 백업 실행 설정에서 vCenter 이름을 지정하세요.'); continue; }
    if (p?.running) { skip('지금 백업 중인 VM 입니다 — 끝난 뒤 다시 요청하세요.'); continue; }
    if (mode === 'portal') { vms.push({ ...row, how: 'portal' }); continue; }
    if (p?.status === 'protected') { vms.push({ ...row, how: 'quick' }); continue; }
    if (unprotected === 'portal') { vms.push({ ...row, how: 'portal', reason: p?.status === 'in-job' ? '전체 복원 지점이 없어 포탈 전용 잡으로 넘깁니다(그 VM 은 두 잡에 들어갑니다).' : '미보호 VM — 포탈 전용 잡으로 넘깁니다.' }); continue; }
    skip(p?.status === 'in-job' ? '전체 복원 지점이 없어 Quick Backup 을 할 수 없습니다(건너뜀).' : '미보호 VM — 건너뜀(설정).');
  }
  const groups = new Map();
  for (const v of vms) {
    if (v.how === 'skip') continue;
    // 포탈 전용 잡은 vCenter 마다 하나.
    // 그룹은 서버×방식×vCenter — moref 는 vCenter 안에서만 유일하다(두 vCenter 의 vm-100 이 한 요청에 섞이면 세션을 엉뚱한 VM 에 붙인다 — 2차 반증 R-A).
    const key = `${v.serverId}|${v.how}|${v.vcenterId}`;
    const g = groups.get(key) || { serverId: v.serverId, serverName: v.serverName, kind: v.how, vcenterId: v.vcenterId, refs: [] };
    g.refs.push({ vmId: v.vmId, name: v.name, hostName: v.hostName, objectId: v.objectId });
    groups.set(key, g);
  }
  return { vms, groups: [...groups.values()] };
}

/**
 * 포탈 전용 잡 이름(순수) — 접두 + vCenter 이름(Veeam 잡 이름에 쓸 수 있는 글자만) + vCenter id 해시 6자리.
 * 해시를 늘 붙이는 이유(반증 검토 F6): 한글 이름은 글자를 걸러 내면 비고('서울'·'부산' → 둘 다 같은 이름), 'KR VC'·'KR/VC' 도 같아진다 —
 * 두 vCenter 의 VM 이 한 잡에 섞이면 'vCenter 마다 잡 하나' 가 깨진다. ⚠ 이 형식을 바꾸면 이미 만든 잡을 못 찾는다(새 잡을 만든다).
 */
export function portalJobName(prefix, vc) {
  const base = String(vc?.name || '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'vcenter';
  const h = crypto.createHash('sha256').update(String(vc?.id ?? '')).digest('hex').slice(0, 6);
  return `${prefix}${base}-${h}`.slice(0, 80);
}
