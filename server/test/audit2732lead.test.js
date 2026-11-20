/**
 * v2.732(점검 2회차) 리드 통합 — 그룹 c(B4-01) 후속.
 *  ① 미보호 VM 리포트: 이 포탈이 지금 직접 수집하지 않는 vCenter(비활성·점검중·엣지 위임)는 창 안에 옛 이벤트가 남아 있어도 판정하지 않는다
 *     — 로그 폴러가 2.732 부터 그 셋을 건너뛰므로, 옛 이벤트로 '판정 가능' 이라 하면 그 뒤 스냅샷이 없는 VM 이 거짓 '미보호' 가 된다.
 *  ② 범위 계정의 vCenter 로그 상태: notCollected·authRejected 는 범위 안 vCenter 만(전 법인 vCenter id·사유는 범위 밖 정보).
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
const rmTmpDirs = () => { for (const d of TMP_DIRS) { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* 정리 실패는 시험 결과가 아니다(늦게 flush 되는 기록기와의 경합 — exit 에서 한 번 더) */ } } };
after(() => { rmTmpDirs(); process.once('exit', () => { try { rmTmpDirs(); } catch { /* 종료 중 */ } }); });

process.env.CONFIG_DIR = tmpDir('audit2732lead-');
process.env.DATA_SOURCE = 'mock';

const { computeUnprotected } = await import('../src/reports/unprotected.js');
const { scopeVcLogStatus } = await import('../src/routes/admin/backupNetSec.js');

const vms = [
  { id: 'vm-1', name: 'a', vcenterId: 'vc-direct', powerState: 'POWERED_ON' },
  { id: 'vm-2', name: 'b', vcenterId: 'vc-site', powerState: 'POWERED_ON' },
];

test('① 직접 수집하지 않는 vCenter 의 VM 은 not-collected(판정 불가) — 옛 이벤트가 있어 covered 여도', () => {
  const r = computeUnprotected(vms, [], {
    coveredVcenterIds: new Set(['vc-direct', 'vc-site']),
    notCollectedVcenterIds: new Set(['vc-site']),
  });
  assert.equal(r.summary.unprotectedCount, 1, 'vc-direct 의 VM 만 미보호로 판정');
  assert.equal(r.summary.undeterminedByReason['not-collected'], 1);
  assert.equal(r.undetermined[0].vcenterId, 'vc-site');
  // 인자를 주지 않으면 예전 판정 그대로(호환)
  const old = computeUnprotected(vms, [], { coveredVcenterIds: new Set(['vc-direct', 'vc-site']) });
  assert.equal(old.summary.unprotectedCount, 2);
});

test('② 범위 계정 로그 상태 — notCollected·authRejected 는 범위 안만 + 뺀 개수', () => {
  const st = {
    lastRun: {
      at: 1, collected: 9,
      notCollected: [{ vcenterId: 'vc-a', why: 'site' }, { vcenterId: 'vc-b', why: 'disabled' }],
      authRejected: [{ vcenterId: 'vc-b', attempts: 2 }],
    },
    store: { vcenters: [] },
  };
  const out = scopeVcLogStatus(st, new Set(['vc-a']));
  assert.deepEqual(out.lastRun.notCollected, [{ vcenterId: 'vc-a', why: 'site' }]);
  assert.equal(out.lastRun.notCollectedOmitted, 1);
  assert.deepEqual(out.lastRun.authRejected, []);
  assert.equal(out.lastRun.authRejectedOmitted, 1);
  // 전체 범위는 그대로
  assert.equal(scopeVcLogStatus(st, null), st);
});
