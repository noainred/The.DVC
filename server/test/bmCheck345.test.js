// 물리서버 점검(v3.45 — 설계 docs/design/bm-feature-proposals ① 보증 · 계약 만료 ② 펌웨어 기준선 ③ BIOS 설정 편차 · 사용자 '① ② ③ ⑨ 먼저 구현' · 범위 '엣지 서버까지').
//   ① 다수 값(util/majority) ② 펌웨어: 이름 정규화 · 구성요소 · 행 상태 · 함대 판정(법인 안 다수 · 관리자 지정 · 못 읽음/보내지 않음 따로) · 엣지 정제
//   ③ BIOS: 아는 키만 · 묶음(법인 · 폴더 · 모델) · 동률 · 미분류 ④ 보증: 날짜 · 경계(오늘 · 90일) · 모름 따로 ⑤ 자산 원장 CSV(별칭 · 오류 줄 · 바꾸기)
//   ⑥ 저장소(손상이면 쓰기 거절 · 기준 지정/해제) ⑦ 입력 모으기(엣지 정제본 그대로 · 찾기 없음 = 판정 안 함) ⑧ 중앙 fleet 정제(검증된 이름만)
//   ⑨ 라우트: 목록 chk · /check(범위 404 · 계약 번호는 관리자 판본만) · 관리 라우트(드라이런 → 커밋 · 게이트) ⑩ 엣지 pushFleetNow 왕복.
//   픽스처 식별자는 전부 합성(SYNTH · 192.0.2.x — 공개 저장소 규약).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_DIRS = [];
const tmpDir = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); TMP_DIRS.push(d); return d; };
const rmTmpDirs = () => { for (const d of TMP_DIRS) { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* 정리 실패는 시험 결과가 아니다 */ } } };
after(() => { rmTmpDirs(); process.once('exit', () => { try { rmTmpDirs(); } catch { /* 종료 중 */ } }); });

const tmp = tmpDir('bmcheck345-');
process.env.CONFIG_DIR = tmp;

const { majorityOf } = await import('../src/util/majority.js');
const F = await import('../src/bmcheck/fw.js');
const B = await import('../src/bmcheck/bios.js');
const W = await import('../src/bmcheck/warranty.js');
const C = await import('../src/bmcheck/assetCsv.js');
const S = await import('../src/bmcheck/store.js');
const ST = await import('../src/bmcheck/state.js');
const { BIOS_KEYS } = await import('../src/idrac/biosKeys.js');
const fleet = await import('../src/central/fleet.js');
const invCache = await import('../src/idrac/invCache.js');
const bs = await import('../src/bmfolders/store.js');
const sm = await import('../src/servicemap/store.js');
const registry = await import('../src/idrac/registry.js');
const { store } = await import('../src/store.js');
const { registerBmFolders, checkInputs } = await import('../src/routes/api/bmFolders.js');
const svcinv = await import('../src/routes/api/svcInventory.js');
const { registerBmAssets, BM_ASSET_GATES } = await import('../src/routes/admin/bmAssets.js');
const { todayStamp } = await import('../src/util/dayKey.js');

// ───────── ① 다수 값 ─────────
test('① 다수 값 — 유일한 최다 값 · 2대 이상일 때만 · 모르는 값은 세지 않는다 · 동률이면 없다', () => {
  assert.deepEqual(majorityOf(['a', 'a', 'b']), { value: 'a', count: 2, known: 3, distinct: 2, tie: false });
  assert.deepEqual(majorityOf(['a', 'b']), { value: null, count: 0, known: 2, distinct: 2, tie: true }, '동률 — 어느 쪽이 옳다고 말하지 않는다');
  assert.deepEqual(majorityOf(['a', 'a', 'b', 'b', 'c']), { value: null, count: 0, known: 5, distinct: 3, tie: true });
  assert.deepEqual(majorityOf(['a']), { value: null, count: 0, known: 1, distinct: 1, tie: false }, '아는 값이 하나뿐이면 다수가 아니다');
  assert.deepEqual(majorityOf(['a', 'a']), { value: 'a', count: 2, known: 2, distinct: 1, tie: false });
  // 모르는 값(null · '' · undefined · 객체 · NaN)은 세지 않는다 — 빈 값이 다수가 되지 않는다
  assert.deepEqual(majorityOf([null, '', undefined, {}, NaN, 'x', 'x', '', '']), { value: 'x', count: 2, known: 2, distinct: 1, tie: false });
  assert.deepEqual(majorityOf(['', '', '']), { value: null, count: 0, known: 0, distinct: 0, tie: false });
  assert.equal(majorityOf([1, 1, 2]).value, '1'); assert.equal(majorityOf([true, true, false]).value, 'true');
  assert.deepEqual(majorityOf(null), { value: null, count: 0, known: 0, distinct: 0, tie: false });
  // 최다가 뒤에 나와도 · 가운데 나와도 같다
  assert.equal(majorityOf(['b', 'a', 'a', 'a', 'b']).value, 'a'); assert.equal(majorityOf(['b', 'b', 'a', 'a', 'a']).count, 3);
});

// ───────── ② 펌웨어 ─────────
test('② 이름 정규화 — 끝의 MAC/WWN · 슬롯 번호를 걷어 내고 모델 글자 안의 숫자는 그대로', () => {
  assert.equal(F.fwLabelOf('Intel(R) Ethernet 10G 2P X710 Adapter - 24:6E:96:00:11:22'), 'Intel(R) Ethernet 10G 2P X710 Adapter');
  assert.equal(F.fwLabelOf('QLogic QLE2772 - 20:00:00:24:FF:00:11:22'), 'QLogic QLE2772', 'WWN 8 마디도');
  assert.equal(F.fwLabelOf('Power Supply.Slot.1'), 'Power Supply.Slot.#');
  assert.equal(F.fwLabelOf('Backplane 1'), 'Backplane #');
  assert.equal(F.fwLabelOf('BRCM GbE 4P 5720-t rNDC'), 'BRCM GbE 4P 5720-t rNDC');
  assert.equal(F.fwLabelOf('PERC H730P Mini'), 'PERC H730P Mini');
  assert.equal(F.fwLabelOf('Name - not:a:mac'), 'Name - not:a:mac', 'MAC 꼴이 아니면 떼지 않는다');
  assert.equal(F.fwLabelOf('A  \t B\u0000C'), 'A B C', '제어 문자 · 겹친 공백');
  assert.equal(F.fwLabelOf(''), ''); assert.equal(F.fwLabelOf(null), ''); assert.equal(F.fwLabelOf({}), '');
  assert.ok(F.fwLabelOf('x'.repeat(5000)).length <= F.FW_LABEL_MAX, '길이 상한');
  assert.equal(F.isDiskLabel('Disk # in Backplane # of Integrated RAID Controller #'), true);
  assert.equal(F.isDiskLabel('PERC H755 Front'), false);
});

const FWL = (bios = '2.19.1', extra = []) => [
  { type: 'BIOS', name: 'BIOS', version: bios }, { type: 'iDRAC', name: 'Integrated Dell Remote Access Controller', version: '7.00.00.171' },
  { type: 'NIC', name: 'Synth X710 - 24:6E:96:00:11:22', version: '22.5.7' }, { type: 'NIC', name: 'Synth X710 - 24:6E:96:00:11:23', version: '22.5.7' },
  { type: 'Storage', name: 'Disk 0 in Backplane 1 of Integrated RAID Controller 1', version: 'A1' }, { type: 'Other', name: 'Diagnostics', version: '4301A73' }, ...extra,
];
test('② 구성요소 — 대조하는 종류만 · 같은 부품의 포트는 하나로 · 디스크/그 밖은 세기만 · 빈 목록은 못 읽음(null)', () => {
  const c = F.fwComponentsOf(FWL());
  assert.deepEqual(c.comps.map((x) => [x.key, x.version, x.mixed]), [['BIOS|bios', '2.19.1', false], ['iDRAC|integrated dell remote access controller', '7.00.00.171', false], ['NIC|synth x710', '22.5.7', false]]);
  assert.equal(c.skipped, 2, '디스크 1 + 그 밖 1');
  assert.equal(F.fwComponentsOf([]), null, 'fetchFirmwareInventory 는 실패해도 [] — 부품이 없다로 읽지 않는다');
  assert.equal(F.fwComponentsOf(null), null); assert.equal(F.fwComponentsOf('x'), null);
  // 한 서버 안에서 같은 부품의 버전이 갈리면 mixed(판정 안 함)
  const m = F.fwComponentsOf([{ type: 'NIC', name: 'N - 24:6E:96:00:11:22', version: '1.0' }, { type: 'NIC', name: 'N - 24:6E:96:00:11:23', version: '2.0' }]);
  assert.deepEqual(m.comps, [{ key: 'NIC|n', type: 'NIC', label: 'N', version: null, mixed: true }]);
  // 버전 · 이름이 없는 줄 · 객체가 아닌 줄은 건너뛴다(0 · 빈 값으로 만들지 않는다)
  assert.deepEqual(F.fwComponentsOf([null, 'x', { type: 'BIOS', name: 'BIOS', version: '' }, { type: 'BIOS', name: '', version: '1' }, { type: 'BIOS', name: 'BIOS', version: '1.2' }]).comps.map((x) => x.version), ['1.2']);
  // 서버당 상한
  const many = Array.from({ length: 80 }, (_, i) => ({ type: 'NIC', name: `Card model${i}x`, version: '1' }));
  const mm = F.fwComponentsOf(many);
  assert.equal(mm.comps.length, F.FW_PER_SERVER_MAX); assert.equal(mm.skipped, 80 - F.FW_PER_SERVER_MAX, '넘친 것은 개수를 밝힌다');
});

