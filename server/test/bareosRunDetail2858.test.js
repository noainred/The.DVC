/**
 * test/bareosRunDetail2858.test.js — v2.858 실행 중 작업 상세(사용자 승인 시안 — 진행 현황 행 펼침 · 실행 현황 · 이력 표).
 *  ① 지난 같은 레벨 실행(prevSameLevel): 성공(T·W) · 같은 레벨 · 바이트를 아는 것 중 jobid 가 가장 큰 것 · 지금 실행 · 실패 · 바이트 모름(null — 0 이 아니다)은 뺀다
 *  ② 진행 행(runningRow)이 상세에 필요한 값(id · Client · Pool · Storage · prev)을 싣는다
 *  ③ 원장 finishedRuns 가 바이트 · 시작 시각을 남긴다(실행 중이면 lastRun 이 그 실행이라 끝난 값은 여기에만 있다)
 *  ④ 데모 실행 길이(env BAREOS_DEMO_RUN_MS) — 기본 30초 · 범위 밖 · 숫자 아님은 기본값
 *  ⑤ 진행 현황 응답에 relayLimits(엣지 대행 Director 로그 시한 — 화면이 숫자를 박지 않게)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bareos2858-'));
const { prevSameLevel, levelKey, runningRow } = await import('../src/routes/api/bareosLive.js');

test('① 지난 같은 레벨 실행 — 성공 · 같은 레벨 · 바이트 아는 것 중 가장 새 것', () => {
  assert.equal(levelKey('Incremental'), 'I'); assert.equal(levelKey('F'), 'F'); assert.equal(levelKey(''), ''); assert.equal(levelKey('x'), '');
  const j = {
    lastRun: { jobid: 30, status: 'R', state: 'running', level: 'I', bytes: null },   // 지금 실행
    recentRuns: [
      { jobid: 10, status: 'T', level: 'I', bytes: 5_000, startedAt: 1, endedAt: 2 },
      { jobid: 18, status: 'W', level: 'I', bytes: 14_000, startedAt: 3, endedAt: 9 },
      { jobid: 20, status: 'f', level: 'I', bytes: 99_000 },   // 실패는 기준이 아니다
      { jobid: 21, status: 'T', level: 'F', bytes: 400_000 },  // 다른 레벨
      { jobid: 22, status: 'T', level: 'I', bytes: null },     // 바이트 모름(v2.858 이전 항목)
      { jobid: 23, status: 'T', level: 'I', bytes: 0 },        // 0 은 기준으로 쓰지 않는다
    ],
  };
  const p = prevSameLevel(j, 'Incremental', 30);
  assert.deepEqual(p, { jobid: 18, level: 'I', status: 'W', bytes: 14_000, startedAt: 3, endedAt: 9 });
  assert.equal(prevSameLevel(j, 'F', 30).jobid, 21);
  assert.equal(prevSameLevel(j, 'D', 30), null, '같은 레벨이 없으면 null');
  assert.equal(prevSameLevel(j, '', 30), null, '레벨을 모르면 null(지어내지 않는다)');
  // 끝난 lastRun 도 후보 — 단 지금 실행 jobid 는 빼고
  const k = { lastRun: { jobid: 40, status: 'T', level: 'I', bytes: 7_000 }, recentRuns: [] };
  assert.equal(prevSameLevel(k, 'I', 41).jobid, 40);
  assert.equal(prevSameLevel(k, 'I', 40), null, '지금 실행 자신은 기준이 아니다');
});

test('② 진행 행이 상세에 필요한 값을 싣는다(id · Client · Pool · Storage · prev)', () => {
  const j = { id: 'bj_9', vmId: 'vc:vm-9', vmName: 'web', client: 'kr-fd', pool: 'PortalVmwareIncr', storage: 'File1', recentRuns: [{ jobid: 5, status: 'T', level: 'I', bytes: 1_000 }] };
  const r = runningRow(j, { jobid: 9, state: 'running', level: 'I', since: Date.now() - 60_000 }, { jobid: 9, bytes: 500, files: 2, aveRate: 10, lastRate: 12 }, true);
  assert.equal(r.id, 'bj_9');
  assert.deepEqual([r.client, r.pool, r.storage], ['kr-fd', 'PortalVmwareIncr', 'File1']);
  assert.equal(r.prev.jobid, 5);
  assert.equal(r.bytes, 500);
  const r2 = runningRow({ ...j, recentRuns: [] }, { jobid: 9, state: 'running', level: 'I' }, null, true);
  assert.equal(r2.prev, null);
  assert.equal(r2.bytes, null, 'FD 보고 없음은 null(0 이 아니다)');
});

test('③ 원장 finishedRuns 가 바이트 · 시작 시각을 남긴다', async () => {
  const registry = await import('../src/bareos/registry.js');
  registry._resetForTest();
  const j = registry.addJob({ vcenterId: 'vc-a', vmId: 'vc-a:vm-1', vmName: 'web', dc: 'DC', folder: '/', bareosJob: 'pv-1-vm-1', client: 'kr-fd', storage: 's', pool: 'p' });
  registry.applyRunRow(j.id, { jobid: 70, status: 'T', type: 'B', level: 'I', startedAt: 1_000, endedAt: 9_000, bytes: 12_345, files: 3, errors: 0 });
  registry.applyRunRow(j.id, { jobid: 71, status: 'R', type: 'B', level: 'I', startedAt: 10_000, endedAt: null, bytes: null, files: null, errors: 0 });
  const g = registry.getJob(j.id);
  assert.equal(g.lastRun.jobid, 71, '실행 중이 lastRun');
  const f = g.finishedRuns.find((x) => x.jobid === 70);
  assert.equal(f.bytes, 12_345); assert.equal(f.startedAt, 1_000);
  // 진행 행의 기준은 이 기록에서 온다
  const d = registry.jobDigests().find((x) => x.id === j.id);
  assert.equal(prevSameLevel(d, 'I', 71).bytes, 12_345);
});

test('④ 데모 실행 길이 — 기본 30초 · env 로 늘림 · 범위 밖 · 숫자 아님은 기본값', async () => {
  const { demoRunMs } = await import('../src/mock/demo/bareos.js');
  const keep = process.env.BAREOS_DEMO_RUN_MS;
  try {
    delete process.env.BAREOS_DEMO_RUN_MS; assert.equal(demoRunMs(), 30_000);
    process.env.BAREOS_DEMO_RUN_MS = '600000'; assert.equal(demoRunMs(), 600_000);
    process.env.BAREOS_DEMO_RUN_MS = '1000'; assert.equal(demoRunMs(), 30_000, '5초 미만');
    process.env.BAREOS_DEMO_RUN_MS = '99999999'; assert.equal(demoRunMs(), 30_000, '1시간 초과');
    process.env.BAREOS_DEMO_RUN_MS = 'abc'; assert.equal(demoRunMs(), 30_000);
  } finally {
    if (keep === undefined) delete process.env.BAREOS_DEMO_RUN_MS; else process.env.BAREOS_DEMO_RUN_MS = keep;
  }
});

test('⑤ 진행 현황 응답에 relayLimits(소스 대조 — 라우트가 edgeOps.relayLimits 를 싣는다)', () => {
  const src = fs.readFileSync(new URL('../src/routes/api/bareosLive.js', import.meta.url), 'utf8');
  assert.match(src, /import \{ relayLimits \} from '\.\.\/\.\.\/bareos\/edgeOps\.js'/);
  assert.match(src, /relayLimits: relayLimits\(\)/);
});
