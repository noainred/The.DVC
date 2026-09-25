/**
 * partFaultSan2548.test.js — SAN 스위치 파트 추출기(`partfault/extract/sanswitch.js`, v2.548 F9).
 *
 * 조사(v2.548)로 확정된 결함: SAN 스위치 스냅샷은 중앙에 온전히 오는데 파트 추출기가 없어
 * 스위치 장애가 파트 장애 DB 에 한 건도 들어가지 않았다. 이 파일이 고정하는 것은 수치가 아니라
 * **정직성 규칙**이다 —
 *   ① 링크 없는 포트의 낮은 Rx 를 '이상' 이라 하지 않는다(v2.521 — 현장 거짓 경보의 원인)
 *   ② 축약분(`portsScope:'problem'`)에서 보지 않은 정상 포트를 '확인했고 정상' 이라 하지 않는다
 *   ③ 팬/PSU 는 개수만 오므로 그룹 단위(`keyKind:'none'`)다 — 어느 팬인지 지어내지 않는다
 *   ④ 광량 임계는 `healthCheck.js` 상수 하나가 원천이다(보고서·화면·파트 장애가 어긋나지 않게)
 *
 * 픽스처는 전부 **합성값**이다(공개 저장소 — v2.513 규약. 실장비 WWN·호스트명·시리얼 금지).
 * 기준 시각을 쓰지 않는다(순수 함수 — `Date.now()` 의존 없음).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { stripComments } from './_stripComments.js';

const { extractSanSwitchParts } = await import('../src/partfault/extract/sanswitch.js');
const { summarize, DEVICE_KEY_KIND, KEY_KIND } = await import('../src/partfault/types.js');
const { RX_WARN_DBM, RX_BAD_DBM } = await import('../src/sanswitch/healthCheck.js');

const HERE = path.dirname(url.fileURLToPath(import.meta.url));

/** 합성 장비 — 중앙 발급 id 꼴(`sw-…`). */
const DEV = { id: 'sw-synth0001', name: 'synth-sw-01', host: '192.0.2.10', agent: 'corp-a' };

/** 합성 포트 행. 필요한 필드만 덮어쓴다. */
const port = (o) => ({
  index: 0, slotPort: '0', name: 'port0', state: 'online', physical: 'Online', enabled: true, speed: '32G',
  rxPowerDbm: -3.1, sfpVendor: 'SYNTHVENDOR', sfpPartNumber: 'SYNTH-PN-1', sfpSerial: 'SYNTH00000001',
  ...o,
});

const snapOf = (list, extra = {}) => ({
  name: 'synth-sw-01', ok: true,
  ports: { total: list.length, list, portsScope: 'full', portsOmitted: 0, ...(extra.ports || {}) },
  health: { status: 'Online', fans: { ok: 4, total: 4 }, psus: { ok: 2, total: 2 }, tempC: null, alerts: 0, ...(extra.health || {}) },
});

const byId = (r, id) => r.parts.find((p) => p.kind === 'port' && p.partId === id);

test('① faulty 포트는 링크와 무관하게 fault 이고 원문 물리 상태를 rawState 에 남긴다', () => {
  const r = extractSanSwitchParts(DEV, snapOf([
    port({ index: 3, slotPort: '3', state: 'faulty', physical: 'Laser_Flt', rxPowerDbm: -30 }),
  ]));
  const p = byId(r, '3');
  assert.ok(p, '포트 3 파트가 있어야 한다');
  assert.equal(p.state, 'fault');
  assert.equal(p.keyKind, KEY_KIND.slot);
  assert.match(p.rawState, /faulty/);
  assert.match(p.rawState, /Laser_Flt/);          // 판정 근거(원문)를 숨기지 않는다
  assert.match(p.detail, /SYNTHVENDOR/);
  assert.match(p.detail, /S\/N SYNTH00000001/);
  assert.match(p.detail, /Rx -30 dBm/);            // 장애 포트의 광량은 원인 정보
  assert.deepEqual(r.covered, ['port', 'fan', 'psu']);
});

test('② 링크 없는 포트(offline·disabled)는 파트를 만들지 않고 notJudged.ports 로 센다', () => {
  const r = extractSanSwitchParts(DEV, snapOf([
    port({ index: 10, slotPort: '10', state: 'offline', physical: 'No_Light', rxPowerDbm: -27.5 }),   // v2.521 현장 사례
    port({ index: 11, slotPort: '11', state: 'disabled', physical: 'Disabled', rxPowerDbm: -40 }),
    port({ index: 12, slotPort: '12', state: 'online', rxPowerDbm: -2.0 }),
  ]));
  assert.equal(byId(r, '10'), undefined, '링크 없는 포트의 -27.5 dBm 은 이상이 아니다');
  assert.equal(byId(r, '11'), undefined);
  assert.equal(byId(r, '12')?.state, 'ok');
  assert.equal(r.notJudged.ports, 2);            // 조용히 빼지 않는다 — 개수를 밝힌다
  assert.equal(r.notJudged.portsOmitted, 0);
  assert.equal(summarize(r.parts).fault, 0);
});

