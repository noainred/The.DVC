/**
 * storage/clientNames.js — 아이실론 클라이언트 IP 에 포탈이 아는 이름을 붙인다(v2.932, 2차 ③ · 순수 모듈).
 *
 * 왜: 장비는 클라이언트를 IP(가끔 remote_name)로 보고한다. 재배치를 하려면 '어느 VM/호스트인가' 를 알아야 한다 — 포탈 인벤토리
 * (vCenter 스냅샷의 VM IP · 호스트 이름/관리 IP · IP 대장 원장)에서만 찾는다. **역방향 DNS 는 하지 않는다**(SSRF·지연 — 설계 §5 상태 '이름 못 찾음').
 *  · 같은 IP 가 여럿(VM 둘이 같은 IP)이면 첫 것 + `ambiguous:true` — 단정하지 않는다.
 *  · 비정규 IPv4 표기(`010.0.0.5`)는 같은 IP 로 보지 않는다(ipToNum 이 null — v2.589 8진 해석 위험).
 *  · 입력(장비 출력)은 외부 입력이다 — 길이를 먼저 자르고 정규식 없이 비교한다.
 */
import { strictIpv4Num } from '../util/ipv4.js'; // 정규 표기만(8진 오해석 위험 — hostLedgerIp 와 같은 판정)
import { hostLedgerIp } from '../ipam/ledger.js';
const ipNum = (v) => { const n = strictIpv4Num(String(v ?? '').slice(0, 64)); return typeof n === 'number' && n > 0 ? n : null; };

const vmIpsOf = (vm) => (Array.isArray(vm?.ipAddresses) && vm.ipAddresses.length ? vm.ipAddresses : (vm?.ipAddress ? [vm.ipAddress] : []));
const cap = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');

/**
 * 스냅샷(store.get() 모양 — vms[]·hosts[]) → IP 숫자 → { name, kind:'vm'|'host', vcenterId, ambiguous? } 색인.
 * 호출마다 전수 순회라 요청 1건에 1번만 만든다(VM 5,850 · 호스트 658 — 수 ms).
 */
export function buildClientNameIndex(snap) {
  const idx = new Map();
  const put = (n, ent) => {
    if (n == null) return;
    const cur = idx.get(n);
    if (!cur) idx.set(n, ent);
    else if (cur.name !== ent.name) cur.ambiguous = true;
  };
  for (const vm of snap?.vms || []) {
    const name = cap(vm?.name, 120);
    if (!name) continue;
    for (const ip of vmIpsOf(vm)) put(ipNum(ip), { name, kind: 'vm', vcenterId: vm.vcenterId ?? null });
  }
  for (const h of snap?.hosts || []) {
    const name = cap(h?.name, 120);
    if (!name) continue;
    const hip = hostLedgerIp(h);
    if (hip) put(hip.n, { name, kind: 'host', vcenterId: h.vcenterId ?? null });
  }
  return idx;
}

/**
 * 클라이언트 행에 이름을 붙인다(제자리 아님 — 새 배열). 장비가 준 이름(remote_name)이 있으면 그것을 먼저 쓰고 출처를 'device' 로 둔다.
 * @param {Array<{client:string, name?:string}>} rows
 * @param {Map} idx buildClientNameIndex 결과
 * @returns {Array<object>} 각 행 + { name, nameSource:'device'|'vm'|'host'|null, vcenterId?, ambiguous? }
 */
export function nameClientRows(rows, idx) {
  return (rows || []).map((r) => {
    const own = cap(r?.name, 80).trim();
    if (own) return { ...r, name: own, nameSource: 'device' };
    const ent = idx.get(ipNum(r?.client));
    if (!ent) return { ...r, name: '', nameSource: null };
    return { ...r, name: ent.name, nameSource: ent.kind, ...(ent.vcenterId != null ? { vcenterId: ent.vcenterId } : {}), ...(ent.ambiguous ? { ambiguous: true } : {}) };
  });
}
/** 이름을 몇 개 붙였는지(화면 각주 — '이름 못 찾음 N'). */
export function nameStats(rows) {
  let named = 0; let device = 0; let unknown = 0;
  for (const r of rows || []) { if (r.nameSource === 'device') device += 1; else if (r.nameSource) named += 1; else unknown += 1; }
  return { named, device, unknown };
}