test('② 행 상태 — 같음 · 낮음 · 높음 · 순서 모름 · 기준 없음 · 섞임', () => {
  assert.equal(F.fwRowState('2.19.1', '2.21.2'), 'behind');
  assert.equal(F.fwRowState('2.21.2', '2.21.2'), 'same');
  assert.equal(F.fwRowState('2.21', '2.21.0'), 'same', '짧은 쪽은 0 으로');
  assert.equal(F.fwRowState('2.22.0', '2.21.2'), 'ahead', '기준보다 높은 것은 뒤처짐이 아니다');
  assert.equal(F.fwRowState('7.00.00.183', '7.00.00.171'), 'ahead');
  assert.equal(F.fwRowState('25.5.9.0001', '25.5.9.1'), 'same');
  assert.equal(F.fwRowState('00.1D.7D', '00.1D.7E'), 'differ', '숫자 꼴이 아니면 순서를 지어내지 않는다');
  assert.equal(F.fwRowState('A12', 'a12'), 'same', '대소문자만 다르면 같다');
  assert.equal(F.fwRowState('2.19.1', ''), 'none'); assert.equal(F.fwRowState('2.19.1', null), 'none'); assert.equal(F.fwRowState('', '2.0'), 'none');
  assert.equal(F.fwRowState(null, '2.0', true), 'mixed');
});

const srv = (id, bios, o = {}) => ({ id, corp: 'vc-a', model: 'PowerEdge R750', fw: F.fwComponentsOf(FWL(bios)), ...o });
test('② 함대 판정 — 같은 법인 · 같은 모델의 다수 버전 · 못 읽음/보내지 않음은 따로 · 다른 법인 값은 섞이지 않는다', () => {
  const r = F.judgeFirmware([srv('a', '2.19.1'), srv('b', '2.21.2'), srv('c', '2.21.2'), { id: 'd', corp: 'vc-a', model: 'PowerEdge R750', fw: null }, { id: 'e', corp: 'vc-a', model: 'PowerEdge R750' },
    // 다른 법인 — 같은 모델이 전부 2.19.1 이어도 vc-a 의 다수를 바꾸지 않는다(범위 가림)
    srv('x1', '2.19.1', { corp: 'vc-b' }), srv('x2', '2.19.1', { corp: 'vc-b' }), srv('x3', '2.19.1', { corp: 'vc-b' }),
    // 다른 모델
    srv('m1', '1.0.0', { model: 'PowerEdge R650' })]);
  const a = r.get('a');
  assert.equal(a.state, 'behind'); assert.equal(a.behind, 1); assert.equal(a.peers, 3, '펌웨어를 읽은 같은 법인 · 같은 모델 서버 수');
  assert.deepEqual(a.rows.find((x) => x.type === 'BIOS'), { key: 'BIOS|bios', type: 'BIOS', label: 'BIOS', installed: '2.19.1', mixed: false, baseline: '2.21.2', basis: 'majority', state: 'behind', peers: 2, known: 3 });
  assert.equal(a.rows.find((x) => x.type === 'NIC').state, 'same');
  assert.equal(r.get('b').state, 'ok'); assert.equal(r.get('b').behind, 0);
  assert.deepEqual([r.get('d').state, r.get('d').rows], ['unread', []], '못 읽음 — 같음에도 뒤처짐에도 넣지 않는다');
  assert.equal(r.get('e').state, 'unsent', '엣지가 보내지 않음(구버전)');
  assert.equal(r.get('x1').state, 'ok', '다른 법인은 그 법인 안에서 판정한다');
  // 같은 모델이 혼자면 기준이 없다 → 판정 안 함
  assert.equal(r.get('m1').state, 'none'); assert.equal(r.get('m1').rows[0].state, 'none'); assert.equal(r.get('m1').rows[0].baseline, null);
  // 동률(1:1)이면 기준 없음 + tie 표지
  const t2 = F.judgeFirmware([srv('a', '1.0.0'), srv('b', '2.0.0')]);
  assert.equal(t2.get('a').rows[0].state, 'none'); assert.equal(t2.get('a').rows[0].tie, true);
  // 법인 · 모델이 없으면 묶음을 만들지 않는다(빈 글자끼리 한 묶음이 되지 않는다)
  const nm = F.judgeFirmware([srv('a', '1.0.0', { model: '' }), srv('b', '1.0.0', { model: '' }), srv('c', '1.0.0', { corp: '' }), srv('d', '1.0.0', { corp: '' })]);
  for (const id of ['a', 'b', 'c', 'd']) { assert.equal(nm.get(id).state, 'none', id); assert.equal(nm.get(id).peers, 0); }
});

test('② 관리자 지정 기준이 다수보다 먼저 · 기준보다 높은 서버는 뒤처짐이 아니다 · 순서 모름은 뒤처짐으로 센다', () => {
  const admin = (model, key) => (model === 'PowerEdge R750' && key === 'BIOS|bios' ? '2.22.0' : '');
  const r = F.judgeFirmware([srv('a', '2.19.1'), srv('b', '2.21.2'), srv('c', '2.21.2'), srv('d', '2.23.0')], { admin });
  for (const id of ['a', 'b', 'c']) { const row = r.get(id).rows[0]; assert.equal(row.basis, 'admin'); assert.equal(row.baseline, '2.22.0'); assert.equal(row.state, 'behind', id); assert.equal(row.peers, undefined, '지정 기준에는 다수 대수가 없다'); }
  assert.equal(r.get('d').rows[0].state, 'ahead'); assert.equal(r.get('d').state, 'ok'); assert.equal(r.get('d').ahead, 1);
  // 숫자 꼴이 아닌 버전이 기준과 다르면 differ → 서버는 behind 로 센다(같다고 하지 않는다)
  const p = (id, v) => ({ id, corp: 'c', model: 'M', fw: F.fwComponentsOf([{ type: 'PSU', name: 'PS1 Power Supply', version: v }]) });
  const d = F.judgeFirmware([p('a', '00.1D.7D'), p('b', '00.1D.7E'), p('c', '00.1D.7E')]);
  assert.equal(d.get('a').rows[0].state, 'differ'); assert.equal(d.get('a').state, 'behind'); assert.equal(d.get('a').behind, 1);
  // 다수 값의 대소문자: 처음 본 글자 그대로 보인다(소문자로 바꿔 보이지 않는다)
  const u = F.judgeFirmware([p('a', 'A12'), p('b', 'A12'), p('c', 'a11')]);
  assert.equal(u.get('c').rows[0].baseline, 'A12');
});

test('② 엣지 정제 — 아는 종류만 · 이름 다시 정규화 · 상한 · 형식이 아니면 undefined(보내지 않음과 같다)', () => {
  const push = F.fwPushOf({ firmware: FWL() });
  assert.deepEqual(push, { c: [{ t: 'BIOS', n: 'BIOS', v: '2.19.1' }, { t: 'iDRAC', n: 'Integrated Dell Remote Access Controller', v: '7.00.00.171' }, { t: 'NIC', n: 'Synth X710', v: '22.5.7' }], s: 2 });
  assert.equal(F.fwPushOf({ firmware: [] }), undefined); assert.equal(F.fwPushOf(null), undefined); assert.equal(F.fwPushOf({}), undefined);
  assert.deepEqual(F.sanitizeFwPush(push), F.fwComponentsOf(FWL()), '보낸 것을 정제하면 중앙이 직접 만든 것과 같다');
  // 엣지가 정규화하지 않은 이름 · 모르는 종류 · 디스크 · 객체가 아닌 값 · 수 버전 · 중복 열쇠
  const s = F.sanitizeFwPush({ c: [{ t: 'NIC', n: 'Card - 24:6E:96:00:11:22', v: '1.0', extra: 'x' }, { t: 'Evil', n: 'x', v: '1' }, { t: 'Storage', n: 'Disk 0 in Backplane 1', v: '1' },
    'str', null, [1], { t: 'BIOS', n: 'BIOS', v: 2.5 }, { t: 'NIC', n: 'card', v: '9.9' }, { t: 'PSU', n: 'PS1', x: 1 }], s: '7', other: 1 });
  assert.deepEqual(s, { comps: [{ key: 'NIC|card', type: 'NIC', label: 'Card', version: '1.0', mixed: false }, { key: 'PSU|ps1', type: 'PSU', label: 'PS1', version: null, mixed: true }], skipped: 0 });
  for (const bad of [null, undefined, 'x', 3, [], { c: 'x' }, { c: [] }, { c: [{ t: 'Evil', n: 'x', v: '1' }] }]) assert.equal(F.sanitizeFwPush(bad), undefined, JSON.stringify(bad));
  const big = F.sanitizeFwPush({ c: Array.from({ length: 500 }, (_, i) => ({ t: 'NIC', n: `card model${i}x`, v: 'v'.repeat(500) })), s: 1e9 });
  assert.equal(big.comps.length, F.FW_PER_SERVER_MAX); assert.ok(big.comps[0].version.length <= F.FW_VER_MAX); assert.equal(big.skipped, 400);
  assert.equal(F.sanitizeFwPush({ c: [{ t: 'BIOS', n: 'BIOS', v: '1' }], s: -3 }).skipped, 0); assert.equal(F.sanitizeFwPush({ c: [{ t: 'BIOS', n: 'BIOS', v: '1' }], s: Infinity }).skipped, 0);
});

