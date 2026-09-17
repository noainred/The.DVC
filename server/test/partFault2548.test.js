/**
 * partFault2548.test.js — 물리 파트 장애 v2.548 재설계(사용자 지시 "이게 가능한지 검토, 다시 설계해줘").
 *
 * 6축 조사 + 적대적 반증으로 v2.547 의 확정 결함 9건을 찾았다. 이 파일은 그중 **코드 실행으로 재현된
 * 것**을 하나씩 고정한다 — 되돌리면 그 항목만 깨진다(변이 검증 완료).
 *   F1 수집 실패가 '부품 0개 = 정상' 으로 읽힘   → extract/idrac reachable · scan unreachable · transition ⑥
 *   F2 파트 키에 법인 축이 없어 법인 간 충돌      → deviceKey 등급 · agent|partKey 동일성 · agent|deviceId 맵
 *   F3 엣지 push 가 opt-in 스위치를 무시          → settings.partFaultEnabled 우선순위
 *   F5 중앙 수신에 소유권 검사가 없음             → partFaultEdge rejected
 *   F6 '장애만' → '장애 + 전체 요약'(프로토콜 2)   → push.buildPayload · partFaultEdge v2 파싱
 *   F9 SAN 추출기 없음                             → scan sanswitch 경로(추출기 주입)
 *   엣지 버전 분류(구버전/무보고/오래됨)           → routes classifyEdges
 *
 * 기준 시각은 **정시 -30분**(CLAUDE.md v2.517 규약) — 절대 상수를 쓰면 조회 창 밖으로 떨어진다.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'partfault2548-'));
process.env.CONFIG_DIR = dir;
delete process.env.PARTFAULT_ENABLED;

const { makePart, partKeyOf, partKeyTail, partKeyFromTail, HOLD_REASON, DEVICE_KEY_KIND, COLLECTION_KINDS, PUSH_PROTOCOL } = await import('../src/partfault/types.js');
const { extractIdracParts, deviceKeyOf } = await import('../src/partfault/extract/idrac.js');
const { scanFrom, devKeyOf } = await import('../src/partfault/scan.js');
const { transition } = await import('../src/partfault/transition.js');
const { buildPayload } = await import('../src/partfault/push.js');
const edge = await import('../src/central/partFaultEdge.js');
const { classifyEdges, cmpVersion, MIN_EDGE_VERSION } = await import('../src/routes/api/partFaults.js');
const settings = await import('../src/partfault/settings.js');

const HOUR = 3_600_000;
const NOW = Math.floor(Date.now() / HOUR) * HOUR - 30 * 60_000;
const inv = (over = {}) => ({ system: { model: 'R750', serviceTag: 'ABC1234', uuid: 'u-1' }, collections: { psus: 'ok', disks: 'ok', storageControllers: 'ok', memoryDimms: 'ok', cpus: 'ok', gpus: 'ok', pcie: 'ok', fans: 'ok' }, reachable: true, psus: [], disks: [], memoryDimms: [], fans: [], cpus: [], gpus: [], storageControllers: [], pcie: [], ...over });

/* ───────────────────────── F2 — 장비 키 등급 ───────────────────────── */

test('장비 키는 서비스태그 → UUID → 로컬 id 순이고 등급을 밝힌다', () => {
  assert.deepEqual(deviceKeyOf({ id: '10.0.0.5' }, inv()), { key: 'ABC1234', kind: DEVICE_KEY_KIND.serviceTag });
  assert.deepEqual(deviceKeyOf({ id: '10.0.0.5' }, inv({ system: { uuid: 'u-1' } })), { key: 'u-1', kind: DEVICE_KEY_KIND.uuid });
  assert.deepEqual(deviceKeyOf({ id: '10.0.0.5' }, inv({ system: {} })), { key: '10.0.0.5', kind: DEVICE_KEY_KIND.localId });
  // 등록부에 서비스태그가 있으면 인벤토리에 없어도 쓴다
  assert.equal(deviceKeyOf({ id: '10.0.0.5', serviceTag: 'REG999' }, inv({ system: {} })).key, 'REG999');
});

test('partKey 의 장비 축은 deviceKey 다 — 같은 IP 라도 서비스태그가 다르면 다른 키', () => {
  const a = makePart({ scope: 'idrac', deviceId: '10.0.0.5', deviceKey: 'TAG-A', deviceKeyKind: 'serviceTag', kind: 'psu', partId: 'S1', state: 'fault' });
  const b = makePart({ scope: 'idrac', deviceId: '10.0.0.5', deviceKey: 'TAG-B', deviceKeyKind: 'serviceTag', kind: 'psu', partId: 'S1', state: 'fault' });
  assert.notEqual(a.partKey, b.partKey);
  assert.equal(a.partKey, 'idrac:TAG-A:psu:S1');
  // 꼬리 왕복(프로토콜 2 states 배열의 근거)
  assert.equal(partKeyFromTail({ scope: 'idrac', deviceKey: 'TAG-A', tail: partKeyTail(a) }), a.partKey);
  // deviceKey 를 안 주면 deviceId(하위 호환) — 그리고 등급은 localId
  const c = makePart({ scope: 'idrac', deviceId: '10.0.0.5', kind: 'psu', partId: 'S1', state: 'ok' });
  assert.equal(c.partKey, 'idrac:10.0.0.5:psu:S1'); assert.equal(c.deviceKeyKind, 'localId');
  assert.equal(partKeyOf({ scope: 'x', deviceId: 'd', kind: 'k', partId: 'p' }), 'x:d:k:p');
});

/* ───────────────────────── F1 — 수집 실패 ≠ 부품 0개 ───────────────────────── */

