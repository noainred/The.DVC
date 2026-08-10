/**
 * 트리 드래그&드롭 이동 백엔드 — moveFolder(reparent) + updateTarget 경로 이동 회귀 방지.
 *  - 폴더 이동 시 하위 폴더·대상의 경로 프리픽스를 함께 스왑.
 *  - 순환(자기 하위) 금지, 대상 위치 동명 폴더 충돌 거부, 10단계 초과 전부 거부(부분 이동 금지).
 *  - 대상 이동은 updateTarget({path}) 부분 업데이트로 이름/호스트 보존.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'svcmon-move-'));
process.env.SVCMON_WORKERS = '0';

const store = await import('../src/svcmon/store.js');

const folderPaths = (kind) => store.listFolders().filter((f) => f.kind === kind).map((f) => f.path).sort();

test('폴더 이동: 하위 폴더·대상의 경로 프리픽스가 함께 바뀐다', () => {
  store.addFolder({ kind: 'infra', path: 't1src' });
  store.addFolder({ kind: 'infra', path: 't1src\\sub' });
  const tgt = store.addTarget({ kind: 'infra', path: 't1src\\sub', name: 't1-h1', host: '10.0.1.1' });
  store.addFolder({ kind: 'infra', path: 't1dst' });

  const r = store.moveFolder({ kind: 'infra', path: 't1src', newParent: 't1dst' });
  assert.equal(r.path, 't1dst\\t1src');
  assert.ok(r.moved >= 3, '폴더 2 + 대상 1 이동');
  const fp = folderPaths('infra');
  assert.ok(fp.includes('t1dst\\t1src') && fp.includes('t1dst\\t1src\\sub'), '폴더 경로 스왑');
  assert.ok(!fp.includes('t1src') && !fp.includes('t1src\\sub'), '원래 경로는 사라짐');
  assert.equal(store.getTarget(tgt.id).path, 't1dst\\t1src\\sub', '대상 경로도 스왑');
});

test('순환 금지: 폴더를 자기 자신의 하위로 옮길 수 없다', () => {
  store.addFolder({ kind: 'infra', path: 't2' });
  store.addFolder({ kind: 'infra', path: 't2\\child' });
  assert.throws(() => store.moveFolder({ kind: 'infra', path: 't2', newParent: 't2\\child' }), /자기 자신/);
});

test('루트로 이동: newParent="" 이면 최상위가 된다', () => {
  store.addFolder({ kind: 'infra', path: 't3par' });
  store.addFolder({ kind: 'infra', path: 't3par\\leaf' });
  const r = store.moveFolder({ kind: 'infra', path: 't3par\\leaf', newParent: '' });
  assert.equal(r.path, 'leaf');
  assert.ok(folderPaths('infra').includes('leaf'));
});

test('충돌: 대상 위치에 같은 이름의 폴더가 있으면 거부', () => {
  store.addFolder({ kind: 'infra', path: 't4a' });      // 옮길 폴더(leaf=t4a)
  store.addFolder({ kind: 'infra', path: 't4box' });
  store.addFolder({ kind: 'infra', path: 't4box\\t4a' }); // 대상 위치에 이미 t4a 존재
  assert.throws(() => store.moveFolder({ kind: 'infra', path: 't4a', newParent: 't4box' }), /이미 있/);
});

test('제자리(현재 부모) 이동은 no-op', () => {
  store.addFolder({ kind: 'infra', path: 't5' });
  store.addFolder({ kind: 'infra', path: 't5\\k' });
  const r = store.moveFolder({ kind: 'infra', path: 't5\\k', newParent: 't5' });
  assert.equal(r.moved, 0, '같은 부모로 옮기면 아무 것도 바뀌지 않는다');
});

test('깊이 초과: 이동 후 10단계를 넘으면 전부 거부(부분 이동 금지)', () => {
  store.addFolder({ kind: 'infra', path: 'a\\b\\c\\d\\e\\f\\g\\h\\i' });  // 9단계
  store.addFolder({ kind: 'infra', path: 'z\\y' });                       // 2단계
  // 'a' 를 'z\\y' 아래로 옮기면 가장 깊은 경로가 z\\y\\a\\b..\\i = 11단계 → 거부.
  assert.throws(() => store.moveFolder({ kind: 'infra', path: 'a', newParent: 'z\\y' }), /10단계/);
  // 거부됐으니 원래 경로가 그대로 남아 있어야 한다(부분 이동 없음).
  assert.ok(folderPaths('infra').includes('a\\b\\c\\d\\e\\f\\g\\h\\i'), '실패 시 원본 보존');
});

test('대상 이동: updateTarget({path}) 가 이름/호스트를 보존하며 경로만 바꾼다', () => {
  store.addFolder({ kind: 'infra', path: 't7from' });
  store.addFolder({ kind: 'infra', path: 't7to' });
  const t = store.addTarget({ kind: 'infra', path: 't7from', name: 't7-h', host: '10.0.7.1' });
  const up = store.updateTarget(t.id, { path: 't7to' });
  assert.equal(up.path, 't7to');
  assert.equal(up.name, 't7-h', '이름 보존');
  assert.equal(up.host, '10.0.7.1', '호스트 보존');
});