// ───────── ③ BIOS ─────────
const bsrv = (id, turbo, o = {}) => ({ id, corp: 'vc-a', path: 'SVC\\DB', model: 'PowerEdge R750', bios: { BootMode: 'Uefi', ProcTurboMode: turbo }, ...o });
test('③ BIOS — 아는 키만 · 값이 없으면 못 읽음 · 엣지 정제는 같은 함수', () => {
  assert.deepEqual(B.biosAttrsOf({ BootMode: 'Uefi', ProcTurboMode: 'Enabled', Secret: 'x', ProcCores: 16, SecureBoot: true, LogicalProc: '', NodeInterleave: null, MemOpMode: { a: 1 } }),
    { BootMode: 'Uefi', ProcCores: '16', SecureBoot: 'true', ProcTurboMode: 'Enabled' });
  assert.equal(B.biosAttrsOf({ Secret: 'x' }), null, '아는 항목이 하나도 없으면 못 읽음'); assert.equal(B.biosAttrsOf(null), null); assert.equal(B.biosAttrsOf([]), null); assert.equal(B.biosAttrsOf('x'), null);
  assert.ok(B.biosAttrsOf({ BootMode: 'x'.repeat(999) }).BootMode.length <= B.BIOS_VALUE_MAX);
  assert.equal(B.biosAttrsOf({ BootMode: 'a\u0000b' }).BootMode, 'a b');
  assert.deepEqual(B.biosPushOf({ bios: { attributes: { BootMode: 'Uefi' } } }), { BootMode: 'Uefi' }); assert.equal(B.biosPushOf({ bios: {} }), undefined); assert.equal(B.biosPushOf(null), undefined);
  assert.deepEqual(B.sanitizeBiosPush({ BootMode: 'Bios', evil: '1' }), { BootMode: 'Bios' }); assert.equal(B.sanitizeBiosPush('x'), undefined); assert.equal(B.sanitizeBiosPush({ evil: 1 }), undefined);
  assert.ok(BIOS_KEYS.includes('ProcTurboMode'));
});

test('③ 함대 판정 — 같은 법인 · 같은 폴더 · 같은 모델의 다수 값 · 동률 · 미분류 · 못 읽음/보내지 않음은 따로', () => {
  const r = B.judgeBios([bsrv('a', 'Enabled'), bsrv('b', 'Disabled'), bsrv('c', 'Disabled'),
    bsrv('u', 'Enabled', { path: '' }),                          // 미분류
    bsrv('n', 'Enabled', { bios: null }), { id: 'e', corp: 'vc-a', path: 'SVC\\DB', model: 'PowerEdge R750' },   // 못 읽음 · 보내지 않음
    bsrv('o1', 'Enabled', { path: 'SVC\\WEB' }), bsrv('o2', 'Enabled', { path: 'SVC\\WEB' }),                    // 다른 폴더 — 전부 Enabled
    bsrv('x', 'Enabled', { corp: 'vc-b' }),                                                                      // 다른 법인 · 혼자
    bsrv('p', 'Enabled', { bios: { BootMode: 'Uefi' } })]);                                                      // 그 설정만 없음
  const a = r.get('a');
  assert.equal(a.state, 'diff'); assert.equal(a.diff, 1); assert.deepEqual(a.group, { size: 6, known: 4 }, '묶음 6대(못 읽음 · 보내지 않음 포함) · 설정을 읽은 4대');
  assert.deepEqual(a.rows, [{ k: 'BootMode', v: 'Uefi', major: 'Uefi', majorN: 4, known: 4, state: 'same' }, { k: 'ProcTurboMode', v: 'Enabled', major: 'Disabled', majorN: 2, known: 3, state: 'diff' }]);
  assert.equal(r.get('b').state, 'ok'); assert.equal(r.get('b').diff, 0);
  assert.deepEqual([r.get('u').state, r.get('u').rows.length], ['unplaced', 0], '미분류는 판정하지 않는다');
  assert.equal(r.get('n').state, 'unread'); assert.equal(r.get('e').state, 'unsent');
  assert.equal(r.get('o1').state, 'ok', '다른 폴더는 그 폴더 안에서');
  assert.equal(r.get('x').state, 'none', '혼자면 다수가 없다 — 판정 안 함'); assert.equal(r.get('x').rows[0].state, 'tie');
  assert.deepEqual(r.get('p').rows.map((x) => [x.k, x.state]), [['BootMode', 'same'], ['ProcTurboMode', 'unread']], '그 설정만 없는 서버 — 다름으로 세지 않는다');
  assert.equal(r.get('p').state, 'ok'); assert.equal(r.get('p').diff, 0);
  // 동률(1:1) — 어느 쪽이 옳다고 말하지 않는다
  const t2 = B.judgeBios([bsrv('a', 'Enabled'), bsrv('b', 'Disabled')]);
  assert.deepEqual(t2.get('a').rows.map((x) => x.state), ['same', 'tie']); assert.equal(t2.get('a').diff, 0); assert.equal(t2.get('a').state, 'ok');
  // 모델이 없으면 묶음이 없다
  assert.equal(B.judgeBios([bsrv('a', 'Enabled', { model: '' }), bsrv('b', 'Enabled', { model: '' })]).get('a').state, 'unplaced');
  // 폴더 · 모델 대소문자는 같은 묶음
  const cs = B.judgeBios([bsrv('a', 'Enabled'), bsrv('b', 'Enabled', { path: 'svc\\db', model: 'poweredge r750' })]);
  assert.deepEqual(cs.get('a').group, { size: 2, known: 2 });
});

// ───────── ④ 보증 ─────────
test('④ 날짜 — 받는 꼴 · 없는 날짜 · 범위', () => {
  assert.equal(W.parseDay('2027-03-14'), '2027-03-14'); assert.equal(W.parseDay('2027/3/4'), '2027-03-04'); assert.equal(W.parseDay('2027.03.14'), '2027-03-14'); assert.equal(W.parseDay('20270314'), '2027-03-14'); assert.equal(W.parseDay(' 2027-03-14 '), '2027-03-14');
  for (const bad of ['', null, undefined, {}, '2027-02-30', '2027-13-01', '27-03-14', '14/03/2027', '2027-03', 'abc', '2027-03-14T00:00', '1989-12-31', '2101-01-01', '2027--03-14', '0']) assert.equal(W.parseDay(bad), '', String(bad));
  assert.equal(W.dayDiff('2027-03-14', '2027-03-14'), 0); assert.equal(W.dayDiff('2027-03-15', '2027-03-14'), 1); assert.equal(W.dayDiff('2027-03-01', '2027-02-28'), 1); assert.equal(W.dayDiff('2028-03-01', '2028-02-28'), 2, '윤년');
  assert.equal(W.dayDiff('x', '2027-03-14'), null);
  assert.equal(W.monthsBetween('2022-03-15', '2026-11-26'), 56); assert.equal(W.monthsBetween('2022-03-15', '2022-04-14'), 0); assert.equal(W.monthsBetween('2022-03-15', '2022-04-15'), 1);
  assert.equal(W.monthsBetween('2027-01-01', '2026-11-26'), null, '미래 구매일은 사용 기간이 아니다');
});

test('④ 보증 상태 — 끝남 · 곧(기준 일수 안) · 정상 · 모름은 따로(끝남에도 정상에도 넣지 않는다) · 만료일 당일은 아직 보증 안', () => {
  const today = '2026-11-26';
  const st = (end) => W.warrantyOf({ end }, today);
  assert.deepEqual([st('2026-11-25').state, st('2026-11-25').daysLeft], ['expired', -1]);
  assert.deepEqual([st('2026-11-26').state, st('2026-11-26').daysLeft], ['soon', 0], '만료일 당일');
  assert.equal(W.WARRANTY_SOON_DAYS, 90);
  assert.deepEqual([st('2027-02-24').state, st('2027-02-24').daysLeft], ['soon', 90]);
  assert.deepEqual([st('2027-02-25').state, st('2027-02-25').daysLeft], ['ok', 91]);
  const none = W.warrantyOf(null, today);
  assert.deepEqual([none.state, none.why, none.daysLeft, none.end], ['unknown', 'no-entry', null, '']);
  const noEnd = W.warrantyOf({ end: '', type: 'Basic', purchase: '2022-03-15' }, today);
  assert.deepEqual([noEnd.state, noEnd.why, noEnd.type, noEnd.ageMonths], ['unknown', 'no-end', 'Basic', 56], '만료일이 없으면 모름 — 다른 값은 그대로 보인다');
  assert.equal(W.warrantyOf({ end: 'garbage' }, today).state, 'unknown', '못 읽는 날짜를 0일 · 끝남으로 만들지 않는다');
  const full = W.warrantyOf({ end: '2027-03-14', type: ' ProSupport ', purchase: '2022-03-15', contract: 'SYNTH-C1', eos: '2026-01-01', note: 'n' }, today);
  assert.deepEqual(full, { state: 'ok', end: '2027-03-14', daysLeft: 108, type: 'ProSupport', purchase: '2022-03-15', ageMonths: 56, contract: 'SYNTH-C1', eos: '2026-01-01', eosPassed: true, note: 'n' });
  assert.equal(W.warrantyOf({ end: '2027-03-14', eos: '2030-01-01' }, today).eosPassed, false); assert.equal(W.warrantyOf({ end: '2027-03-14' }, today).eosPassed, null);
  assert.equal(W.warrantyOf({ end: '2027-03-14', type: {} , contract: 5 }, today).type, '');
});

