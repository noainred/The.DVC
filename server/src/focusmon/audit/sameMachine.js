/**
 * focusmon/audit/sameMachine.js — 집중 모니터링 대상 둘이 **같은 서버인가**(v3.54.0 ⑤) · 엣지가 **자기 서버로 아는 주소인가**(④) 판정 코어(순수).
 *
 * ⑤ 왜: 자동 설치 · 접속 준비는 같은 서버의 sudoers 파일 하나(계정 한 줄)를 쓰므로 같은 서버에 다른 수집 계정 항목이 있으면
 *    디스크 점검을 자동으로 설치하지 않고('host-shared') · 같은 서버 작업을 겹치지 않는다('host-busy'). 예전 판정은 주소 글자 비교 하나라
 *    **같은 서버를 다른 IP(두 번째 NIC · 별칭 IP)로 따로 등록하면** 알아보지 못했다(v3.17.0 S3 의 남은 것). 대상 주소는 등록부가 정규 IPv4 만
 *    받으므로(registry.js) 이름 비교는 대상의 **표시 이름 · 그 서버가 알려 준 호스트 이름(연결 시험 hello)** 으로 한다.
 *    근거(basis):
 *     · 'addr'     같은 주소(예전 그대로 — 노드와 무관하게 등록부 전부)
 *     · 'vm'       같은 노드가 맡은 두 항목의 주소가 인벤토리의 **같은 VM**(그 VM 의 IP 목록)에 있다
 *     · 'hostname' 같은 노드의 두 항목이 연결 시험에서 알려 준 호스트 이름이 같다(localhost 류 제외)
 *     · 'name'     한 항목의 호스트 이름(hello)이 같은 노드 다른 항목의 표시 이름과 같다
 *    새 근거는 **같은 노드 안에서만** 쓴다 — 법인마다 사설 대역 · 호스트 이름이 겹친다(28개 vCenter 의 RFC1918 대역은 겹친다 — proxy/targetHostScope.js).
 *    넓게 잡을수록 안전한 쪽이다(같다고 보면 자동 설치를 하지 않고 손으로 하게 한다). DNS 는 묻지 않는다(요청 경로 — 시한 없는 조회 금지).
 *    한계: 인벤토리에 없고(물리 서버 · VMware Tools 가 IP 를 안 알림) 연결 시험도 한 적 없는 항목은 주소 글자로만 본다.
 *
 * ④ 왜: 엣지는 중앙이 보낸 root 작업(설치 · 준비)의 대상을 따로 확인하지 않았다(v3.17.0 S4 — 토큰 + TLS 에만 기댐). 법인 공통 계정(root 키)은
 *    법인 어느 주소에나 쓸 수 있으므로, 엣지는 그 주소가 **자기가 아는 서버**일 때만 공통 계정을 쓴다 — 그 엣지가 수집한 vCenter 의 VM IP ·
 *    그 엣지 SSH 공용 접속에 등록한 서버 주소(정규 IPv4 만 — 비정규 표기는 inet_aton 이 다르게 읽는다).
 */
import { strictIpv4Num, ipToNum, numToIp } from '../../util/ipv4.js';
import { sameHostName } from '../../util/sameHostName.js';

/** 이름으로 같다고 보지 않는 흔한 기본 호스트 이름(복제 VM 이 그대로 쓴다). */
export const GENERIC_HOSTNAMES = Object.freeze(['localhost', 'localhost.localdomain', 'localhost4', 'localhost4.localdomain4', 'localhost6', 'localhost6.localdomain6', 'localdomain', 'ubuntu', 'centos', 'rhel', 'redhat', 'fedora', 'debian', 'linux', 'server', 'host']);
const GENERIC = new Set(GENERIC_HOSTNAMES);
// 반증 F2(same-machine · 재현): 템플릿 이름을 그대로 쓴 복제 VM('rhel8-template' · 'centos7' · 'rocky9')이 같은 서버로 묶여 일괄 설치가 1대만 시작했다.
const TEMPLATE_RE = /template|^(rhel|centos|ubuntu|rocky|alma|almalinux|oel|ol|oracle|debian|fedora|sles|suse|opensuse|win|windows)[0-9._-]*$/;
/** 같은 노드 · 같은 첫 마디 이름이 이보다 많은 항목에 있으면 이름 근거로 쓰지 않는다(템플릿 · 관례 이름 — 같은 서버를 이만큼 따로 등록하는 일은 드물다). */
export const NAME_BUCKET_MAX = 3;
export const BASIS = Object.freeze(['addr', 'vm', 'hostname', 'name']);
/** 강한 근거(주소 · 인벤토리 VM) — 같은 서버 작업을 겹치지 않게 하는 데(host-busy)는 이것만 쓴다. 이름 근거는 sudoers 를 덮는 쪽(host-shared)에만. */
export const STRONG_BASIS = Object.freeze(['addr', 'vm']);

