/**
 * partFaultStorageFru2548.test.js — 스토리지 FRU 리더는 **실제 생산자**(`svcDiag.parseSpinfo`)의
 * 모양을 읽는다(v2.548 F4) + 장비 축은 중앙 발급 id 다(F2).
 *
 * 왜 이 테스트가 있나: v2.547 의 리더는 `extra.fru = { dimm0:'OK', … }` 평면 맵을 가정했는데 그
 * 모양을 만든 코드는 이 저장소에 존재한 적이 없다. 실제 집계 객체
 * `{ items, total, ok, empty, unknown, fault, faults, sps }` 가 들어오면 `Object.keys` 를 돌며
 * **없는 부품 8개**(items/total/…)를 지어냈다(v2.525 Unity CSV 배너가 없는 장비를 만든 것과 같은 유형).
 * 그래서 fru 를 손으로 흉내 내지 않고 **실제 파서 + 실제 픽스처**로 만든다 — 형식을 흉내 내면
 * 같은 실수를 반복한다(v2.542 의 테스트 21건이 전부 통과하며 놓친 것이 그 유형이다).
 *
 * 픽스처 `fixtures/spinfo-sample.txt` 는 합성값(v2.513 규약 — 공개 저장소)이되 두 관계를 보존한다 —
 * SPA DIMM 24칸 중 OK 12칸(× 8GB = 96GB) · REMOVED 12칸. 이 테스트는 그 관계를 그대로 쓴다.
 * 순수 테스트라 기준 시각이 없다(`Date.now()` 를 쓰지 않는다 — CLAUDE.md v2.517 규약).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const TEXT = fs.readFileSync(path.join(HERE, 'fixtures', 'spinfo-sample.txt'), 'utf8');

const { parseSpinfo, fruKind } = await import('../src/storage/collectors/svcDiag.js');
const { extractStorageParts, fruKindOf, fruItemState } = await import('../src/partfault/extract/storage.js');
const { summarize, PART_STATE, DEVICE_KEY_KIND, PART_KIND_LABEL, KEY_KIND } = await import('../src/partfault/types.js');

/** 중앙이 발급하는 꼴(`st-…`, storage/registry.js:100)의 합성 id — 실장비 식별자가 아니다. */
const DEVICE = { id: 'st-fru2548test', name: 'unity-fru', type: 'unity480', agent: 'edge-a' };
/** 옛 리더가 부품 이름으로 지어냈던 집계 객체의 키들. 이 중 하나라도 partId·label 에 나오면 결함이다. */
const FAKE_PART_NAMES = ['items', 'total', 'ok', 'empty', 'unknown', 'fault', 'faults', 'sps'];

const REAL = parseSpinfo(TEXT);
const run = (fru) => extractStorageParts(DEVICE, { name: 'UNITY-FRU', ok: true, extra: { fru } });

test('실제 파서의 fru 집계 객체 → 지어낸 부품 0개 · 항목 수만큼만 파트', () => {
  assert.ok(REAL.parsed && REAL.fru.items.length > 0, '픽스처가 실제로 파싱돼야 이 테스트가 뜻을 갖는다');
  const r = run(REAL.fru);
  const fake = r.parts.filter((p) => FAKE_PART_NAMES.includes(p.partId) || FAKE_PART_NAMES.includes(p.label));
  assert.deepEqual(fake.map((p) => p.partId), [], '집계 객체의 키를 부품으로 지어냈다');
  assert.equal(r.parts.length, REAL.fru.items.length, '항목 1개 = 파트 1개 — 더도 덜도 없다');
  assert.ok(r.covered.includes('fru'));
  assert.ok(!r.notCollected.includes('fru'));
  // 모든 파트가 계약 어휘의 종류를 갖는다(fruKindOf 가 svcDiag 어휘를 그대로 흘리지 않는다).
  for (const p of r.parts) assert.ok(PART_KIND_LABEL[p.kind], `계약에 없는 종류: ${p.kind}`);
});