test('③ 링크 포트의 광량 — 하한 이하 fault · 주의 이하 warn · 그 위 ok · 못 읽으면 unknown (임계는 healthCheck 상수)', () => {
  const r = extractSanSwitchParts(DEV, snapOf([
    port({ index: 1, slotPort: '1', rxPowerDbm: RX_BAD_DBM - 1 }),       // 하한 미달
    port({ index: 2, slotPort: '2', rxPowerDbm: RX_BAD_DBM }),           // 경계: 하한 == fault
    port({ index: 3, slotPort: '3', rxPowerDbm: RX_WARN_DBM }),          // 경계: 주의 == warn
    port({ index: 4, slotPort: '4', rxPowerDbm: RX_WARN_DBM + 0.5 }),    // 주의 위 == ok
    port({ index: 5, slotPort: '5', rxPowerDbm: null }),                 // 못 읽음
  ]));
  assert.equal(byId(r, '1').state, 'fault');
  assert.equal(byId(r, '2').state, 'fault');
  assert.equal(byId(r, '3').state, 'warn');
  assert.equal(byId(r, '4').state, 'ok');
  assert.equal(byId(r, '5').state, 'unknown');    // ⚠ Rx 미확인은 정상이 아니다
  assert.match(byId(r, '1').rawState, /dBm/);
  const s = summarize(r.parts.filter((p) => p.kind === 'port'));
  assert.deepEqual([s.fault, s.warn, s.ok, s.unknown], [2, 1, 1, 1]);
});

test('③-b 광량 임계는 소스에 숫자로 박지 않고 healthCheck 에서 import 한다(보고서·화면과 같은 원천)', () => {
  const src = stripComments(fs.readFileSync(path.join(HERE, '../src/partfault/extract/sanswitch.js'), 'utf8'));   // 주석을 지운 뒤 검사한다
  assert.match(src, /import\s*\{[^}]*RX_WARN_DBM[^}]*\}\s*from\s*'\.\.\/\.\.\/sanswitch\/healthCheck\.js'/);
  assert.match(src, /import\s*\{[^}]*RX_BAD_DBM[^}]*\}/);
  assert.match(src, /import\s*\{[^}]*isLinked[^}]*\}/);
  assert.doesNotMatch(src, /-\s*9\b|-\s*12\b/, '임계 숫자를 소스에 다시 적지 말 것');
});

test('④ 팬 3/4 → fault · 그룹 단위(partId all · keyKind none) · 라벨과 rawState 가 개수를 밝힌다', () => {
  const r = extractSanSwitchParts(DEV, snapOf([], { health: { fans: { ok: 3, total: 4 }, psus: { ok: 2, total: 2 } } }));
  const fan = r.parts.find((p) => p.kind === 'fan');
  const psu = r.parts.find((p) => p.kind === 'psu');
  assert.ok(fan && psu);
  assert.equal(fan.state, 'fault');
  assert.equal(fan.partId, 'all');
  assert.equal(fan.keyKind, KEY_KIND.none);       // 어느 팬인지 알 수 없다 — 순번을 지어내지 않는다
  assert.equal(fan.label, '팬 3/4 정상');
  assert.equal(fan.rawState, '3/4');
  assert.equal(fan.partKey, `sanswitch:${DEV.id}:fan:all`);
  assert.equal(psu.state, 'ok');
  assert.equal(psu.label, 'PSU 2/2 정상');
  assert.ok(r.covered.includes('fan') && r.covered.includes('psu'));
});

test('④-b 팬 개수를 못 읽었으면(ok null) unknown 이고 라벨에 "정상" 을 붙이지 않는다', () => {
  const r = extractSanSwitchParts(DEV, snapOf([], { health: { fans: { ok: null, total: 4 } } }));
  const fan = r.parts.find((p) => p.kind === 'fan');
  assert.equal(fan.state, 'unknown');
  assert.doesNotMatch(fan.label, /정상/);
  assert.equal(fan.rawState, '?/4');
  assert.equal(summarize(r.parts).ok, 1);         // psu 만 정상 — unknown 은 정상에 들어가지 않는다
});

test('⑤ health.fans / psus 가 null 이면 파트를 만들지 않고 notCollected 에 적는다', () => {
  const r = extractSanSwitchParts(DEV, snapOf([port({})], { health: { fans: null, psus: null } }));
  assert.ok(r.notCollected.includes('fan'));
  assert.ok(r.notCollected.includes('psu'));
  assert.equal(r.parts.filter((p) => p.kind !== 'port').length, 0);   // 0 을 지어내지 않는다
  assert.deepEqual(r.covered, ['port']);
});

