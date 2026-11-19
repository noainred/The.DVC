/**
 * v2.954(점검 B-6) — 프로세스 Top 시간 집계의 RSS: 후보 ∪ 메모리 상위의 PID 마다 한 번(머리말 정의 '같은 comm PID 들의 RSS 합').
 *   예전에는 CPU 증분 > 0 이거나 메모리 상위인 후보만 더해, 조용한 주기 · 재시작 뒤 첫 주기의 후보 RSS 가 빠졌다(rss_max 과소).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'bmtoprss-'));
process.env.CONFIG_DIR = DIR;
test.after(() => fs.rmSync(DIR, { recursive: true, force: true }));
const T = await import('../src/bmusage/topStore.js');

const cand = (pid, rss, cpuS, comm = 'postgres') => ({ pid, start: pid * 10, cpu: 0.1, comm, user: 'gp', rssKb: rss, state: 'S', cpuS });
const topOf = (cpu, mem) => ({ cpu, mem, io: [] });

test('B-6 조용한 주기 — 후보 6개(메모리 상위는 1개)의 RSS 합', () => {
  const cpu = [1, 2, 3, 4, 5, 6].map((p) => cand(p, 1000 * p, 50));
  const mem = [{ pid: 6, start: 60, comm: 'postgres', rssKb: 6000 }, { pid: 99, start: 990, comm: 'java', rssKb: 9000 }];
  const prev = new Map(cpu.map((x) => [`${x.pid}:${x.start}`, 50]));   // 증분 0
  const d = T.hourlyDelta(topOf(cpu, mem), prev, { elapsedS: 300 });
  assert.equal(d.byComm.get('postgres').rss, 21000, '1+2+…+6 천 kB — 메모리 상위 1개분(6000)만이 아니다');
  assert.equal(d.byComm.get('postgres').cpuKnown, false, '증분 0 은 CPU 초를 더하지 않는다');
  assert.equal(d.byComm.get('java').rss, 9000);
});

test('B-6 재시작 뒤 첫 주기(prev 없음) — CPU 는 모르고 RSS 는 합 · 같은 PID 를 두 번 더하지 않는다', () => {
  const cpu = [cand(1, 100, 10), cand(2, 200, 20), cand(3, null, 30, 'idle')];
  const mem = [{ pid: 2, start: 20, comm: 'postgres', rssKb: 200 }];
  const d = T.hourlyDelta(topOf(cpu, mem), null);
  assert.equal(d.byComm.get('postgres').rss, 300);
  assert.equal(d.byComm.has('idle'), false, 'RSS 도 CPU 증분도 없는 후보는 행을 만들지 않는다');
});

test('B-6 증분이 있는 후보는 CPU 와 RSS 를 함께', () => {
  const cpu = [cand(1, 100, 80), cand(2, 200, 50)];
  const prev = new Map([['1:10', 50], ['2:20', 50]]);
  const d = T.hourlyDelta(topOf(cpu, []), prev, { elapsedS: 300 });
  assert.equal(d.byComm.get('postgres').cpuS, 30); assert.equal(d.byComm.get('postgres').rss, 300);
});