test('extract/idrac: reachable=false 면 파트 0개 + 전 종류 failedKinds (빈 배열을 정상으로 읽지 않는다)', () => {
  const r = extractIdracParts({ id: '10.0.0.5' }, inv({ reachable: false, system: {} }));
  assert.equal(r.reachable, false);
  assert.equal(r.parts.length, 0);
  assert.deepEqual([...r.failedKinds].sort(), Object.values(COLLECTION_KINDS).sort());
});

test('extract/idrac: 컬렉션 하나만 실패하면 그 종류만 failedKinds 이고 나머지는 판정한다', () => {
  const r = extractIdracParts({ id: 'x' }, inv({ collections: { ...inv().collections, psus: 'failed' }, psus: [], disks: [{ serial: 'D1', health: 'Critical', state: 'Enabled' }] }));
  assert.deepEqual(r.failedKinds, ['psu']);
  assert.equal(r.parts.length, 1);
  assert.equal(r.parts[0].kind, 'disk');
  assert.equal(r.reachable, true);
});

test('extract/idrac: 메타 없는 구버전 캐시(legacy)는 전부 비어 있을 때만 불통으로 본다', () => {
  const empty = extractIdracParts({ id: 'x' }, { system: {}, psus: [], disks: [] });
  assert.equal(empty.legacy, true); assert.equal(empty.reachable, false);
  const some = extractIdracParts({ id: 'x' }, { system: { model: 'R750' }, psus: [{ name: 'PSU1', health: 'OK', state: 'Enabled' }] });
  assert.equal(some.legacy, true); assert.equal(some.reachable, true); assert.equal(some.parts.length, 1);
});

test('scan: 불통 장비는 deviceOk=false · reason unreachable 이고 요약이 그 수를 센다', () => {
  const r = scanFrom({ idracServers: [{ id: 'a' }, { id: 'b' }], invOf: (id) => (id === 'a' ? inv({ reachable: false, system: {} }) : inv({ psus: [{ name: 'P1', health: 'OK', state: 'Enabled' }] })) });
  assert.equal(r.deviceOk[devKeyOf('', 'a')], false);
  assert.equal(r.deviceOk[devKeyOf('', 'b')], true);
  assert.equal(r.scanned.idrac.unreachable, 1);
  assert.equal(r.scanned.devicesFailed, 1);
  assert.equal(r.devices.find((d) => d.deviceId === 'a').reason, 'unreachable');
  // 부분 실패는 kindFailed 로 올라간다
  const p = scanFrom({ idracServers: [{ id: 'c' }], invOf: () => inv({ collections: { ...inv().collections, memoryDimms: 'failed' } }) });
  assert.deepEqual(p.kindFailed[devKeyOf('', 'c')], ['dimm']);
  assert.equal(p.scanned.idrac.partial, 1);
});

/* ───────────────────────── 전이 — agent 축 + 컬렉션 단위 보류 ───────────────────────── */

const part = (o) => makePart({ scope: 'idrac', deviceId: '10.0.0.5', deviceKey: 'TAG', deviceKeyKind: 'serviceTag', kind: 'psu', ...o });

test('전이 ⑥: 장비에는 닿았는데 그 컬렉션만 실패하면 그 종류의 열린 장애만 collection-failed 로 보류', () => {
  const open = [
    { ...part({ partId: 'P1', state: 'fault', agent: 'E1' }), firstSeenAt: NOW - 1 },
    { ...part({ partId: 'D1', kind: 'disk', state: 'fault', agent: 'E1' }), firstSeenAt: NOW - 1 },
  ];
  const dk = devKeyOf('E1', '10.0.0.5');
  const tr = transition({ open, observed: [part({ partId: 'D1', kind: 'disk', state: 'ok', agent: 'E1' })],
    scan: { deviceOk: { [dk]: true }, kindFailed: { [dk]: ['psu'] } }, now: NOW });
  assert.equal(tr.closed.length, 1); assert.equal(tr.closed[0].kind, 'disk');
  assert.equal(tr.held.length, 1); assert.equal(tr.held[0].holdReason, HOLD_REASON.collectionFailed);
  assert.equal(tr.stats.heldCollectionFailed, 1);
});

test('전이 F2: 같은 partKey 라도 agent 가 다르면 다른 장애 — 한 법인의 ok 가 다른 법인을 닫지 않는다', () => {
  const open = [{ ...part({ partId: 'P1', state: 'fault', agent: 'E1' }), firstSeenAt: NOW - 1 }];
  const tr = transition({ open, observed: [part({ partId: 'P1', state: 'ok', agent: 'E2' })],
    scan: { deviceOk: { [devKeyOf('E2', '10.0.0.5')]: true } }, now: NOW });
  assert.equal(tr.closed.length, 0);
  assert.equal(tr.opened.length, 0);
  assert.equal(tr.held[0].holdReason, HOLD_REASON.deviceFailed);   // E1 장비는 이번에 못 봤다
});

test('전이 ①~⑤ 는 그대로다(회귀 없음)', () => {
  const o = { ...part({ partId: 'P1', state: 'fault' }), firstSeenAt: NOW - 1 };
  const dk = devKeyOf('', '10.0.0.5');
  assert.equal(transition({ open: [o], observed: [], scan: { deviceOk: { [dk]: false } }, now: NOW }).held[0].holdReason, HOLD_REASON.deviceFailed);
  assert.equal(transition({ open: [o], observed: [part({ partId: 'P1', state: 'unknown' })], scan: { deviceOk: { [dk]: true } }, now: NOW }).held[0].holdReason, HOLD_REASON.unknown);
  assert.equal(transition({ open: [o], observed: [part({ partId: 'P1', state: 'absent' })], scan: { deviceOk: { [dk]: true } }, now: NOW }).closed[0].closeReason, 'removed');
  assert.equal(transition({ open: [o], observed: [part({ partId: 'P2', state: 'ok' })], scan: { deviceOk: { [dk]: true } }, now: NOW }).held[0].holdReason, HOLD_REASON.missing);
  assert.equal(transition({ open: [], observed: [part({ partId: 'P1', state: 'unknown' })], scan: {}, now: NOW }).opened.length, 0);
});

