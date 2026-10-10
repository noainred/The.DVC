/**
 * v2.732 점검 2회차 그룹 f — B1-01: 베어메탈 사용률 누적 카운터 간격 한계가 60분 고정이라, 수집 주기를 약 60분 이상으로
 *   두면(설정 상한 6시간) 같은 서버의 두 표본 간격(= 주기 + 실행 소요)이 언제나 한계를 넘어 Linux CPU(v2.731 A2-04 회귀)·
 *   디스크 I/O·네트워크·HBA·iDRAC NIC/FC 가 **매 주기** null 이었고, 화면은 매 주기 '다음 주기부터 나옵니다' 라는 거짓을 말했다.
 *   이제 한계 = max(60분, 주기 × 3 + slack) 이고 한 행의 모든 누적 지표가 같은 한계를 쓴다. 주기를 넘기지 않은 호출은 예전 60분.
 * 실제 함수(rates.spanLimitMs · usage.buildUsage · poller.spanArgsFor)로 본다. 기준 시각은 고정값(Date.now() 금지).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2732f-bmspan-'));

const { test } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
const { buildUsage } = await import('../src/bmusage/usage.js');
const { spanLimitMs, spanOk, MAX_SPAN_MS, cpuPctFromJiffies, perSecond, busyPct } = await import('../src/bmusage/rates.js');
const poller = await import('../src/bmusage/poller.js');
const { stripComments } = await import('./_stripComments.js');

const MIN = 60_000;
const H = 60 * MIN;
// 정시·자정 경계에서 떨어진 고정 기준 시각
const NOW = Date.UTC(2026, 9, 10, 3, 30, 0);
const target = { key: 'SVC1', name: 'db01' };

/** 매 주기 CPU 40%(jiffies 300,000 중 idle 180,000) · 디스크 io_ticks · NIC 바이트가 늘어나는 Linux 표본. */
function linux(i) {
  return {
    ok: true, osKind: 'linux', mem: { usedPct: 40 },
    counters: {
      cpu: { total: 1_000_000 + i * 300_000, idle: 800_000 + i * 180_000 },
      disks: [{ name: 'sda', ioTicksMs: 1000 + i * 600_000 }],
      nets: [{ iface: 'eth0', rxBytes: 1e9 + i * 1e8, txBytes: 1e9 + i * 1e8, bitsPerSec: 1e10 }],
      hbas: [{ host: 'host1', rxBytes: 1e9 + i * 1e8, txBytes: 1e9 + i * 1e8, bitsPerSec: 16e9 }],
    },
  };
}
const prevOf = (i, at) => ({ at, counters: linux(i).counters, idrac: null });
const blanked = (notes) => notes.some((x) => /비웠습니다/.test(x));

test('B1-01 ① spanLimitMs: max(60분, 주기 × 3 + slack) · 주기 모름은 60분 · slack 음수/결측은 0', () => {
  assert.equal(spanLimitMs(), MAX_SPAN_MS);
  assert.equal(spanLimitMs(undefined, 5 * MIN), MAX_SPAN_MS);
  for (const bad of [null, '', 0, -1, NaN, 'abc', [], {}]) assert.equal(spanLimitMs(bad, 10 * MIN), MAX_SPAN_MS, `주기 ${JSON.stringify(bad)}`);
  assert.equal(spanLimitMs(5 * MIN, 0), MAX_SPAN_MS, '기본 5분 주기는 예전 60분보다 좁아지지 않는다(하한)');
  assert.equal(spanLimitMs(5 * MIN, 2 * MIN), MAX_SPAN_MS);
  assert.equal(spanLimitMs(60 * MIN, 3 * MIN), 183 * MIN);
  assert.equal(spanLimitMs(6 * H, 5 * MIN), 18 * H + 5 * MIN);
  for (const bad of [null, '', -5 * MIN, NaN]) assert.equal(spanLimitMs(60 * MIN, bad), 180 * MIN, `slack ${JSON.stringify(bad)}`);
  // spanOk 의 한계 인자 — 주지 않거나 못 읽으면 예전 60분
  assert.equal(spanOk(NOW - 61 * MIN, NOW), false);
  assert.equal(spanOk(NOW - 61 * MIN, NOW, 183 * MIN), true);
  assert.equal(spanOk(NOW - 61 * MIN, NOW, null), false);
  assert.equal(spanOk(NOW - 61 * MIN, NOW, ''), false);
  // 세 환산 함수가 같은 한계 인자를 받는다
  assert.equal(cpuPctFromJiffies({ total: 0, idle: 0 }, { total: 100, idle: 60 }, NOW - 63 * MIN, NOW, 183 * MIN), 40);
  assert.equal(cpuPctFromJiffies({ total: 0, idle: 0 }, { total: 100, idle: 60 }, NOW - 63 * MIN, NOW), null, '한계 인자 없으면 예전 60분');
  assert.ok(perSecond(0, 63 * 60, NOW - 63 * MIN, NOW, 183 * MIN) > 0);
  assert.equal(perSecond(0, 63 * 60, NOW - 63 * MIN, NOW), null);
  assert.ok(busyPct(0, 1000, NOW - 63 * MIN, NOW, 183 * MIN) != null);
  assert.equal(busyPct(0, 1000, NOW - 63 * MIN, NOW), null);
});

