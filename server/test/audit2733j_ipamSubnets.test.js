// v2.733 점검 3회차 그룹 j — C6-01: `/tools/ipam/subnets`(V4·관제 콘솔 네트워크 60초 폴링)가 live 에서 폴링마다 원장 전체를
//   **동기로** 다시 만들고 /24 마다 256행 시트까지 조립하던 것.
//   원인: 원장 캐시 키가 스냅샷 세대(generatedAt — 30초마다 바뀜)인데 v2.619 이후 입력이 그대로면 store 가 원장 재구성을 건너뛰므로
//   새 세대의 캐시는 언제나 비어 있었다. 이제 서브넷 목록은 '원장 입력 지문 + vCenter + 범위 + 관리 리비전 + 데이터센터 귀속' 으로 기억하고
//   시트 없이 원장 행에서 직접 센다. ⚠ 성능 수정이므로 결과가 예전(buildSubnetSheets 의 subnet·base·used)과 같아야 한다 — ① 이 대조한다
//   (비정규 끝 조각 '05'·선행 0·앞뒤 공백·.0·.255·범위 밖 IP 를 일부러 넣는다).
//  ⚠ CONFIG_DIR 은 import 전에 고정한다(config.js 가 import 시점에 굳는다) — 모듈은 before() 에서 동적으로 읽는다.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2733j-subnets-'));
process.env.CONFIG_DIR = tmp;
process.env.DATA_SOURCE = 'mock';
process.env.AUTH_ENABLED = 'false';
process.env.IPAM_WRITE_DEBOUNCE_MS = '60000';

let st, led, ss, ov, rp, srv, baseUrl;
before(async () => {
  st = await import('../src/store.js');
  led = await import('../src/ipam/ledger.js');
  ss = await import('../src/ipam/scanStore.js');
  ov = await import('../src/ipam/overrides.js');
  rp = await import('../src/ipam/rangePolicies.js');
  const express = (await import('express')).default;
  const { api } = await import('../src/routes/api.js');
  const app = express();
  app.use(express.json());
  app.use('/api', api);
  srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  baseUrl = `http://127.0.0.1:${srv.address().port}/api`;
});
after(async () => {
  if (srv) await new Promise((r) => srv.close(r));
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ }
});

// 결정적 난수(mulberry32)
function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
let gen = 0;
/** 옛 구현 — v2.732 의 listSubnets 본문 그대로(시트를 만든 뒤 세 값만). /sheet 화면의 used 와도 같아야 한다. */
const oldList = (snap, vc, allowed) => led.buildSubnetSheets(snap, { vcenterId: vc, allowed }).map((s) => ({ subnet: s.subnet, base: s.base, used: s.used }));

/** IP 표기 — 정규형 외에 시트가 다르게 다루는 변형을 섞는다. */
function ipVariant(r, a, b, c, d) {
  const k = Math.floor(r() * 14);
  switch (k) {
    case 0: return `${a}.${b}.${c}.0${d}`;          // 비정규 끝 조각('05') — ipNum 은 있고 시트는 찾지 못한다
    case 1: return `0${a}.${b}.${c}.${d}`;          // 선행 0 첫 조각 — base 자체가 비정규('010.x.y')
    case 2: return ` ${a}.${b}.${c}.${d}`;          // 앞 공백(ipToNum 은 다듬는다)
    case 3: return `${a}.${b}.${c}.${d} `;          // 뒤 공백
    case 4: return `${a}.${b}.${c}.0`;              // 네트워크 주소 — 세지 않는다
    case 5: return `${a}.${b}.${c}.255`;            // .255 는 센다
    case 6: return `${a}.${b}.${c}.256`;            // 범위 밖 — ipNum null
    case 7: return `${a}.${b}.${c}`;                // 조각 셋 — ipNum null
    case 8: return `${a}.${b}.${c}.000${d}`;        // 긴 선행 0
    default: return `${a}.${b}.${c}.${d}`;
  }
}
function randomSnap(seed) {
  const r = rng(seed);
  const vms = []; const hosts = [];
  const nVm = 60 + Math.floor(r() * 140);
  for (let i = 0; i < nVm; i++) {
    const vc = r() < 0.5 ? 'vc1' : (r() < 0.7 ? 'vc2' : 'vc3');
    const nIp = r() < 0.15 ? 0 : (r() < 0.8 ? 1 : 2);
    const ips = [];
    for (let j = 0; j < nIp; j++) ips.push(ipVariant(r, 10, Math.floor(r() * 3), Math.floor(r() * 6), 1 + Math.floor(r() * 254)));
    vms.push({ id: `vm-${i}`, name: `vm${i}`, vcenterId: vc, ipAddresses: r() < 0.2 ? [] : ips, ipAddress: ips[0] || '', powerState: r() < 0.7 ? 'POWERED_ON' : 'POWERED_OFF', guestOS: 'CentOS 7 (64-bit)', host: `esx${i % 4}`, cluster: 'C1' });
  }
  for (let i = 0; i < 8; i++) {
    const vc = i % 2 ? 'vc1' : 'vc2';
    hosts.push({ id: `h-${i}`, name: r() < 0.3 ? `esx${i}.example` : ipVariant(r, 10, 9, Math.floor(r() * 2), 1 + Math.floor(r() * 254)), vcenterId: vc, powerState: 'POWERED_ON', version: '8.0.2', cluster: 'C1' });
  }
  return { generatedAt: `g-eq-${++gen}`, vcenters: [{ id: 'vc1', name: 'SEOUL' }, { id: 'vc2', name: 'TOKYO' }, { id: 'vc3', name: 'PARIS' }], vms, hosts, datastores: [], networks: [], alarms: [] };
}