/* ───────────────────────── F6 — 프로토콜 2 ───────────────────────── */

test('push.buildPayload: 장비 단위 · 장애는 상세 · 나머지는 상태별 키 꼬리 · 상한은 밝힌다', () => {
  const scan = scanFrom({ idracServers: [{ id: 'a' }], invOf: () => inv({ psus: [{ name: 'P1', health: 'OK', state: 'Enabled' }, { name: 'P2', health: 'Critical', state: 'Enabled' }], memoryDimms: [{ locator: 'A1', state: 'Absent' }, { locator: 'A2' }] }) });
  const body = buildPayload(scan, { agent: 'E1', version: '2.548.0', now: NOW });
  assert.equal(body.v, PUSH_PROTOCOL); assert.equal(body.agent, 'E1'); assert.equal(body.version, '2.548.0');
  assert.equal(body.devices.length, 1);
  const d = body.devices[0];
  assert.equal(d.deviceKey, 'ABC1234'); assert.equal(d.deviceKeyKind, 'serviceTag'); assert.equal(d.ok, true);
  assert.equal(d.open.length, 1); assert.equal(d.open[0].partId, 'P2'); assert.match(d.open[0].rawState, /Critical/);
  assert.deepEqual(d.states.ok, ['psu:P1']); assert.deepEqual(d.states.absent, ['dimm:A1']); assert.deepEqual(d.states.unknown, ['dimm:A2']);
  assert.equal(body.omitted, 0);
  assert.ok(body.scanned.summary, '장애 0건이어도 요약은 있다');
});

test('partFaultEdge: v2 보고 → 전량 관측 복원 · agent 덮어쓰기 · deviceOk/kindFailed 는 agent|deviceId 키', async () => {
  edge._resetForTest(async () => ({ storage: new Set(['st-1']), sanswitch: new Set() }));
  const r = await edge.putEdgeReport('E1', { v: 2, version: '2.548.0', at: NOW, devices: [
    { scope: 'idrac', deviceId: '10.0.0.5', deviceKey: 'TAG', deviceKeyKind: 'serviceTag', deviceName: 'srv', ok: true, failedKinds: ['dimm'], agent: 'HACKER',
      states: { ok: ['psu:P1'], unknown: [], absent: ['dimm:A1'] }, open: [{ kind: 'disk', partId: 'D1', keyKind: 'serial', state: 'fault', rawState: 'Critical', label: 'Disk 0', agent: 'HACKER' }] },
    { scope: 'storage', deviceId: 'st-1', deviceKey: 'st-1', deviceKeyKind: 'centralId', ok: true, states: { ok: ['node:SPA'] }, open: [] },
    { scope: 'storage', deviceId: 'st-NOT-MINE', ok: true, states: {}, open: [{ kind: 'node', partId: 'SPB', state: 'fault' }] },
  ] });
  assert.equal(r.ok, true); assert.equal(r.protocol, 2);
  assert.equal(r.rejected, 1, '남의 스토리지 장비는 버리고 개수를 밝힌다(F5)');
  const m = edge.mergeEdgeReports({ now: NOW + 1000 });
  assert.equal(m.observed.length, 4);
  assert.ok(m.observed.every((p) => p.agent === 'e1'), '엣지가 보낸 agent 값은 무시하고 인증된 agent 로 덮는다');
  const fault = m.observed.find((p) => p.state === 'fault');
  assert.equal(fault.partKey, 'idrac:TAG:disk:D1');
  assert.equal(m.observed.find((p) => p.partKey === 'idrac:TAG:psu:P1').state, 'ok');
  assert.equal(m.deviceOk[devKeyOf('e1', '10.0.0.5')], true);
  assert.deepEqual(m.kindFailed[devKeyOf('e1', '10.0.0.5')], ['dimm']);
  assert.equal(m.agents[0].version, '2.548.0'); assert.equal(m.agents[0].legacy, false);
  // 오래된 보고는 아무것도 닫지 못한다
  const stale = edge.mergeEdgeReports({ now: edge.edgeReport('E1').at + 4 * 3_600_000 + 1000 });   // 보고 시각 기준(NOW 는 최대 90분 전 — 경계 결함)
  assert.equal(stale.deviceOk[devKeyOf('e1', '10.0.0.5')], false); assert.equal(stale.agents[0].stale, true);
  edge._resetForTest();
});

test('partFaultEdge: 프로토콜 1(v2.547 엣지)은 받되 deviceOk=false — unknown 과 해소를 구분해 줄 수 없다', async () => {
  edge._resetForTest(async () => ({ storage: new Set(), sanswitch: new Set() }));
  const r = await edge.putEdgeReport('OLD', { open: [{ scope: 'idrac', deviceId: '10.0.0.9', kind: 'psu', partId: 'P1', state: 'fault' }], deviceOk: { '10.0.0.9': true } });
  assert.equal(r.protocol, 1);
  const m = edge.mergeEdgeReports({ now: NOW });
  assert.equal(m.deviceOk[devKeyOf('old', '10.0.0.9')], false);
  assert.equal(m.agents[0].legacy, true);
  assert.equal(m.observed.length, 1);
  edge._resetForTest();
});

