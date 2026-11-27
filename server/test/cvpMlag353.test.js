/**
 * test/cvpMlag353.test.js — v3.53 사용자 결정 2건(2026-11-26).
 *  ① D-8 토폴로지 — 장비가 알린 MLAG 상태로 피어 확정 · MLAG 쌍과 채널 구성으로 '모양만으로 못 가르던' 층을 판정
 *  ② 호스트 업링크 — 같은 법인에 짧은 이름이 같은 다른 호스트가 있으면 짧은 이름 LLDP 근거를 쓰지 않는다
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { stripComments } from './_stripComments.js';

const TP = await import('../src/cvp/topology.js');
const HM = await import('../src/cvp/hostMatch.js');

const ms = (domain, state = 'active') => ({ state, negotiation: 'connected', peerLinkState: 'up', peerLink: 'Port-Channel1000', domain });
const D = (key, info = null) => ({ agent: '', cvpId: 'c1', key, hostname: key, ...(info ? { info: { mlagStatus: info } } : {}) });
/** edges: [a, b, kind] — kind 'peer' 는 피어 링크. lagOf(me, other, kind) → 그 끝 포트의 채널 소속('' = 없음 · null = 모름). */
function topo(devices, edges, lagOf) {
  const lldp = []; const ports = []; const pn = new Map();
  const next = (k) => { const n = (pn.get(k) || 0) + 1; pn.set(k, n); return `Ethernet${n}`; };
  for (const [a, b, kind] of edges) {
    const pa = next(a); const pb = next(b);
    lldp.push({ agent: '', cvpId: 'c1', key: a, port: pa, sysName: b, portId: pb }, { agent: '', cvpId: 'c1', key: b, port: pb, sysName: a, portId: pa });
    ports.push({ agent: '', cvpId: 'c1', key: a, port: pa, oper: 'up', desc: '', lag: lagOf(a, b, kind) }, { agent: '', cvpId: 'c1', key: b, port: pb, oper: 'up', desc: '', lag: lagOf(b, a, kind) });
  }
  const t = TP.buildTopology({ devices, lldp, ports });
  return Object.fromEntries(t.nodes.map((n) => [n.hostname, n]));
}
const routed = (a, b, kind) => (kind === 'peer' ? 'Port-Channel1000' : '');
const layers = (by) => Object.fromEntries(Object.entries(by).map(([k, n]) => [k, n.layer]));

test('① D-8 — 스파인 4 + 리프 MLAG 쌍 2 · 4대 대칭은 MLAG 상태로 바르게', () => {
  const sp = ['s1', 's2', 's3', 's4']; const lf = ['l1', 'l2', 'l3', 'l4'];
  const e = []; for (const l of lf) for (const s of sp) e.push([l, s, 'up']); e.push(['l1', 'l2', 'peer'], ['l3', 'l4', 'peer']);
  const before = layers(topo([...sp, ...lf].map((k) => D(k)), e, routed));
  assert.deepEqual([before.s1, before.l1], ['leaf', 'spine'], '대조: 모양만으로는 뒤집혔다(예전 판정 — 한계였던 것)');
  // 도메인 ID 는 쌍마다 같은 값('mlag')을 다시 쓴다 — 직접 연결이 아닌 l1 · l3 를 쌍으로 묶지 않는다
  const by = topo([...sp.map((k) => D(k, ms(null, 'disabled'))), ...lf.map((k) => D(k, ms('mlag')))], e, routed);
  assert.deepEqual(layers(by), { s1: 'spine', s2: 'spine', s3: 'spine', s4: 'spine', l1: 'leaf', l2: 'leaf', l3: 'leaf', l4: 'leaf' });
  assert.deepEqual([by.l1.mlagBy, by.l1.layerBy, by.s1.mlagPeer, by.s1.layerBy], ['status', 'mlag', false, 'mlag']);
  const sym = [['l1', 's1', 'up'], ['l1', 's2', 'up'], ['l2', 's1', 'up'], ['l2', 's2', 'up'], ['l1', 'l2', 'peer']];
  assert.deepEqual(layers(topo([D('s1', ms(null, 'disabled')), D('s2', ms(null, 'disabled')), D('l1', ms('mlag')), D('l2', ms('mlag'))], sym, routed)), { s1: 'spine', s2: 'spine', l1: 'leaf', l2: 'leaf' });
});

