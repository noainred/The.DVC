/**
 * v2.929(C-① — 설계 docs/design/san-cvp-traffic/README.md §9) — 라이선스 없이 호스트 × 스토리지 분배: ESXi 경로 카운터(실측 비율) + IPF 보정.
 *  ① 경로 인스턴스 이름 두 형식(fc. 전송 식별자 · 런타임 이름 + 멀티패스 rt 표) · 못 푸는 이름은 unparsed(0 이 아니다) · 타깃별 KB = KBps × 20초 합 · 결측은 partial
 *  ② 엣지 정제 — 아는 필드만 · 상한 · 엣지 시각은 수신 시각으로(원본 edgeAt) · 멀티패스 rt 추출 · 정제 화이트리스트
 *  ③ IPF — 행합 정확 · 열합 잔차 · 여유 행/열(다른 초기자 · 다른 스위치 타깃) · 후보 하나·실측 행 고정
 *  ④ 귀속 엔진 우선순위 — 실측 비율 → IPF → 타깃 포트 비율 · 분배 방식 세그먼트(ipf · ratio) · 함대 개수 · Fabric Vision 라이선스 판정
 *  ⑤ 표본 이력 — 같은 at 은 한 번 · 기간 창 · 상한 · 스냅샷에서 사라진 호스트 정리
 *  ⑥ 수집기 — FC 호스트만 · 묶음 · 캐시 · 카운터 없음 · 실패 격리(실제 refreshStorPath 호출)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'storpath2929-'));
const P = await import('../src/storpath/parse.js');
const I = await import('../src/sanswitch/ipf.js');
const A = await import('../src/sanswitch/attribution.js');
const HI = await import('../src/storpath/history.js');
const H = 3_600_000;
const NOW = Math.floor(Date.now() / H) * H;   // 정시로 떨어뜨린 실제 시각(docs/rules/common.md)

const HB1 = '10:00:00:10:9b:00:00:01', HB2 = '10:00:00:10:9b:00:00:02', OTH = '21:00:00:24:ff:00:00:09';
const T1 = '50:00:09:73:00:00:00:01', T2 = '58:cc:f0:00:00:00:00:c0';
const hex = (w) => w.replace(/:/g, '');

test('① 경로 이름 두 형식 · 타깃별 합 · unparsed · partial', () => {
  assert.deepEqual(P.pathKeyOf(`fc.2000001b32933ac2:${hex(HB1)}-fc.50060160bce00a83:${hex(T1)}-naa.600601603a002b00b0e01f06e4bfe011`), { init: HB1, target: T1 });
  assert.deepEqual(P.pathKeyOf('vmhba2:C0:T3:L12'), { adapter: 'vmhba2', tid: 'vmhba2:c0:t3' });
  assert.equal(P.pathKeyOf('sas.5000c50000000000-sas.5000c50000000001-naa.1'), null);
  assert.equal(P.pathKeyOf(''), null); assert.equal(P.pathKeyOf(null), null);
  assert.equal(P.pathKeyOf(`fc.${'a'.repeat(5000)}`), null, '긴 입력은 잘라서 앵커 정규식으로');
  const host = { hbas: [{ name: 'vmhba1', wwn: HB1 }, { name: 'vmhba2', wwn: HB2 }], hcfg: { mp: { targets: [{ adapter: 'vmhba2', wwn: T2, live: 2, rt: ['vmhba2:c0:t3'] }] } } };
  const rtMap = P.rtMapOf(host); const hbaByWwn = P.hbaByWwnOf(host);
  assert.equal(rtMap.get('vmhba2:c0:t3'), T2); assert.equal(hbaByWwn.get(HB1), 'vmhba1');
  const ids = { read: '11', write: '12', latR: '13', latW: '14' };
  const fc1 = `fc.20:${hex(HB1)}-fc.50:${hex(T1)}-naa.1`.replace('fc.20:', 'fc.2000001b32933ac2:').replace('fc.50:', 'fc.50060160bce00a83:');
  const fc2 = fc1.replace('naa.1', 'naa.2');
  const byC = new Map([
    ['11', new Map([[fc1, [100, 100, 100]], [fc2, [50, 50]], ['vmhba2:C0:T3:L1', [30, 30, 30]], ['vmhba2:C0:T9:L1', [7, 7, 7]], ['weird', [1, 1, 1]]])],
    ['12', new Map([[fc1, [10, 10, 10]], [fc2, [5, 5, 5]], ['vmhba2:C0:T3:L1', [3, 3, 3]]])],
    ['13', new Map([[fc1, [2, 2, 2]], [fc2, [4, 4]]])],
  ]);
  const s = P.summarizeHostPaths(byC, ids, { rtMap, hbaByWwn, at: NOW, samples: 3 });
  assert.equal(s.instances, 5); assert.equal(s.unparsed, 2, 'rt 표에 없는 런타임 이름 · 모르는 형식은 unparsed');
  const t1 = s.targets.find((t) => t.wwn === T1); const t2 = s.targets.find((t) => t.wwn === T2);
  assert.equal(t1.adapter, 'vmhba1', '초기자 WWN → HBA 이름'); assert.equal(t1.paths, 2);
  assert.equal(t1.readKB, (300 + 100) * 20, 'KBps × 20초 합(값이 있는 표본만)'); assert.equal(t1.writeKB, (30 + 15) * 20);
  assert.equal(t1.rKBps, 100 + 50, '경로별 평균 KBps 의 합'); assert.equal(t1.partial, true, '표본이 빠진 경로가 있다');
  assert.equal(t1.latR, 3, '경로 평균 지연의 평균'); assert.equal(t1.latW, null, '지연 계열이 없으면 null(0 이 아니다)');
  assert.equal(t2.adapter, 'vmhba2'); assert.equal(t2.readKB, 90 * 20); assert.equal(t2.partial, false);
  const empty = P.summarizeHostPaths(new Map(), ids, { at: NOW });
  assert.deepEqual([empty.targets, empty.instances, empty.unparsed], [[], 0, 0]);
});

test('② 엣지 정제 · 멀티패스 rt', async () => {
  const v = P.sanitizeHostSpath({ at: NOW + 60_000, sampleSec: 20, samples: 15, instances: 4, unparsed: 1, truncated: false, evil: 'x',
    targets: [{ adapter: 'vmhba1', init: HB1.toUpperCase(), wwn: T1, readKB: '100', writeKB: -5, rKBps: 3, wKBps: null, latR: 1.5, latW: 'abc', paths: 9e9, partial: 'yes', x: 1 },
      { adapter: 'bad adapter!', wwn: 'nope' }, 'str'] }, NOW);
  assert.equal(v.at, NOW, '엣지 시각이 미래면 수신 시각으로'); assert.equal(v.edgeAt, NOW + 60_000);
  assert.equal(Object.hasOwn(v, 'evil'), false);
  assert.equal(v.targets.length, 1);
  assert.deepEqual(v.targets[0], { adapter: 'vmhba1', init: HB1, wwn: T1, readKB: 100, writeKB: null, rKBps: 3, wKBps: null, latR: 1.5, latW: null, paths: P.SPATH_PATHS_MAX, partial: false });
  assert.equal(P.sanitizeHostSpath('x'), null); assert.equal(P.sanitizeHostSpath([]), null);
  assert.equal(P.sanitizeHostSpath({ targets: new Array(200).fill({ wwn: T1 }) }).targets.length, P.SPATH_TARGETS_MAX);
  const HC = await import('../src/hostcfg/parse.js');
  const p = (name, lun, adapter, pwwn) => `<path><key>key-vim.host.MultipathInfo.Path-${name}</key><name>${name}</name><pathState>active</pathState><lun>${lun}</lun><adapter>key-vim.host.FibreChannelHba-${adapter}</adapter><transport xsi:type="HostFibreChannelTargetTransport"><portWorldWideName>${pwwn}</portWorldWideName></transport></path>`;
  const m = HC.parseMultipath(`<lun>${p('vmhba1:C0:T3:L1', 'L1', 'vmhba1', '5764689621520744449')}${p('vmhba1:C0:T3:L2', 'L2', 'vmhba1', '5764689621520744449')}${p('fc.x-fc.y-naa.z', 'L3', 'vmhba1', '5764689621520744450')}</lun>`);
  assert.deepEqual(m.targets.map((t) => [t.wwn, t.rt]), [['50:00:4a:ab:0b:20:00:01', ['vmhba1:c0:t3']], ['50:00:4a:ab:0b:20:00:02', []]]);
  const s = HC.sanitizeHostCfg({ mp: { targets: [{ adapter: 'vmhba1', wwn: '50:00:4a:ab:0b:20:00:01', live: 1, rt: ['vmhba1:c0:t3', 'x; rm', 5] }] } });
  assert.deepEqual(s.mp.targets[0].rt, ['vmhba1:c0:t3']);
  // 중앙 정제 화이트리스트에 실려 있다(새 엣지 export 필드 — 루트 CLAUDE.md)
  const src = fs.readFileSync(new URL('../src/routes/central.js', import.meta.url), 'utf8');
  assert.match(src, /Object\.hasOwn\(o, 'spath'\)[^\n]*sanitizeHostSpath\(o\.spath\)/);
});

test('③ IPF — 행합 정확 · 여유 행/열 · 고정 행', () => {
  let r = I.ipfSplit({ rows: new Map([['h1', 1000]]), cols: new Map([['A', 300], ['B', 700]]), allowed: new Map([['h1', new Set(['A', 'B'])]]) });
  assert.equal(r.converged, true); assert.ok(Math.abs(r.shares.get('h1').get('A') - 0.3) < 1e-6);
  r = I.ipfSplit({ rows: new Map([['h1', 100]]), cols: new Map([['A', 300], ['B', 100]]), allowed: new Map([['h1', new Set(['A', 'B'])]]) });
  assert.equal(r.slackRow, 300, '다른 초기자 몫'); assert.equal(r.converged, true);
  assert.ok(Math.abs(r.shares.get('h1').get('A') - 0.75) < 1e-6);
  r = I.ipfSplit({ rows: new Map([['h1', 100]]), cols: new Map([['A', 30], ['B', 10]]), allowed: new Map([['h1', new Set(['A', 'B'])]]) });
  assert.equal(r.slackCol, 60); assert.ok(Math.abs(r.elsewhere.get('h1') - 0.6) < 1e-6, '다른 스위치 타깃 몫을 밝힌다');
  // 수렴하지 않는 모양(열이 0 인 칸만 허용된 행 + 여유 열 없음) — converged false
  r = I.ipfSplit({ rows: new Map([['h1', 100], ['h2', 100]]), cols: new Map([['A', 0], ['B', 200]]), allowed: new Map([['h1', new Set(['A'])], ['h2', new Set(['B'])]]), }, { maxIter: 5 });
  assert.equal(r.converged, false);
  // 스위치 문맥 — H1(후보 2) · OTH(후보 1 → 고정) · 열합에서 고정 몫을 뺀 뒤 나머지
  const f = fab();
  const pb = bytes({ 0: 1000, 1: 900, 2: 700, 3: 600 });
  const out = I.ipfForFabrics([f], pb);
  const row = out.byRow.get(`swA|${HB1}`);
  assert.equal(row.kind, 'ipf'); assert.ok(Math.abs(row.shares.get(T1) - 0.3) < 1e-3 && Math.abs(row.shares.get(T2) - 0.7) < 1e-3, 'OTH 600 을 T1 에서 먼저 뺀다');
  assert.equal(out.byRow.get(`swA|${OTH}`).kind, 'single');
  assert.deepEqual(out.fabrics.map((x) => [x.deviceId, x.switches, x.rows, x.fixedRows, x.converged]), [['swA', 1, 2, 1, true]]);
  // 실측 몫이 있는 초기자는 고정(추정이 실측을 덮지 않는다)
  const fx = I.ipfForFabrics([f], pb, { fixedOf: (w) => (w === HB1 ? new Map([[T1, 0.8], [T2, 0.2]]) : null) });
  assert.equal(fx.byRow.get(`swA|${HB1}`).kind, 'fixed'); assert.equal(fx.byRow.get(`swA|${HB1}`).shares.get(T1), 0.8);
  assert.equal(I.ipfForFabrics([f], null).byRow.size, 0, '포트 바이트가 없으면 아무것도 하지 않는다');
  // 코어-엣지 — 호스트는 엣지(swE) · 어레이는 코어(swC), 같은 zone 설정(같은 패브릭) → 패브릭 단위로 풀어 만난다(스위치 하나로는 행·열이 안 만난다)
  const zones = [{ name: 'Z1', members: [HB1, T1] }, { name: 'Z2', members: [HB1, T2] }];
  const roles = { [HB1]: 'initiator', [T1]: 'target', [T2]: 'target' };
  const [fe, fc] = A.buildFabrics([
    { deviceId: 'swE', name: 'EDGE', ports: { list: [portOf(0, [HB1], 'Emulex')] }, zoning: { available: true, zones }, nsRoles: roles },
    { deviceId: 'swC', name: 'CORE', ports: { list: [portOf(1, [T1], `${PMAX}::FA-1D:4`), portOf(2, [T2], 'PowerStore::PS1::node-A')] }, zoning: { available: true, zones }, nsRoles: roles }]);
  const ce = I.ipfForFabrics([fe, fc], new Map([['swE|0', { bytes: 1000 }], ['swC|1', { bytes: 250 }], ['swC|2', { bytes: 750 }]]));
  assert.deepEqual(ce.fabrics.map((x) => [x.switches, x.rows, x.cols, x.converged]), [[2, 1, 2, true]]);
  const er = ce.byRow.get(`swE|${HB1}`);
  assert.equal(er.kind, 'ipf'); assert.ok(Math.abs(er.shares.get(T1) - 0.25) < 1e-3, '행 키는 초기자가 로그인한 스위치');
  const v = A.attributeHost({ ...host }, [fe, fc], { portBytes: new Map([['swE|0', { bytes: 1000 }], ['swC|1', { bytes: 250 }], ['swC|2', { bytes: 750 }]]), ipf: ce }).hbas.find((x) => x.hba === 'vmhba1');
  assert.equal(v.split, 'ipf', '타깃 포트 비율(A)은 같은 스위치만 봐서 나누지 못하던 코어-엣지 호스트를 IPF 가 나눈다');
  assert.equal(A.attributeHost({ ...host }, [fe, fc], { portBytes: new Map([['swE|0', { bytes: 1000 }], ['swC|1', { bytes: 250 }], ['swC|2', { bytes: 750 }]]), split: 'ratio' }).hbas[0].conf, 'unsplit');
});

// 스위치 하나: H1(vmhba1) 은 T1(PMAX) · T2(PowerStore) 둘과 조닝, OTH(다른 서버)는 T1 만.
const PMAX = 'SYMMETRIX::000497700230';
const portOf = (index, attached, attachedName) => ({ index, slotPort: `0/${index}`, name: `p${index}`, state: 'online', attached, attachedName, inBps: 100, outBps: 200 });
function fab(extra = {}) {
  return A.buildFabrics([{ deviceId: 'swA', name: 'SW-A', datacenterId: 'corp-a', collectedAt: NOW,
    ports: { list: [portOf(0, [HB1], 'Emulex'), portOf(1, [T1], `${PMAX}::FA-1D:4`), portOf(2, [T2], 'PowerStore::PS12345::node-A'), portOf(3, [OTH], 'QLogic')] },
    zoning: { available: true, zones: [{ name: 'Z1', members: [HB1, T1] }, { name: 'Z2', members: [HB1, T2] }, { name: 'Z3', members: [OTH, T1] }] },
    nsRoles: { [HB1]: 'initiator', [OTH]: 'initiator', [T1]: 'target', [T2]: 'target' }, ...extra }])[0];
}
const bytes = (o) => new Map(Object.entries(o).map(([k, v]) => [`swA|${k}`, { bytes: v, measuredBuckets: 4, totalBuckets: 4 }]));
const host = { id: 'vc:h1', name: 'esx01', vcenterId: 'vc', hbas: [{ name: 'vmhba1', type: 'FibreChannel', wwn: HB1 }] };

test('④ 귀속 엔진 — 실측 비율 → IPF → 타깃 포트 비율 · 분배 방식 · 함대 · 라이선스', () => {
  const f = fab(); const pb = bytes({ 0: 1000, 1: 900, 2: 700, 3: 600 });
  const ipf = I.ipfForFabrics([f], pb);
  const pw = { kb: new Map([[`vmhba1|${T1}`, 800], [`vmhba1|${T2}`, 200], [`vmhba9|${T1}`, 5000]]), samples: 24, firstAt: NOW - 23 * H, lastAt: NOW };
  const by = (r) => r.hbas.find((x) => x.hba === 'vmhba1');
  let r = A.attributeHost(host, [f], { portBytes: pb, pathWeights: pw, ipf });
  let v = by(r);
  assert.equal(v.conf, 'measured'); assert.equal(v.split, 'measured'); assert.equal(v.splitInfo.samples, 24);
  assert.deepEqual(v.targets.map((t) => [t.name, Math.round(t.share * 100)]), [[PMAX, 80], ['PowerStore::PS12345', 20]]);
  assert.equal(r.totals.pathMeasuredBytes, 1000); assert.equal(r.totals.estimatedBytes, null, '실측 분배는 추정 합에 넣지 않는다');
  const st = Object.fromEntries(r.storages.map((s) => [s.name, s]));
  assert.equal(st[PMAX].measuredBytes, 800); assert.deepEqual(st[PMAX].measuredPorts, ['vmhba1@SW-A']);
  // 실측이 없으면 IPF
  r = A.attributeHost(host, [f], { portBytes: pb, pathWeights: null, ipf }); v = by(r);
  assert.equal(v.conf, 'estimated'); assert.equal(v.split, 'ipf'); assert.match(v.basis, /IPF 보정/);
  assert.deepEqual(v.targets.map((t) => Math.round(t.share * 100)), [30, 70]);
  // 분배 방식 — ipf: 실측을 건너뛴다 · ratio: A 단계(타깃 포트 비율 900:700)
  v = by(A.attributeHost(host, [f], { portBytes: pb, pathWeights: pw, ipf, split: 'ipf' }));
  assert.equal(v.split, 'ipf');
  v = by(A.attributeHost(host, [f], { portBytes: pb, pathWeights: pw, ipf: null, split: 'ratio' }));
  assert.equal(v.split, 'ratio'); assert.deepEqual(v.targets.map((t) => Math.round(t.share * 1000)), [563, 438]);
  // 그 어댑터를 잰 적이 없거나(키 없음) 합이 0 이면 실측 아님 — IPF 로
  v = by(A.attributeHost(host, [f], { portBytes: pb, pathWeights: { kb: new Map([[`vmhba1|${T1}`, 0]]), samples: 1 }, ipf }));
  assert.equal(v.split, 'ipf');
  assert.equal(A.measuredSharesOf(pw, 'vmhba2'), null); assert.equal(A.measuredSharesOf(null, 'vmhba1'), null);
  // 함대 — 실측 짝 개수 · 분배 방식별 포트 수
  const fl = A.attributeFleet([host, { ...host, id: 'vc:h2', name: 'esx02', hbas: [{ name: 'vmhba1', wwn: '10:00:00:10:9b:00:00:77' }] }], [f],
    { portBytes: pb, ipf, pathWeightsOf: (h) => (h.id === 'vc:h1' ? pw : null) });
  assert.equal(fl.counts.measuredPairs, 2); assert.equal(fl.counts.measuredSplitPorts, 1);
  assert.equal(fl.storages.find((s) => s.name === PMAX).hostsMeasured, 1);
  // Fabric Vision 라이선스 — 있음 · 없음(목록을 읽음) · 못 읽음(rbash)
  assert.deepEqual(A.fabricVisionOf({ licenses: [{ name: 'Fabric Vision license', expires: '2027-03-31' }] }), { state: 'yes', expires: '2027-03-31' });
  assert.deepEqual(A.fabricVisionOf({ licenses: [{ name: 'Ports on Demand' }] }), { state: 'no' });
  assert.deepEqual(A.fabricVisionOf({ licenses: [], sections: { licenses: 'ok' } }), { state: 'no' });
  assert.deepEqual(A.fabricVisionOf({ sections: { licenses: 'rbash: licenseshow: command not found' } }), { state: 'unknown', reason: 'rbash: licenseshow: command not found' });
  assert.deepEqual(A.fabricVisionOf({}), { state: 'unknown', reason: null });
  assert.equal(f.fv.state, 'unknown');
});

test('⑤ 표본 이력 — 같은 at 한 번 · 기간 창 · 상한 · 사라진 호스트 정리', () => {
  HI._resetStorPathHistory();
  const mk = (at, kb1, kb2) => ({ id: 'vc:h1', spath: { at, samples: 15, sampleSec: 20, targets: [{ adapter: 'vmhba1', wwn: T1, readKB: kb1, writeKB: 0 }, { adapter: 'vmhba1', wwn: T2, readKB: kb2, writeKB: null }, { adapter: 'vmhba1', wwn: '50:00:00:00:00:00:00:99', readKB: null, writeKB: null }] } });
  assert.equal(HI.recordHosts([mk(NOW - 2 * H, 100, 50)]), 1);
  assert.equal(HI.recordHosts([mk(NOW - 2 * H, 100, 50)]), 0, '같은 at 은 다시 넣지 않는다');
  HI.recordHosts([mk(NOW - H, 300, 0)]);
  let w = HI.weightsFor('vc:h1');
  assert.equal(w.samples, 2); assert.equal(w.kb.get(`vmhba1|${T1}`), 400); assert.equal(w.kb.get(`vmhba1|${T2}`), 50);
  assert.equal(w.kb.has('vmhba1|50:00:00:00:00:00:00:99'), false, '값이 하나도 없는 타깃은 0 이 아니라 모름');
  w = HI.weightsFor('vc:h1', { since: NOW - 90 * 60_000 });
  assert.equal(w.samples, 1); assert.equal(w.kb.get(`vmhba1|${T1}`), 300);
  assert.equal(HI.weightsFor('vc:h1', { since: NOW }), null, '창 안에 표본이 없으면 null');
  for (let i = 0; i < 40; i++) HI.recordHosts([mk(NOW + i * 1000, 1, 1)]);
  assert.equal(HI.historyStatus().samples, HI.HIST_MAX);
  HI.recordHosts([{ id: 'other' }]);
  assert.equal(HI.weightsFor('vc:h1'), null, '스냅샷에서 사라진 호스트는 버린다');
  HI._resetStorPathHistory();
});

test('⑥ 수집기 — 실제 refreshStorPath 호출 · FC 호스트 · 묶음 · 캐시 · 카운터 없음 · 실패 격리', async () => {
  const C = await import('../src/storpath/collect.js');
  const K = await import('../src/storpath/cache.js');
  K._resetStorPathCache(); C._resetStorPathRetry();
  assert.equal(C.hasFcHba({ hbas: [{ wwn: HB1 }] }), true); assert.equal(C.hasFcHba({ hbas: [{ wwn: '' }, { name: 'vmhba64' }] }), false);
  const inst = `fc.2000001b32933ac2:${hex(HB1)}-fc.50060160bce00a83:${hex(T1)}-naa.1`;
  const bodies = [];
  const catalog = new Map([['storagePath.read.average', '501'], ['storagePath.write.average', '502']]);
  const fake = (fail = false) => ({ sc: { perfManager: 'PerfMgr' }, perfCounterMap: async () => catalog,
    callRaw: async (body) => {
      bodies.push(body);
      if (fail) throw new Error('boom');
      const refs = [...body.matchAll(/<entity type="HostSystem">([^<]+)<\/entity>/g)].map((m) => m[1]);
      return `<x>${refs.map((ref) => `<returnval><entity type="HostSystem">${ref}</entity><value><id><counterId>501</counterId><instance>${inst}</instance></id><value>10</value><value>-1</value><value>10</value></value>`
        + `<value><id><counterId>502</counterId><instance>${inst}</instance></id><value>4</value></value></returnval>`).join('')}</x>`;
    } });
  const hosts = Array.from({ length: 6 }, (_, i) => ({ ref: `host-${i}`, host: { hbas: [{ name: 'vmhba1', wwn: HB1 }] } }));
  const settings = { storPathScan: true, storPathRefreshMs: H, storPathPerCycle: 5, storPathSamples: 3 };
  let r = await C.refreshStorPath(fake(), 'vc1', { hosts, now: NOW, settings });
  assert.equal(r.fetched, 5, '주기당 상한'); assert.equal(bodies.length, 2, `묶음 ${C.HOST_CHUNK}대씩`);
  assert.match(bodies[0], /<instance>\*<\/instance>/); assert.match(bodies[0], /<maxSample>3<\/maxSample>/);
  const e = K.get('vc1', 'host-0');
  assert.equal(e.targets[0].wwn, T1); assert.equal(e.targets[0].readKB, 20 * 20, '결측(-1)은 더하지 않는다'); assert.equal(e.targets[0].partial, true);
  r = await C.refreshStorPath(fake(), 'vc1', { hosts, now: NOW + 60_000, settings });
  assert.equal(r.fetched, 1, '한 번도 안 읽은 호스트만(주기 안)');
  // 카운터가 카탈로그에 없으면 묻지 않고 상태에 남긴다
  K._resetStorPathCache(); bodies.length = 0;
  r = await C.refreshStorPath({ ...fake(), perfCounterMap: async () => new Map() }, 'vc2', { hosts, now: NOW, settings });
  assert.equal(r.fetched, 0); assert.equal(bodies.length, 0); assert.ok(K.statusOf('vc2').missingCounters.includes('storagePath.read.average'));
  // 묶음 실패는 격리 — 던지지 않고 상태에 오류
  r = await C.refreshStorPath(fake(true), 'vc3', { hosts, now: NOW, settings });
  assert.equal(r.fetched, 0); assert.equal(r.errors, 2); assert.match(K.statusOf('vc3').error, /boom/);
  assert.deepEqual(await C.refreshStorPath(fake(), 'vc4', { hosts, now: NOW, settings: { ...settings, storPathScan: false } }), { skipped: 'off' });
  // 끊긴(목록에 없는) 호스트의 캐시는 버린다
  await C.refreshStorPath(fake(), 'vc5', { hosts: hosts.slice(0, 2), now: NOW, settings });
  await C.refreshStorPath(fake(), 'vc5', { hosts: hosts.slice(0, 1), now: NOW + 1, settings });
  assert.equal(K.get('vc5', 'host-1'), null);
  // vCenter 삭제 · 접속처 변경 때 함께 버린다(hostcfg/cache.js CACHE_DROPPERS)
  const src = fs.readFileSync(new URL('../src/hostcfg/cache.js', import.meta.url), 'utf8');
  assert.match(src, /dropStorPath, dropStorPathRetry/);
});