test('B1-01 ② buildUsage: 주기 60분 · 실행 3분 · 간격 63분 → CPU·디스크·네트워크·HBA 전부 값(같은 한계)', () => {
  const r = buildUsage({ target, os: linux(1), prev: prevOf(0, NOW - 63 * MIN), now: NOW, intervalMs: 60 * MIN, slackMs: 3 * MIN });
  assert.equal(r.row.cpu_pct, 40, `CPU: ${JSON.stringify(r.notes)}`);
  assert.notEqual(r.row.disk_busy_pct, null, '디스크 I/O');
  assert.notEqual(r.row.net_pct, null, '네트워크 사용률');
  assert.notEqual(r.row.net_bps, null, '네트워크 처리량');
  assert.notEqual(r.row.hba_bps, null, 'HBA 처리량');
  assert.equal(blanked(r.notes), false, `비웠다고 말하면 안 된다: ${JSON.stringify(r.notes)}`);
});

test('B1-01 ③ buildUsage: 같은 설정에서 간격 4시간(> 183분) → null + 한계를 말한다', () => {
  const r = buildUsage({ target, os: linux(1), prev: prevOf(0, NOW - 4 * H), now: NOW, intervalMs: 60 * MIN, slackMs: 3 * MIN });
  assert.equal(r.row.cpu_pct, null);
  assert.equal(r.row.disk_busy_pct, null);
  assert.equal(r.row.net_bps, null);
  assert.equal(r.row.hba_bps, null);
  const note = r.notes.find((x) => /비웠습니다/.test(x)) || '';
  assert.match(note, /240분 전/);
  assert.match(note, /허용 간격\(183분/, `한계(183분)를 말해야 한다: ${note}`);
  assert.doesNotMatch(note, /60분 초과/, '예전 고정 문구(60분 초과)를 쓰지 않는다');
});

test('B1-01 ④ buildUsage: 주기 6시간 · 간격 6시간 5분 → 값 / 주기 5분 · 간격 30분 → 값(60분 하한) / 주기 5분 · 간격 24시간 → null', () => {
  const six = buildUsage({ target, os: linux(1), prev: prevOf(0, NOW - (6 * H + 5 * MIN)), now: NOW, intervalMs: 6 * H, slackMs: 2 * MIN });
  assert.equal(six.row.cpu_pct, 40);
  assert.notEqual(six.row.disk_busy_pct, null);
  const five = buildUsage({ target, os: linux(1), prev: prevOf(0, NOW - 30 * MIN), now: NOW, intervalMs: 5 * MIN, slackMs: 1 * MIN });
  assert.equal(five.row.cpu_pct, 40, '하한 60분을 빼면 5분 주기의 30분 끊김이 빈다');
  assert.notEqual(five.row.net_bps, null);
  const day = buildUsage({ target, os: linux(1), prev: prevOf(0, NOW - 24 * H), now: NOW, intervalMs: 5 * MIN, slackMs: 1 * MIN });
  assert.equal(day.row.cpu_pct, null, 'A2-04: 5분 주기의 하루 공백은 여전히 null');
});

test('B1-01 ⑤ buildUsage: 주기를 넘기지 않은 호출은 예전 60분 그대로 — 간격 61분 → null', () => {
  const r = buildUsage({ target, os: linux(1), prev: prevOf(0, NOW - 61 * MIN), now: NOW });
  assert.equal(r.row.cpu_pct, null);
  assert.equal(r.row.disk_busy_pct, null);
  assert.ok(blanked(r.notes));
  const ok = buildUsage({ target, os: linux(1), prev: prevOf(0, NOW - 59 * MIN), now: NOW });
  assert.equal(ok.row.cpu_pct, 40);
});

test('B1-01 ⑥ 간격 문구는 한계와 모순되지 않는다 — 60.2분 간격을 "60분 전 … 60분 초과" 로 쓰지 않는다', () => {
  const r = buildUsage({ target, os: linux(1), prev: prevOf(0, NOW - (60 * MIN + 12_000)), now: NOW });
  const note = r.notes.find((x) => /비웠습니다/.test(x)) || '';
  assert.match(note, /60분 12초 전/, note);
  assert.match(note, /허용 간격\(60분\)/, note);
  // 분 단위로 정확하면 예전처럼 '<분>분 전'(1440분 전 — audit2731g3b ① 과 같은 표기)
  const day = buildUsage({ target, os: linux(1), prev: prevOf(0, NOW - 24 * H), now: NOW });
  assert.ok(day.notes.some((x) => /1440분 전/.test(x)));
});

test('B1-01 ⑦ iDRAC NIC·FC 누적 바이트도 같은 한계 — 리포트 간격 63분 · 주기 60분 → 처리량 값', () => {
  const pIdrac = { nics: [{ iface: 'NIC.1', rxBytes: 1e9, txBytes: 1e9, bitsPerSec: 1e10, at: NOW - 63 * MIN }], fcs: [{ host: 'FC.1', rxBytes: 1e9, txBytes: 1e9, bitsPerSec: 16e9, at: NOW - 63 * MIN }] };
  const cur = { ok: true, nics: [{ iface: 'NIC.1', rxBytes: 2e9, txBytes: 2e9, bitsPerSec: 1e10, at: NOW }], fcs: [{ host: 'FC.1', rxBytes: 2e9, txBytes: 2e9, bitsPerSec: 16e9, at: NOW }] };
  const prev = { at: NOW - 63 * MIN, counters: null, idrac: pIdrac };
  const withIv = buildUsage({ target, idrac: cur, prev, now: NOW, intervalMs: 60 * MIN, slackMs: 3 * MIN });
  assert.notEqual(withIv.row.net_bps, null, 'iDRAC NIC');
  assert.notEqual(withIv.row.hba_bps, null, 'iDRAC FC');
  const legacy = buildUsage({ target, idrac: cur, prev, now: NOW });
  assert.equal(legacy.row.net_bps, null, '주기 모름은 예전 60분');
  assert.equal(legacy.row.hba_bps, null);
});

test('B1-01 ⑧ poller.spanArgsFor: slack = 직전 실행 소요 + 이번 주기 offset · 결측은 0 · 주기 못 읽음은 null', () => {
  assert.equal(typeof poller.spanArgsFor, 'function');
  assert.deepEqual(poller.spanArgsFor({ intervalMs: 60 * MIN, prevRunMs: 3 * MIN, runT0: NOW, sampledAt: NOW + 40_000 }), { intervalMs: 60 * MIN, slackMs: 3 * MIN + 40_000 });
  assert.deepEqual(poller.spanArgsFor({ intervalMs: 60 * MIN }), { intervalMs: 60 * MIN, slackMs: 0 });
  assert.deepEqual(poller.spanArgsFor({ intervalMs: '', prevRunMs: '', runT0: null, sampledAt: NOW }), { intervalMs: null, slackMs: 0 });
  assert.deepEqual(poller.spanArgsFor({ intervalMs: 0, prevRunMs: -5, runT0: NOW, sampledAt: NOW - 10 }), { intervalMs: null, slackMs: 0 });
});

test('B1-01 ⑨ 다주기 모사(적응 타이머 — 다음 틱 = 종료 + 주기): 주기 60분 · 실행 3분 → 2주기째부터 값 · 5분 주기는 예전 그대로', () => {
  const run = (intervalMin, runMin, offsetMin, cycles = 5) => {
    let prev = null; let tStart = NOW; let prevRunMs = 0; const out = [];
    for (let i = 0; i < cycles; i++) {
      const at = tStart + offsetMin * MIN;
      const r = buildUsage({ target, os: linux(i), prev, now: at, ...poller.spanArgsFor({ intervalMs: intervalMin * MIN, prevRunMs, runT0: tStart, sampledAt: at }) });
      out.push(r.row.cpu_pct);
      prev = r.next;
      prevRunMs = runMin * MIN;
      tStart = tStart + runMin * MIN + intervalMin * MIN;
    }
    return out;
  };
  assert.deepEqual(run(60, 3, 1), [null, 40, 40, 40, 40]);
  assert.deepEqual(run(58, 3, 1), [null, 40, 40, 40, 40]);
  assert.deepEqual(run(360, 5, 2), [null, 40, 40, 40, 40]);
  assert.deepEqual(run(5, 2, 1), [null, 40, 40, 40, 40]);
});

test('B1-01 ⑩ poller 배선: buildUsage 호출이 주기·여유(spanArgsFor)를 넘기고 주기 출처는 loadBmUsageSettings', () => {
  const src = stripComments(fs.readFileSync(new URL('../src/bmusage/poller.js', import.meta.url), 'utf8'));
  const call = /buildUsage\(\{[^;]*\}\);/.exec(src)?.[0] || '';
  assert.ok(call, 'buildUsage 호출을 찾지 못했다');
  assert.match(call, /spanArgsFor\(\{[^}]*intervalMs/, `buildUsage 에 주기를 넘겨야 한다: ${call}`);
  assert.match(call, /prevRunMs/);
  assert.match(src, /collectOne\(tg, \{[^}]*intervalMs[^}]*prevRunMs[^}]*runT0/, '주기 수집이 collectOne 에 주기·직전 실행 소요·주기 시작을 넘긴다');
  assert.match(src, /const intervalMs = loadBmUsageSettings\(\)\.intervalMs/, '타이머와 같은 출처의 주기');
});