test('① D-8 — 코어 쌍(채널을 내줌)은 위층 · 판정 못 하는 경우는 예전 그대로', () => {
  const e = [['a1', 'c1x', 'up'], ['a1', 'c2x', 'up'], ['a2', 'c1x', 'up'], ['a2', 'c2x', 'up'], ['c1x', 'c2x', 'peer']];
  const chan = (me, other, kind) => (kind === 'peer' ? 'Port-Channel1000' : `Port-Channel${me.startsWith('c') ? (other === 'a1' ? 11 : 12) : 1}`);
  assert.deepEqual(layers(topo([D('c1x', ms('core')), D('c2x', ms('core')), D('a1', ms(null, 'disabled')), D('a2', ms(null, 'disabled'))], e, chan)), { c1x: 'spine', c2x: 'spine', a1: 'leaf', a2: 'leaf' });
  // 채널 소속을 모르면(null) 층은 정하지 않는다 — 피어는 확정
  const sym = [['l1', 's1', 'up'], ['l1', 's2', 'up'], ['l2', 's1', 'up'], ['l2', 's2', 'up'], ['l1', 'l2', 'peer']];
  const unk = topo([D('s1', ms(null, 'disabled')), D('s2', ms(null, 'disabled')), D('l1', ms('mlag')), D('l2', ms('mlag'))], sym, (a, b, k) => (k === 'peer' ? 'Port-Channel1000' : null));
  assert.deepEqual([unk.l1.mlagBy, unk.l1.layerBy, unk.s1.layerBy], ['status', undefined, undefined]);
  // 양쪽 다 MLAG 쌍이면 이 규칙으로 가를 수 없다(정하지 않는다)
  const both = topo([D('s1', ms('sp')), D('s2', ms('sp')), D('l1', ms('lf')), D('l2', ms('lf'))], [...sym, ['s1', 's2', 'peer']], routed);
  assert.ok(Object.values(both).every((n) => n.layerBy == null && n.mlagBy === 'status'));
});

test('① D-8 — 피어 확정 조건(피어 링크 멤버 · 도메인 · active) · disabled 는 모양 추정 피어도 아니다', () => {
  const sym = [['l1', 's1', 'up'], ['l1', 's2', 'up'], ['l2', 's1', 'up'], ['l2', 's2', 'up'], ['l1', 'l2', 'peer']];
  // 피어 링크 채널 멤버가 아닌 포트로만 이어져 있으면 확정하지 않는다
  const noPl = topo([D('s1'), D('s2'), D('l1', ms('mlag')), D('l2', ms('mlag'))], sym, () => '');
  assert.equal(noPl.l1.mlagBy, undefined);
  // 도메인이 다르면 쌍이 아니다 · 한쪽이 inactive 면 확정하지 않는다
  assert.equal(topo([D('s1'), D('s2'), D('l1', ms('a')), D('l2', ms('b'))], sym, routed).l1.mlagBy, undefined);
  assert.equal(topo([D('s1'), D('s2'), D('l1', ms('m')), D('l2', ms('m', 'inactive'))], sym, routed).l1.mlagBy, undefined);
  // MLAG 를 'disabled' 로 알린 장비는 연결 모양만으로도 피어로 잡지 않는다
  const tri = [['s', 'a', 'up'], ['s', 'b', 'up'], ['t', 'a', 'up'], ['t', 'b', 'up'], ['a', 'b', 'up']];
  const shapeOnly = topo(['s', 't', 'a', 'b'].map((k) => D(k)), tri, routed);
  const off = topo([D('s'), D('t'), D('a', ms(null, 'disabled')), D('b', ms(null, 'disabled'))], tri, routed);
  assert.equal(off.a.mlagPeer, false);
  assert.equal(shapeOnly.a.mlagPeer, true, '대조: MLAG 상태가 없으면 연결 모양으로 피어(직접 연결 + 이웃 공유)');
});