/* ───────────────────────── F3 — 스위치 ───────────────────────── */

test('settings.partFaultEnabled: env > 중앙 설정 > 기본 꺼짐, 그리고 왜인지 밝힌다', () => {
  settings._resetForTest();
  assert.deepEqual(settings.partFaultEnabled(), { enabled: false, source: 'default' });
  settings.savePartFaultSettings({ enabled: true, edges: { 'e1': { enabled: false }, 'BAD': 'x' } });
  assert.deepEqual(settings.partFaultEnabled(), { enabled: true, source: 'central' });
  assert.deepEqual(settings.settingsForAgent('E1'), { enabled: false });      // 엣지별 off 가 이긴다(대소문자 무시)
  assert.deepEqual(settings.settingsForAgent('e2'), { enabled: true });
  assert.equal(Object.keys(settings.loadPartFaultSettings().edges).length, 1, '형식이 아닌 항목은 버린다');
  process.env.PARTFAULT_ENABLED = 'false';
  assert.deepEqual(settings.partFaultEnabled(), { enabled: false, source: 'env' });
  delete process.env.PARTFAULT_ENABLED;
  settings._resetForTest();
});

/* ───────────────────────── 엣지 분류 ───────────────────────── */

test('classifyEdges: 보고 없음을 구버전/무보고/버전미상으로 나누고, 보고는 fresh/stale/legacy 로 나눈다', () => {
  assert.ok(cmpVersion('2.547.0', MIN_EDGE_VERSION) < 0); assert.equal(cmpVersion('2.548.0', MIN_EDGE_VERSION), 0); assert.equal(cmpVersion('x', '1.0.0'), null);
  const r = classifyEdges({
    collectors: [{ id: 'c1', name: 'OLD' }, { id: 'c2', name: 'NEW' }, { id: 'c3', name: 'FRESH' }, { id: 'c4', name: 'NOVER' }, { id: 'c5', name: 'STALE' }, { id: 'c6', name: 'LEG' }],
    status: { c1: { version: '2.547.0' }, c2: { version: '2.548.0' }, c3: { version: '2.548.0' }, c5: { version: '2.548.0' }, c6: { version: '2.547.0' } },
    reports: [
      { agent: 'fresh', at: NOW, ageMs: 10, stale: false, legacy: false, version: '2.548.0', protocol: 2, devices: 3, devicesFailed: 0, open: 1 },
      { agent: 'stale', at: NOW, ageMs: 9e9, stale: true, legacy: false, version: '2.548.0', protocol: 2, devices: 3, devicesFailed: 0, open: 0 },
      { agent: 'leg', at: NOW, ageMs: 10, stale: false, legacy: true, version: '', protocol: 1, devices: 1, devicesFailed: 1, open: 1 },
      { agent: 'ghost', at: NOW, ageMs: 10, stale: false, legacy: false, version: '2.548.0', protocol: 2, devices: 1, devicesFailed: 0, open: 0 },
    ],
  });
  const kind = (n) => r.rows.find((x) => x.agent.toLowerCase() === n).kind;
  assert.equal(kind('old'), 'old-version'); assert.equal(kind('new'), 'silent'); assert.equal(kind('fresh'), 'fresh');
  assert.equal(kind('nover'), 'unknown-version'); assert.equal(kind('stale'), 'stale'); assert.equal(kind('leg'), 'legacy');
  assert.equal(r.rows.find((x) => x.agent === 'ghost').unregistered, true, '등록부에 없는 보고자를 숨기지 않는다');
  assert.deepEqual(r.counts, { 'old-version': 1, silent: 1, fresh: 2, 'unknown-version': 1, stale: 1, legacy: 1 });
});

/* ───────────────────────── 배선 검사 ───────────────────────── */

test('배선: 엣지 push 는 스위치를 보고, 중앙 poller 는 엣지에서 돌지 않으며, 수신 캐시는 디스크에 쓰지 않는다', () => {
  const here = path.dirname(new URL(import.meta.url).pathname);
  const src = (f) => fs.readFileSync(path.join(here, '..', 'src', f), 'utf8');
  assert.match(src('partfault/push.js'), /partFaultEnabled\(\)/);
  assert.match(src('partfault/poller.js'), /isEdge\(\)\) return/);
  assert.equal(/atomicWriteFileSync|writeFileSync/.test(src('central/partFaultEdge.js')), false);
  assert.match(src('idrac/poller.js'), /onSnapshotRefreshed\('idrac'\)/);
  assert.match(src('index.js'), /startPartFaultConfigPull/);
  assert.match(src('routes/central.js'), /partfault-config/);
  assert.match(src('index.js'), /app\.use\('\/api\/central\/part-faults', BIG_JSON\)/);
});

// ── v2.548 적대적 보안 리뷰 S1·S2 — 중앙 수신부의 프로토타입 키·null 원소·파트 상한 ────────────────
test('S1: scope 가 프로토타입 키(constructor·__proto__)이거나 원소가 null 이어도 던지지 않는다', async () => {
  edge._resetForTest(async () => ({ storage: new Set(['st-1']), sanswitch: new Set() }));
  const body = { v: 2, version: '2.548.0', at: NOW, devices: [
    null, 'x', 7,
    { scope: 'constructor', deviceId: 'c1', ok: true, open: [null, 'y', { kind: 'psu', partId: 'P1', state: 'fault' }], states: { ok: [null, 3, 'fan:F1'] } },
    { scope: '__proto__', deviceId: 'p1', ok: true, open: [], states: { ok: ['fan:F1'] } },
    { scope: 'storage', deviceId: 'st-1', ok: true, open: [], states: { ok: ['disk:D1'] } },
    { scope: 'storage', deviceId: 'st-9', ok: true, open: [], states: {} },
  ] };
  const r = await edge.putEdgeReport('E1', body);
  assert.equal(r.ok, true);
  assert.equal(r.devices, 3, '프로토타입 키 장비 2대 + 소유 스토리지 1대 — null·문자열 원소는 건너뛴다');
  assert.equal(r.rejected, 1, '등록부에 없는 스토리지는 여전히 거부');
  assert.equal(r.open, 1, 'null 원소는 세지 않는다');
  assert.equal(r.partsOmitted, 0);
});