test('⑤-b ports 가 없거나 비었으면 notCollected 에 port (전체 범위일 때만)', () => {
  const a = extractSanSwitchParts(DEV, { name: 'synth-sw-01', health: { fans: null, psus: null } });
  assert.deepEqual(a.notCollected, ['port', 'fan', 'psu']);
  assert.equal(a.parts.length, 0);
  const b = extractSanSwitchParts(DEV, snapOf([]));
  assert.ok(b.notCollected.includes('port'));
  assert.ok(!b.covered.includes('port'));
});

test('⑥ portsScope problem(축약분)이면 ok 파트를 만들지 않고 covered 는 port:partial · 뺀 포트 수를 밝힌다', () => {
  const r = extractSanSwitchParts(DEV, snapOf([
    port({ index: 7, slotPort: '7', rxPowerDbm: -3.0 }),                 // 정상처럼 보여도 '확인' 이 아니다
    port({ index: 8, slotPort: '8', rxPowerDbm: RX_WARN_DBM - 1 }),      // 문제 포트 — 판정한다
    port({ index: 9, slotPort: '9', state: 'faulty', physical: 'Port_Flt' }),
    port({ index: 20, slotPort: '20', state: 'disabled' }),
  ], { ports: { portsScope: 'problem', portsOmitted: 44 } }));
  assert.equal(summarize(r.parts.filter((p) => p.kind === 'port')).ok, 0);
  assert.equal(byId(r, '7'), undefined);
  assert.equal(byId(r, '8').state, 'warn');
  assert.equal(byId(r, '9').state, 'fault');
  assert.ok(r.covered.includes('port:partial'));
  assert.ok(!r.covered.includes('port'));
  assert.equal(r.notJudged.portsOmitted, 44);
  assert.equal(r.notJudged.ports, 1);
  assert.ok(!r.notCollected.includes('port'));

  // 문제 포트가 0개라 list 가 비고 portsOmitted 만 남은 경우 — '미수집' 이 아니라 '전부 정상이라 뺀 것'
  const e = extractSanSwitchParts(DEV, snapOf([], { ports: { portsScope: 'problem', portsOmitted: 48 } }));
  assert.ok(!e.notCollected.includes('port'));
  assert.ok(e.covered.includes('port:partial'));
  assert.equal(e.notJudged.portsOmitted, 48);
});

test('⑦ partKey 의 장비 축은 device.id(중앙 발급 sw-…) 이고 deviceKeyKind 는 centralId', () => {
  const r = extractSanSwitchParts(DEV, snapOf([port({ index: 0, slotPort: '0' })]));
  const p = byId(r, '0');
  assert.equal(p.partKey, `sanswitch:${DEV.id}:port:0`);
  assert.equal(p.deviceKey, DEV.id);
  assert.equal(p.deviceKeyKind, DEVICE_KEY_KIND.centralId);
  assert.equal(p.deviceId, DEV.id);
  assert.equal(p.deviceName, 'synth-sw-01');       // 스위치가 보고한 이름 우선
  assert.equal(p.agent, 'corp-a');
  assert.equal(p.scope, 'sanswitch');
  // 이름·host 가 바뀌어도 키는 그대로다(바뀌면 열린 장애가 닫히고 새 장애가 열린다)
  const r2 = extractSanSwitchParts({ ...DEV, name: 'renamed', host: '192.0.2.99' }, snapOf([port({ index: 0, slotPort: '0' })], { name: 'other' }));
  assert.equal(byId(r2, '0').partKey, p.partKey);
});

test('⑦-b 디렉터 slot/port 표기와 slotPort 가 없을 때의 index 폴백 · 식별자 없는 포트는 세기만 한다', () => {
  const r = extractSanSwitchParts(DEV, snapOf([
    port({ index: 100, slotPort: '3/4' }),
    port({ index: 0, slotPort: '' }),                 // ⚠ index 0 은 유효한 식별자다(`||` 함정)
    port({ index: null, slotPort: '' }),              // 식별자 없음 — 키를 만들 수 없다
  ]));
  assert.equal(byId(r, '3/4').partKey, `sanswitch:${DEV.id}:port:3/4`);
  assert.ok(byId(r, '0'), 'index 0 포트가 있어야 한다');
  assert.equal(r.notJudged.unidentified, 1);
  assert.equal(r.parts.filter((p) => p.kind === 'port').length, 2);
});

test('noLicense 포트는 absent(빈 자리) — 장애로도 정상으로도 세지 않는다', () => {
  const r = extractSanSwitchParts(DEV, snapOf([
    port({ index: 40, slotPort: '40', state: 'noLicense', physical: 'No_License', rxPowerDbm: -35 }),
    port({ index: 41, slotPort: '41', state: 'nolicense', physical: 'No_License', rxPowerDbm: null }),
  ]));
  const s = summarize(r.parts.filter((p) => p.kind === 'port'));
  assert.deepEqual([s.absent, s.fault, s.ok, s.unknown], [2, 0, 0, 0]);
  assert.equal(r.notJudged.ports, 0);                // 빈 자리는 '링크 없음' 과 다른 축이다
});
