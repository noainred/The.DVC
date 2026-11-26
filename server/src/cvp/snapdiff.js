/**
 * cvp/snapdiff.js — ⑬ 작업 전후 비교(순수, v3.38 — docs/design/cvp-network-features §3 '전후 비교').
 *
 * 스냅샷 본문(장비 하나) = 그 시각 중앙 DB 의 최신값 복사: 버전 · 포트(상태 · 속도 · VLAN · 채널 · 설명 · MTU) · BGP 피어 상태 · 트랜시버 장착 · LLDP 이웃.
 *   못 읽은 묶음은 null 로 둔다(빈 배열과 다르다).
 * 비교: 한쪽이 못 읽은 묶음은 '비교 못 함'(na)이지 '달라짐' 이 아니다. 한쪽에만 있는 장비는 added/removed. 같은 값은 내지 않는다.
 */
import { intfOfPartName } from './portmap.js';

export const DIFF_ROWS_MAX = 5000;
const s = (v, n = 200) => (v == null ? null : String(v).slice(0, n));
const num = (v) => { const n = Number(v); return v == null || v === '' || !Number.isFinite(n) ? null : n; };

/**
 * @param {{ device:{hostname,model,serial,eosVersion,collectedAt,portsRead,partsList,bgpPeers}, ports:Array|null, lldp:{rows:Array, read:boolean}|null }} a
 */
export function snapshotBody({ device = {}, ports = null, lldp = null } = {}) {
  const x = Array.isArray(device.partsList) ? device.partsList.filter((p) => p && p.kind === 'xcvr') : null;
  return {
    h: s(device.hostname, 128), m: s(device.model, 64), v: s(device.eosVersion, 64), at: num(device.collectedAt),
    p: device.portsRead && Array.isArray(ports) ? ports.map((p) => [s(p.port ?? p.name, 64), linkWord(p.oper), linkWord(p.admin), num(p.speedBps ?? p.speed_bps), s(p.vlan, 32), p.lag == null ? null : s(p.lag, 64), p.desc === undefined ? s(p.descr) : s(p.desc), num(p.mtu)]) : null,
    b: Array.isArray(device.bgpPeers) ? device.bgpPeers.slice(0, 512).map((b) => [s(b.peer ?? b.peerAddress, 64), s(b.vrf, 64) || 'default', s(b.state, 32)]) : null,
    x: x && x.length ? x.slice(0, 512).map((p) => [intfOfPartName(p.name) || s(p.name, 96), p.state === 'absent' ? 0 : 1, s(p.media, 48)]) : null,
    l: lldp && lldp.read ? (lldp.rows || []).slice(0, 512).map((r) => [s(r.port, 64), s(r.sysName, 128), s(r.portId, 64)]) : null,
  };
}

/** v3.42(2회차 반증 R2): 'unknown'(못 읽음 — 일부 목록이 남긴 옛 행 등)은 값이 아니다 — null 로 둬 비교에서 뺀다(예전: 'up → unknown' 이 거짓 '바뀜' 32건). */
const unk = (v) => v == null || v === 'unknown';
function linkWord(v) { const w = s(v, 16); return w === 'unknown' ? null : w; }
const PORT_FIELDS = Object.freeze([[1, 'oper'], [2, 'admin'], [3, 'speed'], [4, 'vlan'], [5, 'lag'], [6, 'desc'], [7, 'mtu']]);
/** 장비 하나 비교 → { changes:[{ kind, item, field, before, after }], na:[묶음] } */
export function diffDevice(a, b) {
  const ch = []; const na = [];
  const push = (kind, item, field, before, after) => ch.push({ kind, item, field, before, after });
  if (a.v !== b.v && a.v != null && b.v != null) push('device', '', 'version', a.v, b.v);
  // 포트
  if (a.p == null || b.p == null) na.push('ports');
  else {
    const am = new Map(a.p.map((r) => [r[0], r])); const bm = new Map(b.p.map((r) => [r[0], r]));
    let portStateNa = false;
    for (const [name, ra] of am) {
      const rb = bm.get(name);
      if (!rb) { push('port', name, 'removed', null, null); continue; }
      for (const [i, f] of PORT_FIELDS) {
        // 한쪽 못 읽음 — 이 칸은 비교하지 않는다(옛 스냅샷의 'unknown' 포함). 링크 상태를 **한쪽만** 못 읽은 포트가 있으면 '비교 못 함(포트 상태 일부)' 로 따로 센다
        //   (3회차 A1-F3: 일부 목록으로 32포트를 비교 못 한 장비가 '그대로 1대' 로 셌다). 양쪽 다 모르는 포트(늘 모름)는 세지 않는다 — 잃은 비교가 없다.
        if (unk(ra[i]) || unk(rb[i])) { if (i === 1 && unk(ra[i]) !== unk(rb[i])) portStateNa = true; continue; }
        if (ra[i] !== rb[i]) push('port', name, f, ra[i], rb[i]);
      }
    }
    for (const name of bm.keys()) if (!am.has(name)) push('port', name, 'added', null, null);
    if (portStateNa) na.push('portState');
  }
  // BGP
  if (a.b == null || b.b == null) na.push('bgp');
  else {
    const k = (r) => `${r[1]}|${r[0]}`;
    const am = new Map(a.b.map((r) => [k(r), r])); const bm = new Map(b.b.map((r) => [k(r), r]));
    for (const [key, ra] of am) {
      const rb = bm.get(key);
      if (!rb) push('bgp', key, 'removed', ra[2], null);
      else if (ra[2] != null && rb[2] != null && ra[2] !== rb[2]) push('bgp', key, 'state', ra[2], rb[2]);
    }
    for (const [key, rb] of bm) if (!am.has(key)) push('bgp', key, 'added', null, rb[2]);
  }
  // 트랜시버
  if (a.x == null || b.x == null) na.push('xcvr');
  else {
    const am = new Map(a.x.map((r) => [r[0], r])); const bm = new Map(b.x.map((r) => [r[0], r]));
    for (const [n, ra] of am) {
      const rb = bm.get(n);
      if (!rb) continue;
      if (ra[1] !== rb[1]) push('xcvr', n, ra[1] ? 'pulled' : 'inserted', ra[2], rb[2]);
      else if (ra[1] && ra[2] && rb[2] && ra[2] !== rb[2]) push('xcvr', n, 'type', ra[2], rb[2]);
    }
  }
  // LLDP
  if (a.l == null || b.l == null) na.push('lldp');
  else {
    const g = (rows) => { const m = new Map(); for (const r of rows) { if (!m.has(r[0])) m.set(r[0], []); m.get(r[0]).push(`${r[1] || ''}${r[2] ? ` ${r[2]}` : ''}`); } for (const v of m.values()) v.sort(); return m; };
    const am = g(a.l); const bm = g(b.l);
    for (const port of new Set([...am.keys(), ...bm.keys()])) {
      const x = (am.get(port) || []).join(', '); const y = (bm.get(port) || []).join(', ');
      if (x !== y) push('lldp', port, 'neighbor', x || null, y || null);
    }
  }
  return { changes: ch, na };
}

