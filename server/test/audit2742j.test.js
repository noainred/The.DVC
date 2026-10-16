/**
 * v2.742 수정 그룹 GI1 — SAN 스위치(점검·조닝·처리량·요약 응답) 회귀.
 *  DEV-02 sensorshow·psshow·fanshow 의 빈 슬롯(Absent)을 이상으로 세지 않는다 — 실제 파서 + 실제 점검 판정 + 파트 장애 추출
 *  DEV-04 조닝: peer zone 속성 멤버(00:02:…)를 WWN 끝점으로 읽지 않는다 · REST principal-entry-name 합치기 · principal↔peer 간선만
 *  DEV-06 처리량 간격 상한 = max(2시간, 주기 × 3 + 실행 소요) · computed:false 사유
 *  DB-06 storage-summary 응답 객체를 같은 조회 키·계산 결과·역할이면 재사용(compress 캐시가 직렬화를 다시 하지 않게) — 실제 api 라우터
 * ⚠ 픽스처는 전부 합성이다(v2.513 — 실장비 식별자 금지). WWN 은 접두(OUI) 성질만 보존한 가짜 값.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2742j-'));
process.env.SANSW_PERF_ROLLUP_BACKFILL = '0';
Object.assign(process.env, { DATA_SOURCE: 'mock', AUTH_ENABLED: 'false', IPAM_WRITE_WORKER: '0' });

const P = await import('../src/sanswitch/collectors/fosParse.js');
const { checkDevice } = await import('../src/sanswitch/healthCheck.js');
const { extractSanSwitchParts } = await import('../src/partfault/extract/sanswitch.js');

const SENSOR = [
  'sensor  1: (Temperature) is Ok, value is 32 C',
  'sensor  2: (Temperature) is Ok, value is 30 C',
  'sensor  4: (Fan        ) is Ok,speed is 7258 RPM',
  'sensor  6: (Power Supply) is Ok',
  'sensor  7: (Power Supply) is Absent',
].join('\n');
const PS = 'Power Supply #1 is OK V10645,SYNTH00000001,60-0000000-02,B\nPower Supply #2 is absent';
const FAN = 'Fan 1 is Ok, speed is 7258 RPM\nFan 2 is Ok, speed is 7258 RPM\nFan 3 is Absent';

const snapOf = (health, sensors) => ({
  ok: true, switchState: 'Online',
  sections: { health: 'skip', chassis: 'ok', sensors: 'ok', ports: 'ok', sfp: 'skip', counters: 'skip' },
  ports: { list: [] }, health, extra: { sensors },
});

/* ── DEV-02 ─────────────────────────────────────────────────────────────── */

test('DEV-02 ① sensorshow: Absent 는 빈 슬롯 표지 — 이상(bad)도 미확인(unknown)도 아니다', () => {
  const s = P.parseSensorShow(SENSOR);
  assert.deepEqual(s.counts, { total: 5, ok: 4, bad: 0, unknown: 0, absent: 1 });
  const a = s.list.find((x) => /absent/i.test(x.state));
  assert.equal(a.absent, true);
  assert.notEqual(a.ok, false, '빈 슬롯을 ok:false(이상)로 두지 않는다');
  const r = checkDevice(snapOf({ fans: P.parseFruShow(FAN), psus: P.parseFruShow(PS) }, s));
  const it = r.items.find((i) => i.key === 'sensors');
  assert.equal(it.status, 'ok', `빈 슬롯 하나가 센서 항목을 이상으로 만들면 안 된다: ${it.detail}`);
  assert.ok(!/이상 \d+개/.test(it.detail), it.detail);
  assert.match(it.detail, /미장착 1/);
});