/** 호스트 이름 비교 열쇠 — 소문자 · 끝 점 제거 · 이름 글자만 · 흔한 기본 이름 · IP 모양은 null. 길이를 먼저 자른다. */
export function nameKey(v) {
  if (typeof v !== 'string') return null;
  const t = v.slice(0, 256).trim().toLowerCase();
  let e = t.length;
  while (e > 0 && t[e - 1] === '.') e--;
  const s = t.slice(0, e);
  if (!s || s.length > 253 || !/^[a-z0-9][a-z0-9.-]*$/.test(s) || /^[0-9.]+$/.test(s)) return null;
  const first = s.split('.')[0];
  if (GENERIC.has(s) || GENERIC.has(first) || TEMPLATE_RE.test(first)) return null;
  return s;
}
/** 같은 서버 판정용 주소 열쇠(느슨히 — 넓게 잡는 쪽): IPv4 숫자 정규형 · 아니면 소문자 글자. */
export function addrKey(v) {
  const s = String(v ?? '').slice(0, 64).trim();
  if (!s) return null;
  const n = ipToNum(s);
  return n == null ? `s:${s.toLowerCase()}` : numToIp(n);
}
const vmIpsOf = (vm) => (Array.isArray(vm?.ipAddresses) && vm.ipAddresses.length ? vm.ipAddresses : (vm?.ipAddress ? [vm.ipAddress] : []));
const nodeOf = (t) => String(t?.agent || '').toLowerCase();

/**
 * 대상 목록의 같은 서버 색인(요청마다 한 번 — O(대상 + VM)).
 * @param {object[]} targets  등록부 대상 전부(범위 · 데모와 무관 — 같은 서버를 찾는다)
 * @param {{vms?:object[], helloOf?:(id:string)=>({hostname?:string}|null), vmNodeOf?:(vm)=>string|null, groupOf?:(t)=>string}} ctx
 *   vms = 중앙 스냅샷 VM(없으면 인벤토리 근거 없음) · vmNodeOf = 그 VM 을 수집한 노드(엣지 이름 소문자 · 중앙 직접 '' · 모르면 null — 그 VM 은 근거로 쓰지 않는다;
 *   주지 않으면 노드로 거르지 않는다) · groupOf = 같은 노드 안에서 이름 근거를 더 나눌 묶음(라우트: 중앙 직접 대상의 법인 — null 은 모름 = 어느 묶음과도 견준다)
 * 반증 F1(same-machine · 재현): 예전에는 전 법인 VM 을 IP 당 8개까지만 색인해, 겹치는 사설 대역의 다른 법인 VM 8개가 앞에 있으면 그 노드의 실제 VM 이 빠졌다
 *   → 대상 주소에 든 IP 만 색인(상한 없음 — 총량은 VM IP 수 이하) · VM 은 대상과 같은 노드가 수집한 것만.
 * @returns {{peersOf:(id:string)=>Array<{id:string, basis:string}>}}
 */
export function machineIndex(targets, { vms = [], helloOf = () => null, vmNodeOf = null, groupOf = null } = {}) {
  const list = (Array.isArray(targets) ? targets : []).filter((t) => t && typeof t.id === 'string');
  const grp = (t) => { if (typeof groupOf !== 'function') return null; try { const g = groupOf(t); return g == null || g === '' ? null : String(g); } catch { return null; } };
  const want = new Set(list.map((t) => addrKey(t.host)).filter((k) => k && !k.startsWith('s:')));
  // 주소 → [{vk, node}](대상 주소에 든 IP 만)
  const vmByIp = new Map();
  for (const vm of Array.isArray(vms) ? vms : []) {
    if (!vm || vm.id == null) continue;
    let vnode = null;
    if (typeof vmNodeOf === 'function') { try { vnode = vmNodeOf(vm); } catch { vnode = null; } if (vnode == null) continue; }
    const vk = `${String(vm.vcenterId ?? '')}|${String(vm.id)}`;
    for (const ip of vmIpsOf(vm).slice(0, 64)) {
      const k = addrKey(ip); if (!k || !want.has(k)) continue;
      let a = vmByIp.get(k); if (!a) { a = []; vmByIp.set(k, a); } a.push({ vk, node: vnode });
    }
  }
  const byAddr = new Map(); const byVm = new Map(); const byLabel = new Map(); // 노드|첫 마디 → [{id, grp, hello, disp}]
  const push = (m, k, v) => { let a = m.get(k); if (!a) { a = []; m.set(k, a); } a.push(v); };
  for (const t of list) {
    const ak = addrKey(t.host); if (ak) push(byAddr, ak, t.id);
    const node = nodeOf(t);
    for (const v of (ak && vmByIp.get(ak)) || []) if (v.node === null || v.node === node) push(byVm, `${node}#${v.vk}`, t.id);
    let hn = null; try { hn = nameKey(helloOf(t.id)?.hostname); } catch { hn = null; }
    const disp = nameKey(t.name);
    for (const lab of new Set([hn, disp].filter(Boolean).map((x) => x.split('.')[0]))) push(byLabel, `${node}#${lab}`, { id: t.id, grp: grp(t), hn, disp });
  }
  const vmKeysOf = new Map(); for (const [k, ids] of byVm) for (const id of ids) { let a = vmKeysOf.get(id); if (!a) { a = []; vmKeysOf.set(id, a); } a.push(k); }
  const me = new Map(list.map((t) => [t.id, t]));
  return {
    peersOf(id) {
      const t = me.get(id); if (!t) return [];
      const out = new Map();
      const add = (pid, basis) => { if (pid !== id && !out.has(pid)) out.set(pid, basis); };
      const ak = addrKey(t.host);
      for (const pid of (ak && byAddr.get(ak)) || []) add(pid, 'addr');
      for (const k of vmKeysOf.get(id) || []) for (const pid of byVm.get(k) || []) add(pid, 'vm');
      const node = nodeOf(t); const g = grp(t);
      let hn = null; try { hn = nameKey(helloOf(id)?.hostname); } catch { hn = null; }
      const disp = nameKey(t.name);
      for (const lab of new Set([hn, disp].filter(Boolean).map((x) => x.split('.')[0]))) {
        const bucket = (byLabel.get(`${node}#${lab}`) || []).filter((p) => p.grp == null || g == null || p.grp === g); // 법인이 다르면(둘 다 알 때) 견주지 않는다
        if (new Set(bucket.map((p) => p.id)).size > NAME_BUCKET_MAX) continue; // 템플릿 · 관례 이름(반증 F2)
        for (const p of bucket) {
          if (p.id === id || out.has(p.id)) continue;
          if (hn && p.hn && sameHostName(hn, p.hn) === true) add(p.id, 'hostname');
          else if ((hn && p.disp && sameHostName(hn, p.disp) === true) || (disp && p.hn && sameHostName(disp, p.hn) === true)) add(p.id, 'name');
        }
      }
      return [...out].map(([pid, basis]) => ({ id: pid, basis }));
    },
  };
}