test('② 호스트 업링크 — 짧은 이름이 겹치면 짧은 이름 LLDP 근거를 쓰지 않는다', () => {
  const host = { id: 'vc-a:h1', name: 'esx01', nics: [{ device: 'vmnic0', mac: '00:50:56:00:00:01' }] };
  const row = (sysName, extra = {}) => ({ agent: '', cvpId: 'c', key: 'sw', hostname: 'sw', port: 'Ethernet1', sysName, sysLc: sysName.toLowerCase(), sysShort: sysName.toLowerCase().split('.')[0], portId: 'vmnic0', ...extra });
  assert.equal(HM.matchL2({ host, lldpRows: [row('esx01')] }).uplinks.length, 1, '대조: 겹치지 않으면 근거');
  assert.equal(HM.matchL2({ host, lldpRows: [row('esx01')], shortAmbiguous: true }).uplinks.length, 0, '짧은 이름이 겹치면 근거가 아니다');
  assert.equal(HM.matchL2({ host, lldpRows: [row('esx01', { chassisId: '00:50:56:00:00:01' })], shortAmbiguous: true }).uplinks.length, 1, '섀시 MAC 이 맞으면 근거');
  const fq = { ...host, name: 'esx01.a.corp' };
  assert.equal(HM.matchL2({ host: fq, lldpRows: [row('esx01.a.corp')], shortAmbiguous: true }).uplinks.length, 1, '전체 이름이 맞으면 근거');
  const r = stripComments(fs.readFileSync(new URL('../src/routes/api/hostSan.js', import.meta.url), 'utf8'));
  // 반증 F8 · F9 · F10: 법인을 모르는 호스트도 센다 · IP 이름은 통째로 · 화면 표지는 그 계정이 볼 수 있는 호스트와 겹칠 때만
  assert.match(r, /const myShort = cvpShortOf\(h\.name\);/);
  assert.match(r, /anyUnassigned \|\| !hostCorp \|\| !String\(datacenterOfVcenter\(x\.vcenterId\) \|\| ''\) \|\| String\(datacenterOfVcenter\(x\.vcenterId\) \|\| ''\) === hostCorp/);
  assert.match(r, /ambiguousShown = collide\.some\(\(x\) => inUserScope\(req\.user, snap, x\.vcenterId\)\);/);
  assert.match(r, /\.\.\.\(ambiguousShown \? \{ lldpNameAmbiguous: true \} : \{\}\)/);
});

test('① D-8 — 경계: 모양으로 못 잡는 쌍 · 후보 둘 · 한쪽만 disabled · 소속 일부 모름 · 양쪽 MLAG', () => {
  // 업링크 둘이 내려간 리프 쌍 — 모양 추정으로는 쌍이 아니지만(공유 이웃 부족) MLAG 상태로 확정
  const down = [['l1', 's1', 'up'], ['l1', 's2', 'up'], ['l1', 's3', 'up'], ['l2', 's1', 'up'], ['l1', 'l2', 'peer']];
  const shape = topo(['s1', 's2', 's3', 'l1', 'l2'].map((k) => D(k)), down, routed);
  const st = topo([D('s1'), D('s2'), D('s3'), D('l1', ms('m')), D('l2', ms('m'))], down, routed);
  assert.deepEqual([shape.l1.mlagPeer, st.l1.mlagPeer, st.l2.mlagPeer, st.l1.mlagBy], [false, true, true, 'status']);
  // 확정 쌍 장비(l1)와 모양이 더 닮은 다른 장비(x)를 모양 추정으로 짝짓지 않는다
  const near = topo([D('s1'), D('s2'), D('s3'), D('x'), D('l1', ms('m')), D('l2', ms('m'))],
    [['l1', 'x', 'up'], ['l1', 's1', 'up'], ['l1', 's2', 'up'], ['l1', 's3', 'up'], ['x', 's1', 'up'], ['x', 's2', 'up'], ['x', 's3', 'up'], ['l2', 's1', 'up'], ['l1', 'l2', 'peer']], routed);
  assert.deepEqual([near.l1.mlagBy, near.x.mlagPeer], ['status', false]);
  // 피어 링크 멤버로 둘과 이어진 장비는 쌍을 정하지 않는다
  const tri = topo([D('s1'), D('l1', ms('m')), D('l2', ms('m')), D('l3', ms('m'))], [['l1', 'l2', 'peer'], ['l1', 'l3', 'peer'], ['l1', 's1', 'up']], routed);
  assert.equal(tri.l1.mlagBy, undefined);
  // 한쪽만 MLAG 'disabled' 여도 모양 추정 쌍이 아니다
  const sq = [['s', 'a', 'up'], ['s', 'b', 'up'], ['t', 'a', 'up'], ['t', 'b', 'up'], ['a', 'b', 'up']];
  assert.equal(topo([D('s'), D('t'), D('a', ms(null, 'disabled')), D('b')], sq, routed).a.mlagPeer, false);
  // 리프 쌍이 스파인을 향한 포트 가운데 하나라도 소속을 모르면 층을 정하지 않는다
  const sym = [['l1', 's1', 'up'], ['l1', 's2', 'up'], ['l2', 's1', 'up'], ['l2', 's2', 'up'], ['l1', 'l2', 'peer']];
  const partUnk = topo([D('s1', ms(null, 'disabled')), D('s2', ms(null, 'disabled')), D('l1', ms('m')), D('l2', ms('m'))], sym,
    (a, b, k) => (k === 'peer' ? 'Port-Channel1000' : a === 'l1' && b === 's2' ? null : ''));
  assert.equal(partUnk.l1.layerBy, undefined);
  // 양쪽 다 MLAG 쌍 — 채널 방향이 한쪽으로 맞아도 이 규칙은 쓰지 않는다
  const both = topo([D('s1', ms('sp')), D('s2', ms('sp')), D('l1', ms('lf')), D('l2', ms('lf'))], [...sym, ['s1', 's2', 'peer']],
    (a, b, k) => (k === 'peer' ? 'Port-Channel1000' : a.startsWith('s') ? 'Port-Channel20' : ''));
  assert.ok(Object.values(both).every((n) => n.layerBy == null));
});