// ───────── ⑤ 자산 원장 CSV ─────────
test('⑤ CSV — 머리글 별칭(한글) · 빈 줄 · 수식 가드 풀기 · 태그 열이 없으면 오류', () => {
  const r = C.parseAssetCsv('﻿서비스 태그,보증 만료,보증 종류,구매일,계약번호,지원종료,비고,모르는열\r\nSYNTH01,2027-03-14,ProSupport,2022-03-15,C-1,2029-03-31,메모,x\r\n\r\n ,,,,,,,\r\nSYNTH02,2026/12/31,,,,,,\r\n');
  assert.equal(r.error, undefined);
  assert.deepEqual(r.rows, [{ _line: 2, service_tag: 'SYNTH01', warranty_end: '2027-03-14', warranty_type: 'ProSupport', purchase_date: '2022-03-15', contract_no: 'C-1', eos_date: '2029-03-31', note: '메모' },
    { _line: 5, service_tag: 'SYNTH02', warranty_end: '2026/12/31', warranty_type: '', purchase_date: '', contract_no: '', eos_date: '', note: '' }]);
  assert.match(C.parseAssetCsv('name,end\nx,2027-01-01').error, /service_tag/);
  assert.match(C.parseAssetCsv('').error, /빈 파일/);
  assert.deepEqual(C.parseAssetCsv('service_tag,warranty_end').rows, []);
  assert.equal(C.parseAssetCsv("service_tag,note\nSYNTH01,'=SUM(A1)").rows[0].note, '=SUM(A1)', '내보낼 때 붙인 수식 가드는 가져올 때 푼다');
});

test('⑤ 가져오기 판정 — 더함 · 바꿈 · 같음 · 오류 줄(못 읽는 날짜 · 같은 태그 두 번 · 값 없음) · 파일로 바꾸기는 오류가 있으면 전부 멈춘다', () => {
  const cur = { synth01: { tag: 'SYNTH01', end: '2027-03-14', type: 'Basic', purchase: '', contract: '', eos: '', note: '' }, synth09: { tag: 'SYNTH09', end: '2026-01-01', type: '', purchase: '', contract: '', eos: '', note: '' } };
  const rows = C.parseAssetCsv('service_tag,warranty_end,warranty_type\nsynth01,2027-03-14,Basic\nSYNTH02,2028-01-01,Pro\nSYNTH03,2027-02-30,x\nSYNTH02,2029-01-01,y\nSYNTH04,,\n,2027-01-01,z\nSYNTH05,2030-05-05,').rows;
  const a = C.analyzeAssetImport(rows, cur);
  assert.deepEqual(a.summary, { add: 2, update: 0, same: 1, error: 4, remove: 0 });
  assert.deepEqual(a.report.map((x) => [x.line, x.action]), [[2, 'same'], [3, 'add'], [4, 'error'], [5, 'error'], [6, 'error'], [7, 'error'], [8, 'add']]);
  assert.match(a.report[2].reason, /날짜로 읽지 못한 값 — 보증 만료일 ‘2027-02-30’/); assert.match(a.report[3].reason, /3번째 줄에도/); assert.match(a.report[4].reason, /값이 없습니다/); assert.match(a.report[5].reason, /비어 있습니다/);
  assert.deepEqual(Object.keys(a.next).sort(), ['synth01', 'synth02', 'synth05', 'synth09'], '합치기 — 파일에 없는 줄은 그대로 · 오류 줄은 넣지 않는다');
  assert.equal(a.next.synth02.end, '2028-01-01', '같은 태그의 뒤 줄(오류)이 앞 줄을 덮지 않는다');
  // 대소문자만 다른 태그는 같은 서버 — 값이 달라지면 update
  const u = C.analyzeAssetImport(C.parseAssetCsv('service_tag,warranty_end\nsynth01,2028-03-14').rows, cur);
  assert.deepEqual(u.summary, { add: 0, update: 1, same: 0, error: 0, remove: 0 });
  // 파일로 바꾸기: 오류 줄이 있으면 next 가 없다(오류 줄의 서버가 원장에서 사라지지 않게)
  const rp = C.analyzeAssetImport(rows, cur, { replace: true });
  assert.equal(rp.next, null); assert.equal(rp.summary.remove, 1, 'SYNTH09 가 파일에 없다');
  const ok = C.analyzeAssetImport(C.parseAssetCsv('service_tag,warranty_end\nSYNTH02,2028-01-01').rows, cur, { replace: true });
  assert.deepEqual(Object.keys(ok.next), ['synth02']); assert.deepEqual(ok.summary, { add: 1, update: 0, same: 0, error: 0, remove: 2 });
  // 객체 열쇠로 쓰면 안 되는 태그(__proto__ · constructor · prototype)는 오류 — 원장 객체의 원형을 바꾸지 못한다
  const bad = C.analyzeAssetImport(C.parseAssetCsv('service_tag,warranty_end\n__proto__,2030-01-01\nconstructor,2030-01-01\nPROTOTYPE,2030-01-01\nSYNTH07,2030-01-01').rows, {});
  assert.deepEqual(bad.summary, { add: 1, update: 0, same: 0, error: 3, remove: 0 });
  assert.deepEqual(Object.keys(bad.next), ['synth07']); assert.equal(Object.getPrototypeOf(bad.next), Object.prototype); assert.equal({}.end, undefined);
  // 길이 상한은 자르지 않고 오류
  assert.match(C.entryOfRow({ service_tag: 'T'.repeat(65), warranty_end: '2027-01-01' }).error, /너무 깁니다/);
  assert.match(C.entryOfRow({ service_tag: 'T', warranty_end: '2027-01-01', note: 'n'.repeat(121) }).error, /너무 깁니다/);
});

test('⑤ 내보내기 — 태그 순 · 수식 주입 가드 · 다시 읽으면 같은 값 · 샘플은 스스로 통과한다', () => {
  const entries = { b: { tag: 'SYNTH02', end: '2028-01-01', type: '=cmd', purchase: '', contract: 'C,1', eos: '', note: '' }, a: { tag: 'SYNTH01', end: '2027-03-14', type: 'Basic', purchase: '2022-03-15', contract: '', eos: '', note: '"q"' } };
  const csv = C.assetsToCsv(entries);
  assert.ok(csv.startsWith('﻿service_tag,warranty_end,warranty_type,purchase_date,contract_no,eos_date,note\r\nSYNTH01,'));
  assert.ok(!/,=cmd/.test(csv), '수식으로 시작하는 칸을 그대로 내보내지 않는다');
  const back = C.analyzeAssetImport(C.parseAssetCsv(csv).rows, {});
  assert.deepEqual(back.summary, { add: 2, update: 0, same: 0, error: 0, remove: 0 });
  assert.deepEqual(back.next.synth02, { tag: 'SYNTH02', end: '2028-01-01', type: '=cmd', purchase: '', contract: 'C,1', eos: '', note: '' });
  assert.equal(back.next.synth01.note, '"q"');
  const sample = C.analyzeAssetImport(C.parseAssetCsv(C.sampleAssetCsv()).rows, {});
  assert.deepEqual([sample.summary.error, sample.summary.add], [0, 2]);
});

// ───────── ⑥ 저장소 ─────────
const resetStores = () => { S.assetStore._resetForTest(); S.fwBaselineStore._resetForTest(); for (const f of ['bm-assets.json', 'bm-fw-baseline.json']) fs.rmSync(path.join(tmp, f), { force: true }); for (const f of fs.readdirSync(tmp)) if (/^bm-(assets|fw-baseline)\.json\.corrupt/.test(f)) fs.rmSync(path.join(tmp, f), { force: true }); };
test('⑥ 저장소 — 없으면 빈 값 · 저장하면 세대가 오른다 · 손상이면 빈 값으로 덮지 않고 쓰기를 거절한다', () => {
  resetStores();
  assert.deepEqual(S.assetStore.get(), { v: 1, at: null, by: '', rows: {} }); assert.equal(S.assetStore.loadError(), null);
  const r0 = S.assetStore.rev();
  assert.deepEqual(S.assetStore.save({ v: 1, at: 5, by: 'admin', rows: { synth01: { tag: 'SYNTH01', end: '2027-03-14', type: 'Basic', extra: 'x' }, bad: 'x', notag: { end: '2027-01-01' } } }), { ok: true });
  assert.ok(S.assetStore.rev() > r0);
  assert.deepEqual(S.assetStore.get().rows, { synth01: { tag: 'SYNTH01', end: '2027-03-14', type: 'Basic', purchase: '', contract: '', eos: '', note: '' } }, '아는 필드만 · 태그 없는 줄은 버린다');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(tmp, 'bm-assets.json'), 'utf8')).rows.synth01.tag, 'SYNTH01');
  // 손상
  S.assetStore._resetForTest(); fs.writeFileSync(path.join(tmp, 'bm-assets.json'), '{oops');
  const w = console.error; const ww = console.warn; console.error = () => {}; console.warn = () => {};
  try {
    assert.ok(S.assetStore.loadError(), '로드 오류 표지');
    const r = S.assetStore.save({ v: 1, rows: {} });
    assert.equal(r.ok, false); assert.equal(r.status, 409);
    const ci = checkInputs();
    assert.deepEqual([ci.assets, ci.assetsErr], [null, true], '못 읽었으면 보증 판정을 하지 않는다(빈 원장으로 보고 전부 모름이라 하지 않는다)');
  } finally { console.error = w; console.warn = ww; }
  resetStores();
});