test('① 결과 동일성 — 새 listSubnets 는 옛 시트 기반 목록(subnet·base·used)과 같다(비정규 IP·범위·vCenter·스캔·override·정책)', () => {
  // 스캔 결과(정규·선행 0 표기 섞음) · 수동 예약 IP(새 /24) · 숨김 override · 숨김 대역 정책
  ss.mergeScanResults([
    { ip: '10.7.1.5', openPorts: [22] }, { ip: '10.7.1.05', openPorts: [22] }, { ip: '10.7.2.255', openPorts: [80] },
    { ip: '10.1.2.9', openPorts: [443] }, { ip: '010.8.0.4', openPorts: [22] },
  ], Date.now(), 'edge-a');
  assert.equal(ov.setOverride('10.20.0.5', { owner: '예약' }, { username: 't' }).ok, true);
  assert.equal(ov.setOverride('10.20.1.7', { owner: '예약', claimedVcenterId: 'vc1' }, { username: 't' }).ok, true);
  assert.equal(ov.setOverride('10.0.0.1', { status: 'ignored' }, { username: 't' }).ok, true);
  const pol = rp.setPolicy({ spec: '10.1.3.0/28', status: 'ignored' }, { username: 't' });
  assert.equal(pol.ok, true, JSON.stringify(pol));
  const scopes = [null, new Set(['vc1']), new Set(['vc1', 'vc2'])];
  let compared = 0; let nonCanonUsed = 0;
  for (let s = 1; s <= 30; s++) {
    const snap = randomSnap(1000 + s);
    const sig = st.ledgerInputSignatureOf(snap);
    for (const vc of ['', 'vc1', 'vc2']) {
      for (const allowed of scopes) {
        const want = oldList(snap, vc, allowed);
        const got1 = led.listSubnets(snap, vc, allowed, { inputSig: sig });
        const got2 = led.listSubnets(snap, vc, allowed); // 지문 없이(세대 키) — 같은 결과
        const got3 = led.listSubnets(snap, vc, allowed, { inputSig: sig }); // 기억 적중 — 같은 결과
        assert.ok(isDeepStrictEqual(got1, want), `seed ${s} vc=${vc} scope=${allowed ? [...allowed] : 'all'}\n새: ${JSON.stringify(got1)}\n옛: ${JSON.stringify(want)}`);
        assert.ok(isDeepStrictEqual(got2, want), `지문 없이 seed ${s}`);
        assert.ok(isDeepStrictEqual(got3, want), `기억 적중 seed ${s}`);
        compared++;
      }
    }
    // 대조가 공허하지 않은지 — 비정규 끝 조각 IP 가 실제로 들어간 /24 가 있다(그 IP 는 used 에 들지 않아야 한다)
    const rows = led.buildIpamRows(snap, '', null).rows;
    if (rows.some((r) => r.ipNum != null && /\.0\d+$/.test(r.ip.trim()))) nonCanonUsed++;
  }
  assert.equal(compared, 30 * 9);
  assert.ok(nonCanonUsed >= 20, `비정규 끝 조각 IP 가 든 표본이 너무 적다(${nonCanonUsed}/30) — 대조가 그 경우를 보지 못한다`);
  // 순수 계산부 — 비정규 끝 조각은 세지 않고 .0 도 세지 않으며 .255 는 센다, 서브넷은 남는다(used 0)
  assert.deepEqual(led.subnetsFromRows([
    { ip: '10.5.5.05', ipNum: 1 }, { ip: '10.5.5.0', ipNum: 1 }, { ip: '10.5.5.255', ipNum: 1 }, { ip: '10.5.5.255', ipNum: 1 },
    { ip: '10.4.4.0', ipNum: 1 }, { ip: 'x', ipNum: null }, { ip: '10.5.5.7 ', ipNum: 1 },
  ]), [{ subnet: '10.4.4.0/24', base: '10.4.4', used: 0 }, { subnet: '10.5.5.0/24', base: '10.5.5', used: 1 }]);
  rp.deletePolicy(pol.policy.id);
  ov.clearOverride('10.20.0.5'); ov.clearOverride('10.20.1.7'); ov.clearOverride('10.0.0.1');
});

