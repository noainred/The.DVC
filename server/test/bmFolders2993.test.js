/**
 * v2.995 묶음 C(설계 docs/design/bm-folders §14 결정 1-(가)) — 폴더 등록 저장 키 자동 변경(fl: → st:) · '태그 없음' 표지.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-bmf2993-'));
const B = await import('../src/bmfolders/build.js');
const { scheduleKeyMigration } = await import('../src/routes/api/bmFolders.js');

const FL = 'fl:0123456789abcdef'; const FL2 = 'fl:fedcba9876543210';
const reg = (corp, p = 'DB\\Oracle') => ({ corp, path: p, name: 'db01', by: 'u', at: 1 });
const main = { rev: 1, corps: { vc1: { folders: ['DB', 'DB\\Oracle'] } }, rules: [], settings: { autoRules: false } };

test('후보 — 태그를 읽어 st: 로 오른 서버가 같은 법인 별칭 등록을 쓸 때만(fl: 지금 키 · 다른 법인 · 가드 밖은 아님)', () => {
  const members = [
    { key: 'st:TAG1', keyKind: 'serviceTag', kind: 'bm', corp: 'vc1', name: 'db01', aliasKeys: [FL, FL2] },
    { key: 'fl:1111111111111111', keyKind: 'fleetId', kind: 'bm', corp: 'vc1', name: 'db02', aliasKeys: ['fl:2222222222222222'] },
  ];
  const assign = { [FL]: reg('vc1'), [FL2]: reg('vc1', 'DB'), 'fl:2222222222222222': reg('vc1') };
  const b = B.buildFolders({ members, main, assign });
  assert.equal(b.placeOf.get('st:TAG1').path, 'DB\\Oracle');
  assert.deepEqual(b.migrate, [{ from: FL, to: 'st:TAG1', corp: 'vc1', drop: [FL2] }], 'fl: 지금 키 서버는 옮기지 않는다(태그를 읽은 것이 아니다)');
  // 다른 법인 별칭 · 둘이 주장하는 별칭은 후보가 아니다
  const b2 = B.buildFolders({ members: [{ ...members[0], corp: 'vc2' }], main, assign: { [FL]: reg('vc1') } });
  assert.deepEqual(b2.migrate, []);
  const b3 = B.buildFolders({ members: [members[0], { key: 'st:TAG9', keyKind: 'serviceTag', kind: 'bm', corp: 'vc1', name: 'x', aliasKeys: [FL] }], main, assign: { [FL]: reg('vc1') } });
  assert.deepEqual(b3.migrate, []);
});

test('적용 — 다시 확인하고 옮긴다(위치 · 이름 · 등록자 그대로) · 그사이 지금 키에 등록이 생겼거나 별칭이 바뀌었으면 건드리지 않는다', () => {
  const list = [{ from: FL, to: 'st:TAG1', corp: 'vc1', drop: [FL2] }];
  const a1 = { [FL]: reg('vc1'), [FL2]: reg('vc1', 'DB') };
  assert.equal(B.keyMigrationPending(a1, list), true);
  assert.equal(B.applyKeyMigration(a1, list), 1);
  assert.deepEqual(a1, { 'st:TAG1': reg('vc1') });
  const a2 = { [FL]: reg('vc1'), 'st:TAG1': reg('vc1', 'DB') };
  assert.equal(B.keyMigrationPending(a2, list), false);
  assert.equal(B.applyKeyMigration(a2, list), 0);
  assert.equal(a2[FL].path, 'DB\\Oracle', '지금 키 등록이 있으면 별칭 등록도 지우지 않는다(목록에 없는 등록으로 남아 사람이 정리)');
  const a3 = { [FL]: reg('vc9') };
  assert.equal(B.applyKeyMigration(a3, list), 0, '법인이 바뀐 별칭은 옮기지 않는다');
  const a4 = { [FL]: reg('vc1'), [FL2]: reg('vc2') };
  B.applyKeyMigration(a4, list);
  assert.ok(a4[FL2], '다른 법인의 별칭 등록은 지우지 않는다');
});

test('예약 — 옮길 것이 없으면 쓰지 않고 · 저장소 손상이면 쓰지 않고 · 겹쳐 돌지 않고 · 감사는 system', () => {
  const list = [{ from: FL, to: 'st:TAG1', corp: 'vc1', drop: [] }];
  const calls = []; const audits = []; let deferred = null;
  const deps = (o = {}) => ({ peek: () => ({ [FL]: reg('vc1') }), mutate: (fn) => { const d = { assign: { [FL]: reg('vc1') } }; const r = fn(d); calls.push(d.assign); return { ok: true, result: r.result }; }, audit: (x) => audits.push(x), defer: (f) => { deferred = f; }, loadErr: () => null, ...o });
  assert.equal(scheduleKeyMigration([], deps()), false);
  assert.equal(scheduleKeyMigration(list, deps({ peek: () => ({}) })), false, '옮길 것 없음 — 세대를 올리지 않는다');
  assert.equal(scheduleKeyMigration(list, deps({ loadErr: () => ({ main: 'x' }) })), false, '손상이면 쓰지 않는다');
  assert.equal(scheduleKeyMigration(list, deps()), true);
  assert.equal(scheduleKeyMigration(list, deps()), false, '진행 중이면 겹쳐 예약하지 않는다');
  deferred();
  assert.deepEqual(calls[0], { 'st:TAG1': reg('vc1') });
  assert.equal(audits[0].user, 'system');
  assert.equal(scheduleKeyMigration(list, deps()), true, '끝나면 다시 예약할 수 있다');
  deferred();
});

test('실제 구성원 키 종류 값(svcInventory bmKeyOf)으로 — keyKind 는 serviceTag · fleetId 다(st · fl 로 비교하면 한 번도 맞지 않는다)', async () => {
  const { bmKeyOf } = await import('../src/routes/api/svcInventory.js');
  const tagged = bmKeyOf({ serviceTag: 'ABC1234' }); const untagged = bmKeyOf({ fleetId: 'x' });
  assert.equal(tagged.keyKind, 'serviceTag'); assert.equal(untagged.keyKind, 'fleetId');
  const members = [{ ...tagged, kind: 'bm', corp: 'vc1', name: 'db01', aliasKeys: [untagged.key] }];
  const b = B.buildFolders({ members, main, assign: { [untagged.key]: reg('vc1') } });
  assert.deepEqual(b.migrate.map((x) => [x.from, x.to]), [[untagged.key, tagged.key]]);
});

test('응답 — 임시 키 표지(tmpKey)와 예약 호출이 메인 응답에 있다(소스)', () => {
  const src = fs.readFileSync(new URL('../src/routes/api/bmFolders.js', import.meta.url), 'utf8');
  assert.match(src, /tmpKey: String\(m\.key\)\.startsWith\('fl:'\) \? true : undefined/);
  assert.match(src, /scheduleKeyMigration\(b\.migrate\);/);
});