test('DEV-02 ② sensorshow 상태 단어: healthWord 규칙 — Unknown 은 모름, 모르는 단어는 모름, 명백한 이상어는 이상', () => {
  const st = (w) => P.parseSensorShow(`sensor  1: (Fan        ) is ${w}`).list[0];
  assert.equal(st('Ok').ok, true);
  assert.equal(st('Normal').ok, true);
  assert.equal(st('Present').ok, true);
  assert.equal(st('Faulty').ok, false);
  assert.equal(st('Failed').ok, false);
  assert.equal(st('Unknown').ok, null, "'is Unknown' 을 이상으로 단정하지 않는다");
  assert.equal(st('Weird').ok, null, '모르는 단어는 모름');
  assert.equal(P.parseSensorShow('sensor  9: (Power Supply) is Not Present').list[0].absent, true);
  const s = P.parseSensorShow('sensor  1: (Fan        ) is Faulty\nsensor  2: (Fan        ) is Unknown');
  assert.deepEqual(s.counts, { total: 2, ok: 0, bad: 1, unknown: 1, absent: 0 });
  const it = checkDevice(snapOf({}, s)).items.find((i) => i.key === 'sensors');
  assert.equal(it.status, 'bad', '진짜 이상은 그대로 이상');
});

test('DEV-02 ③ psshow/fanshow: absent 줄은 total 에서 빼고 absent 로 센다 → 점검 정상 · 파트 장애 fault 아님', () => {
  const ps = P.parseFruShow(PS);
  const fan = P.parseFruShow(FAN);
  assert.deepEqual(ps, { ok: 1, total: 1, absent: 1 });
  assert.deepEqual(fan, { ok: 2, total: 2, absent: 1 });
  assert.deepEqual(P.parseFruShow('Fan 1 is Ok\nFan 2 is Faulty'), { ok: 1, total: 2, absent: 0 }, '고장은 그대로 이상');
  const r = checkDevice(snapOf({ fans: fan, psus: ps }, P.parseSensorShow(SENSOR)));
  for (const k of ['psu', 'fan']) {
    const it = r.items.find((i) => i.key === k);
    assert.equal(it.status, 'ok', `${k}: ${it.detail}`);
    assert.match(it.detail, /빈 슬롯 1개/);
  }
  const ex = extractSanSwitchParts({ id: 'sw-1', name: 'SW1' }, { ok: true, health: { fans: fan, psus: ps }, ports: { list: [] } });
  for (const k of ['psu', 'fan']) {
    const part = ex.parts.find((p) => p.kind === k);
    assert.equal(part.state, 'ok', `${k} 파트: 빈 슬롯이 fault 로 열리면 안 된다(${part.rawState})`);
  }
  // 장착된 것이 하나도 없다고 보고되면 '정상' 이라 말하지 않는다
  const none = P.parseFruShow('Power Supply #1 is absent');
  assert.deepEqual(none, { ok: 0, total: 0, absent: 1 });
  assert.notEqual(checkDevice(snapOf({ psus: none }, null)).items.find((i) => i.key === 'psu').status, 'ok');
  assert.equal(extractSanSwitchParts({ id: 'sw-1' }, { ok: true, health: { psus: none }, ports: { list: [] } }).parts.find((p) => p.kind === 'psu').state, 'unknown');
});

test('DEV-02 ④ REST: operational-state absent 도 같은 규칙(fosRest.fruCounts)', async () => {
  const { fruCounts } = await import('../src/sanswitch/collectors/fosRest.js');
  assert.deepEqual(fruCounts([{ 'operational-state': 'ok' }, { 'operational-state': 'absent' }, { 'operational-state': 'faulty' }]), { ok: 1, total: 2, absent: 1 });
  assert.equal(fruCounts([]), null);
});

/* ── DEV-04 ─────────────────────────────────────────────────────────────── */

const PZ_TXT = `Effective configuration:
 cfg:	cfg1
 zone:	pz_a
		00:02:00:00:00:03:00:01
		50:06:01:60:00:00:00:a1
		10:00:00:10:9b:00:00:01
 zone:	pz_b
		00:02:00:00:00:03:00:01
		50:06:01:60:00:00:00:b1
		10:00:00:10:9b:00:00:02
`;