test('⑥ 펌웨어 기준 지정 · 해제 — 모델은 대소문자 무시 · 같은 값이면 바뀌지 않음 · 해제하면 모델 줄도 사라진다', () => {
  resetStores();
  const set = (o) => S.setAdminBaseline({ model: 'PowerEdge R750', key: 'BIOS|bios', label: 'BIOS', type: 'BIOS', by: 'admin', now: 9, ...o });
  assert.deepEqual(set({ version: '2.22.0' }), { ok: true, changed: true });
  assert.deepEqual(set({ version: '2.22.0' }), { ok: true, changed: false });
  const look = S.adminBaselineLookup();
  assert.equal(look('poweredge r750', 'BIOS|bios'), '2.22.0'); assert.equal(look(' PowerEdge R750 ', 'BIOS|bios'), '2.22.0'); assert.equal(look('PowerEdge R650', 'BIOS|bios'), ''); assert.equal(look('PowerEdge R750', 'NIC|x'), '');
  assert.deepEqual(S.fwBaselineStore.get().models['poweredge r750'].comps['BIOS|bios'], { label: 'BIOS', type: 'BIOS', version: '2.22.0', by: 'admin', at: 9 });
  assert.deepEqual(set({ version: '' }), { ok: true, changed: true });
  assert.deepEqual(S.fwBaselineStore.get().models, {});
  assert.deepEqual(set({ version: '' }), { ok: true, changed: false });
  assert.equal(S.setAdminBaseline({ model: '', key: 'BIOS|bios', version: '1' }).status, 400); assert.equal(S.setAdminBaseline({ model: 'M', key: '', version: '1' }).status, 400);
  // 객체 열쇠로 쓰면 안 되는 이름 — 거절 · 조회는 자기 열쇠만(Object 의 것을 기준으로 읽지 않는다)
  assert.equal(S.setAdminBaseline({ model: '__proto__', key: 'BIOS|bios', version: '1' }).status, 400); assert.equal(S.setAdminBaseline({ model: 'M', key: 'constructor', version: '1' }).status, 400);
  assert.equal(S.adminBaselineLookup()('constructor', 'name'), ''); assert.equal(S.adminBaselineLookup()('__proto__', 'x'), ''); assert.equal(S.adminBaselineLookup({ models: { m: { comps: {} } } })('m', 'toString'), '');
  // 파일에 그런 열쇠가 들어 있어도 읽을 때 버린다
  S.fwBaselineStore._resetForTest(); fs.writeFileSync(path.join(tmp, 'bm-fw-baseline.json'), '{"v":1,"models":{"__proto__":{"model":"x","comps":{"a":{"version":"9"}}},"ok":{"model":"OK","comps":{"__proto__":{"version":"9"},"BIOS|bios":{"version":"1.0"}}}}}');
  assert.deepEqual(Object.keys(S.fwBaselineStore.get().models), ['ok']); assert.deepEqual(Object.keys(S.fwBaselineStore.get().models.ok.comps), ['BIOS|bios']);
  assert.equal(Object.getPrototypeOf(S.fwBaselineStore.get().models), Object.prototype);
  S.assetStore._resetForTest(); fs.writeFileSync(path.join(tmp, 'bm-assets.json'), '{"v":1,"rows":{"__proto__":{"tag":"X","end":"2030-01-01"},"synth01":{"tag":"SYNTH01","end":"2030-01-01"}}}');
  assert.deepEqual(Object.keys(S.assetStore.get().rows), ['synth01']); assert.equal(Object.getPrototypeOf(S.assetStore.get().rows), Object.prototype);
  resetStores();
});

// ───────── ⑦ 입력 모으기 ─────────
test('⑦ 입력 모으기 — 엣지는 정제본 그대로(없으면 보내지 않음) · 인벤토리 없음은 못 읽음 · 찾기/원장이 없으면 그 판정을 하지 않는다 · ESXi 는 보증만', () => {
  const members = [
    { key: 'st:a', kind: 'bm', corp: 'vc-a', model: 'M', serviceTag: 'SYNTH01' }, { key: 'st:b', kind: 'bm', corp: 'vc-a', model: 'M', serviceTag: 'SYNTH02' },
    { key: 'st:c', kind: 'bm', corp: 'vc-a', model: 'M', serviceTag: 'SYNTH03' }, { key: 'st:d', kind: 'bm', corp: 'vc-a', model: 'M', serviceTag: '' },
    { key: 'st:e', kind: 'esxi', corp: 'vc-a', model: 'M', serviceTag: 'SYNTH05' },
  ];
  const inv = (bios, turbo) => ({ firmware: [{ type: 'BIOS', name: 'BIOS', version: bios }], bios: { attributes: { ProcTurboMode: turbo } } });
  const hxOf = (m) => (m.kind !== 'bm' ? null : m.key === 'st:a' ? { inv: inv('1.0.0', 'Enabled'), via: 'local' } : m.key === 'st:b' ? { inv: inv('2.0.0', 'Disabled'), via: 'remote' }
    : m.key === 'st:c' ? { inv: null, via: 'edge', fw: F.fwComponentsOf([{ type: 'BIOS', name: 'BIOS', version: '2.0.0' }]), bios: { ProcTurboMode: 'Disabled' } } : { inv: null, via: 'edge' });
  const placeOf = new Map([['st:a', { path: 'SVC', src: 'manual' }], ['st:b', { path: 'SVC', src: 'rule' }], ['st:c', { path: 'SVC', src: 'manual' }], ['st:d', { path: 'SVC', src: 'manual' }]]);
  const assets = { synth01: { tag: 'SYNTH01', end: '2026-01-01' }, synth05: { tag: 'SYNTH05', end: '2030-01-01' } };
  const chk = ST.bmCheckFor({ members, placeOf, hxOf, assets, adminBase: null, today: '2026-11-26' });
  const a = chk.ofMember(members[0]);
  assert.equal(a.warranty.state, 'expired'); assert.equal(a.fw.state, 'behind'); assert.equal(a.fw.peers, 3, '로컬 · 수집 서버 · 엣지 서버가 한 묶음'); assert.equal(a.bios.state, 'diff');
  assert.equal(chk.ofMember(members[2]).fw.state, 'ok'); assert.equal(chk.ofMember(members[2]).bios.state, 'ok');
  const d = chk.ofMember(members[3]);
  assert.deepEqual([d.fw.state, d.bios.state, d.warranty.state, d.warranty.why], ['unsent', 'unsent', 'unknown', 'no-entry'], '엣지가 보내지 않은 서버 · 태그 없는 서버');
  assert.equal(chk.ofMember(members[1]).warranty.state, 'unknown', '원장에 없는 서버는 모름');
  const e = chk.ofMember(members[4]);
  assert.deepEqual([e.warranty.state, e.fw, e.bios], ['ok', undefined, undefined], 'ESXi 호스트는 보증만(같은 물리 박스)');
  assert.deepEqual(ST.chkRowOf(a), { w: 'expired', wd: -329, fw: 'behind', fwn: 1, bios: 'diff', biosn: 1 });
  assert.deepEqual(ST.chkRowOf(chk.ofMember(members[2])), { w: 'unknown', fw: 'ok', bios: 'ok' }, '0 은 싣지 않는다 · 모름에는 남은 일수가 없다');
  assert.equal(ST.chkRowOf(null), undefined); assert.equal(ST.chkRowOf({}), undefined);
  // 미분류(src 없음)는 BIOS 판정 밖
  const un = ST.bmCheckFor({ members, placeOf: new Map(), hxOf, assets, adminBase: null, today: '2026-11-26' });
  assert.equal(un.ofMember(members[0]).bios.state, 'unplaced');
  // 찾기를 만들지 못함 → 펌웨어 · BIOS 키가 없다(정상으로 읽히지 않는다) · 원장을 못 읽음 → 보증 키가 없다
  const no = ST.bmCheckFor({ members, placeOf, hxOf: null, assets: null, adminBase: null, today: '2026-11-26' });
  assert.deepEqual(no.ofMember(members[0]), {});
  // 인벤토리가 없는 로컬 서버는 못 읽음
  const ur = ST.bmCheckFor({ members: [members[0]], placeOf, hxOf: () => ({ inv: null, via: '' }), assets, adminBase: null, today: '2026-11-26' });
  assert.deepEqual([ur.ofMember(members[0]).fw.state, ur.ofMember(members[0]).bios.state], ['unread', 'unread']);
  // hxOf 가 던져도 그 서버만 못 읽음
  const th = ST.bmCheckFor({ members: [members[0]], placeOf, hxOf: () => { throw new Error('x'); }, assets, adminBase: null, today: '2026-11-26' });
  assert.equal(th.ofMember(members[0]).fw.state, 'unread');
  // 태그가 객체의 내장 이름과 같아도 그것을 원장 줄로 읽지 않는다
  const pr = ST.bmCheckFor({ members: [{ key: 'st:x', kind: 'bm', corp: 'vc-a', model: 'M', serviceTag: 'constructor' }, { key: 'st:y', kind: 'bm', corp: 'vc-a', model: 'M', serviceTag: 'toString' }], placeOf, hxOf: null, assets, adminBase: null, today: '2026-11-26' });
  assert.deepEqual([pr.of('st:x').warranty.why, pr.of('st:y').warranty.why], ['no-entry', 'no-entry']);
  // 관리자 지정 기준이 판정에 들어간다
  const ad = ST.bmCheckFor({ members, placeOf, hxOf, assets, adminBase: (model, key) => (key === 'BIOS|bios' ? '1.0.0' : ''), today: '2026-11-26' });
  assert.equal(ad.ofMember(members[0]).fw.state, 'ok'); assert.equal(ad.ofMember(members[1]).fw.rows[0].state, 'ahead');
});

