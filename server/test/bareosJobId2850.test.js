/**
 * test/bareosJobId2850.test.js — v2.850 백업 대상 원장 id 충돌(릴리스 단위 테스트 bareosBugs2846a E-1 이 간헐로 [200, 200, 49] — 재현).
 *  id 가 `bj_<밀리초><무작위 3바이트>` 라 같은 밀리초 일괄 등록에서 겹칠 수 있었고, 겹친 뒤 항목은 id 로 찾을 수 없었다
 *  (다시 등록은 같은 id 의 두 번째 잡 잠금에 실패해 한 건을 빼고 보냈다).
 *  ① 새 id — 시각 · 무작위 값이 같아도 원장에 없는 id 만 준다 · 각 항목을 id 로 찾고 지울 수 있다
 *  ② 이미 겹친 원장 — 읽을 때 뒤 항목에 결정적 id(<원래>d<n>) · 재시작해도 같다 · 이미 있는 id 와도 겹치지 않는다 · 파일은 읽기만으로 바꾸지 않는다
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bareosjobid2850-'));
process.env.CONFIG_DIR = tmp;
process.env.DATA_SOURCE = 'mock';
const REG = await import('../src/bareos/registry.js');
after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

const row = (i) => ({ vcenterId: 'vc-a', vmId: `vc-a:vm-${i}`, vmName: `vm${i}`, dc: 'DC', folder: '/', directorId: 'dir_default', bareosJob: `pv-${i}`, client: 'c', storage: 's', pool: 'p', level: 'Incremental', createdBy: 'adm' });

test('① 새 id — 같은 밀리초 · 같은 무작위 값이어도 겹치지 않는다', () => {
  REG._resetForTest();
  const rb = crypto.randomBytes; const now = Date.now;
  crypto.randomBytes = (n) => Buffer.alloc(n, 7);   // 최악: 무작위 값이 매번 같다
  Date.now = () => 1_793_587_000_000;
  let out;
  try { out = REG.addJobs([row(1), row(2), row(3)]); } finally { crypto.randomBytes = rb; Date.now = now; }
  assert.ok(out.every((o) => o.ok));
  const ids = out.map((o) => o.job.id);
  assert.equal(new Set(ids).size, 3, `id 가 겹쳤다: ${ids.join(',')}`);
  for (const [i, id] of ids.entries()) assert.equal(REG.getJob(id).vmId, `vc-a:vm-${i + 1}`, '각 항목을 id 로 찾는다');
  REG.deleteJob(ids[1]);
  assert.deepEqual(REG.listJobs().map((j) => j.vmId).sort(), ['vc-a:vm-1', 'vc-a:vm-3'], '지우면 그 항목만');
  for (const id of [ids[0], ids[2]]) REG.deleteJob(id);
  // 평소 id 는 무작위 6바이트(12자리)
  const one = REG.addJobs([row(9)])[0].job.id;
  assert.match(one, /^bj_[0-9a-z]+[0-9a-f]{12}$/);
  REG.deleteJob(one);
});

test('② 이미 겹친 원장 — 읽을 때 뒤 항목에 결정적 id · 재시작해도 같다 · 파일은 그대로', () => {
  const file = path.join(tmp, REG.FILE_NAME);
  const jobs = [{ ...row(1), id: 'bj_x' }, { ...row(2), id: 'bj_x' }, { ...row(3), id: 'bj_xd1' }, { ...row(4), id: 'bj_x' }];
  const raw = JSON.stringify({ jobs, retired: [] });
  fs.writeFileSync(file, raw);
  REG._resetForTest();
  const a = REG.listJobs().map((j) => [j.vmId, j.id]);
  assert.deepEqual(a, [['vc-a:vm-1', 'bj_x'], ['vc-a:vm-2', 'bj_xd2'], ['vc-a:vm-3', 'bj_xd1'], ['vc-a:vm-4', 'bj_xd3']], '앞 항목은 그대로 · 뒤 항목은 이미 있는 id 를 피해 붙인다');
  assert.equal(REG.getJob('bj_xd2').vmId, 'vc-a:vm-2', '겹쳤던 항목도 id 로 찾는다');
  assert.equal(fs.readFileSync(file, 'utf8'), raw, '읽기만으로 파일을 쓰지 않는다');
  REG._resetForTest();
  assert.deepEqual(REG.listJobs().map((j) => [j.vmId, j.id]), a, '재시작해도 같은 id');
  assert.equal(REG.dedupeJobIds([{ id: 'a' }, { id: 'b' }]), 0);
});
