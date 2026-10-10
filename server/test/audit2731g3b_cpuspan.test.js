/**
 * v2.731 점검 1회차 G3b — A2-04: 누적 CPU 카운터 사용률이 두 표본의 간격을 보지 않던 결함(bmusage Linux · CVP).
 *   같은 모듈의 처리량 환산(rates.js perSecond/busyPct · CVP portDelta)은 간격이 비정상이면 null 인데, CPU 비율만 간격 검사가 없어
 *   몇 시간~하루 공백 뒤 첫 표본이 '그 긴 구간 평균' 을 이번 주기 값처럼 원시·일 롤업·임계 판정에 넣었다(같은 행의 디스크·네트워크는 null).
 * 실제 함수(buildUsage · applySys)로 본다.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'g3b-cpuspan-'));

const { test } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
const { buildUsage } = await import('../src/bmusage/usage.js');
const { cpuPctFromJiffies, MAX_SPAN_MS } = await import('../src/bmusage/rates.js');
const { applySys } = await import('../src/cvp/poller.js');
const { cpuPctFromCounters } = await import('../src/cvp/parse.js');

const H = 3_600_000;
// 경계에서 떨어진 고정 기준 시각(CLAUDE.md — Date.now() 를 기준으로 쓰지 않는다)
const NOW = Date.UTC(2026, 9, 9, 3, 30, 0);

const target = { key: 'SVC1', name: 'db01' };
const prevCounters = { cpu: { total: 1_000_000, idle: 900_000 }, disks: [{ name: 'sda', ioTicksMs: 1000 }], nets: [{ iface: 'eth0', rxBytes: 1e9, txBytes: 1e9, bitsPerSec: 1e10 }], hbas: [] };
const osNow = (cpu) => ({ ok: true, osKind: 'linux', mem: { usedPct: 40 }, counters: { cpu, disks: [{ name: 'sda', ioTicksMs: 5000 }], nets: [{ iface: 'eth0', rxBytes: 1.1e9, txBytes: 1.1e9, bitsPerSec: 1e10 }], hbas: [] } });

test('A2-04 ① bmusage: 24시간 공백 뒤 첫 표본은 CPU 를 그 긴 구간 평균으로 적재하지 않는다(디스크·네트워크와 같은 경계)', () => {
  const prev = { at: NOW - 24 * H, counters: prevCounters, idrac: null };
  const r = buildUsage({ target, os: osNow({ total: 9_640_000, idle: 5_000_000 }), prev, now: NOW });
  assert.equal(r.row.cpu_pct, null, '24시간 평균(52.5)을 이번 주기 값으로 적재했다');
  assert.equal(r.row.disk_busy_pct, null);
  assert.equal(r.row.net_pct, null);
  assert.equal(r.row.mem_pct, 40, '순간값(메모리)은 그대로');
  assert.ok(r.notes.some((x) => /1440분 전/.test(x) && /비웠습니다/.test(x)), `공백 사유를 말해야 한다: ${JSON.stringify(r.notes)}`);
  // 이번 표본은 새 기준이 된다 — 다음 주기는 정상
  assert.equal(r.next.at, NOW);
  const r2 = buildUsage({ target, os: osNow({ total: 9_640_000 + 30_000, idle: 5_000_000 + 24_000 }), prev: r.next, now: NOW + 5 * 60_000 });
  assert.equal(r2.row.cpu_pct, 20);
  assert.ok(!r2.notes.some((x) => /비웠습니다/.test(x)));
});

test('A2-04 ② bmusage: 정상 간격(5분)은 그대로 · 시각 없는 이전 표본·시계 역행은 null', () => {
  const ok = buildUsage({ target, os: osNow({ total: 1_000_000 + 30_000, idle: 900_000 + 24_000 }), prev: { at: NOW - 5 * 60_000, counters: prevCounters }, now: NOW });
  assert.equal(ok.row.cpu_pct, 20);
  const noAt = buildUsage({ target, os: osNow({ total: 1_030_000, idle: 924_000 }), prev: { counters: prevCounters }, now: NOW });
  assert.equal(noAt.row.cpu_pct, null);
  const back = buildUsage({ target, os: osNow({ total: 1_030_000, idle: 924_000 }), prev: { at: NOW + 60_000, counters: prevCounters }, now: NOW });
  assert.equal(back.row.cpu_pct, null);
  // 경계: 정확히 MAX_SPAN 은 허용, 넘으면 null
  assert.equal(cpuPctFromJiffies({ total: 100, idle: 90 }, { total: 200, idle: 170 }, NOW - MAX_SPAN_MS, NOW), 20);
  assert.equal(cpuPctFromJiffies({ total: 100, idle: 90 }, { total: 200, idle: 170 }, NOW - MAX_SPAN_MS - 1, NOW), null);
});

test('A2-04 ③ CVP: 스트리밍이 끊겼다 돌아온 장비의 첫 CPU 표본은 null + 새 기준(포트와 같은 한계)', () => {
  const m = new Map();
  const iv = 5 * 60_000;
  const d1 = { key: 'SW1', sysAt: NOW - 6 * H, cpu: { counters: { busy: 100, total: 1000 } } };
  applySys('cvp1', d1, m, { intervalMs: iv, slackMs: 0 });
  assert.equal(d1.cpuPct, null, '첫 표본');
  const d2 = { key: 'SW1', sysAt: NOW, cpu: { counters: { busy: 100 + 21_600 * 50, total: 1000 + 21_600 * 100 } } };
  applySys('cvp1', d2, m, { intervalMs: iv, slackMs: 0 });
  assert.equal(d2.cpuPct, null, '6시간 평균(50)을 이번 주기 값으로 적재했다');
  assert.equal(d2.sysAt, null, 'CPU·메모리 둘 다 없으면 sysAt 도 비운다(적재하지 않음)');
  // 다음 주기(5분 뒤)는 정상 — 방금 표본이 기준
  const d3 = { key: 'SW1', sysAt: NOW + iv, cpu: { counters: { busy: 100 + 21_600 * 50 + 30, total: 1000 + 21_600 * 100 + 300 } } };
  applySys('cvp1', d3, m, { intervalMs: iv, slackMs: 0 });
  assert.equal(d3.cpuPct, 10);
  // 직전 실행 소요(slack)는 한계에 더한다 — 주기 × 3 + slack 안이면 값
  const m2 = new Map();
  applySys('c', { key: 'X', sysAt: NOW, cpu: { counters: { busy: 0, total: 0 } } }, m2, { intervalMs: iv, slackMs: 60_000 });
  const dx = { key: 'X', sysAt: NOW + 3 * iv + 30_000, cpu: { counters: { busy: 10, total: 100 } } };
  applySys('c', dx, m2, { intervalMs: iv, slackMs: 60_000 });
  assert.equal(dx.cpuPct, 10);
});

test('A2-04 ④ CVP 순수 함수: opts.intervalMs 가 있으면 간격 판정(시각 없음은 null), 없으면 예전 동작', () => {
  const a = { busy: 0, total: 0, at: NOW - 10 * H }; const b = { busy: 5, total: 10, at: NOW };
  assert.equal(cpuPctFromCounters(a, b, { intervalMs: 60_000 }), null);
  assert.equal(cpuPctFromCounters({ busy: 0, total: 0 }, { busy: 5, total: 10 }, { intervalMs: 60_000 }), null, '시각 없음');
  assert.equal(cpuPctFromCounters({ busy: 0, total: 0 }, { busy: 5, total: 10 }), 50, '시각 인자 없는 호출은 예전 그대로');
  assert.equal(cpuPctFromCounters({ busy: 0, total: 0, at: NOW - 60_000 }, b, { intervalMs: 60_000 }), 50);
});