test('DEV-04 ① SSH cfgshow: peer zone 속성 멤버는 끝점이 아니다 — zone 이 한 덩어리로 묶이지 않고 이니시에이터/타깃이 갈린다', async () => {
  const Z = await import('../src/sanswitch/zoning.js');
  const { zoningFromText } = await import('../src/sanswitch/zoningCollect.js');
  assert.equal(Z.isPropertyMember('00:02:00:00:00:03:00:01'), true);
  assert.equal(Z.isPropertyMember('10:00:00:10:9b:00:00:01'), false);
  const r = Z.resolveZones(Z.parseCfgShow(PZ_TXT));
  for (const z of r.zones) {
    assert.ok(!z.wwns.includes('00:02:00:00:00:03:00:01'), `속성 멤버가 끝점으로 들어갔다: ${z.wwns}`);
    assert.equal(z.peer, true); assert.equal(z.properties, 1);
  }
  const g = Z.buildZoneGraph(r.zones, {});
  assert.ok(!g.nodes.some((n) => n.wwn.startsWith('00:')), '속성 멤버 노드가 없어야 한다');
  assert.equal(g.columns.middle.length, 0, `모든 끝점이 middle 로 덮이면 안 된다: ${g.nodes.map((n) => `${n.wwn}:${n.side}`).join(' ')}`);
  assert.equal(g.columns.left.length, 2); assert.equal(g.columns.right.length, 2);
  assert.equal(g.peerZones, 2); assert.equal(g.propertyMembers, 2);
  // 저장(compact) → 읽기 왕복에서도 같은 판정 — 옛 스냅샷(속성 멤버가 members 에 든 것)도 읽을 때 걸러진다.
  const c = zoningFromText(PZ_TXT, 'cfg1');
  assert.ok(c.zones.every((z) => !z.members.some((m) => m.startsWith('00:'))));
  const old = { zones: [{ name: 'pz_a', members: ['00:02:00:00:00:03:00:01', '50:06:01:60:00:00:00:a1', '10:00:00:10:9b:00:00:01'] }] };
  const back = Z.zonesFromCompact(old);
  assert.deepEqual(back[0].wwns, ['50:06:01:60:00:00:00:a1', '10:00:00:10:9b:00:00:01']);
  assert.equal(back[0].properties, 1);
  // 속성 멤버를 멤버 수에 세지 않는다 — 속성 + 끝점 1개짜리 peer zone 은 '멤버 1개'
  const one = Z.zonesFromCompact({ zones: [{ name: 'pz_c', members: ['00:02:00:00:00:03:00:01', '50:06:01:60:00:00:00:c1'] }] });
  const f = Z.zoneFindings(one, Z.buildZoneGraph(one, {}), {});
  assert.ok(f.some((x) => x.kind === 'single-member'), JSON.stringify(f));
});