// ───────── ⑧ 중앙 fleet 정제 ─────────
test('⑧ 중앙 fleet — 검증된 이름만 펌웨어 · BIOS 를 받고 정제한다 · 형식이 아니면 키가 없다 · 요약만 바뀌면 fleet rev 그대로', async () => {
  const { fleetRev } = await import('../src/insights/fleetRev.js');
  fleet.resetEdgeFleet();
  const row = { fleetId: 'synth03', name: 'synth-edge-03', serviceTag: 'SYNTH03', vcenterId: 'vc-a', source: 'idrac' };
  const fw = F.fwPushOf({ firmware: FWL() });
  fleet.setEdgeFleet('synth-edge', [{ ...row, fw: { ...fw, evil: 1 }, bios: { BootMode: 'Uefi', evil: 'x' } }], 'g1');
  let s = fleet.getEdgeFleetServers().find((x) => x.serviceTag === 'SYNTH03');
  assert.deepEqual(s.fw, F.fwComponentsOf(FWL())); assert.deepEqual(s.bios, { BootMode: 'Uefi' });
  const rev = fleetRev();
  fleet.setEdgeFleet('synth-edge', [{ ...row, fw: F.fwPushOf({ firmware: FWL('9.9.9') }), bios: { BootMode: 'Bios' } }], 'g2');
  assert.equal(fleetRev(), rev, '펌웨어 · BIOS 만 바뀌면 함대 캐시를 무효화하지 않는다');
  s = fleet.getEdgeFleetServers().find((x) => x.serviceTag === 'SYNTH03');
  assert.equal(s.fw.comps[0].version, '9.9.9'); assert.equal(s.bios.BootMode, 'Bios');
  fleet.setEdgeFleet('synth-edge', [{ ...row, fw: 'bad', bios: [1] }], 'g3');
  s = fleet.getEdgeFleetServers().find((x) => x.serviceTag === 'SYNTH03');
  assert.deepEqual([s.fw, s.bios], [undefined, undefined], '형식이 아니면 보내지 않은 것과 같다');
  const w = console.warn; console.warn = () => {};
  try { fleet.setEdgeFleet('synth-unverified', [{ ...row, fleetId: 'synth-u1', serviceTag: 'SYNTHU1', fw, bios: { BootMode: 'Uefi' } }], 'gu', { verified: false }); } finally { console.warn = w; }
  const u = fleet.getEdgeFleetServers().find((x) => x.serviceTag === 'SYNTHU1');
  assert.deepEqual([u?.fw, u?.bios], [undefined, undefined], '공유 토큰의 이름 주장으로 판정 입력을 심지 못한다');
  fleet.resetEdgeFleet();
});

// ───────── ⑨ 라우트 ─────────
const routes = new Map();
const reg = { get: (p, ...h) => routes.set(`GET ${p}`, h), post: (p, ...h) => routes.set(`POST ${p}`, h) };
registerBmFolders(reg); svcinv.registerSvcInventory(reg); registerBmAssets(reg);
const ADMIN = { username: 'admin', role: 'admin', scope: { vcenters: [], regions: [], writeVcenters: [] } };
const VIEWER = { username: 'viewer1', role: 'viewer', scope: { vcenters: [], regions: [], writeVcenters: [] } };
const SCOPED_A = { username: 'scoped-a', role: 'admin', scope: { vcenters: ['vc-a'], regions: [], writeVcenters: [] } };
const SCOPED_B = { username: 'scoped-b', role: 'admin', scope: { vcenters: ['vc-b'], regions: [], writeVcenters: [] } };
const WRITE_SCOPED = { username: 'wscoped', role: 'admin', scope: { vcenters: [], regions: [], writeVcenters: ['vc-a'] } };
let gen = 0;
const mkRes = () => ({ statusCode: 200, headers: {}, body: undefined, headersSent: false,
  status(c) { this.statusCode = c; return this; }, json(o) { this.body = o; this.headersSent = true; return this; },
  setHeader(k, v) { this.headers[k] = v; }, set(k, v) { this.headers[k] = v; return this; }, end() { this.headersSent = true; return this; }, send(x) { this.body = x; this.headersSent = true; return this; } });
/** 마지막 처리기만(게이트는 따로 시험한다 — 물리서버 폴더 테스트와 같은 방식). */
async function call(key, { user = ADMIN, query = {}, body = {} } = {}) {
  const res = mkRes();
  await routes.get(key).at(-1)({ user, query, body, ip: '127.0.0.1', headers: {}, originalUrl: `${key.replace(/^\w+ /, '/api')}?${new URLSearchParams(query)}&u=${user.username}&g=${gen}` }, res);
  return res;
}
/** 게이트까지 순서대로 — 권한 미들웨어(requirePerm)는 건너뛰고 gate 표지가 있는 것 · 이름 있는 게이트만 돈다. */
async function callGated(key, { user = ADMIN, body = {} } = {}) {
  const res = mkRes(); const req = { user, query: {}, body, ip: '127.0.0.1', headers: {}, originalUrl: key };
  for (const h of routes.get(key)) { let nexted = false; await h(req, res, () => { nexted = true; }); if (!nexted) break; }
  return res;
}
const snapOf = () => ({ ...store.snapshot, initial: false, generatedAt: Date.now() + 1000 + (gen += 7),
  vcenters: [{ id: 'vc-a', name: 'vcenter-a', status: 'ok' }, { id: 'vc-b', name: 'vcenter-b', status: 'ok' }], hosts: [], vms: [] });
const withSnap = async (fn) => { const prev = store.snapshot; try { store.snapshot = snapOf(); return await fn(); } finally { store.snapshot = prev; } };
const INV = (bios, turbo, tag) => ({ collectedAt: 1_790_000_000_000, collections: { system: 'ok' }, system: { hostName: `os-${tag}`, model: 'PowerEdge R750', manufacturer: 'Dell Inc.', serviceTag: tag },
  idrac: { firmwareVersion: '7.00.00.171' }, firmware: FWL(bios), bios: { version: bios, attributes: { BootMode: 'Uefi', ProcTurboMode: turbo } } });
function reset() {
  bs._resetForTest(); sm._resetForTest(); fleet.resetEdgeFleet(); resetStores();
  for (const f of fs.readdirSync(tmp)) fs.rmSync(path.join(tmp, f), { recursive: true, force: true });
  fs.writeFileSync(path.join(tmp, 'service-map.json'), JSON.stringify({ rev: 0, globals: [], settings: { tagCategory: '' }, corps: {} }));
  fs.writeFileSync(path.join(tmp, 'service-map-pins.json'), JSON.stringify({ rev: 0, pins: {} }));
  const S1 = (id, tag, vc) => ({ id, name: `synth-db-${id}`, host: `https://192.0.2.${10 + Number(id.slice(1))}`, username: 'root', password: 'x', serviceTag: tag, model: 'PowerEdge R750', vcenterId: vc });
  registry.importServers([S1('s1', 'SYNTH01', 'vc-a'), S1('s2', 'SYNTH02', 'vc-a'), S1('s3', 'SYNTH03', 'vc-a'), S1('s4', 'SYNTH04', 'vc-b')], 'replace');
  invCache.setInventory('s1', INV('2.19.1', 'Enabled', 'SYNTH01')); invCache.setInventory('s2', INV('2.21.2', 'Disabled', 'SYNTH02'));
  invCache.setInventory('s3', INV('2.21.2', 'Disabled', 'SYNTH03')); invCache.setInventory('s4', INV('1.0.0', 'Enabled', 'SYNTH04'));
}

