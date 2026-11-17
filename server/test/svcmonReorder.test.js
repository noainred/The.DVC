/**
 * 트리 순서 재정렬 백엔드 — reorderTargets / reorderFolders 회귀 방지.
 *  - 지정한 폴더/부모 안의 형제에만 order=0..n 을 부여하고, 다른 폴더는 건드리지 않는다.
 *  - buildTree(프론트) 수동 정렬이 이 order 를 읽어 표시 순서를 정한다.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// v3.18.8: 이 파일이 만든 임시 폴더는 시험이 끝나면 지운다(지우지 않아 전량 실행마다 /tmp 에 쌓였다 — tmpCleanup3188 이 고정).
//   exit 에서 한 번 더 지운다 — 모듈의 종료 flush(util/exitFlush.js)가 뒤늦게 다시 만든 폴더(수 MB 실측)까지.
const TMP_DIRS = [];
const tmpDir = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); TMP_DIRS.push(d); return d; };
const rmTmpDirs = () => { for (const d of TMP_DIRS) fs.rmSync(d, { recursive: true, force: true }); };
after(() => { rmTmpDirs(); process.once('exit', () => { try { rmTmpDirs(); } catch { /* 종료 중 */ } }); });

process.env.CONFIG_DIR = tmpDir('svcmon-reorder-');
process.env.SVCMON_WORKERS = '0';

const store = await import('../src/svcmon/store.js');

const orderOf = (id) => store.getTarget(id).order;
const folderOrder = (p) => store.listFolders().find((f) => f.path === p)?.order;

test('reorderTargets: 폴더 안 대상에 지정 순서대로 order 0..n 을 부여', () => {
  store.addFolder({ kind: 'infra', path: 'RF' });
  const a = store.addTarget({ kind: 'infra', path: 'RF', name: 'ra', host: '10.5.0.1' });
  const b = store.addTarget({ kind: 'infra', path: 'RF', name: 'rb', host: '10.5.0.2' });
  const c = store.addTarget({ kind: 'infra', path: 'RF', name: 'rc', host: '10.5.0.3' });
  const r = store.reorderTargets({ kind: 'infra', path: 'RF', ids: [c.id, a.id, b.id] });
  assert.equal(r.reordered, 3);
  assert.equal(orderOf(c.id), 0);
  assert.equal(orderOf(a.id), 1);
  assert.equal(orderOf(b.id), 2);
});

test('reorderTargets: 다른 폴더 대상은 건드리지 않고, 그 폴더 밖 id 는 무시', () => {
  store.addFolder({ kind: 'infra', path: 'RG' });
  const other = store.addTarget({ kind: 'infra', path: 'RG', name: 'rg-x', host: '10.5.1.1' });
  const before = orderOf(other.id);
  const inRf = store.listTargets().filter((t) => t.path === 'RF').map((t) => t.id);
  // RG 대상 id 를 RF 재정렬에 섞어도 무시되고, RG 대상 order 는 그대로.
  const r = store.reorderTargets({ kind: 'infra', path: 'RF', ids: [other.id, ...inRf] });
  assert.equal(r.reordered, inRf.length, 'RF 안 대상만 반영(RG id 무시)');
  assert.equal(orderOf(other.id), before, 'RG 대상 order 불변');
});

test('reorderFolders: 같은 부모 형제 폴더에 order 0..n 부여', () => {
  store.addFolder({ kind: 'infra', path: 'P' });
  store.addFolder({ kind: 'infra', path: 'P\\x' });
  store.addFolder({ kind: 'infra', path: 'P\\y' });
  store.addFolder({ kind: 'infra', path: 'P\\z' });
  const r = store.reorderFolders({ kind: 'infra', parent: 'P', paths: ['P\\z', 'P\\x', 'P\\y'] });
  assert.equal(r.reordered, 3);
  assert.equal(folderOrder('P\\z'), 0);
  assert.equal(folderOrder('P\\x'), 1);
  assert.equal(folderOrder('P\\y'), 2);
});

test('reorderFolders: 다른 부모의 폴더는 건드리지 않는다', () => {
  store.addFolder({ kind: 'infra', path: 'Q' });
  store.addFolder({ kind: 'infra', path: 'Q\\x' });
  store.reorderFolders({ kind: 'infra', parent: 'P', paths: ['Q\\x', 'P\\x'] });   // Q\\x 는 부모가 P 아님
  assert.equal(folderOrder('Q\\x'), undefined, 'Q\\x 는 order 부여 대상 아님');
});

test('최상위(부모="") 폴더도 재정렬된다', () => {
  store.addFolder({ kind: 'infra', path: 'TOP1' });
  store.addFolder({ kind: 'infra', path: 'TOP2' });
  const r = store.reorderFolders({ kind: 'infra', parent: '', paths: ['TOP2', 'TOP1'] });
  assert.ok(r.reordered >= 2);
  assert.ok(folderOrder('TOP2') < folderOrder('TOP1'), 'TOP2 가 TOP1 보다 앞');
});