test('DEV-04 ② REST: principal-entry-name 을 버리지 않고, peer zone 은 principal↔peer 쌍만 간선', async () => {
  const Z = await import('../src/sanswitch/zoning.js');
  const { zoningFromRest } = await import('../src/sanswitch/zoningCollect.js');
  const eff = { 'effective-configuration': { 'cfg-name': 'cfg1', 'enabled-zone': [
    { 'zone-name': 'pz_a', 'zone-type': 1, 'member-entry': { 'entry-name': ['10:00:00:10:9b:00:00:01', '10:00:00:10:9b:00:00:02'], 'principal-entry-name': ['50:06:01:60:00:00:00:a1'] } },
  ] } };
  const z = zoningFromRest(eff, null);
  assert.ok(z.zones[0].members.includes('50:06:01:60:00:00:00:a1'), `principal(타깃)이 버려졌다: ${z.zones[0].members}`);
  assert.equal(z.zones[0].peer, true);
  const zones = Z.zonesFromCompact(z);
  const g = Z.buildZoneGraph(zones, {});
  assert.equal(g.links.length, 2, `peer 끼리 간선을 넣으면 안 된다: ${JSON.stringify(g.links)}`);
  assert.ok(g.links.every((l) => l.a === '50:06:01:60:00:00:00:a1' || l.b === '50:06:01:60:00:00:00:a1'));
  const side = Object.fromEntries(g.nodes.map((n) => [n.wwn, n.side]));
  assert.equal(side['50:06:01:60:00:00:00:a1'], 'target');
  assert.equal(side['10:00:00:10:9b:00:00:01'], 'initiator');
  assert.equal(side['10:00:00:10:9b:00:00:02'], 'initiator');
  // peer zone 은 설계상 다중 이니시에이터 — single-initiator 위반으로 세지 않는다
  assert.ok(!Z.zoneFindings(zones, g, {}).some((x) => x.kind === 'multi-initiator'));
  // 일반 zone(principal 없음)은 예전처럼 모든 쌍 · v2.511 판정 순서(네임서버 확정이 구조 추론보다 먼저)는 그대로
  const plain = [{ name: 'z', wwns: ['10:00:00:10:9b:00:00:01', '10:00:00:10:9b:00:00:02', '50:06:01:60:00:00:00:a1'], members: [], unresolved: [] }];
  assert.equal(Z.buildZoneGraph(plain, {}).links.length, 3);
  const g2 = Z.buildZoneGraph(plain, { nsRoles: { '10:00:00:10:9b:00:00:01': 'initiator', '10:00:00:10:9b:00:00:02': 'initiator', '50:06:01:60:00:00:00:a1': 'target' } });
  assert.ok(g2.nodes.every((n) => n.confidence === 'confirmed'));
});

/* ── DEV-06 ─────────────────────────────────────────────────────────────── */

test('DEV-06 ① 간격 상한 = max(2시간, 주기 × 3 + 실행 소요) · computed:false 사유', async () => {
  const R = await import('../src/sanswitch/rates.js');
  R._resetForTest();
  const H = 3600_000;
  const T0 = Math.floor(1_790_000_000_000 / H) * H + 17 * 60_000;
  const port = (b) => ({ index: 0, inBytes: b, outBytes: b, inFrames: b, outFrames: b });
  assert.equal(R.maxGapMs({ intervalMs: 0, runMs: 0 }), 2 * H, '주기를 모르면 2시간 하한');
  assert.equal(R.maxGapMs({ intervalMs: 3 * H, runMs: 60_000 }), 9 * H + 60_000);
  // 주기 3시간 — 간격 3시간 2분은 이제 계산한다(예전 2시간 고정이면 영원히 null)
  R.setRateCadence({ intervalMs: 3 * H, runMs: 120_000 });
  const a = R.applyRates('d1', [port(1000)], T0);
  assert.equal(a.computed, false); assert.equal(a.reason, 'first');
  const p2 = [port(1000 + 3600)];
  const b = R.applyRates('d1', p2, T0 + 3 * H + 120_000);
  assert.equal(b.computed, true, JSON.stringify(b));
  assert.ok(p2[0].inBps != null);
  // 상한을 넘으면 사유가 gap-too-long, 너무 짧으면 gap-too-short
  const c = R.applyRates('d1', [port(9999)], T0 + 3 * H + 120_000 + 10 * H);
  assert.equal(c.reason, 'gap-too-long'); assert.equal(c.maxGapSec, Math.round((9 * H + 120_000) / 1000));
  const d = R.applyRates('d1', [port(9999)], T0 + 3 * H + 120_000 + 10 * H + 1000);
  assert.equal(d.reason, 'gap-too-short');
  assert.equal(R.lastRateResult('d1').reason, 'gap-too-short');
  R._resetForTest();
});

