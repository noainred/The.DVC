/**
 * VM 사양 변경 창(VmReconfig.jsx)의 순수 판정 — 변경 계획 · 확인 문구 · 못 읽은 현재 값.
 *
 * 54회차 F4: 서버 `provision/reconfig.js parseHardware` 는 못 읽은 vCPU · 코어/소켓 · 메모리 · 디스크 용량을 **null** 로 준다(예전 0).
 *   현재 값을 모르면 '증설만' 을 판정할 수 없으므로 그 항목은 '—' 로 보이고 입력을 잠그며, 계획 · 확인 문구에 싣지 않는다
 *   (서버도 같은 경우 400 으로 막는다 — 화면은 보내지 않을 뿐 판정의 근거는 서버다).
 */

/** 입력 칸 값 → 수(비었거나 수가 아니면 d). ⚠ Number('') === 0 — 예전 동작 그대로(빈 칸은 0 으로 보고 서버가 '올바르지 않음' 으로 막는다). */
export const numOr = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const posInt = (v) => Number.isInteger(v) && v > 0;

/** 현재 vCPU 수를 읽었는가(못 읽으면 vCPU · 코어/소켓 변경을 잠근다 — 코어/소켓은 총 vCPU 의 약수 판정이 필요하다). */
export const cpuKnown = (hw) => !!hw && posInt(hw.cpu);
/** 현재 메모리(MB)를 읽었는가. */
export const memKnown = (hw) => !!hw && posInt(hw.memMB);
/** 디스크 현재 용량(GB)을 읽었는가. */
export const diskCapKnown = (d) => !!d && typeof d.capacityGB === 'number' && Number.isFinite(d.capacityGB) && d.capacityGB > 0;
/** 원래 코어/소켓 — 못 읽었으면 1(입력 칸의 시작 값과 같게 · 2차 공통 기능 점검 8회차). */
export const cps0 = (hw) => (Number.isInteger(hw?.coresPerSocket) && hw.coresPerSocket >= 1 ? hw.coresPerSocket : 1);
/** 원래 RAM(GB · 표시 반올림) — 못 읽었으면 null(예전 `|| 0` 은 0GB 를 기준으로 삼았다). */
export const ramGB0 = (hw) => (memKnown(hw) ? Math.round(hw.memMB / 1024) : null);
/** 현재 값 표시 — 못 읽었으면 '—'(단위 없음). */
export const curText = (v, unit = '') => (v == null ? '—' : `${v}${unit}`);

/**
 * 입력 상태 → 서버로 보낼 계획(POST /admin/vm/:id/reconfig 본문).
 * @param {object} hw  GET /hardware 의 hw
 * @param {{cpu, cps, ramGB, grows, adds, nicAdds, nicRemoves, nicConn}} f  입력 상태
 * @param {Array<{id,name,type,moref}>} networks
 */
