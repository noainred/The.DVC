/**
 * 원격 접속 대상 호스트의 사용자 범위(scope) 판정 — 순수 함수(v2.579 에 `routes/remote.js` 에서 분리).
 *
 * 왜 옮겼나(ARCH-05): `proxy/sshGateway.js`(WS 게이트웨이 도메인)가 이 함수를 **라우트 파일**에서
 * 가져다 쓰면서 도메인 → routes 방향 의존이 생겼다(주석은 "런타임 호출이라 순환 안전" 이라 적고
 * 있었지만, 안전한 이유가 '호출 시점' 하나에 걸려 있는 구조는 v2.566 TDZ 사고와 같은 유형이다).
 * 라우트와 게이트웨이가 **같은 판정**을 써야 하므로 둘 다 이 파일을 import 한다. `routes/remote.js` 는
 * 같은 이름을 재수출한다(테스트 `nsxRemoteScope` 가 그 경로로 가져간다).
 */
// v2.744(최종 검토 RF-R1): 호스트의 IP 는 IP 대장과 같은 판정(hostLedgerIp — 이름이 IP 면 그 이름, 아니면 정규형 관리 IP)을 쓴다.
//   복제 금지 — 대장이 '이 호스트의 IP' 라고 보여 주는 값과 원격 접속이 '그 호스트' 로 인정하는 값이 갈라지지 않게.
import { hostLedgerIp } from '../ipam/ledger.js';
import { ipToNum } from '../util/ipv4.js';

const SCOPE_REASON = '범위 내 vCenter 의 VM/호스트(IP·이름)만 대상으로 할 수 있습니다.';

const vmIpsOf = (vm) => (vm.ipAddresses?.length ? vm.ipAddresses : (vm.ipAddress ? [vm.ipAddress] : []));

/**
 * 범위 밖 객체(허용되지 않은 vCenter 의 VM·호스트, vCenter 귀속 없는 호스트)가 같은 IP 를 갖고 있는가 — 숫자로 비교한다
 * (느슨한 표기 '10.20.0.044' 도 같은 IP 로 본다 — 넓게 잡을수록 안전한 쪽이다).
 */
function claimedOutsideScope(snap, allowedSet, n) {
  const same = (v) => { const x = ipToNum(String(v ?? '')); return x != null && x === n; };
  for (const vm of snap.vms || []) {
    if (allowedSet.has(vm.vcenterId)) continue;
    if (vmIpsOf(vm).some(same)) return true;
  }
  for (const h of snap.hosts || []) {
    if (allowedSet.has(h.vcenterId)) continue;
    if (same(h.name)) return true;
    const hip = hostLedgerIp(h);
    if (hip && hip.n === n) return true;
  }
  return false;
}

/**
 * targetHost 의 사용자 scope 검사(v2.320, 2026-08-13 감사 보류 갭 적용 — 순수, 테스트 고정).
 * 범위 계정은 **허용 vCenter 인벤토리에 실재하는 대상**(VM 의 IP/이름 또는 호스트 이름·원장 IP)만
 * 프로브/터널 생성 가능 — 임의 사내 IP 도달성 스캔(정찰)·범위 밖 피벗 준비를 차단한다.
 * 인벤토리에 없는 대상은 범위 계정에겐 거부('vCenter 귀속 없는 데이터 미노출' 규칙과 동일 취지).
 * 전체 범위 계정(allowed=null)은 기존 신뢰 모델 유지(임의 대상 허용 — 변화 없음).
 *
 * v2.744(최종 검토 RF-R1 — 재현): 이름(FQDN)으로 등록된 ESXi 의 IP 대장 행 IP 는 관리 IP 다(hostLedgerIp). 예전에는 호스트를
 *   이름으로만 대조해, 범위 안 호스트를 그 행의 IP 로 원격 접속하면 403 이었다(화면은 '도달 불가 — 방화벽/포트 확인' 으로 안내).
 *   이제 허용 vCenter 호스트의 원장 IP 도 그 호스트로 인정한다. 넓히는 쪽이므로 경계를 함께 둔다 —
 *   · 관리 IP 가 비정규 표기·0.0.0.0 이면 hostLedgerIp 가 null 을 준다(인정하지 않는다 — 8진 해석 위험).
 *   · 대상 문자열은 원장 IP(정규형)와 **글자 그대로 같을 때만** 맞는다 — '10.20.0.011' 같은 비정규 표기는 같은 IP 로 보지 않는다.
 *   · 같은 IP 를 범위 밖 객체도 갖고 있으면 이 규칙으로는 인정하지 않는다(그 IP 가 실제로 어느 장비인지 알 수 없다 — 안전한 쪽).
 *   기존 규칙(VM IP·VM 이름·호스트 이름)은 예전 그대로다.
 * @returns {string|null} 거부 사유(존재 여부를 흘리지 않는 일반 문구) 또는 null(허용)
 */