/** 큰 원장 — VM 4만 대가 /24 2,000개에 흩어진다(시트 조립이면 2,000 × 256행). */
function bigSnap() {
  const vms = [];
  for (let i = 0; i < 40_000; i++) {
    const s = Math.floor(i / 20);  // /24 하나에 20대
    vms.push({ id: `vm-${i}`, name: `big${i}`, vcenterId: i % 3 ? 'vc1' : 'vc2', ipAddresses: [`10.${100 + (s >> 8)}.${s & 255}.${1 + (i % 20)}`], ipAddress: '', powerState: 'POWERED_ON', guestOS: 'Ubuntu 22.04', host: 'esx1', cluster: 'C1' });
  }
  return { generatedAt: `g-big-${++gen}`, vcenters: [{ id: 'vc1', name: 'SEOUL' }, { id: 'vc2', name: 'TOKYO' }], vms, hosts: [], datastores: [], networks: [], alarms: [] };
}
const getJson = async (p) => { const t0 = performance.now(); const r = await fetch(`${baseUrl}${p}`); const body = await r.json(); return { status: r.status, body, ms: performance.now() - t0 }; };
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

test('② live 재현 — 입력이 그대로인 새 세대의 폴링은 원장을 다시 만들지 않는다(store 가 v2.619 로 건너뛴 경우)', async (t) => {
  const S = st.store;
  st._setLedgerAsyncMinForTest(1e9); // 원장 동기 경로(커밋을 기다리기 쉽게) — 양보 경로와 결과는 같다
  try {
    S.snapshot = bigSnap();
    let t0 = Date.now();
    S._ledgerFullAt = 0;
    S.syncLedger();
    for (let i = 0; i < 300 && !(S.ledgerSync && S.ledgerSync.at >= t0); i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(S.ledgerSync?.ok, true, `원장 커밋 실패: ${JSON.stringify(S.ledgerSync)}`);
    const first = await getJson('/tools/ipam/subnets');
    assert.equal(first.status, 200);
    assert.ok(first.body.subnets.length >= 2000, `서브넷 ${first.body.subnets.length}개`); // + ① 에서 넣은 스캔 결과의 /24

    const ms = [];
    for (let k = 0; k < 5; k++) {
      // 같은 내용 · 새 세대(30초마다 store.refresh 가 만드는 것) — store 는 입력 지문이 같아 원장 재구성을 건너뛴다
      const skips = S.ledgerInputSkips || 0;
      S.snapshot = bigSnap();
      S.syncLedger();
      assert.equal(S.ledgerInputSkips, skips + 1, '입력이 같은데 store 가 원장을 다시 만들었다(테스트 전제)');
      const builds = led._ledgerCacheStats().builds;
      assert.equal(typeof builds, 'number', '원장 재구성 횟수를 읽지 못했다');
      const r = await getJson('/tools/ipam/subnets');
      assert.equal(r.status, 200);
      assert.ok(isDeepStrictEqual(r.body.subnets, first.body.subnets), '같은 입력인데 결과가 다르다');
      assert.equal(led._ledgerCacheStats().builds, builds, '입력이 그대로인 폴링이 원장을 다시 만들었다');
      ms.push(r.ms);
    }
    // 비교 기준: 같은 내용의 원장을 이 프로세스에서 한 번 새로 만드는 시간(예전 폴링 비용의 하한 — 시트 조립은 빼고)
    const ref = [];
    for (let k = 0; k < 3; k++) { const snap = bigSnap(); const t = performance.now(); led.buildIpamRows(snap, '', null); ref.push(performance.now() - t); }
    const tPoll = median(ms); const tRebuild = median(ref);
    t.diagnostic(`폴링 중앙값 ${tPoll.toFixed(1)}ms · 원장 재구성 중앙값 ${tRebuild.toFixed(1)}ms`);
    assert.ok(tRebuild > 20, `비교 기준이 너무 작다(${tRebuild.toFixed(1)}ms) — 표본을 키울 것`);
    assert.ok(tPoll < tRebuild / 4, `폴링 ${tPoll.toFixed(1)}ms 가 원장 재구성 ${tRebuild.toFixed(1)}ms 의 1/4 이상이다 — 폴링마다 다시 만든다`);

    // 결과는 옛 구현과 같다(마지막 세대 기준)
    assert.ok(isDeepStrictEqual(first.body.subnets, oldList(S.snapshot, '', null)), '옛 시트 기반 목록과 다르다');
    // 범위(vCenter) 질의도 같은 기억 규칙 — vc2 만
    const vc2 = await getJson('/tools/ipam/subnets?vcenterId=vc2');
    assert.ok(isDeepStrictEqual(vc2.body.subnets, oldList(S.snapshot, 'vc2', null)), 'vCenter 를 고른 결과가 옛 구현과 다르다');
  } finally {
    st._setLedgerAsyncMinForTest(NaN);
  }
});

test('③ 기억은 입력이 바뀌면 버려진다 — 관리 입력(override·스캔)·스냅샷 내용·안전망 시간', async () => {
  const S = st.store;
  const snap = bigSnap();
  S.snapshot = snap;
  const has = (list, subnet) => list.find((x) => x.subnet === subnet);
  let r = await getJson('/tools/ipam/subnets');
  assert.equal(has(r.body.subnets, '10.250.0.0/24'), undefined);
  // 수동 예약 IP(새 /24) — overridesRev 가 오른다
  assert.equal(ov.setOverride('10.250.0.7', { owner: '예약' }, { username: 't' }).ok, true);
  r = await getJson('/tools/ipam/subnets');
  assert.deepEqual(has(r.body.subnets, '10.250.0.0/24'), { subnet: '10.250.0.0/24', base: '10.250.0', used: 1 });
  // 그 /24 의 유일한 IP 를 숨김 — 서브넷이 사라진다
  assert.equal(ov.setOverride('10.250.0.7', { status: 'ignored' }, { username: 't' }).ok, true);
  r = await getJson('/tools/ipam/subnets');
  assert.equal(has(r.body.subnets, '10.250.0.0/24'), undefined);
  ov.clearOverride('10.250.0.7');
  // 스캔 결과(새 /24) — scanRev 가 오른다
  ss.mergeScanResults([{ ip: '10.251.0.9', openPorts: [22] }], Date.now(), 'edge-b');
  r = await getJson('/tools/ipam/subnets');
  assert.deepEqual(has(r.body.subnets, '10.251.0.0/24'), { subnet: '10.251.0.0/24', base: '10.251.0', used: 1 });
  // 스냅샷 내용이 바뀐 새 세대 — 입력 지문이 바뀐다
  const next = bigSnap();
  next.vms.push({ id: 'vm-new', name: 'new', vcenterId: 'vc1', ipAddresses: ['10.252.3.4'], ipAddress: '', powerState: 'POWERED_ON', guestOS: '', host: 'esx1', cluster: 'C1' });
  S.snapshot = next;
  r = await getJson('/tools/ipam/subnets');
  assert.deepEqual(has(r.body.subnets, '10.252.3.0/24'), { subnet: '10.252.3.0/24', base: '10.252.3', used: 1 });
  assert.ok(isDeepStrictEqual(r.body.subnets, oldList(next, '', null)), '바뀐 입력에서 옛 구현과 다르다');

  // 넘긴 지문이 관리 리비전을 모르더라도(호출부가 옛 리비전으로 계산했더라도) 기억 키의 리비전이 결과를 바꾼다
  const fixedSig = 'fixed-sig-2733j';
  assert.equal(has(led.listSubnets(next, '', null, { inputSig: fixedSig }), '10.254.0.0/24'), undefined);
  assert.equal(ov.setOverride('10.254.0.3', { owner: '예약' }, { username: 't' }).ok, true);
  assert.deepEqual(has(led.listSubnets(next, '', null, { inputSig: fixedSig }), '10.254.0.0/24'), { subnet: '10.254.0.0/24', base: '10.254.0', used: 1 }, '관리 리비전이 바뀌었는데 기억을 썼다');
  ov.clearOverride('10.254.0.3');

  // 안전망 — 같은 지문이라도 10분이 지나면 다시 센다(지문이 모르는 입력이 생겼을 때 store 의 LEDGER_FULL_CHECK_MS 와 같은 성격)
  const sig = st.ledgerInputSignatureOf(next);
  const T = Date.now();
  led.listSubnets(next, '', null, { inputSig: sig, now: T });
  const other = { ...next, generatedAt: `g-other-${++gen}` }; // 같은 내용 · 새 세대 객체(원장 캐시는 비어 있다)
  const b0 = led._ledgerCacheStats().builds;
  led.listSubnets(other, '', null, { inputSig: sig, now: T + 60_000 });
  assert.equal(led._ledgerCacheStats().builds, b0, '10분 안에는 기억을 쓴다');
  led.listSubnets(other, '', null, { inputSig: sig, now: T + 10 * 60_000 + 1 });
  assert.equal(led._ledgerCacheStats().builds, b0 + 1, '10분이 지났는데 다시 세지 않았다');
});

test('④ 입력 지문 기억 — 같은 스냅샷 객체·같은 관리 리비전이면 store 가 계산한 값을 다시 쓰고, 리비전이 바뀌면 다시 계산한다', () => {
  const snap = bigSnap();
  const a = st.ledgerInputSignatureOf(snap);
  assert.equal(a, st.ledgerInputSignature(snap));
  assert.equal(st.ledgerInputSignatureOf(snap), a);
  assert.equal(ov.setOverride('10.253.0.1', { owner: 'x' }, { username: 't' }).ok, true);
  const b = st.ledgerInputSignatureOf(snap);
  assert.notEqual(b, a, '관리 리비전이 바뀌었는데 옛 지문을 줬다');
  assert.equal(b, st.ledgerInputSignature(snap));
  ov.clearOverride('10.253.0.1');
});

test('⑤ 기억 키에는 데이터센터 귀속이 들어간다 — vCenter 의 DataCenter 할당을 바꾸면 그 vCenter 보기의 스캔 행이 다시 판정된다', async () => {
  const dcs = await import('../src/datacenter/store.js');
  assert.equal(dcs.addDatacenter({ id: 'dc-a', name: 'A' }).ok, true);
  assert.equal(dcs.addDatacenter({ id: 'dc-b', name: 'B' }).ok, true);
  ss.saveScanSettings('edge-dc', { datacenterId: 'dc-b', ranges: ['10.249.0.0/24'] });
  ss.mergeScanResults([{ ip: '10.249.0.9', openPorts: [22] }], Date.now(), 'edge-dc');
  const snap = randomSnap(77);
  const has = (list) => list.some((x) => x.subnet === '10.249.0.0/24');
  const sig = 'sig-dc-2733j';
  assert.equal(has(led.listSubnets(snap, 'vc1', null, { inputSig: sig })), true, 'DataCenter 할당 전에는 귀속 없는 vCenter 보기에도 보인다');
  assert.equal(dcs.setVcenterDatacenter('vc1', 'dc-a').ok, true);
  const after = led.listSubnets(snap, 'vc1', null, { inputSig: sig });
  assert.equal(has(after), false, 'vc1 이 dc-a 가 됐는데 dc-b 에이전트의 스캔 행을 기억에서 줬다');
  assert.ok(isDeepStrictEqual(after, oldList(snap, 'vc1', null)), '옛 구현과 다르다');
  dcs.setVcenterDatacenter('vc1', '');
});