/* ── 반증 1인(F1~F10) — 뒤집힌 리프-스파인 모양만 바로잡는다 ─────────────────────────────────────────────────── */
test('① D-8 반증 — 채널 업링크 · 3단 · 설명 링크 · disabled 는 예전 판정 그대로 · 엇갈린 판정은 통째로 버림', () => {
  const sp = ['s1', 's2']; const lf = ['l1', 'l2', 'l3', 'l4'];
  const e = []; for (const l of lf) for (const s of sp) e.push([l, s, 'up']); e.push(['l1', 'l2', 'peer'], ['l3', 'l4', 'peer']);
  // F2: 리프 쌍이 스파인마다 라우팅 포트 채널(로컬 LACP)로 올라간다 — '채널 = 위층' 으로 뒤집지 않는다
  const lacp = (me, other, kind) => (kind === 'peer' ? 'Port-Channel1000' : `Port-Channel${me}${other}`);
  const old = layers(topo([...sp, ...lf].map((k) => D(k)), e, lacp));
  const now = topo([...sp.map((k) => D(k, ms(null, 'disabled'))), ...lf.map((k) => D(k, ms('m')))], e, lacp);
  assert.deepEqual(layers(now), old); assert.ok(Object.values(now).every((n) => n.layerBy == null));
  // F3: 3단(단독 코어 c ↔ 분배 MLAG 쌍(채널) ↔ 접속) — 코어를 리프로 내리지 않는다
  const t3 = [['c', 'd1', 'up'], ['c', 'd2', 'up'], ['d1', 'd2', 'peer'], ['d1', 'a1', 'up'], ['d2', 'a1', 'up'], ['d1', 'a2', 'up'], ['d2', 'a2', 'up']];
  const ch = (me, other, kind) => (kind === 'peer' ? 'Port-Channel1000' : 'Port-Channel10');
  const o3 = layers(topo(['c', 'd1', 'd2', 'a1', 'a2'].map((k) => D(k)), t3, ch));
  assert.deepEqual(layers(topo([D('c', ms(null, 'disabled')), D('d1', ms('d')), D('d2', ms('d')), D('a1', ms(null, 'disabled')), D('a2', ms(null, 'disabled'))], t3, ch)), o3);
  // F6: 전부 MLAG 'disabled' 면 층은 MLAG 정보가 없을 때와 같다(피어 표시만 뺀다) — 작은 무작위 구성 300개
  let seed = 7; const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  for (let c = 0; c < 300; c++) {
    const n = 3 + Math.floor(rnd() * 6); const ks = Array.from({ length: n }, (_, i) => `k${i}`);
    const ed = []; for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) if (rnd() < 0.45) ed.push([ks[i], ks[j], 'up']);
    const a0 = layers(topo(ks.map((k) => D(k)), ed, routed));
    const a1 = topo(ks.map((k) => D(k, ms(null, 'disabled'))), ed, routed);
    assert.deepEqual(layers(a1), a0, JSON.stringify(ed));
    assert.ok(Object.values(a1).every((x) => x.mlagPeer === false && x.layerBy == null));
  }
});