export function targetHostScopeIssue(snap, allowedSet, targetHost) {
  if (!allowedSet) return null;
  const t = String(targetHost || '').toLowerCase();
  for (const vm of snap.vms || []) {
    if (!allowedSet.has(vm.vcenterId)) continue;
    if (vmIpsOf(vm).some((ip) => String(ip).toLowerCase() === t) || String(vm.name || '').toLowerCase() === t) return null;
  }
  let ledgerHit = null;
  for (const h of snap.hosts || []) {
    if (!allowedSet.has(h.vcenterId)) continue;
    if (String(h.name || '').toLowerCase() === t) return null; // 호스트 name 은 통상 FQDN/IP
    if (ledgerHit == null) { const hip = hostLedgerIp(h); if (hip && hip.ip === t) ledgerHit = hip.n; }
  }
  if (ledgerHit != null && !claimedOutsideScope(snap, allowedSet, ledgerHit)) return null;
  return SCOPE_REASON;
}

/*
 * v2.770(점검 R5-E5-1): 위 판정은 'targetHost 문자열이 허용 vCenter 인벤토리 **어딘가에** 있는가' 만 보고, 실제로 나갈 중계(프록시)는
 *   요청의 vcenterId 로 따로 골랐다(resolveProxy). vcenterId 를 비우면 기본 프록시(범위 밖 법인 망일 수 있다)로, 다른 범위 안 vcenterId 를
 *   넣으면 그 vCenter 의 중계로 나가 **그 망의 같은 IP(범위 밖 장비)** 에 터널이 열렸다 — 28개 vCenter 의 RFC1918 대역은 겹친다.
 *   범위 계정은 이제 (vcenterId, targetHost) **쌍**으로 본다 —
 *   · vcenterId 가 있으면 targetHost 가 **그 vCenter 의** VM IP/이름·호스트 이름·원장 관리 IP 여야 한다. 그 vCenter 의 중계 경로에서 범위 밖
 *     객체가 같은 주소를 갖고 있으면(같은 프록시 = 같은 망) 어느 장비인지 알 수 없으므로 거부한다(proxyIdOf 를 넘긴 경우).
 *   · 비어 있으면(IP 대장 원격 버튼 — 웹 IpamCore ipRemoteItem 은 '' 를 보낼 수 있다 — 'vcenterId 필수' 로 바꾸지 말 것) 일치 객체에서
 *     **유일하게** 유도한다. 범위 안 여러 vCenter 에 있거나 범위 밖에도 같은 주소가 있으면 거부(모호 — 어느 망으로 나갈지 정할 수 없다).
 *   전체 범위 계정(allowedSet=null)은 예전 그대로(요청 vcenterId 를 그대로 쓴다). 위 targetHostScopeIssue 의 규칙(비정규 IPv4·원장 IP 충돌)은
 *   먼저 그대로 적용한다 — 이 함수는 좁히기만 한다.
 */
const AMBIGUOUS_REASON = 'vCenter 를 지정하지 않으면 이 주소의 대상을 특정할 수 없습니다 — VM·호스트 상세 화면의 원격 접속을 쓰세요.';

/** 범위 안 vCenter 별 일치 종류 — direct(VM IP/이름·호스트 이름) / ledger(호스트 원장 관리 IP — 범위 밖 충돌이 있으면 인정하지 않는다). */
function inScopeMatches(snap, allowedSet, t) {
  const out = new Map();
  const mark = (vc, kind) => { const e = out.get(vc) || { direct: false, ledger: false }; e[kind] = true; out.set(vc, e); };
  for (const vm of snap.vms || []) {
    if (!allowedSet.has(vm.vcenterId)) continue;
    if (vmIpsOf(vm).some((ip) => String(ip).toLowerCase() === t) || String(vm.name || '').toLowerCase() === t) mark(vm.vcenterId, 'direct');
  }
  for (const h of snap.hosts || []) {
    if (!allowedSet.has(h.vcenterId)) continue;
    if (String(h.name || '').toLowerCase() === t) { mark(h.vcenterId, 'direct'); continue; }
    const hip = hostLedgerIp(h);
    if (hip && hip.ip === t) mark(h.vcenterId, 'ledger');
  }
  return out;
}