test('S2: 장비당 파트 상한을 넘기면 잘린 개수를 밝히고 그 장비를 ok:false(parts-capped) 로 둔다 — 닫지 않는 쪽', async () => {
  edge._resetForTest(async () => ({ storage: new Set(), sanswitch: new Set() }));
  const big = Array.from({ length: 2_500 }, (_, i) => `dimm:D${i}`);
  const r = await edge.putEdgeReport('E2', { v: 2, version: '2.548.0', at: NOW, devices: [
    { scope: 'idrac', deviceId: '10.0.0.1', ok: true, open: [{ kind: 'psu', partId: 'P1', state: 'fault' }], states: { ok: big } },
    { scope: 'idrac', deviceId: '10.0.0.2', ok: true, open: [], states: { ok: ['fan:F1'] } },
  ] });
  assert.equal(r.ok, true);
  assert.equal(r.partsOmitted, 501, '2,501 - 2,000');
  const m = edge.mergeEdgeReports({ now: NOW });
  assert.equal(m.deviceOk[devKeyOf('e2', '10.0.0.1')], false, '잘린 장비는 못 본 것으로');
  assert.equal(m.deviceOk[devKeyOf('e2', '10.0.0.2')], true, '멀쩡한 장비는 그대로');
  const d = edge.edgeReport('E2').devices.find((x) => x.deviceId === '10.0.0.1');
  assert.equal(d.reason, 'parts-capped');
  assert.equal(d.partsOmitted, 501);
  assert.equal(d.parts.length, 2_000);
  assert.equal(m.agents[0].partsOmitted, 501, '엣지 표가 밝힌다');
});

test('S2: scanned 요약이 32KB 를 넘으면 버리고 scannedDropped 로 밝힌다 · 문자열 필드는 길이를 자른다', async () => {
  edge._resetForTest(async () => ({ storage: new Set(), sanswitch: new Set() }));
  const r = await edge.putEdgeReport('E3', { v: 2, version: 'v'.repeat(500), at: NOW, scanned: { blob: 'x'.repeat(40_000) }, devices: [
    { scope: 'idrac', deviceId: '10.0.0.3', deviceName: 'n'.repeat(1_000), ok: true, reason: 'r'.repeat(1_000), open: [], states: {}, failedKinds: Array.from({ length: 200 }, () => 'psu') },
  ] });
  assert.equal(r.ok, true);
  const rep = edge.edgeReport('E3');
  assert.equal(rep.scanned, null);
  assert.equal(rep.scannedDropped, true);
  assert.equal(rep.version.length, 32);
  assert.equal(rep.devices[0].deviceName.length, 200);
  assert.equal(rep.devices[0].reason.length, 300);
  assert.equal(rep.devices[0].failedKinds.length, 64);
  const small = await edge.putEdgeReport('E4', { v: 2, at: NOW, scanned: { idrac: { devices: 3 } }, devices: [] });
  assert.equal(small.ok, true);
  assert.deepEqual(edge.edgeReport('E4').scanned, { idrac: { devices: 3 } }, '정상 크기 요약은 그대로');
});

test('S1 계열: settingsForAgent 는 프로토타입 키 agent 에 기본값을 준다', () => {
  settings._resetForTest();
  // 앞 테스트가 전역 스위치를 파일에 저장해 뒀을 수 있다 — 기준은 '등록되지 않은 agent 와 같은 값'(전역값)이다.
  const base = settings.settingsForAgent('no-such-agent');
  assert.equal(typeof base.enabled, 'boolean');
  assert.deepEqual(settings.settingsForAgent('constructor'), base, 'Object 생성자를 엣지 설정으로 읽지 않는다');
  assert.deepEqual(settings.settingsForAgent('__proto__'), base);
  assert.deepEqual(settings.settingsForAgent('hasOwnProperty'), base);
});

// ── v2.548 적대적 정확성 리뷰 C1~C5 — '거짓 복구' 경로 ──────────────────────────────────────────
const mkPart = (o) => makePart({ scope: 'idrac', deviceId: '10.0.0.5', deviceKey: 'TAG1', deviceKeyKind: 'serviceTag', kind: 'psu', partId: 'S1', keyKind: 'serial', ...o });

