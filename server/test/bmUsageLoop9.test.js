/**
 * 베어메탈 사용률 점검 반복 9회차 — 회귀 고정.
 *  G1: 진단 스냅샷의 프로세스 사용자 이름(cpuTop · memTop · ioTop 의 user)이 비관리자(운영자 · 조회자 · 데모)에게 원문으로 나갔다
 *      (8b 규약 '프로세스 사용자 이름은 관리자 판본만 원문' — Top-N 은 토큰) → scrubSnapshot 이 같은 토큰으로.
 *  J1: 데모(mock) 화면 KPI 'OS 경로 0' ↔ 경로 줄 · 신뢰 띠 '둘 다 15' — 성능 열 겹침(demoPerfLatestRows)과 같은 순위 · 시나리오로 KPI 경로 수도 겹친다(응답 전용).
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

test('G1 — 스냅샷 프로세스 사용자 이름은 비관리자에게 토큰(Top-N 과 같은 토큰) · comm 안 주소도 가림 · 관리자는 원문', async () => {
  const { scrubSnapshot } = await import('../src/routes/api/bmUsage.js');
  const { maskTopRows } = await import('../src/routes/api/bmTop.js');
  const rows = [{ pid: 101, user: 'etl_svc_prod', comm: 'java -Dhost=10.20.30.40', cpu: 55.1 }, { pid: 1, user: 'root', comm: 'systemd', cpu: 0.1 }];
  const result = { v: 1, cpuTop: rows, memTop: rows.slice(0, 1), ioTop: [{ pid: 7, user: 'gpadmin', comm: 'postgres', readKBs: 10 }], dmesg: [], ss: [] };
  const res = { ok: true, result, snapshot: { id: 's1', by: 'op', reason: 'r', result } };
  const out = scrubSnapshot(res, false);
  for (const r of [out.result, out.snapshot.result]) {
    assert.ok(r.cpuTop.every((p) => /^masked-/.test(p.user)), `재현 r9 G1 — 예전 원문 · ${JSON.stringify(r.cpuTop)}`);
    assert.ok(r.memTop.every((p) => /^masked-/.test(p.user))); assert.ok(r.ioTop.every((p) => /^masked-/.test(p.user)));
    assert.ok(!JSON.stringify(r).includes('etl_svc_prod') && !JSON.stringify(r).includes('gpadmin'));
    assert.ok(!JSON.stringify(r).includes('10.20.30.40'), 'comm 안 주소');
  }
  // Top-N 과 같은 토큰(같은 값 = 같은 토큰 — 화면이 두 곳을 맞춰 볼 수 있다)
  const tn = maskTopRows({ cpu: rows }).cpu;
  assert.equal(out.result.cpuTop[0].user, tn[0].user);
  // 관리자 판본은 원문 그대로
  assert.equal(scrubSnapshot(res, true).result.cpuTop[0].user, 'etl_svc_prod');
  // 원본은 바꾸지 않는다
  assert.equal(rows[0].user, 'etl_svc_prod');
});

test('J1 — 데모 KPI 경로 수는 성능 열 겹침과 같은 규칙(시나리오 idrac-only 만 iDRAC 경로) · paths 는 그대로 · 사람이 등록한 대상은 건드리지 않음', async () => {
  const B = await import('../src/mock/demo/baremetal.js');
  const demo = Array.from({ length: 17 }, (_, i) => ({ key: `MTAG${String(i).padStart(2, '0')}`, serverId: `mock-s${i}`, paths: ['idrac'], vcenterId: 'vcA' }));
  const human = { key: 'REAL1', serverId: 's-real', paths: ['idrac'], vcenterId: 'vcA' };
  const all = [...demo, human];
  const counts = { targets: 18, idrac: 18, os: 0, both: 0 };
  const c = B.demoPathCounts(counts, all, all);
  const ranks = [...demo.map((x) => x.key)].sort();
  const expectOs = ranks.filter((_, i) => B.DEMO_PERF_SCENARIOS[i % B.DEMO_PERF_SCENARIOS.length] !== 'idrac-only').length;
  assert.equal(expectOs, 15);
  assert.equal(c.os, 15, `재현 r9 J1 — 예전 KPI os 0 ↔ 경로 줄 둘 다 15 · ${JSON.stringify(c)}`); assert.equal(c.both, 15); assert.equal(c.idrac, 18); assert.equal(c.demoOsOverlay, 15);
  assert.ok(demo.every((x) => x.paths.length === 1 && x.paths[0] === 'idrac'), '대상 paths 는 바꾸지 않는다(스냅샷 · 집중이 SSH 를 시도하지 않게)');
  // 겹침과 같은 규칙 — 같은 대상에 os_at 이 생기는 것과 KPI 가 1:1
  const rowsIn = all.map((x) => ({ key: x.key, ts: Date.now(), cpu_pct: 10 }));
  const overlaid = B.demoPerfLatestRows(rowsIn, all);
  assert.equal(overlaid.filter((r) => r.os_at != null).length, c.os, '겹친 OS 열 수 = KPI 에 더한 OS 경로 수');
  // 보이는 대상만(범위 계정) — 순위는 전체 기준
  const vis = all.filter((x) => ['MTAG00', 'MTAG01', 'REAL1'].includes(x.key));
  const cv = B.demoPathCounts({ os: 0, both: 0 }, vis, all);
  assert.equal(cv.os, vis.filter((x) => x.key !== 'REAL1' && B.DEMO_PERF_SCENARIOS[ranks.indexOf(x.key) % B.DEMO_PERF_SCENARIOS.length] !== 'idrac-only').length);
  // 데모 대상이 없으면 그대로
  assert.equal(B.demoPathCounts(counts, [human], [human]), counts);
});

