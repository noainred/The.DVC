/**
 * test/bareosRegistryDirty2871.test.js — v2.871 감사 A2-09: 묶음 저장(inBatch)의 디스크 쓰기가 실패하면 '미저장' 표지를 남겨 다음 묶음 끝에 다시 쓴다.
 *   예전(코드 판독 — restoreFinish.js 주석 '다음 틱에 다시 — 원장은 그대로' 와 달랐다): inBatch 가 writeNow **앞에서** _dirty=false 로 내려,
 *   쓰기가 실패하면 이미 바뀐 메모리 원장(복원 마무리의 pending + opId — vmclone 작업은 이미 나감)이 다음 원장 변경 때까지 디스크에 다시 쓰이지 않았다.
 *   재현: 원장 파일 자리를 디렉터리로 바꿔 rename 을 실패시킨다(root 로 돌아도 막힌다 — chmod 는 root 에게 효과가 없다).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bareosdirty-'));
process.env.CONFIG_DIR = tmp;
process.env.DATA_SOURCE = 'mock';
const FILE = path.join(tmp, 'bareos-jobs.json');
const job = { id: 'j1', vcenterId: 'vc-a', vmId: 'vc-a:vm-1', vmName: 'db-01', directorId: 'dir_kr', bareosJob: 'vm-j1', client: 'kr-fd', storage: 's', pool: 'p', level: 'Incremental', enabled: true, restores: [] };
fs.writeFileSync(FILE, JSON.stringify({ version: 1, retired: [], jobs: [job] }));
const REG = await import('../src/bareos/registry.js');
after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

const onDisk = () => JSON.parse(fs.readFileSync(FILE, 'utf8')).jobs.find((j) => j.id === 'j1');

test('A2-09 — 묶음 쓰기가 실패하면 미저장 표지가 남고 다음 inBatch 끝(변경이 없어도)에서 같은 메모리 원장을 다시 쓴다', () => {
  assert.equal(REG.jobDigests().length, 1, '전제: 원장을 읽었다');
  // 디스크 쓰기 실패 상태로
  fs.rmSync(FILE);
  fs.mkdirSync(FILE);
  fs.writeFileSync(path.join(FILE, 'x'), 'x');
  assert.throws(() => REG.inBatch(() => { REG.patchJob('j1', { lastError: { at: 1, message: '표지-1' } }); }), '묶음 끝 쓰기가 실패하면 던진다(호출부가 받는다 — 예전 그대로)');
  assert.equal(REG.jobDigests()[0].lastError?.message, '표지-1', '메모리 원장은 이미 바뀌었다');
  assert.equal(REG._dirtyForTest(), true, '쓰기에 실패했으니 미저장 표지가 남는다(예전에는 쓰기 전에 내려 다시 쓰지 않았다)');
  // 디스크가 돌아오면 — 변경이 없는 다음 묶음(다음 틱) 끝에서 다시 쓴다
  fs.rmSync(FILE, { recursive: true, force: true });
  REG.inBatch(() => {});
  assert.equal(REG._dirtyForTest(), false);
  assert.equal(onDisk().lastError?.message, '표지-1', '메모리 변경이 디스크에 들어갔다');
  // 정상 경로: 묶음 밖 쓰기도 성공하면 표지가 내려간다
  REG.patchJob('j1', { lastError: { at: 2, message: '표지-2' } });
  assert.equal(REG._dirtyForTest(), false);
  assert.equal(onDisk().lastError?.message, '표지-2');
});

test('A2-09 — 묶음 쓰기 실패 뒤 묶음 밖 단건 쓰기가 성공하면 그 쓰기가 앞의 미저장 변경까지 함께 싣고 표지를 내린다', () => {
  fs.rmSync(FILE);
  fs.mkdirSync(FILE);
  fs.writeFileSync(path.join(FILE, 'x'), 'x');
  assert.throws(() => REG.inBatch(() => { REG.patchJob('j1', { schedule: 'sched-a' }); }));
  assert.equal(REG._dirtyForTest(), true);
  fs.rmSync(FILE, { recursive: true, force: true });
  REG.patchJob('j1', { lastError: { at: 3, message: '표지-3' } });
  assert.equal(REG._dirtyForTest(), false);
  const d = onDisk();
  assert.equal(d.schedule, 'sched-a', '앞 묶음의 메모리 변경도 디스크에');
  assert.equal(d.lastError?.message, '표지-3');
});

test('묶음 밖 단건 쓰기 실패는 예전 계약 그대로 — 메모리를 되돌리고 미저장 표지를 올리지 않는다', () => {
  fs.rmSync(FILE);
  fs.mkdirSync(FILE);
  fs.writeFileSync(path.join(FILE, 'x'), 'x');
  try {
    assert.throws(() => REG.patchJob('j1', { lastError: { at: 4, message: '표지-4' } }));
    assert.equal(REG.jobDigests()[0].lastError?.message, '표지-3', '메모리를 되돌렸다(v2.847 D2-7)');
    assert.equal(REG._dirtyForTest(), false);
  } finally { fs.rmSync(FILE, { recursive: true, force: true }); }
});
