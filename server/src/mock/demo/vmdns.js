/**
 * mock/demo/vmdns.js — v2.710 VM DNS 변경 이력 데모.
 * 특수 기능 › VM DNS 설정 확인의 '최근 DNS 설정 변경' 은 수집을 시작한 뒤의 **바뀐 것만** 기록하므로 데모에서는 언제나 0건이었다.
 * 첫 관측이 적재된 뒤 한 번, 몇몇 VM 에 '과거에 이 값에서 지금 값으로 바뀌었다' 는 변경 행을 지난 14일에 흩어 넣는다.
 * 규칙(flags.js 머리말): mock 모드에서만 · 변경 행이 하나도 없을 때만 · 바뀐 뒤(after)는 **지금 실제 값**이라 다음 주기가
 * 다른 변경으로 읽지 않는다 · 결정적(같은 VM 이 같은 이력).
 */
import { isMockMode, demoHash } from './flags.js';
import { effectiveServers } from '../../vmdns/analyze.js';

const DAY = 86_400_000;
let _done = false;
export function _resetVmDnsDemoForTest() { _done = false; }

/** before 값 — 지금 값에서 하나를 바꾼다(예전 사내 DNS · 공용 DNS 를 쓰던 시절 · 순서가 달랐던 것). */
function beforeOf(servers, i) {
  const k = i % 3;
  if (k === 0) return ['10.0.0.53', ...servers.slice(1)];
  if (k === 1) return [...servers.slice(0, 1), '8.8.8.8'];
  return servers.length > 1 ? [...servers].reverse() : [servers[0], '10.0.0.54'];
}

export async function ensureVmDnsChangeDemo(snap, now = Date.now()) {
  if (!isMockMode() || _done) return { skipped: true };
  _done = true;
  const { listChanges, applyObservations, demoBackdateFirst } = await import('../../vmdns/db.js');
  const cur = await listChanges({ since: 0, limit: 50 });
  if (cur.available === false || (cur.changes || []).some((c) => !c.first)) return { skipped: 'exists' };
  const picked = [];
  for (const vm of Array.isArray(snap?.vms) ? snap.vms : []) {
    if (!vm || vm.template === true || vm.id == null || !Object.hasOwn(vm, 'dns')) continue;
    const servers = effectiveServers(vm);
    if (!servers || !servers.length) continue;
    if (demoHash(`dnsch|${vm.id}`) % 40 !== 0) continue;
    picked.push({ vm, servers });
    if (picked.length >= 24) break;
  }
  let n = 0;
  // 오래된 것부터 적재 — 같은 VM 의 latest 행은 마지막(가장 최근) 변경으로 남는다.
  const rows = picked.map((p, i) => ({ ...p, i, ts: now - (1 + (demoHash(`dnst|${p.vm.id}`) % 13)) * DAY - (demoHash(`dnsm|${p.vm.id}`) % 600) * 60_000 }))
    .sort((a, b) => a.ts - b.ts);
  for (const r of rows) {
    const before = beforeOf(r.servers, r.i);
    const res = await applyObservations({ now: r.ts, changes: [{ vmId: String(r.vm.id), vcId: String(r.vm.vcenterId ?? ''), name: String(r.vm.name ?? ''), before, after: r.servers, sig: r.servers.join(',') }] });
    if (res.ok) { n += 1; await demoBackdateFirst(String(r.vm.id), r.ts - 7 * DAY, before, now); }
  }
  if (n) console.log(`[mock] VM DNS 변경 이력 데모 ${n}건(지난 14일)`);
  return { added: n };
}
