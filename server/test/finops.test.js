import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// v3.18.8: 이 파일이 만든 임시 폴더는 시험이 끝나면 지운다(지우지 않아 전량 실행마다 /tmp 에 쌓였다 — tmpCleanup3188 이 고정).
//   exit 에서 한 번 더 지운다 — 모듈의 종료 flush(util/exitFlush.js)가 뒤늦게 다시 만든 폴더(수 MB 실측)까지.
const TMP_DIRS = [];
const tmpDir = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); TMP_DIRS.push(d); return d; };
const rmTmpDirs = () => { for (const d of TMP_DIRS) { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* 정리 실패는 시험 결과가 아니다(늦게 flush 되는 기록기와의 경합 — exit 에서 한 번 더) */ } } };
after(() => { rmTmpDirs(); process.once('exit', () => { try { rmTmpDirs(); } catch { /* 종료 중 */ } }); });

process.env.CONFIG_DIR = tmpDir('finops-');
const { computeFinOps } = await import('../src/insights/finops.js');

const CFG = { tariffPerKwh: 130, currency: '₩', co2KgPerKwh: 0.45, pue: 1.5 };
const snap = {
  vcenters: [{ id: 'vc1', location: { region: 'KR' } }],
  hosts: [{ name: 'esxi-a', vcenterId: 'vc1', model: 'R740' }],
};

test('FinOps: 매핑 안 된 측정 서버도 전력 합계에 포함(버그 수정)', () => {
  const measured = [
    { serverName: 'esxi-a', host: 'esxi-a', watts: 400 },     // 인벤토리 매핑됨
    { serverName: 'LESASBPDPS93', host: 'lesasbpdps93', watts: 440 }, // 미매핑
    { serverName: 'LESASBPDPS94', host: 'lesasbpdps94', watts: 460 }, // 미매핑
  ];
  const r = computeFinOps(snap, measured, CFG);
  assert.equal(r.measuredHosts, 3);            // 3대 모두 측정에 포함
  assert.equal(r.totals.watts, 1300);          // 400+440+460
  assert.equal(r.unmappedServers, 2);
  assert.equal(r.unmappedWatts, 900);
});

test('FinOps: 미매핑 전력은 (미매핑) vCenter 버킷으로 귀속', () => {
  const measured = [
    { serverName: 'esxi-a', host: 'esxi-a', watts: 400 },
    { serverName: 'x', host: 'unknown-host', watts: 1000 },
  ];
  const r = computeFinOps(snap, measured, CFG);
  const vcIds = r.byVcenter.map((v) => v.vcId).sort();
  assert.deepEqual(vcIds, ['(미매핑)', 'vc1']);
  assert.equal(r.byVcenter.find((v) => v.vcId === '(미매핑)').watts, 1000);
});

test('FinOps: 하위호환 — Map(host→{watts}) 입력도 처리', () => {
  const m = new Map([['esxi-a', { watts: 500 }]]);
  const r = computeFinOps(snap, m, CFG);
  assert.equal(r.totals.watts, 500);
  assert.equal(r.measuredHosts, 1);
});