test('DEV-06 ② 폴러가 주기를 알려 준다(실제 pollSanSwitchOnce — 데모 스위치) · 스냅샷에 사유를 싣는다(attachRateReason)', async () => {
  const H = 3600_000;
  const reg = await import('../src/sanswitch/registry.js');
  const poller = await import('../src/sanswitch/poller.js');
  const { getSnapshot } = await import('../src/sanswitch/store.js');
  const R = await import('../src/sanswitch/rates.js');
  assert.equal(reg.seedDemoDevices([{ id: 'mock-san-gi1', name: 'GI1', type: 'brocade', host: '192.0.2.10', username: 'u', password: 'p', collectMethod: 'ssh' }]), 1);
  process.env.SANSW_POLL_MS = String(3 * H);
  try {
    const r1 = await poller.pollSanSwitchOnce({ manual: true });
    assert.equal(r1.ok, true, JSON.stringify(r1));
    assert.ok(getSnapshot('mock-san-gi1')?.ok);
    assert.ok(R.lastRateResult('mock-san-gi1').maxGapSec >= 9 * 3600, '주기 3시간이면 상한은 9시간 이상(폴러가 setRateCadence 로 알린다)');
  } finally { delete process.env.SANSW_POLL_MS; }
  // 스냅샷 사유 — 실제 applyRates 결과를 그대로 싣는다
  R._resetForTest();
  const t0 = Date.now();
  const ports = [{ index: 0, inBytes: 1, outBytes: 1 }];
  const rate = R.applyRates('dX', ports, t0);
  const snap = poller.attachRateReason({ ok: true, extra: { rateReady: rate.computed, rateGapSec: rate.gapSec } }, 'dX', t0 - 1);
  assert.equal(snap.extra.rateReason, 'first');
  assert.ok(snap.extra.rateMaxGapSec > 0);
  // 이번 수집이 applyRates 까지 가지 않았으면(시작 시각보다 오래된 결과) 직전 사유를 붙이지 않는다
  const stale = poller.attachRateReason({ ok: true, extra: { rateReady: false } }, 'dX', Date.now() + 60_000);
  assert.equal(stale.extra.rateReason, undefined);
  // 계산했으면 사유를 싣지 않는다
  assert.equal(poller.attachRateReason({ ok: true, extra: { rateReady: true } }, 'dX', 0).extra.rateReason, undefined);
});

/* ── DB-06 ─────────────────────────────────────────────────────────────── */

test('DB-06 storage-summary: 같은 조건·같은 집계·같은 역할이면 같은 응답 객체(compress 캐시 재사용) — 실제 SAN 라우트 등록 함수', async () => {
  const express = (await import('express')).default;
  // 실제 라우트 등록 함수(routes/api.js 가 부르는 registerSanSwitch)를 그대로 쓴다 — api.js 전체를 띄우지 않는 것은 다른 화면의
  // 라우트 로드와 무관하게 이 라우트만 보려는 것이다(게이트·핸들러는 같다).
  const { registerSanSwitch } = await import('../src/routes/api/sanSwitch.js');
  const api = express.Router();
  registerSanSwitch(api);
  const bodies = [];
  const app = express(); app.use(express.json());
  app.use((req, res, next) => {
    if (req.headers['x-test-role']) req.user = { username: 'tester', role: String(req.headers['x-test-role']) };
    const o = res.json.bind(res);
    res.json = (b) => { if (req.path.endsWith('/storage-summary')) bodies.push(b); return o(b); };
    next();
  });
  app.use('/api', api);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${srv.address().port}/api/tools/sanswitch/perf/storage-summary?hours=1`;
  const get = async (q = '', role = 'admin') => {
    const r = await fetch(`${base}${q}`, { headers: { 'x-test-role': role } });
    const j = await r.json();
    assert.equal(r.status, 200, JSON.stringify(j).slice(0, 300));
    return j;
  };
  try {
    const a = await get();
    const b = await get();
    assert.equal(a.computedAt, b.computedAt);
    assert.equal(bodies.length, 2);
    assert.equal(bodies[0], bodies[1], '같은 조건이면 같은 객체를 res.json 에 넘겨야 compress 캐시가 직렬화를 다시 하지 않는다');
    await get('&kind=array');
    assert.notEqual(bodies[2], bodies[0], '종류가 다르면 다른 응답');
    const op = await get('', 'operator');
    assert.notEqual(bodies[3], bodies[0], '역할이 다르면(관리 주소 가림) 다른 응답');
    assert.equal(op.addressHidden, true);
    assert.equal(bodies[0].addressHidden, undefined);
  } finally { srv.close(); }
});
