/**
 * svcDiag2526.test.js — `svc_diag -s spinfo` 파서 회귀(v2.526).
 *
 * 사용자 신고(2026-09-16): "unity 장비에 ssh 로 접속은 성공했는데, 수집하는 정보가 없어" +
 * "용량 정보 확인 및 장비 구성정보 등 최대한 많은 정보를 수집해줘".
 *
 * 여기서 고정하는 것은 **정직성 판정**이다. 이 파서가 만들 수 있는 가장 위험한 거짓은
 * **빈 슬롯(REMOVED)을 고장으로 세는 것**이다 — 정상 Unity 한 대에 장애 12건이 찍힌다.
 * 그 다음은 **상대 SP 의 UNKNOWN 을 정상으로 세는 것**(못 읽은 것을 정상이라 말하는 것)이다.
 *
 * ⚠ 픽스처(`fixtures/spinfo-sample.txt`)는 **합성값**이다 — 이 저장소는 공개이므로 실장비
 *    부품번호·일련번호를 커밋하지 않는다(v2.513 규약). 형식과 **관계**(DIMM OK 12칸 × 8GB =
 *    96GB, `ps0: OK 330` ↔ `Input Power : 330 Watts`)만 실제 출력에서 옮겼다.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseSpinfo, fruState, fruKind, powerFromBlocks, memoryFromResume, FRU_STATE,
} from '../src/storage/collectors/svcDiag.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TEXT = fs.readFileSync(path.join(HERE, 'fixtures', 'spinfo-sample.txt'), 'utf8');

test('fruState — REMOVED 는 빈 슬롯, UNKNOWN 은 확인 불가(둘 다 고장이 아니다)', () => {
  assert.equal(fruState('OK'), FRU_STATE.ok);
  assert.equal(fruState('REMOVED'), FRU_STATE.empty);
  assert.equal(fruState('UNKNOWN'), FRU_STATE.unknown);
  assert.equal(fruState('N/A'), FRU_STATE.unknown);
  assert.equal(fruState(''), FRU_STATE.unknown);       // 빈 값을 정상이라 말하지 않는다
  assert.equal(fruState('FAULTED'), FRU_STATE.fault);
  assert.equal(fruState('무슨상태'), FRU_STATE.fault); // 모르는 값은 고장 쪽(안전한 방향)
});

test('fruKind 는 부품 이름을 종류로 묶는다', () => {
  assert.equal(fruKind('dimm11'), 'dimm');
  assert.equal(fruKind('ps0'), 'psu');
  assert.equal(fruKind('fan1'), 'fan');
  assert.equal(fruKind('spa'), 'sp');
  assert.equal(fruKind('dpe'), 'enclosure');
  assert.equal(fruKind('iom0'), 'iom');
  assert.equal(fruKind('bbu0'), 'bbu');
});

test('FRU 집계 — 빈 슬롯·확인 불가를 고장으로 세지 않는다', () => {
  const sp = parseSpinfo(TEXT);
  assert.equal(sp.parsed, true);
  assert.equal(sp.systemType, 'EMC Unity 480F');
  assert.equal(sp.spId, 'SPA');

  // SPA DIMM: OK 12 · REMOVED 12 (실장비에서 확인한 관계)
  const spaDimms = sp.fru.items.filter((x) => x.kind === 'dimm' && x.sp === 'spa');
  assert.equal(spaDimms.length, 24);
  assert.equal(spaDimms.filter((x) => x.state === 'ok').length, 12);
  assert.equal(spaDimms.filter((x) => x.state === 'empty').length, 12);
  // ★ 빈 슬롯이 고장으로 새지 않았다
  assert.equal(spaDimms.filter((x) => x.state === 'fault').length, 0);

  // 상대 SP 의 UNKNOWN 은 정상으로도 고장으로도 세지 않는다
  const spbUnknown = sp.fru.items.filter((x) => x.sp === 'spb' && x.state === 'unknown');
  assert.equal(spbUnknown.length, 3);

  // 진짜 고장은 fan1 하나뿐이다
  assert.equal(sp.fru.fault, 1);
  assert.deepEqual(sp.fru.faults.map((f) => f.name), ['fan1']);
  assert.equal(sp.fru.faults[0].raw, 'FAULTED');   // 장비 원문을 보존한다
  assert.deepEqual(sp.fru.sps, ['spa', 'spb']);

  // 합이 전체와 맞는다(어느 범주에도 안 들어간 항목이 없다)
  assert.equal(sp.fru.ok + sp.fru.empty + sp.fru.unknown + sp.fru.fault, sp.fru.total);
});

test('`temp: 21` 은 상태가 아니라 DPE 온도 수치다', () => {
  const sp = parseSpinfo(TEXT);
  assert.equal(sp.dpeTemp, 21);
  // 상태 항목으로 들어가면 '알 수 없는 상태 1건' 이 되어 확인 불가 수치를 오염시킨다
  assert.equal(sp.fru.items.some((x) => x.name === 'temp'), false);
});

test('`ps0: OK 330` 의 뒤 토큰은 수치(W)로 읽는다 — 전원 요약과 교차 확인용', () => {
  const sp = parseSpinfo(TEXT);
  const ps = sp.fru.items.find((x) => x.name === 'ps0' && x.sp === 'spa');
  assert.equal(ps.value, 330);
  assert.equal(ps.state, FRU_STATE.ok);
  // 모델 문자열은 수치가 아니다 — value 는 null 이고 원문은 detail 에 남는다
  const iom = sp.fru.items.find((x) => x.name === 'iom0' && x.sp === 'spa');
  assert.equal(iom.value, null);
  assert.equal(iom.detail, 'SAMPLE_IOM_BOM_A_REV_A');
});

test('전원 블록 — 읽은 값만 합하고 못 읽으면 null(0 으로 위장 금지)', () => {
  const sp = parseSpinfo(TEXT);
  assert.equal(sp.power.supplies.length, 2);
  assert.equal(sp.power.totalWatts, 655);          // 330 + 325
  assert.equal(sp.power.readWatts, 2);
  const [a] = sp.power.supplies;
  assert.equal(a.inputWatts, 330);                 // FRU 트리의 330 과 일치
  assert.equal(a.inputVolts, 208);
  assert.equal(a.tempC, 27);
  assert.equal(a.state, FRU_STATE.ok);
  assert.deepEqual(a.faults, []);

  // 결함 플래그를 하나도 못 읽으면 '정상' 이 아니라 '확인 불가' 다
  const blind = powerFromBlocks([{ title: 'SPA PS0 Status', fields: { Inserted: 'True' } }]);
  assert.equal(blind.supplies[0].state, FRU_STATE.unknown);
  assert.equal(blind.totalWatts, null);
  assert.equal(blind.readWatts, 0);
});

test('인벤토리 — 읽기 실패한 부품은 "없는 것" 이 아니라 readErrors 로 센다', () => {
  const sp = parseSpinfo(TEXT);
  assert.ok(sp.resume.devices.length >= 13);
  assert.equal(sp.resume.readErrors, 1);           // BBU0 resume prom 읽기 실패
  const bbu = sp.resume.devices.find((d) => /BBU0/.test(d.device));
  assert.match(bbu.error, /failed to read/i);
  const d0 = sp.resume.devices.find((d) => d.device === 'SPA DIMM0');
  assert.equal(d0.fields['Module Part Number'], 'SYNTHDIMM8G');
  assert.equal(d0.fields.Density, '8 GB');
  const iom = sp.resume.devices.find((d) => /IOM0/.test(d.device));
  assert.deepEqual(iom.programmables, [{ name: 'CPLD', revision: '1.02' }]);
});

test('메모리 합계 — DIMM 12개 × 8GB = 96GB(접속 배너와 일치하는 관계)', () => {
  const sp = parseSpinfo(TEXT);
  const mem = memoryFromResume(sp.resume);
  assert.equal(mem.modules, 12);
  assert.equal(mem.totalGB, 96);
  // 인벤토리가 비면 0 이 아니라 null 이다('메모리 0GB' 라는 거짓 금지)
  assert.equal(memoryFromResume({ devices: [] }).totalGB, null);
});

test('모르는 `__ 제목 __` 블록도 버리지 않는다(출력을 전부 보지 못했다)', () => {
  const sp = parseSpinfo(TEXT);
  assert.ok(sp.blocks.some((b) => /Suitcase/i.test(b.title)));
});

test('페이저로 잘린 출력은 truncated 로 밝힌다', () => {
  assert.equal(parseSpinfo(TEXT).truncated, false);
  assert.equal(parseSpinfo(`${TEXT}\n--More--`).truncated, true);
});

test('빈 입력은 parsed:false — 아무것도 지어내지 않는다', () => {
  const sp = parseSpinfo('');
  assert.equal(sp.parsed, false);
  assert.equal(sp.fru.total, 0);
  assert.equal(sp.power.totalWatts, null);
});

test('픽스처에 실장비 식별자를 넣지 않는다(공개 저장소 — v2.513 규약)', () => {
  // 합성 표식만 쓰였는지 확인한다. 실장비 캡처를 다시 커밋하면 여기서 깨진다.
  const serials = [...TEXT.matchAll(/Serial Number\s*:\s*(\S+)/g)].map((m) => m[1]);
  assert.ok(serials.length > 0);
  for (const s of serials) assert.match(s, /^SYNTH/, `합성 일련번호가 아니다: ${s}`);
  assert.match(/Unique ID\s*:\s*(\S+)/.exec(TEXT)[1], /^SYNTH-/);
});