/** 같은 주소(IP 는 숫자로 — 느슨한 표기도 같은 IP 로 본다 · 이름은 대소문자 무시)를 가진 범위 밖 객체들의 vCenter id 목록(귀속 없음은 ''). */
function outsideClaimVcenters(snap, allowedSet, t) {
  const n = ipToNum(t);
  const sameIp = (v) => { if (n == null) return false; const x = ipToNum(String(v ?? '')); return x != null && x === n; };
  const out = [];
  for (const vm of snap.vms || []) {
    if (allowedSet.has(vm.vcenterId)) continue;
    if (vmIpsOf(vm).some(sameIp) || String(vm.name || '').toLowerCase() === t) out.push(String(vm.vcenterId ?? ''));
  }
  for (const h of snap.hosts || []) {
    if (allowedSet.has(h.vcenterId)) continue;
    const hip = hostLedgerIp(h);
    if (String(h.name || '').toLowerCase() === t || sameIp(h.name) || (n != null && hip && hip.n === n)) out.push(String(h.vcenterId ?? ''));
  }
  return out;
}

/**
 * (vcenterId, targetHost) 쌍의 범위 판정 + 쓸 vCenter 유도(순수).
 * @param {object} snap
 * @param {Set<string>|null} allowedSet  scopedVcenterIds 결과(null = 전체 범위)
 * @param {string} targetHost
 * @param {string} [vcenterId]
 * @param {{proxyIdOf?:(vcenterId:string)=>string}} [opt]  vCenter → 중계 프록시 id(registry.resolveProxy(vc).id). 넘기면 같은 중계 경로의 범위 밖 충돌도 거부한다.
 * @returns {{ vcenterId: string, issue: string|null, derived?: boolean }}
 */
export function resolveScopedTarget(snap, allowedSet, targetHost, vcenterId, { proxyIdOf } = {}) {
  const id = vcenterId == null ? '' : String(vcenterId);
  if (!allowedSet) return { vcenterId: id, issue: null };
  const base = targetHostScopeIssue(snap, allowedSet, targetHost);
  if (base) return { vcenterId: id, issue: base };
  const t = String(targetHost || '').toLowerCase();
  const inScope = inScopeMatches(snap, allowedSet, t);
  const outside = outsideClaimVcenters(snap, allowedSet, t);
  // 원장 관리 IP 로만 맞은 vCenter 는 범위 밖 충돌이 하나라도 있으면 인정하지 않는다(targetHostScopeIssue v2.744 규칙과 같은 기준).
  const usable = (vc) => { const k = inScope.get(vc); return !!k && (k.direct || outside.length === 0); };
  if (id) {
    if (!allowedSet.has(id) || !usable(id)) return { vcenterId: id, issue: SCOPE_REASON };
    if (typeof proxyIdOf === 'function' && outside.length) {
      const p = proxyIdOf(id);
      if (outside.some((vc) => proxyIdOf(vc) === p)) return { vcenterId: id, issue: SCOPE_REASON };
    }
    return { vcenterId: id, issue: null };
  }
  if (outside.length) return { vcenterId: '', issue: AMBIGUOUS_REASON };
  const cands = [...inScope.keys()].filter(usable);
  if (cands.length !== 1) return { vcenterId: '', issue: cands.length ? AMBIGUOUS_REASON : SCOPE_REASON };
  return { vcenterId: String(cands[0]), issue: null, derived: true };
}

/**
 * 저장된 매핑의 범위 재검사(WS 게이트웨이·/rdp/:id·범위 admin 목록) — (vcenterId, targetHost) 쌍 + **그 매핑이 실제로 나가는 중계**가
 * 그 vCenter 의 중계와 같은가. 예전 매핑(vcenterId '')은 유도해서 본다. 프록시 배정이 바뀌어 매핑의 중계가 그 vCenter 의 것이 아니면
 * 거부한다(그 중계 망의 같은 IP 가 어느 장비인지 알 수 없다 — 삭제 후 다시 접속하면 새 중계로 만들어진다).
 * @returns {string|null}
 */
export function mappingTargetScopeIssue(snap, allowedSet, m, { proxyIdOf } = {}) {
  if (!allowedSet) return null;
  const r = resolveScopedTarget(snap, allowedSet, m?.targetHost, m?.vcenterId, { proxyIdOf });
  if (r.issue) return r.issue;
  if (typeof proxyIdOf === 'function' && String(m?.proxyId || 'default') !== String(proxyIdOf(r.vcenterId))) return SCOPE_REASON;
  return null;
}
