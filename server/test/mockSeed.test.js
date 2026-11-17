import { test, before, after } from 'node:test';
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

// 목업 시더는 DATA_SOURCE=mock에서만 동작 — import 전에 env 설정.
process.env.DATA_SOURCE = 'mock';
process.env.CONFIG_DIR = tmpDir('mockseed-');
process.env.IDRAC_DB_DIR = process.env.CONFIG_DIR;

let seed, store, idracReg, pingStore;
before(async () => {
  seed = await import('../src/mock/seed.js');
  ({ store } = await import('../src/store.js'));
  idracReg = await import('../src/idrac/registry.js');
  pingStore = await import('../src/ping/store.js');
  await store.refresh({ force: true }).catch(() => {});
});

test('isMockMode: DATA_SOURCE=mock이면 true', () => {
  assert.equal(seed.isMockMode(), true);
});

test('mockIdracPollTick: Dell 호스트를 iDRAC로 시드 + 전력 샘플 적재', async () => {
  const snap = store.get();
  assert.ok(snap.hosts.length > 0, '스냅샷 호스트 존재');
  const r = await seed.mockIdracPollTick(snap);
  assert.ok(r && r.measured > 0, '전력 샘플 적재됨');
  const reg = idracReg.loadRegistry();
  assert.ok(reg.length > 0, 'iDRAC 레지스트리 시드됨');
  // 모든 시드 서버는 스냅샷 호스트 이름과 vcenterId를 가진다(전력 귀속용).
  assert.ok(reg.every((s) => s.name && s.vcenterId), '이름/vcenterId 보유');
  assert.ok(reg.every((s) => s.id.startsWith('mock-idrac-')), 'mock 접두사로 식별 가능');
});

test('mockPingPollTick: vCenter 도달+포트 대상 시드 + RTT 적재', async () => {
  const snap = store.get();
  const r = await seed.mockPingPollTick(snap);
  assert.ok(r && r.measured > 0, 'RTT 샘플 적재됨');
  const vc = pingStore.listTargets('vcenter');
  const vcp = pingStore.listTargets('vcport');
  assert.ok(vc.length > 0, 'vCenter 도달 대상 시드');
  assert.ok(vcp.length > 0, 'vCenter 포트 대상 시드');
});