test('C1: 같은 (agent|partKey) 가 한 주기에 두 번 관측되면 가장 나쁜 상태가 이긴다 — ok 관측이 fault 를 닫지 못한다', () => {
  const dk = devKeyOf('', '10.0.0.5');
  const open = [{ ...mkPart({ state: 'fault' }), firstSeenAt: NOW - 60_000, lastSeenAt: NOW - 60_000 }];
  // 등록부에 같은 서버가 두 id 로 있을 때 — 한쪽 인벤토리(25분 전)는 ok, 다른 쪽(방금)은 fault
  const observed = [mkPart({ state: 'ok', deviceId: '10.0.0.5' }), mkPart({ state: 'fault', deviceId: 'TAG1' })];
  const tr = transition({ open, observed, scan: { deviceOk: { [dk]: true, [devKeyOf('', 'TAG1')]: true } }, now: NOW });
  assert.equal(tr.closed.length, 0, 'ok 관측이 있어도 닫지 않는다');
  assert.equal(tr.updated.length, 1);
  assert.equal(tr.stats.duplicateObserved, 1, '중복 관측을 밝힌다');
  // unknown 도 ok 를 이긴다(규칙 ② 와 같은 방향)
  const tr2 = transition({ open, observed: [mkPart({ state: 'ok' }), mkPart({ state: 'unknown' })], scan: { deviceOk: { [dk]: true } }, now: NOW });
  assert.equal(tr2.closed.length, 0);
  assert.equal(tr2.held[0].holdReason, HOLD_REASON.unknown);
  // 전부 ok 면 닫는다(정상 경로는 그대로)
  const tr3 = transition({ open, observed: [mkPart({ state: 'ok' }), mkPart({ state: 'ok' })], scan: { deviceOk: { [dk]: true } }, now: NOW });
  assert.equal(tr3.closed.length, 1);
});

test('C2: 오래된 엣지 보고의 파트는 관측 목록에 들어가지 않는다 — lastSeen 도 갱신되지 않고 ok 꼬리가 닫지 못한다', async () => {
  edge._resetForTest(async () => ({ storage: new Set(), sanswitch: new Set() }));
  await edge.putEdgeReport('E1', { v: 2, version: '2.548.0', at: NOW, devices: [
    { scope: 'idrac', deviceId: '10.0.0.5', deviceKey: 'TAG1', deviceKeyKind: 'serviceTag', ok: true,
      open: [{ kind: 'psu', partId: 'S1', keyKind: 'serial', state: 'fault' }], states: { ok: ['psu:P1'] } },
  ] });
  const fresh = edge.mergeEdgeReports({ now: NOW });
  assert.equal(fresh.observed.length, 2, '신선하면 장애 1 + ok 1 이 관측된다');
  const at = edge.edgeReport('E1').at;   // 보고 시각(모듈이 Date.now() 로 찍는다) 기준 — NOW 는 최대 90분 전이라 경계에 걸린다
  const stale = edge.mergeEdgeReports({ now: at + 4 * 3_600_000 });
  assert.equal(stale.observed.length, 0, '3시간이 지난 보고의 파트는 관측이 아니다');
  assert.equal(stale.deviceOk[devKeyOf('e1', '10.0.0.5')], false);
  assert.equal(stale.agents[0].open, 1, '열린 개수 집계는 그대로(화면의 엣지 표)');
  // 전이의 방어선 — 장비가 실패로 표시됐는데 ok 관측이 섞여 와도 닫지 않는다
  const open = [{ ...mkPart({ agent: 'e1', state: 'fault' }), firstSeenAt: NOW - 60_000, lastSeenAt: NOW - 60_000 }];
  const tr = transition({ open, observed: [mkPart({ agent: 'e1', state: 'ok' })], scan: { deviceOk: { [devKeyOf('e1', '10.0.0.5')]: false } }, now: NOW });
  assert.equal(tr.closed.length, 0);
  assert.equal(tr.held[0].holdReason, HOLD_REASON.deviceFailed);
});

test('C3: Systems GET 만 실패한 주기에는 장비 키가 IP 로 떨어지지 않도록 파트를 내지 않는다(system-failed 보류)', () => {
  const server = { id: '10.0.0.5', name: 'esxi05', serviceTag: '' };
  const okInv = { reachable: true, collections: { system: 'ok', psus: 'ok', disks: 'failed', storageControllers: 'failed', memoryDimms: 'failed', cpus: 'failed', gpus: 'failed', pcie: 'failed' },
    system: { serviceTag: 'TAG1' }, psus: [{ name: 'PSU 1', serial: 'S1', health: 'Critical', state: 'Enabled' }] };
  const a = extractIdracParts(server, okInv);
  assert.equal(a.deviceKeyKind, DEVICE_KEY_KIND.serviceTag);
  assert.equal(a.parts.length, 1);
  const badInv = { ...okInv, collections: { ...okInv.collections, system: 'failed' }, system: {} };
  const b = extractIdracParts(server, badInv);
  assert.equal(b.keyUnstable, true);
  assert.equal(b.parts.length, 0, 'IP 키로 새 행을 열지 않는다');
  assert.equal(b.reachable, true, '닿긴 했다 — unreachable 과 구분');
  // 등록부에 서비스태그가 있으면 키가 흔들리지 않으므로 그대로 진행
  const c = extractIdracParts({ ...server, serviceTag: 'TAG1' }, badInv);
  assert.equal(c.keyUnstable, undefined);
  assert.equal(c.deviceKey, 'TAG1');
  assert.equal(c.parts.length, 1);
  // scan 은 그 장비를 실패로 접는다
  const sc = scanFrom({ idracServers: [server], invOf: () => badInv, invFresh: () => true, storageDevices: [], storageSnapOf: () => null, sanDevices: [], sanSnapOf: () => null, agent: '' });
  assert.equal(sc.devices[0].ok, false);
  assert.equal(sc.devices[0].reason, 'system-failed');
  assert.equal(sc.scanned.idrac.keyUnstable, 1);
});