test('빈 슬롯(REMOVED)은 absent 이지 fault 가 아니다 — DIMM OK 12 · absent 12 · fault 0', () => {
  const r = run(REAL.fru);
  const spaDimm = r.parts.filter((p) => p.kind === 'dimm' && p.partId.startsWith('spa/'));
  const s = summarize(spaDimm);
  assert.equal(spaDimm.length, 24);
  assert.equal(s.ok, 12, 'OK 12칸 × 8GB = 96GB(배너와 일치하는 관계)');
  assert.equal(s.absent, 12, 'REMOVED 12칸 — 빈 슬롯');
  assert.equal(s.fault, 0, '⚠ 빈 슬롯을 장애로 세면 정상 장비에 장애 12건이 찍힌다(v2.526 실측)');
  assert.equal(s.unknown, 0);

  // 생산자의 집계와 이 리더의 집계가 **같은 수**를 낸다 — 판정을 다시 하지 않았다는 증거.
  const all = summarize(r.parts);
  assert.equal(all.ok, REAL.fru.ok);
  assert.equal(all.absent, REAL.fru.empty);
  assert.equal(all.unknown, REAL.fru.unknown);
  assert.equal(all.fault, REAL.fru.fault);
  assert.equal(all.warn, 0);

  // 픽스처의 유일한 장애는 spa fan1(FAULTED) — 원문이 그대로 실린다.
  const faults = r.parts.filter((p) => p.state === PART_STATE.fault);
  assert.deepEqual(faults.map((p) => [p.partId, p.kind, p.rawState]), [['spa/fan1', 'fan', 'FAULTED']]);
  // 상대 SP 의 UNKNOWN 은 확인 불가로 **따로** 남는다(정상도 이상도 아니다).
  const unk = r.parts.filter((p) => p.state === PART_STATE.unknown).map((p) => p.partId).sort();
  assert.deepEqual(unk, ['spb/dimm0', 'spb/dimm1', 'spb/iom0']);
});

test('spa/dimm0 과 spb/dimm0 은 다른 partKey 다 — sp 없이 name 만 쓰면 한 키로 접힌다', () => {
  const r = run(REAL.fru);
  const dimm0 = r.parts.filter((p) => p.label === 'dimm0');
  assert.equal(dimm0.length, 2);
  assert.deepEqual(dimm0.map((p) => p.partId).sort(), ['spa/dimm0', 'spb/dimm0']);
  assert.notEqual(dimm0[0].partKey, dimm0[1].partKey);
  assert.deepEqual(dimm0.map((p) => p.keyKind), [KEY_KIND.name, KEY_KIND.name]);
  // 전체 partKey 가 유일하다(어느 두 부품도 한 키로 접히지 않았다).
  const keys = r.parts.map((p) => p.partKey);
  assert.equal(new Set(keys).size, keys.length);
  // SP 자신은 `spa/spa` 가 아니라 `spa` 이고 종류는 node 다.
  const sp = r.parts.filter((p) => p.kind === 'node').map((p) => p.partId).sort();
  assert.deepEqual(sp, ['spa', 'spb']);
  // 픽스처의 `dpe:` 줄은 상태 토큰이 없어 파서가 항목으로 만들지 않는다(`if (!rest) continue`) —
  // 그러니 enclosure 파트도 **0개**다. 상태 없는 줄을 리더가 '정상' 으로 지어내면 여기서 잡힌다.
  assert.deepEqual(r.parts.filter((p) => p.kind === 'enclosure'), []);
  // ps0 의 뒤쪽 토큰(입력 전력 W)은 detail 로만 실린다 — 상태로 읽지 않는다.
  const ps = r.parts.find((p) => p.partId === 'spa/ps0');
  assert.equal(ps.state, PART_STATE.ok);
  assert.equal(ps.detail, '330');
});

test('집계 객체 모양이 아닌 값(문자열·숫자·평면 맵·items 비배열·빈 배열) → 파트 0개 + notCollected fru', () => {
  const bad = [
    'OK', 42, true,
    { dimm0: 'OK', ps0: 'OK', fan1: 'FAULTED' },      // v2.547 주석이 약속했던 — 존재한 적 없는 — 평면 맵
    { items: 'nope', total: 3 },
    { items: { dimm0: 'OK' } },
    { items: [] },                                    // 읽은 항목 0개 — '부품 0개 = 정상' 이 아니다
    [],
  ];
  for (const fru of bad) {
    const r = run(fru);
    assert.equal(r.parts.length, 0, `파트를 지어냈다: ${JSON.stringify(fru)}`);
    assert.deepEqual(r.notCollected, ['fru'], JSON.stringify(fru));
    assert.ok(!r.covered.includes('fru'));
  }
  // `extra.fru` 자체가 없으면 아무 말도 하지 않는다 — 이 경로는 아직 배선되지 않았고(v2.542),
  // FRU 를 주지 않는 장비군까지 '미수집' 으로 찍으면 소음이다(partFault2547 의 노드 테스트가 이 계약에 기댄다).
  const none = extractStorageParts(DEVICE, { name: 'x', ok: true, extra: {} });
  assert.deepEqual(none.notCollected, []);
  assert.deepEqual(none.covered, []);
  assert.equal(none.parts.length, 0);
});