test('⑨ 목록 chk · /check — 보증(원장) · 펌웨어(법인 안 다수) · BIOS(폴더에 넣은 뒤) · 범위 밖 404 · 계약 번호는 관리자 판본만', async () => {
  reset();
  S.assetStore.save({ v: 1, at: 7, by: 'admin', rows: { synth01: { tag: 'SYNTH01', end: '2020-01-01', type: 'Basic', contract: 'SYNTH-CONTRACT-1', note: '비고' } } });
  await withSnap(async () => {
    const list = (await call('GET /tools/bm-folders')).body;
    assert.equal(list.ok, true, JSON.stringify(list).slice(0, 300));
    assert.deepEqual(list.check, { soonDays: 90, assets: { n: 1, at: 7, by: 'admin' } });
    const by = (n) => list.servers.find((x) => x.name === n);
    const r1 = by('synth-db-s1'); const r2 = by('synth-db-s2'); const r4 = by('synth-db-s4');
    assert.ok(r1 && r2 && r4, JSON.stringify(list.servers.map((x) => x.name)));
    assert.equal(r1.chk.w, 'expired'); assert.ok(r1.chk.wd < 0); assert.equal(r1.chk.fw, 'behind'); assert.equal(r1.chk.fwn, 1);
    assert.equal(r1.chk.bios, 'unplaced', '폴더에 넣기 전에는 BIOS 를 견주지 않는다');
    assert.deepEqual(r2.chk, { w: 'unknown', fw: 'ok', bios: 'unplaced' }, '원장에 없는 서버는 모름');
    assert.equal(r4.chk.fw, 'none', '다른 법인의 같은 모델은 묶음이 아니다(혼자 — 기준 없음)');
    // 폴더에 넣으면 BIOS 를 견준다
    for (const k of [r1.key, r2.key, by('synth-db-s3').key]) {
      const o = await call('POST /tools/bm-folders/op', { body: { op: 'assign', corp: 'vc-a', path: 'SVC\\DB', keys: [k], createMissing: true } });
      assert.equal(o.body.ok, true, JSON.stringify(o.body));
    }
  });
  await withSnap(async () => {
    const list = (await call('GET /tools/bm-folders')).body;
    const r1 = list.servers.find((x) => x.name === 'synth-db-s1');
    assert.equal(r1.chk.bios, 'diff'); assert.equal(r1.chk.biosn, 1);
    const d = (await call('GET /tools/bm-folders/check', { query: { key: r1.key } })).body;
    assert.equal(d.ok, true, JSON.stringify(d).slice(0, 300));
    assert.equal(d.soonDays, 90); assert.equal(d.model, 'PowerEdge R750'); assert.equal(d.path, 'SVC\\DB'); assert.equal(d.canBaseline, true);
    assert.equal(d.warranty.state, 'expired'); assert.equal(d.warranty.contract, 'SYNTH-CONTRACT-1'); assert.equal(d.warranty.note, '비고');
    assert.equal(d.fw.state, 'behind'); assert.deepEqual(d.fw.rows.find((x) => x.type === 'BIOS'), { key: 'BIOS|bios', type: 'BIOS', label: 'BIOS', installed: '2.19.1', mixed: false, baseline: '2.21.2', basis: 'majority', state: 'behind', peers: 2, known: 3 });
    assert.equal(d.bios.state, 'diff'); assert.deepEqual(d.bios.group, { size: 3, known: 3 });
    assert.deepEqual(d.bios.rows.find((x) => x.k === 'ProcTurboMode'), { k: 'ProcTurboMode', v: 'Enabled', major: 'Disabled', majorN: 2, known: 3, state: 'diff' });
    assert.ok(!JSON.stringify(d).includes('SYNTH01'), '응답에 서비스 태그를 싣지 않는다');
    // 비관리자: 계약 번호 · 비고 없음 · 기준 지정 단추 없음
    const vkey = (await call('GET /tools/bm-folders', { user: VIEWER })).body.servers.find((x) => x.chk?.w === 'expired').key;
    const v = (await call('GET /tools/bm-folders/check', { user: VIEWER, query: { key: vkey } })).body;
    assert.deepEqual([v.warranty.state, v.warranty.contract, v.warranty.note, v.canBaseline], ['expired', '', '', false]);
    assert.ok(!JSON.stringify(v).includes('SYNTH-CONTRACT'));
    assert.equal((await call('GET /tools/bm-folders', { user: VIEWER })).body.check.assets.by, undefined, '올린 사람은 관리자 판본만');
    // 범위 관리자: 자기 법인만 · 밖은 404(존재 은닉) · 판정은 같다(묶음이 법인을 넘지 않는다) · 기준 지정은 전체 범위 관리자만
    const sa = (await call('GET /tools/bm-folders', { user: SCOPED_A })).body;
    assert.equal(sa.servers.length, 3);
    const sk = sa.servers.find((x) => x.chk?.fw === 'behind').key;
    const sd = (await call('GET /tools/bm-folders/check', { user: SCOPED_A, query: { key: sk } })).body;
    assert.deepEqual([sd.fw.state, sd.bios.state, sd.canBaseline], ['behind', 'diff', false]);
    assert.equal((await call('GET /tools/bm-folders/check', { user: SCOPED_B, query: { key: sk } })).statusCode, 404);
    assert.equal((await call('GET /tools/bm-folders/check', { user: SCOPED_B, query: { key: r1.key } })).statusCode, 404, '원문 키로도 범위 밖은 404');
    assert.equal((await call('GET /tools/bm-folders/check', { query: { key: 'st:nope' } })).statusCode, 404);
    assert.equal((await call('GET /tools/bm-folders/check', { query: {} })).statusCode, 404);
  });
  // 관리자 지정 기준 → 목록 · 상세에 반영(응답 캐시 열쇠에 기준 세대가 들어 있다)
  assert.deepEqual(S.setAdminBaseline({ model: 'PowerEdge R750', key: 'BIOS|bios', label: 'BIOS', type: 'BIOS', version: '2.19.1', by: 'admin' }), { ok: true, changed: true });
  await withSnap(async () => {
    const list = (await call('GET /tools/bm-folders')).body;
    const r1 = list.servers.find((x) => x.name === 'synth-db-s1'); const r2 = list.servers.find((x) => x.name === 'synth-db-s2');
    assert.equal(r1.chk.fw, 'ok', '지정 기준과 같다'); assert.equal(r2.chk.fw, 'ok', '기준보다 높은 것은 뒤처짐이 아니다');
    const d = (await call('GET /tools/bm-folders/check', { query: { key: r2.key } })).body;
    assert.deepEqual([d.fw.rows[0].basis, d.fw.rows[0].baseline, d.fw.rows[0].state], ['admin', '2.19.1', 'ahead']);
  });
  reset();
});

test('⑨ 원장을 못 읽으면 보증을 판정하지 않는다(전부 모름이라 하지 않는다) · 목록은 그대로', async () => {
  reset();
  S.assetStore._resetForTest(); fs.writeFileSync(path.join(tmp, 'bm-assets.json'), '{oops');
  const w = console.error; const ww = console.warn; console.error = () => {}; console.warn = () => {};
  try {
    await withSnap(async () => {
      const list = (await call('GET /tools/bm-folders')).body;
      assert.equal(list.ok, true); assert.deepEqual(list.check.assets, { unreadable: true });
      const r1 = list.servers.find((x) => x.name === 'synth-db-s1');
      assert.equal(r1.chk.w, undefined, '보증 키가 없다'); assert.equal(r1.chk.fw, 'behind', '다른 판정은 그대로');
      const d = (await call('GET /tools/bm-folders/check', { query: { key: r1.key } })).body;
      assert.deepEqual([d.warranty, d.assetsUnreadable], [null, true]);
    });
  } finally { console.error = w; console.warn = ww; }
  reset();
});