test('C4: 같은 이름의 부품이 둘이면 첫 항목도 #1 · index 등급이 된다 — 순서가 바뀌어도 키 집합이 같다', () => {
  const server = { id: '10.0.0.5', serviceTag: 'TAG1' };
  const inv = (ctrls) => ({ reachable: true, collections: { system: 'ok', psus: 'failed', disks: 'ok', storageControllers: 'ok', memoryDimms: 'failed', cpus: 'failed', gpus: 'failed', pcie: 'failed' },
    system: { serviceTag: 'TAG1' }, disks: [], storageControllers: ctrls });
  const a = extractIdracParts(server, inv([{ name: 'PERC H755 Front', health: 'Critical', state: 'Enabled' }, { name: 'PERC H755 Front', health: 'OK', state: 'Enabled' }]));
  const ctrl = a.parts.filter((p) => p.kind === 'controller');
  assert.deepEqual(ctrl.map((p) => p.partId), ['PERC H755 Front#1', 'PERC H755 Front#2']);
  assert.deepEqual(ctrl.map((p) => p.keyKind), ['index', 'index'], '첫 항목도 순번 키임을 밝힌다');
  const b = extractIdracParts(server, inv([{ name: 'PERC H755 Front', health: 'OK', state: 'Enabled' }, { name: 'PERC H755 Front', health: 'Critical', state: 'Enabled' }]));
  assert.deepEqual(new Set(b.parts.map((p) => p.partKey)), new Set(a.parts.map((p) => p.partKey)), '순서가 바뀌어도 키 집합은 같다');
  // 단일 항목은 그대로 name 등급
  const c = extractIdracParts(server, inv([{ name: 'PERC H755 Front', health: 'OK', state: 'Enabled' }]));
  assert.equal(c.parts.find((p) => p.kind === 'controller').keyKind, 'name');
});

test('C5: 판정 대상에 아예 없는 장비의 열린 장애는 unassigned / no-report 로 나눠 보류한다(장비 실패와 다르다)', () => {
  const rowA = { ...mkPart({ agent: 'a', state: 'fault' }), firstSeenAt: NOW - 60_000, lastSeenAt: NOW - 60_000 };
  const rowB = { ...mkPart({ agent: 'b', state: 'fault' }), firstSeenAt: NOW - 60_000, lastSeenAt: NOW - 60_000 };
  const rowL = { ...mkPart({ agent: '', state: 'fault' }), firstSeenAt: NOW - 60_000, lastSeenAt: NOW - 60_000 };
  const tr = transition({ open: [rowA, rowB, rowL], observed: [], scan: { deviceOk: {}, kindFailed: {}, agentsReported: new Set(['', 'a']) }, now: NOW });
  const by = Object.fromEntries(tr.held.map((h) => [h.agent || 'local', h.holdReason]));
  assert.equal(by.a, HOLD_REASON.unassigned, 'a 는 보고했는데 이 장비가 없다');
  assert.equal(by.b, HOLD_REASON.noReport, 'b 는 보고 자체가 없다');
  assert.equal(by.local, HOLD_REASON.unassigned, '중앙 로컬 스캔에 없는 장비(등록 삭제)');
  assert.equal(tr.stats.heldUnassigned, 2);
  assert.equal(tr.stats.heldNoReport, 1);
  // agentsReported 를 안 주는 구 호출부는 예전대로 장비 실패
  const old = transition({ open: [rowA], observed: [], scan: { deviceOk: {} }, now: NOW });
  assert.equal(old.held[0].holdReason, HOLD_REASON.deviceFailed);
});

// ── v2.548 정직성 리뷰 H7 — 보류 사유가 '장비 실패' 와 '엣지 보고 오래됨/구버전' 을 구분한다 ──────
test('H7: 오래된 엣지 보고의 장비는 edge-stale, 구 프로토콜은 edge-legacy 로 보류한다(장비 탓으로 돌리지 않는다)', async () => {
  edge._resetForTest(async () => ({ storage: new Set(), sanswitch: new Set() }));
  await edge.putEdgeReport('S1', { v: 2, version: '2.548.0', at: NOW, devices: [{ scope: 'idrac', deviceId: '10.0.0.5', deviceKey: 'TAG1', deviceKeyKind: 'serviceTag', ok: true, open: [], states: { ok: ['psu:S1'] } }] });
  await edge.putEdgeReport('L1', { open: [{ scope: 'idrac', deviceId: '10.0.0.7', deviceKey: 'TAG7', deviceKeyKind: 'serviceTag', kind: 'psu', partId: 'S1', state: 'fault' }], deviceOk: { '10.0.0.7': true } });
  // 오래됨은 시각으로, 구 프로토콜은 신선해도 성립한다 — 두 시점을 따로 본다(+4h 에서는 L1 도 오래됨이 먼저다)
  const mS = edge.mergeEdgeReports({ now: edge.edgeReport('S1').at + 4 * 3_600_000 });
  assert.equal(mS.deviceReason[devKeyOf('s1', '10.0.0.5')], 'edge-stale');
  const mF = edge.mergeEdgeReports({ now: edge.edgeReport('L1').at });
  assert.equal(mF.deviceReason[devKeyOf('l1', '10.0.0.7')], 'edge-legacy');
  assert.equal(mF.deviceReason[devKeyOf('s1', '10.0.0.5')], undefined, '신선하고 ok 인 장비는 사유가 없다');
  // 구 프로토콜 엣지는 장애만 보내므로 **사라진 장애**(S2)가 곧 '해소' 가 아니다 — edge-legacy 로 보류
  const open = [
    { ...mkPart({ agent: 's1', state: 'fault' }), firstSeenAt: NOW - 60_000, lastSeenAt: NOW - 60_000 },
    { ...mkPart({ agent: 'l1', deviceId: '10.0.0.7', deviceKey: 'TAG7', partId: 'S2', state: 'fault' }), firstSeenAt: NOW - 60_000, lastSeenAt: NOW - 60_000 },
  ];
  const scan = { deviceOk: { ...mF.deviceOk, [devKeyOf('s1', '10.0.0.5')]: false }, kindFailed: {}, deviceReason: { ...mF.deviceReason, [devKeyOf('s1', '10.0.0.5')]: 'edge-stale' }, agentsReported: new Set(['', 's1', 'l1']) };
  const tr = transition({ open, observed: mF.observed.filter((p) => p.agent === 'l1'), scan, now: NOW });
  const by = Object.fromEntries(tr.held.map((h) => [h.agent, h.holdReason]));
  assert.equal(by.s1, HOLD_REASON.edgeStale);
  assert.equal(by.l1, HOLD_REASON.edgeLegacy);
  assert.equal(tr.closed.length, 0);
  assert.equal(tr.stats.heldEdge, 2);
  // 신선한 프로토콜 2 보고에서 장비 자체가 실패했으면 여전히 device-failed
  edge._resetForTest(async () => ({ storage: new Set(), sanswitch: new Set() }));
  await edge.putEdgeReport('F1', { v: 2, version: '2.548.0', at: NOW, devices: [{ scope: 'idrac', deviceId: '10.0.0.5', deviceKey: 'TAG1', deviceKeyKind: 'serviceTag', ok: false, reason: 'unreachable', open: [], states: {} }] });
  const m2 = edge.mergeEdgeReports({ now: NOW });
  assert.equal(m2.deviceReason[devKeyOf('f1', '10.0.0.5')], 'unreachable');
  const tr2 = transition({ open: [{ ...mkPart({ agent: 'f1', state: 'fault' }), firstSeenAt: NOW - 1 }], observed: [], scan: { deviceOk: m2.deviceOk, deviceReason: m2.deviceReason, agentsReported: new Set(['', 'f1']) }, now: NOW });
  assert.equal(tr2.held[0].holdReason, HOLD_REASON.deviceFailed);
});