/**
 * @param {Map<string,object>} before  장비 id → 본문
 * @param {Map<string,object>} after
 * @returns {{ devices:Array<{id, hostname, state:'changed'|'added'|'removed', changes, na}>, counts, unchanged:number, omitted:number }}
 */
export function diffSnapshots(before, after, { broken = new Set() } = {}) {
  const out = []; let unchanged = 0; let rowsN = 0;
  const counts = { devicesChanged: 0, added: 0, removed: 0, device: 0, port: 0, bgp: 0, xcvr: 0, lldp: 0, naDevices: 0 };
  // v3.42(A2-F7): 스냅샷 본문이 깨진 장비는 '사라짐 · 새로 생김' 이 아니라 '비교 못 함'.
  for (const id of broken) {
    if (before.has(id) && after.has(id)) continue;
    counts.naDevices++;
    const x = before.get(id) || after.get(id) || {};
    out.push({ id, hostname: x.h || '', state: 'na', changes: [], na: ['broken'] });
  }
  for (const [id, a] of before) {
    if (broken.has(id) && !after.has(id)) continue;
    const b = after.get(id);
    if (!b) { counts.removed++; out.push({ id, hostname: a.h || '', state: 'removed', changes: [], na: [] }); continue; }
    const d = diffDevice(a, b);
    if (d.na.length) counts.naDevices++;
    // v3.42(A2-F8): '그대로' 는 비교 못 한 묶음이 없는 장비만 센다(일부를 못 읽은 장비가 '그대로' 에 섞였다).
    if (!d.changes.length) { if (d.na.length) out.push({ id, hostname: b.h || a.h || '', state: 'na', changes: [], na: d.na }); else unchanged++; continue; }
    counts.devicesChanged++;
    for (const c of d.changes) counts[c.kind]++;
    rowsN += d.changes.length;
    out.push({ id, hostname: b.h || a.h || '', state: 'changed', changes: d.changes, na: d.na });
  }
  for (const [id, b] of after) if (!before.has(id) && !broken.has(id)) { counts.added++; out.push({ id, hostname: b.h || '', state: 'added', changes: [], na: [] }); }
  const order = { changed: 0, removed: 1, added: 2, na: 3 };
  out.sort((x, y) => (order[x.state] - order[y.state]) || String(x.hostname).localeCompare(String(y.hostname)));
  // 바뀐 항목 상한(장비 단위로 자른다 — 한 장비의 일부만 보이지 않게)
  let acc = 0; let cut = out.length;
  for (let i = 0; i < out.length; i++) { acc += out[i].changes.length; if (acc > DIFF_ROWS_MAX) { cut = i; break; } }
  return { devices: out.slice(0, cut), counts, unchanged, omitted: out.length - cut, changeRows: rowsN };
}