test('⑨ 관리 라우트 — 게이트(관리자 · 조회 ∧ 쓰기 전체 범위) · 드라이런은 쓰지 않는다 · 커밋 · 바꾸기는 오류가 있으면 멈춘다 · 기준 지정 검증', async () => {
  reset();
  assert.equal(BM_ASSET_GATES.length, 2);
  for (const key of ['GET /bm-assets', 'POST /bm-assets/import', 'GET /bm-fw-baseline', 'POST /bm-fw-baseline', 'GET /bm-assets/sample.csv']) {
    const hs = routes.get(key);
    assert.ok(hs.includes(BM_ASSET_GATES[0]) && hs.includes(BM_ASSET_GATES[1]), `${key} 게이트`);
    assert.ok(hs.indexOf(BM_ASSET_GATES[0]) < hs.length - 1 && hs.indexOf(BM_ASSET_GATES[1]) < hs.length - 1, `${key} 게이트가 처리기 앞`);
  }
  assert.ok(routes.get('GET /bm-assets.csv').includes(BM_ASSET_GATES[1]));
  await withSnap(async () => {
    // 비관리자 · 범위 관리자 · 쓰기 범위만 제한된 관리자는 못 쓴다
    for (const user of [VIEWER, SCOPED_A, WRITE_SCOPED]) {
      const r = await callGated('POST /bm-assets/import', { user, body: { csv: 'service_tag,warranty_end\nSYNTH01,2027-01-01' } });
      assert.equal(r.statusCode, 403, user.username);
    }
    assert.deepEqual(S.assetStore.get().rows, {});
    const csv = 'service_tag,warranty_end,warranty_type\nSYNTH01,2027-03-14,Basic\nSYNTH02,bad-date,x\n';
    const dry = await callGated('POST /bm-assets/import', { body: { csv, dryRun: true } });
    assert.equal(dry.body.ok, true); assert.equal(dry.body.dryRun, true); assert.deepEqual(dry.body.summary, { add: 1, update: 0, same: 0, error: 1, remove: 0 });
    assert.equal(dry.body.report[0].action, 'error', '오류 줄이 먼저 보인다');
    assert.deepEqual(S.assetStore.get().rows, {}, '드라이런은 쓰지 않는다');
    const rep = await callGated('POST /bm-assets/import', { body: { csv, replace: true } });
    assert.equal(rep.statusCode, 400); assert.deepEqual(S.assetStore.get().rows, {}, '바꾸기 + 오류 줄 → 아무것도 쓰지 않는다');
    const ok = await callGated('POST /bm-assets/import', { body: { csv } });
    assert.equal(ok.body.ok, true); assert.equal(ok.body.changed, true);
    assert.deepEqual(Object.keys(S.assetStore.get().rows), ['synth01']); assert.equal(S.assetStore.get().by, 'admin');
    const same = await callGated('POST /bm-assets/import', { body: { csv: 'service_tag,warranty_end,warranty_type\nSYNTH01,2027-03-14,Basic' } });
    assert.equal(same.body.changed, false, '바뀐 것이 없으면 쓰지 않는다');
    assert.equal((await callGated('POST /bm-assets/import', { body: { csv: { a: 1 } } })).statusCode, 400, '글자가 아닌 본문');
    assert.equal((await callGated('POST /bm-assets/import', { body: { csv: 'service_tag\n' } })).statusCode, 400);
    const meta = await callGated('GET /bm-assets');
    assert.equal(meta.body.n, 1); assert.equal(meta.body.by, 'admin');
    // 기준 지정
    const B1 = { model: 'PowerEdge R750', key: 'BIOS|bios', label: 'BIOS', type: 'BIOS', version: '2.22.0' };
    assert.equal((await callGated('POST /bm-fw-baseline', { user: SCOPED_A, body: B1 })).statusCode, 403);
    assert.equal((await callGated('POST /bm-fw-baseline', { body: { ...B1, type: 'Evil' } })).statusCode, 400);
    assert.equal((await callGated('POST /bm-fw-baseline', { body: { ...B1, key: 'NIC|bios' } })).statusCode, 400, '열쇠의 종류와 type 이 다르면 거절');
    assert.equal((await callGated('POST /bm-fw-baseline', { body: { ...B1, version: '2.22 0' } })).statusCode, 400, '공백이 든 버전');
    assert.equal((await callGated('POST /bm-fw-baseline', { body: { ...B1, version: 'v'.repeat(49) } })).statusCode, 400);
    assert.equal((await callGated('POST /bm-fw-baseline', { body: { ...B1, model: '' } })).statusCode, 400);
    assert.equal((await callGated('POST /bm-fw-baseline', { body: { ...B1, version: { a: 1 } } })).statusCode, 400);
    assert.deepEqual((await callGated('POST /bm-fw-baseline', { body: B1 })).body, { ok: true, changed: true });
    assert.deepEqual((await callGated('GET /bm-fw-baseline')).body.rows.map((x) => [x.model, x.key, x.version, x.by]), [['PowerEdge R750', 'BIOS|bios', '2.22.0', 'admin']]);
    assert.deepEqual((await callGated('POST /bm-fw-baseline', { body: { ...B1, version: '' } })).body, { ok: true, changed: true });
    assert.deepEqual((await callGated('GET /bm-fw-baseline')).body.rows, []);
  });
  reset();
});

// ───────── ⑩ 엣지 → 중앙 실제 push(진입 함수를 실제로 부른다 — CLAUDE.md 테스트 규약) ─────────
test('⑩ 엣지 pushFleetNow 가 펌웨어 구성요소 · BIOS 설정을 싣고, 중앙 정제를 거쳐 물리서버 점검 판정에 들어간다(인벤토리 없는 서버는 키가 없다)', async (t) => {
  const http = await import('node:http');
  const zlib = await import('node:zlib');
  const got = [];
  const central = http.createServer((q, r) => {
    const ch = []; q.on('data', (c) => ch.push(c));
    q.on('end', () => {
      let b = Buffer.concat(ch); if ((q.headers['content-encoding'] || '') === 'gzip') b = zlib.gunzipSync(b);
      let body = null; try { body = JSON.parse(b.toString('utf8') || 'null'); } catch { body = null; }
      got.push({ path: q.url.split('?')[0], body });
      r.writeHead(200, { 'content-type': 'application/json' }); r.end(JSON.stringify({ ok: true, accepted: Array.isArray(body?.baremetal) ? body.baremetal.length : 0 }));
    });
  });
  await new Promise((ok) => central.listen(0, '127.0.0.1', ok));
  const { config } = await import('../src/config.js');
  const prev = { url: config.agent.centralUrl, tok: config.agent.centralToken, name: config.agent.name, ctok: config.central.token };
  t.after(() => { central.close(); Object.assign(config.agent, { centralUrl: prev.url, centralToken: prev.tok, name: prev.name }); config.central.token = prev.ctok; });
  reset();
  invCache.setInventory('s3', null);   // 인벤토리를 아직 못 읽은 서버
  config.agent.centralUrl = `http://127.0.0.1:${central.address().port}`; config.agent.centralToken = 'synth-edge-token'; config.agent.name = 'synth-edge';
  const fp = await import('../src/agent/fleetPush.js');
  fp._setFleetWithholdSinceForTest(null, null);
  const w = console.warn; const l = console.log; console.warn = () => {}; console.log = () => {};
  let r;
  try { r = await withSnap(() => fp.pushFleetNow()); } finally { console.warn = w; console.log = l; }
  assert.equal(r?.ok, true, JSON.stringify(r));
  const f = got.find((g) => g.path === '/api/central/fleet');
  assert.ok(f, '목 중앙에 도착');
  const b1 = f.body.baremetal.find((x) => x.serviceTag === 'SYNTH01'); const b3 = f.body.baremetal.find((x) => x.serviceTag === 'SYNTH03');
  assert.ok(b1 && b3, JSON.stringify(f.body.baremetal.map((x) => x.serviceTag)));
  assert.deepEqual(b1.fw, { c: [{ t: 'BIOS', n: 'BIOS', v: '2.19.1' }, { t: 'iDRAC', n: 'Integrated Dell Remote Access Controller', v: '7.00.00.171' }, { t: 'NIC', n: 'Synth X710', v: '22.5.7' }], s: 2 });
  assert.deepEqual(b1.bios, { BootMode: 'Uefi', ProcTurboMode: 'Enabled' });
  assert.ok(!('fw' in b3) && !('bios' in b3), '인벤토리가 없으면 키를 만들지 않는다(없음으로 올리지 않는다)');
  assert.ok(!JSON.stringify(b1.fw).includes('24:6E'), 'MAC 은 싣지 않는다');
  // 중앙 쪽: 같은 본문을 받아 판정까지
  config.agent.centralUrl = prev.url; config.central.token = 'synth-central-token';
  fleet.resetEdgeFleet();
  fleet.setEdgeFleet('synth-edge', f.body.baremetal.map((x) => ({ ...x, vcenterId: 'vc-a' })), 'g1', { vcAllowed: () => true });
  const servers = fleet.getEdgeFleetServers();
  const s1 = servers.find((x) => x.serviceTag === 'SYNTH01'); const s3 = servers.find((x) => x.serviceTag === 'SYNTH03');
  assert.deepEqual(s1.fw, F.fwComponentsOf(FWL('2.19.1'))); assert.deepEqual(s1.bios, { BootMode: 'Uefi', ProcTurboMode: 'Enabled' });
  assert.deepEqual([s3.fw, s3.bios], [undefined, undefined]);
  const members = servers.filter((x) => ['SYNTH01', 'SYNTH02', 'SYNTH03'].includes(x.serviceTag)).map((x) => ({ key: `st:${x.serviceTag}`, kind: 'bm', corp: 'vc-a', model: x.model || 'PowerEdge R750', serviceTag: x.serviceTag, _e: x }));
  const chk = ST.bmCheckFor({ members, placeOf: new Map(members.map((m) => [m.key, { path: 'SVC', src: 'manual' }])), hxOf: (m) => ({ inv: null, via: 'edge', fw: m._e.fw, bios: m._e.bios }), assets: {}, adminBase: null, today: todayStamp() });
  const of = (tag) => chk.ofMember(members.find((m) => m.serviceTag === tag));
  assert.equal(of('SYNTH01').fw.state, 'ok', '읽은 서버가 둘(2.19.1 · 2.21.2)이면 동률 — 기준 없음이지만 같은 구성요소는 같다'); assert.equal(of('SYNTH01').fw.rows.find((x) => x.type === 'BIOS').state, 'none');
  assert.deepEqual([of('SYNTH03').fw.state, of('SYNTH03').bios.state], ['unsent', 'unsent'], '보내지 않은 서버는 같음에도 다름에도 없다');
  fleet.resetEdgeFleet(); reset();
});