// ── v2.548 정직성 리뷰 H5 — 수집 서버 pull 실패가 version 을 지우지 않는다 ────────────────────────
test('H5: collector 상태의 실패 경로가 version·agent 를 보존한다(소스 검사)', async () => {
  const src = fs.readFileSync(new URL('../src/collector/puller.js', import.meta.url), 'utf8');
  assert.match(src, /getCollectorStatus\(c\.id\)/, '실패 경로가 직전 상태를 읽는다');
  assert.match(src, /\.\.\.prevSt, ok: false/, '실패 상태를 직전 상태 위에 덮는다');
  assert.match(src, /\.\.\.prevSt, ok: true, degraded: true/, '저하 상태도 같다');
  const st = await import('../src/collector/state.js');
  st.setCollectorStatus('pf-h5', { ok: true, version: '2.548.0', agent: 'A' });
  st.setCollectorStatus('pf-h5', { ...(st.getCollectorStatus('pf-h5') || {}), ok: false, error: 'x', fails: 2 });
  assert.equal(st.getCollectorStatus('pf-h5').version, '2.548.0');
  assert.equal(st.getCollectorStatus('pf-h5').ok, false);
});

// ── C3 반증 ①② — 가드를 비켜 가던 두 조건 ────────────────────────────────────────────────────────
test('C3-①: 등록부 태그가 인벤토리 태그와 달라도(대소문자·값) 장비 키는 주기마다 같다 — 등록부가 먼저', () => {
  const okInv = { reachable: true, collections: { system: 'ok', psus: 'ok', disks: 'failed', storageControllers: 'failed', memoryDimms: 'failed', cpus: 'failed', gpus: 'failed', pcie: 'failed' },
    system: { serviceTag: 'TAG1' }, psus: [{ name: 'PSU 1', serial: 'S1', health: 'Critical', state: 'Enabled' }] };
  const sysFail = { ...okInv, collections: { ...okInv.collections, system: 'failed' }, system: {} };
  const server = { id: '10.0.0.5', serviceTag: 'tag1' };   // CSV 로 들어온 소문자
  const a = extractIdracParts(server, okInv);
  const b = extractIdracParts(server, sysFail);
  assert.equal(a.deviceKey, 'TAG1'); assert.equal(b.deviceKey, 'TAG1', '두 주기의 키가 같다');
  assert.equal(a.parts[0].partKey, b.parts[0].partKey);
  // 등록부 태그가 아예 다른 값이어도(메인보드 교체 뒤) 흔들리지 않는다 — 요건은 진짜 태그가 아니라 안정성
  const c = extractIdracParts({ id: '10.0.0.5', serviceTag: 'OLDTAG' }, okInv);
  assert.equal(c.deviceKey, 'OLDTAG');
});

test('C3-②: 메타 없는 구버전 캐시가 system 을 통째로 못 읽었으면 IP 키 파트를 내지 않는다(keyUnstable)', () => {
  const legacyNoSys = { system: {}, psus: [{ name: 'PSU 1', serial: 'S1', health: 'Critical', state: 'Enabled' }] };
  const r = extractIdracParts({ id: '10.0.0.5' }, legacyNoSys);
  assert.equal(r.legacy, true); assert.equal(r.reachable, true); assert.equal(r.keyUnstable, true); assert.equal(r.parts.length, 0);
  // model 만 있어도 '읽었다' — 태그 없는 장비는 localId 로 일관되게 간다
  const legacyModel = { system: { model: 'R750' }, psus: legacyNoSys.psus };
  const s = extractIdracParts({ id: '10.0.0.5' }, legacyModel);
  assert.equal(s.keyUnstable, undefined); assert.equal(s.parts.length, 1); assert.equal(s.deviceKeyKind, 'localId');
});
