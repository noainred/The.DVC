/**
 * 베어메탈 사용률 점검 반복 9회차 — 회귀 고정.
 *  G1: 진단 스냅샷의 프로세스 사용자 이름(cpuTop · memTop · ioTop 의 user)이 비관리자(운영자 · 조회자 · 데모)에게 원문으로 나갔다
 *      (8b 규약 '프로세스 사용자 이름은 관리자 판본만 원문' — Top-N 은 토큰) → scrubSnapshot 이 같은 토큰으로.
 *  (J1 은 10회차 L1 에서 되돌림 — 아래 끝 주석)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'bmloop9-'));
process.env.CONFIG_DIR = DIR;
process.env.DATA_SOURCE = 'mock';
process.env.AUTH_ENABLED = 'false';
delete process.env.CENTRAL_URL;
test.after(() => fs.rmSync(DIR, { recursive: true, force: true }));

test('G1 · 10회차 K1 — 스냅샷 프로세스 사용자 이름은 비관리자에게 토큰(Top-N 과 같은 토큰) · 이름(name — 실제 파서 칸) 안 주소도 가림 · 관리자는 원문', async () => {
  // ⚠ 정정(10회차 K1): 처음 판은 합성 행(comm 칸)을 넣어 통과했다 — 실제 파서(parseSnapshot)는 name 칸을 만든다. 이제 실제 파서 출력으로.
  const { scrubSnapshot } = await import('../src/routes/api/bmUsage.js');
  const { parseSnapshot } = await import('../src/bmusage/snapshot/command.js');
  const { maskTopRows } = await import('../src/routes/api/bmTop.js');
  const stdout = ['##PSCPU', '101 etl_svc_prod 55.1 1000 10.20.30.40:80', '1 root 0.1 100 systemd', '##PSMEM', '101 etl_svc_prod 55.1 1000 10.20.30.40:80', '##PIDS', '200', '##END', ''].join('\n');
  const result = parseSnapshot(stdout, { topN: 5, dmesgLines: 5 });
  assert.equal(result.cpuTop[0].name, '10.20.30.40:80', '실제 파서 칸은 name(전제 확인)'); assert.equal(result.cpuTop[0].user, 'etl_svc_prod');
  const res = { ok: true, result, snapshot: { id: 's1', by: 'op', reason: 'r', result } };
  const out = scrubSnapshot(res, false);
  for (const r of [out.result, out.snapshot.result]) {
    assert.ok(r.cpuTop.every((p) => /^masked-/.test(p.user)), `재현 r9 G1 — 예전 원문 · ${JSON.stringify(r.cpuTop)}`);
    assert.ok(r.memTop.every((p) => /^masked-/.test(p.user)));
    assert.ok(!JSON.stringify(r).includes('etl_svc_prod'));
    assert.ok(!JSON.stringify(r).includes('10.20.30.40'), `재현 r10 K1 — 9회차 판은 comm 만 가려 name 안 주소가 원문 · ${JSON.stringify(r.cpuTop)}`);
  }
  // Top-N 과 같은 토큰(같은 값 = 같은 토큰)
  assert.equal(out.result.cpuTop[0].user, maskTopRows({ cpu: [{ user: 'etl_svc_prod', comm: 'x' }] }).cpu[0].user);
  // 관리자 판본은 원문 그대로 · 원본은 바꾸지 않는다
  assert.equal(scrubSnapshot(res, true).result.cpuTop[0].user, 'etl_svc_prod');
  assert.equal(result.cpuTop[0].name, '10.20.30.40:80');
});

// J1(데모 KPI 경로 수 겹침)은 10회차 L1 에서 되돌렸다 — 어긋남이 칩 · 표 · CSV · 스냅샷 쪽으로 옮겨 갔다(정정 · docs/rules/idrac-server.md 9 · 10회차 절).