export function reconfigPlan(hw, f, networks = []) {
  const plan = {};
  if (!hw) return plan;
  // 54회차 F4: 현재 vCPU 를 모르면 vCPU · 코어/소켓을 싣지 않는다(예전에는 기준 0 과 비교해 무엇이든 보냈다)
  if (cpuKnown(hw) && numOr(f.cpu, hw.cpu) !== hw.cpu) plan.numCPUs = numOr(f.cpu, hw.cpu);
  // 2차 공통 기능 점검 8회차: 원래 코어/소켓을 못 읽었으면(입력 칸은 1 로 시작) 1 을 원래 값으로 본다 — 예전엔 `|| 0` 과 비교해 손대지 않아도 '코어/소켓 →1' 을 보냈다.
  if (cpuKnown(hw) && numOr(f.cps, cps0(hw)) !== cps0(hw) && numOr(f.cps, 0) >= 1) plan.coresPerSocket = numOr(f.cps, 0);
  // v2.480(3차 감사 WB-1): 표시 GB 기준으로 '바뀌었을 때만' 전송(1.5GB 같은 VM 이 아무것도 안 바꿔도 감소 요청이 되던 것). 54회차 F4: 모르면 싣지 않는다.
  const r0 = ramGB0(hw);
  if (r0 != null && numOr(f.ramGB, r0) !== r0) plan.memoryMB = numOr(f.ramGB, r0) * 1024;
  const diskGrows = Object.entries(f.grows || {})
    .map(([key, gb]) => ({ key: Number(key), newGB: numOr(gb, 0) }))
    .filter((g) => { const d = (hw.disks || []).find((x) => x.key === g.key); return diskCapKnown(d) && g.newGB > d.capacityGB; });
  if (diskGrows.length) plan.diskGrows = diskGrows;
  const diskAdds = (f.adds || []).map((a) => ({ sizeGB: numOr(a.gb, 0), controllerKey: a.ctrl ? Number(a.ctrl) : undefined, datastore: a.ds || undefined })).filter((a) => a.sizeGB > 0);
  if (diskAdds.length) plan.diskAdds = diskAdds;
  const nicAddList = (f.nicAdds || []).map((id) => networks.find((n) => n.id === id)).filter(Boolean)
    .map((n) => (n.type === 'DISTRIBUTED_PORTGROUP' ? { type: n.type, networkMoref: n.moref } : { type: n.type, networkName: n.name }));
  if (nicAddList.length) plan.nicAdds = nicAddList;
  const removes = f.nicRemoves || new Set();
  if (removes.size) plan.nicRemoves = [...removes];
  const conn = f.nicConn || {};
  const nicConnects = (hw.nics || []).filter((n) => !removes.has(n.key) && conn[n.key] !== n.connected).map((n) => ({ key: n.key, connected: !!conn[n.key] }));
  if (nicConnects.length) plan.nicConnects = nicConnects;
  return plan;
}

/** 확인 창 · 아래 줄의 변경 목록(계획과 같은 기준값). */
export function reconfigSummary(hw, f, networks = []) {
  const s = [];
  if (!hw) return s;
  if (cpuKnown(hw) && numOr(f.cpu, hw.cpu) !== hw.cpu) s.push(`vCPU ${hw.cpu}→${numOr(f.cpu, hw.cpu)}`);
  if (cpuKnown(hw) && numOr(f.cps, cps0(hw)) !== cps0(hw) && numOr(f.cps, 0) >= 1) s.push(`코어/소켓 →${numOr(f.cps, 0)}`);
  // 2차 공통 기능 점검 8회차: 계획과 같은 기준값 — 예전엔 memMB 가 없으면 NaN 과 비교해 늘 'RAM NaN→0GB' 를 확인 창에 띄웠다. 54회차 F4: 모르면 싣지 않는다.
  { const r0 = ramGB0(hw); if (r0 != null && numOr(f.ramGB, r0) !== r0) s.push(`RAM ${r0}→${numOr(f.ramGB, 0)}GB`); }
  Object.entries(f.grows || {}).forEach(([key, gb]) => { const d = (hw.disks || []).find((x) => x.key === Number(key)); if (diskCapKnown(d) && numOr(gb, 0) > d.capacityGB) s.push(`${d.label} ${d.capacityGB}→${numOr(gb, 0)}GB`); });
  (f.adds || []).forEach((a) => { if (numOr(a.gb, 0) > 0) s.push(`디스크 추가 +${numOr(a.gb, 0)}GB${a.ds ? ` (${a.ds})` : ''}`); });
  (f.nicAdds || []).forEach((id) => { const n = networks.find((x) => x.id === id); if (n) s.push(`NIC 추가(${n.name})`); });
  const removes = f.nicRemoves || new Set();
  [...removes].forEach((k) => { const n = (hw.nics || []).find((x) => x.key === k); if (n) s.push(`NIC 삭제(${n.network || n.macAddress || k})`); });
  const conn = f.nicConn || {};
  (hw.nics || []).forEach((n) => { if (!removes.has(n.key) && conn[n.key] !== n.connected) s.push(`NIC ${conn[n.key] ? '연결' : '연결해제'}(${n.network || n.key})`); });
  return s;
}

/** 못 읽어 잠근 항목 이름(화면 안내 줄) — 없으면 빈 배열. */
export function lockedItems(hw) {
  if (!hw) return [];
  const out = [];
  if (!cpuKnown(hw)) out.push('vCPU · 코어/소켓');
  if (!memKnown(hw)) out.push('RAM');
  const nd = (hw.disks || []).filter((d) => !diskCapKnown(d)).length;
  if (nd) out.push(`디스크 증설 ${nd}개`);
  return out;
}