test('partKey 의 장비 축은 device.id(중앙 발급 st-…)이고 등급은 centralId — 세 경로 전부', () => {
  const fruParts = run(REAL.fru).parts;
  const nodeParts = extractStorageParts(DEVICE, { nodes: { count: 1, list: [{ name: 'SPA', health: 'OK' }] } }).parts;
  const diskParts = extractStorageParts(DEVICE, { extra: { disks: [{ serial: 'SYNTHDISK1', health: 'OK' }] } }).parts;
  assert.ok(fruParts.length && nodeParts.length && diskParts.length);
  for (const p of [...fruParts, ...nodeParts, ...diskParts]) {
    assert.equal(p.deviceId, DEVICE.id);
    assert.equal(p.deviceKey, DEVICE.id);
    assert.equal(p.deviceKeyKind, DEVICE_KEY_KIND.centralId);
    assert.equal(p.partKey.split(':')[1], DEVICE.id, p.partKey);
    assert.equal(p.partKey, `storage:${DEVICE.id}:${p.kind}:${p.partId}`);
  }
});

test('fruKindOf 의 인식 어휘는 svcDiag.fruKind 와 같고 출력만 계약 어휘다', () => {
  // svcDiag 종류 → 이 계약의 PART_KIND_LABEL 키. 한쪽만 이름을 추가하면 아래 순회가 깨진다.
  const MAP = { dimm: 'dimm', fan: 'fan', psu: 'psu', bbu: 'battery', slic: 'pcie', mezz: 'pcie', iom: 'pcie', sp: 'node', enclosure: 'enclosure', other: 'other' };
  const names = ['dimm0', 'dimm23', 'fan1', 'ps0', 'bbu0', 'slic0', 'mezz1', 'iom0', 'spa', 'spb', 'dpe', 'dae0', 'dae12', 'temp', 'foo', '', 'DIMM3', 'PS1'];
  for (const n of [...names, ...REAL.fru.items.map((i) => i.name)]) {
    const theirs = fruKind(n);
    assert.ok(MAP[theirs] != null, `svcDiag 가 모르는 종류를 냈다: ${theirs}`);
    assert.equal(fruKindOf(n), MAP[theirs], `어휘 불일치: ${n}`);
    assert.ok(PART_KIND_LABEL[fruKindOf(n)], `계약에 없는 종류: ${fruKindOf(n)}`);
  }
});

test('fruItemState 는 번역만 한다 — empty→absent · 모르는 값→unknown · 원문 보존', () => {
  assert.deepEqual(fruItemState('ok', 'OK'), { state: PART_STATE.ok, raw: 'OK' });
  assert.deepEqual(fruItemState('empty', 'REMOVED'), { state: PART_STATE.absent, raw: 'REMOVED' });
  assert.deepEqual(fruItemState('unknown', 'UNKNOWN'), { state: PART_STATE.unknown, raw: 'UNKNOWN' });
  assert.deepEqual(fruItemState('fault', 'FAULTED'), { state: PART_STATE.fault, raw: 'FAULTED' });
  // 생산자가 준 적 없는 값 — 장애로 접지 않는다(우리가 잘못 읽은 것이다).
  assert.equal(fruItemState('degraded', 'DEGRADED').state, PART_STATE.unknown);
  assert.equal(fruItemState('', 'OK').state, PART_STATE.unknown);
  assert.equal(fruItemState(undefined).state, PART_STATE.unknown);
  assert.equal(fruItemState('OK', 'OK').state, PART_STATE.ok);   // 대소문자는 관용
});

test('같은 SP 에 같은 이름이 둘이면 덮어쓰지 않고 #2 + 등급 index 로 낮춘다(실제 파서로 재현)', () => {
  // 파서는 줄을 그대로 항목으로 만든다 — 출력이 한 줄을 반복하면 같은 이름이 둘이 된다.
  const dup = parseSpinfo([
    "This SP's system type is: EMC Unity 480F",
    "This SP's ID is: SPA",
    '',
    'Displaying all FRU statuses:',
    'dpe:',
    '  spa: OK',
    '    fan0: OK',
    '    fan0: FAULTED',
    '',
  ].join('\n'));
  assert.equal(dup.fru.items.filter((i) => i.name === 'fan0').length, 2);
  const r = run(dup.fru);
  const fans = r.parts.filter((p) => p.kind === 'fan');
  assert.deepEqual(fans.map((p) => [p.partId, p.keyKind, p.state]),
    [['spa/fan0', KEY_KIND.name, PART_STATE.ok], ['spa/fan0#2', KEY_KIND.index, PART_STATE.fault]]);
  assert.equal(new Set(r.parts.map((p) => p.partKey)).size, r.parts.length);
});