/** 같은 서버로 보는 다른 대상(대상 객체 + 근거). machine 이 없으면 예전처럼 주소 글자(대소문자 무시)로만. */
export function sameMachinePeers(t, peers, machine = null) {
  const all = Array.isArray(peers) ? peers : [];
  if (machine && typeof machine.peersOf === 'function') {
    const byId = new Map(all.filter((p) => p && typeof p.id === 'string').map((p) => [p.id, p]));
    return machine.peersOf(t.id).map((x) => (byId.has(x.id) ? { ...byId.get(x.id), basis: x.basis } : null)).filter(Boolean);
  }
  const h = String(t?.host || '').trim().toLowerCase();
  if (!h) return [];
  return all.filter((p) => p && p.id !== t.id && String(p.host || '').trim().toLowerCase() === h).map((p) => ({ ...p, basis: 'addr' }));
}

/**
 * ④ 엣지가 자기 서버로 아는 주소 — 그 엣지 스냅샷의 VM IP + SSH 공용 접속 서버 주소(이 노드가 맡은 것 — agent '').
 * 정규 IPv4 글자만(비정규 표기는 같은 주소로 보지 않는다 — 좁게 잡는 쪽이 안전하다).
 *  · 반증 F3(edge-target): VM IP 는 게스트가 알린 값이다 — **한 VM 에만 있는 IP** 만 쓴다(docker0 172.17.0.1 · virbr0 처럼 여러 VM 이 같이 알리는 내부 브리지 주소를 빼려고).
 *  · 반증 F2(edge-target · 재현): 인벤토리를 아직 다 읽지 못했으면(첫 수집 전 · vCenter 못 읽음) 함수의 `unknown` 이 참 — 모르는 주소를 '엣지가 모르는 서버' 로 단정하지 않게
 *    (installCred 가 'local-unknown' 으로 알린다 — 그래도 공통 계정은 쓰지 않는다).
 *  · ⚠ 서버 항목에는 중앙이 배포(bm-onboard)로 넣은 것도 있다 — 이 판정은 중앙이 **작업 주소 하나를 틀리게** 보낸 경우를 막고, 설정까지 배포하는 침해된 중앙은 막지 못한다(문서의 남은 것).
 * @returns {((host:string)=>boolean) & {unknown:boolean}}
 */
export function localHostIndex({ vms = [], servers = [], unknown = false } = {}) {
  const set = new Set();
  const canon = (v) => { const s = String(v ?? '').trim(); return typeof strictIpv4Num(s) === 'number' ? s : null; };
  const vmCount = new Map();
  for (const vm of Array.isArray(vms) ? vms : []) for (const ip of new Set(vmIpsOf(vm).slice(0, 64).map(canon).filter(Boolean))) vmCount.set(ip, (vmCount.get(ip) || 0) + 1);
  for (const [ip, n] of vmCount) if (n === 1) set.add(ip);
  for (const s of Array.isArray(servers) ? servers : []) if (s && !String(s.agent || '').trim()) { const ip = canon(s.host); if (ip) set.add(ip); }
  const fn = (host) => { const h = String(host ?? '').trim(); return typeof strictIpv4Num(h) === 'number' && set.has(h); };
  fn.unknown = unknown === true;
  return fn;
}
