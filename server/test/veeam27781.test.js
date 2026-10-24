/**
 * v2.778.1 — 실서버: Veeam 콘솔 작업 '23. spotfire' 49% completed 인데 포탈 카드에는 '백업 중 28%' 가 보였다.
 *  · 카드의 '백업 중 28%'·'Veeam 10-22 01:12' 는 **고정 범례 예시**였다 — 예시 값을 쓰지 않는다(웹 VeeamParts.jsx).
 *  · 포탈은 VM 단위(task) 진행률만 가졌다 — 작업 전체 진행률(세션 progressPercent, 콘솔 작업 목록의 %)을 작업에 싣고 관리자 판본에 보인다.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const P = await import('../src/veeam/parse.js');
const JOBS = { data: [{ id: 'j1', name: '23. spotfire', type: 'Backup', virtualMachines: { includes: [
  { type: 'VirtualMachine', hostName: 'vc01', name: 'sf01', objectId: 'vm-1' }, { type: 'VirtualMachine', hostName: 'vc01', name: 'sf02', objectId: 'vm-2' }] } }] };
const STATES = { data: [{ id: 'j1', status: 'Running', lastResult: 'Success', lastRun: '2026-10-24T09:00:00Z' }] };
const ses = (o) => [{ session: { id: 's1', jobId: 'j1', state: 'Working', progressPercent: 49, ...o }, tasks: [{ name: 'sf01', objectId: 'vm-1', hostName: 'vc01', state: 'Working', progress: { progressPercent: 28 } }] }];

test('세션 진행률(작업 전체)을 작업에 싣는다 — VM 배지의 task 진행률과 따로', () => {
  const r = P.buildServerResult({ jobs: JOBS, states: STATES, sessions: ses() });
  const j = r.jobs.find((x) => x.id === 'j1');
  assert.equal(j.running, true); assert.equal(j.pg, 49);
  assert.equal(r.vms.find((v) => v.n === 'sf01').pg, 28, 'VM 은 자기 task 진행률');
  // progress 객체 꼴도 받는다 · 범위 밖은 자른다 · 없으면 싣지 않는다
  assert.equal(P.buildServerResult({ jobs: JOBS, states: STATES, sessions: ses({ progressPercent: undefined, progress: { progressPercent: 140 } }) }).jobs[0].pg, 100);
  assert.equal('pg' in P.buildServerResult({ jobs: JOBS, states: STATES, sessions: ses({ progressPercent: null }) }).jobs[0], false);
});

test('엣지 결과 정제가 실행 중 작업의 진행률만 남긴다 · 오래된 결과는 실행 중과 함께 진행률도 지운다', () => {
  const r = P.buildServerResult({ jobs: JOBS, states: STATES, sessions: ses() });
  const clean = P.sanitizeServerResult({ ...r, ok: true, ts: Date.now() });
  assert.equal(clean.jobs[0].pg, 49);
  assert.equal('pg' in P.sanitizeServerResult({ ...r, ok: true, ts: Date.now(), jobs: [{ ...r.jobs[0], running: false, pg: 30 }] }).jobs[0], false);
  assert.equal(P.sanitizeServerResult({ ...r, ok: true, ts: Date.now(), jobs: [{ ...r.jobs[0], pg: '49' }] }).jobs[0].pg, 49, '글자 수치는 수로');
  const stale = P.withoutStaleRunning({ ...r, ok: true, ts: 1 }, { now: Date.now(), maxAgeMs: 1000 });
  assert.equal(stale.jobs[0].running, false); assert.equal('pg' in stale.jobs[0], false, '오래된 결과의 작업 진행률은 키째 지운다');
});

test('라우트 — 실행 중 작업(이름·진행률)은 관리자 판본에만 · 웹 범례에 예시 값이 없다', () => {
  const src = fs.readFileSync(new URL('../src/routes/api/veeam.js', import.meta.url), 'utf8');
  assert.match(src, /if \(admin\) views\[views\.length - 1\]\.runningJobs = /);
  const web = fs.readFileSync(new URL('../../web/src/views/VeeamParts.jsx', import.meta.url), 'utf8');
  assert.ok(!/chip\('백업 중 \d+%'/.test(web) && !/chip\('Veeam \d\d-\d\d/.test(web), '범례 칩에 실제처럼 보이는 예시 값 금지');
});