test('① D-8 반증 — 설명으로만 이어진 장비 · 범위 밖 판정 · 링크 색인', () => {
  // F5: 리프 쌍의 포트 설명으로만 가리킨 접속 스위치는 이웃(N)이 아니다 — 스파인으로 올리지 않는다
  const sym = [['l1', 's1', 'up'], ['l1', 's2', 'up'], ['l2', 's1', 'up'], ['l2', 's2', 'up'], ['l1', 'l2', 'peer']];
  const devices = [D('s1', ms(null, 'disabled')), D('s2', ms(null, 'disabled')), D('l1', ms('m')), D('l2', ms('m')), D('acc1', ms(null, 'disabled'))];
  const lldp = []; const ports = []; const pn = new Map();
  const next = (k) => { const n = (pn.get(k) || 0) + 1; pn.set(k, n); return `Ethernet${n}`; };
  for (const [a, b, kind] of sym) {
    const pa = next(a); const pb = next(b);
    lldp.push({ agent: '', cvpId: 'c1', key: a, port: pa, sysName: b, portId: pb }, { agent: '', cvpId: 'c1', key: b, port: pb, sysName: a, portId: pa });
    ports.push({ agent: '', cvpId: 'c1', key: a, port: pa, oper: 'up', desc: '', lag: kind === 'peer' ? 'Port-Channel1000' : '' }, { agent: '', cvpId: 'c1', key: b, port: pb, oper: 'up', desc: '', lag: kind === 'peer' ? 'Port-Channel1000' : '' });
  }
  ports.push({ agent: '', cvpId: 'c1', key: 'l1', port: 'Ethernet40', oper: 'up', desc: 'acc1 Et49', lag: 'Port-Channel40' });
  const t = Object.fromEntries(TP.buildTopology({ devices, lldp, ports }).nodes.map((n) => [n.hostname, n]));
  assert.deepEqual([t.l1.layer, t.s1.layer, t.acc1.layer, t.acc1.layerBy], ['leaf', 'spine', 'leaf', undefined]);
  // F1: 쌍마다 전체 링크를 훑지 않는다(장비별 링크 색인)
  const src = stripComments(fs.readFileSync(new URL('../src/cvp/topology.js', import.meta.url), 'utf8'));
  assert.match(src, /for \(const l of linksByDev\.get\(me\) \|\| \[\]\)/);
  assert.match(src, /import \{ mlagRoleOf \} from '\.\/redundancy\.js';/, '이중화 판정과 같은 MLAG 상태 글자 규칙');
});

test('① D-8 반증 — 고치는 것은 뒤집힌 모양뿐(이미 맞으면 손대지 않음 · 이웃 상태 모름 · 한쪽만 이어진 이웃)', () => {
  // 스파인 2 · 리프 쌍 3 — 예전 판정이 이미 맞다: MLAG 로 덮지 않는다(layerBy 없음)
  const sp = ['s1', 's2']; const lf = ['l1', 'l2', 'l3', 'l4', 'l5', 'l6'];
  const e = []; for (const l of lf) for (const s of sp) e.push([l, s, 'up']); e.push(['l1', 'l2', 'peer'], ['l3', 'l4', 'peer'], ['l5', 'l6', 'peer']);
  const ok3 = topo([...sp.map((k) => D(k, ms(null, 'disabled'))), ...lf.map((k) => D(k, ms('m')))], e, routed);
  assert.deepEqual([ok3.s1.layer, ok3.l1.layer, ok3.s1.layerBy, ok3.l1.layerBy], ['spine', 'leaf', undefined, undefined]);
  // 뒤집힌 모양이어도 이웃(스파인)의 MLAG 상태를 읽지 못했으면 고치지 않는다
  const sp4 = ['s1', 's2', 's3', 's4']; const lf4 = ['l1', 'l2', 'l3', 'l4'];
  const e4 = []; for (const l of lf4) for (const s of sp4) e4.push([l, s, 'up']); e4.push(['l1', 'l2', 'peer'], ['l3', 'l4', 'peer']);
  const unread = topo([...sp4.map((k) => D(k)), ...lf4.map((k) => D(k, ms('m')))], e4, routed);
  assert.ok(Object.values(unread).every((n) => n.layerBy == null));
  // 쌍의 한 장비에만 이어진 이웃이 있으면 그 쌍은 고치지 않는다
  const e5 = [...e4, ['l1', 's5', 'up']];
  const one = topo([...[...sp4, 's5'].map((k) => D(k, ms(null, 'disabled'))), ...lf4.map((k) => D(k, ms('m')))], e5, routed);
  assert.deepEqual([one.l1.layerBy, one.l2.layerBy, one.l3.layerBy], [undefined, undefined, 'mlag'], '대조: 다른 쌍(l3 · l4)은 고친다');
});
