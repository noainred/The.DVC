/**
 * v2.744 회귀 검토 RB — v2.744 GB 수정분(FC HBA 사용률·물리 상한·-1 표지·iDRAC Sensors)이 남긴 잘못된 분류.
 *
 *  GB-R1  명목(nominal) 기준 포트의 100% 초과가 '데이터율을 크게 넘음' 으로 세여 서버 대표값이 비고, 'FC 표준 데이터율 초과 …
 *         카운터 이상일 수 있다' 는 사실과 다른 critical 알림이 나갔다. 명목 초과는 머리말(fcRate.js) 그대로 '예전대로' 다 —
 *         그 포트 사용률만 비우고(속도 보고 확인) 대표값은 나머지 포트, 알림은 초과로 보지 않는다.
 *  GB-R2  물리 상한이 함께 읽은 속도 값을 믿어서, 속도를 1 Gbit 미만으로 읽은(단위가 다를 수 있는) iDRAC FC 포트의 실제 처리량을
 *         '카운터 이상' 으로 버렸다 · 주기 중 링크 재협상(16G→4G)이면 평균 처리량을 버렸다.
 *  GB-R3  2^53 을 넘는 FC 단어 카운터를 '-1 표지(못 읽음)' 로 처리해 오래 돈 바쁜 HBA 의 처리량이 영원히 비었다.
 *  GB-R4  iDRAC FC 행이 대표값에 쓰이지 않았는데(OS 값이 대표) 노트가 '대표값도 비웠다 · 알림은 초과' 라고 적었다.
 *  GB-R5  fetchSensorCollection 이 문구 판정 `/\b404\b/` 을 써서 호스트명에 404 가 든 리다이렉트 실패를 'Sensors 없음' 으로 기록했다.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

// CONFIG_DIR 은 저장소 밖(작업 지시 — 스크래치패드 아래)에 둔다.
// v2.744(회귀 검토 GI-R3 형제): 세션 스크래치 경로를 박지 않는다(다른 환경에서는 EACCES). 필요하면 env 로 바꾼다.
const BASE = process.env.AUDIT2744RB_TMP || os.tmpdir();
const TMP = fs.mkdtempSync(path.join(BASE, 'audit2744rb-'));
process.env.CONFIG_DIR = TMP;
process.env.DATA_SOURCE = process.env.DATA_SOURCE || 'mock';
process.env.AUTH_ENABLED = 'false';
process.env.IPAM_WRITE_WORKER = '0';
after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* noop */ } });

// ⚠ 동적 import 는 첫 test() 등록 앞에 둔다(루트 after 가 먼저 돌지 않게 — audit2743l 의 교훈).
const { buildUsage } = await import('../src/bmusage/usage.js');
const { fcUtilization, fcRateCapBps, fcRepresentative, fcRateNotes } = await import('../src/bmusage/parse/fcRate.js');
const { parseFcHosts } = await import('../src/bmusage/parse/linuxProc.js');
const { evaluateRows, alertOf } = await import('../src/bmusage/alertRules.js');
const { summarizeHbaBasis } = await import('../src/bmusage/hbaBasis.js');
const redfish = await import('../src/idrac/redfish.js');

const T0 = 1_700_000_000_000;
const NOW = T0 + 300_000;
const TG = { key: 'RB1', name: 'srv-rb', vcenterId: 'vc1' };
const hbaRow = (host, speedRaw, bitsPerSec, txBytes, rxBytes = 0) => ({ host, state: 'Online', speedRaw, bitsPerSec, txBytes, rxBytes });
const osAt = (at, hbas) => ({ ok: true, osKind: 'linux', at, mem: { usedPct: 10 }, mounts: [], read: [], missing: [], absent: [], counters: { hbas } });
/** 5분 간격 두 주기 — ports: [{ host, speedRaw, bits, prevBits?, bps }] (방향당 B/s 를 tx 에 싣는다). */
function osCycle(ports) {
  const prev = { at: T0, counters: { hbas: ports.map((p) => hbaRow(p.host, p.prevSpeedRaw || p.speedRaw, p.prevBits ?? p.bits, 0)) } };
  const os = osAt(NOW, ports.map((p) => hbaRow(p.host, p.speedRaw, p.bits, p.bps * 300)));
  return buildUsage({ target: TG, os, prev, now: NOW, intervalMs: 300_000 });
}
const CFG = { enabled: true, pct: 90, sustainMin: 15, repeatHours: 6, intervalMs: 300_000 };
function alertsOver(row, cycles = 6) {
  let st = {}; const fires = [];
  for (let i = 0; i < cycles; i++) {
    const r = evaluateRows([{ ...row, ts: NOW + i * 300_000 }], st, CFG, NOW + i * 300_000);
    st = r.next; fires.push(...r.fires);
  }
  return fires;
}
const BIG_DR = 'FC 표준 데이터율의 110% 를 크게 넘는';

// ───────────────────────────── GB-R1 ─────────────────────────────

test('GB-R1 ① 명목 포트(10 Gbit)의 104% — 그 포트만 비우고 대표값은 나머지 포트 · 알림 없음 · 데이터율 문구 아님', () => {
  const b = osCycle([
    { host: 'host1', speedRaw: '10 Gbit', bits: 10e9, bps: 1.3e9 },
    { host: 'host2', speedRaw: '16 Gbit', bits: 16e9, bps: 80e6 },
  ]);
  const fc0 = b.detail.fc[0];
  assert.equal(fc0.pctBasis, 'nominal'); assert.equal(fc0.pctOver, true); assert.equal(fc0.pct, null); assert.equal(fc0.pctRaw, 104);
  assert.equal(b.row.hba_over, undefined, '명목 초과는 데이터율 초과가 아니다 — hba_over 를 세우지 않는다');
  assert.equal(b.row.hba_pct, 5, '대표값은 나머지 포트(머리말 — 명목 초과는 예전대로)');
  assert.equal(b.row.hba_bps, 1.3e9, '처리량은 그대로');
  assert.ok(!b.notes.some((x) => x.includes(BIG_DR)), JSON.stringify(b.notes));
  assert.ok(b.notes.some((x) => x.includes('명목 속도') && x.includes('속도 보고')), JSON.stringify(b.notes));
  const fires = alertsOver(b.row);
  assert.equal(fires.length, 0, JSON.stringify(fires.map((f) => alertOf(f).title)));
});

test('GB-R1 ② 포화 포트의 표본 시각 차이(100.5%)도 같다 · 명목 포트 하나뿐이면 대표값 null(판정 보류 — 알림 없음)', () => {
  const u = fcUtilization(1.25625e9, 10e9);
  assert.equal(u.basis, 'nominal'); assert.equal(u.over, true); assert.equal(u.pct, null);
  const b = osCycle([{ host: 'host1', speedRaw: '10 Gbit', bits: 10e9, bps: 1.25625e9 }]);
  assert.equal(b.row.hba_pct, null); assert.equal(b.row.hba_over, undefined);
  assert.ok(!b.notes.some((x) => x.includes(BIG_DR)), JSON.stringify(b.notes));
  assert.ok(b.notes.some((x) => x.includes('명목 속도')), JSON.stringify(b.notes));
  assert.equal(alertsOver(b.row).length, 0);
});

test('GB-R1 ③ 데이터율 기준 크게 초과(125%)는 그대로 대표값을 비우고 알림은 초과(RECENT-02 설계 유지)', () => {
  const b = osCycle([
    { host: 'host1', speedRaw: '16 Gbit', bits: 16e9, bps: 2.0e9 },
    { host: 'host2', speedRaw: '10 Gbit', bits: 10e9, bps: 1.3e9 },
  ]);
  assert.equal(b.row.hba_pct, null); assert.equal(b.row.hba_over, true);
  assert.ok(b.notes.some((x) => x.includes(BIG_DR)), JSON.stringify(b.notes));
  const fires = alertsOver(b.row);
  assert.equal(fires.length, 1);
  assert.match(alertOf(fires[0]).title, /FC 표준 데이터율 초과/);
  const rep = fcRepresentative(b.detail.fc);
  assert.equal(rep.blanked, 1); assert.equal(rep.nominalOver, 1); assert.equal(rep.overBlank, true);
});

test('GB-R1 ④ 분모 근거 요약 — 명목 초과는 blanked 가 아니라 nominalOver 로 센다', () => {
  const b = osCycle([
    { host: 'host1', speedRaw: '10 Gbit', bits: 10e9, bps: 1.3e9 },
    { host: 'host2', speedRaw: '16 Gbit', bits: 16e9, bps: 80e6 },
  ]);
  const s = summarizeHbaBasis(b.detail.fc);
  assert.equal(s.blanked, 0); assert.equal(s.nominalOver, 1); assert.equal(s.nominal, 1);
});

// ───────────────────────────── GB-R2 ─────────────────────────────

test('GB-R2 ① 속도를 1 Gbit 미만으로 읽은 iDRAC FC(단위 미확인 16 → 16e6)의 실제 처리량 500MB/s 를 버리지 않는다', () => {
  assert.equal(fcRateCapBps(16e6), 1e12, '1 Gbit 미만 속도는 상한 근거가 아니다(속도 미상과 같다)');
  assert.equal(fcRateCapBps(16e9), 1.6e9 * 2, '표준 등급은 그대로(DEV-01)');
  assert.equal(fcRateCapBps(10e9), (10e9 / 8) * 2, '1 Gbit 이상 명목 속도는 그대로');
  const prev = { at: T0, counters: null, idrac: { nics: [], fcs: [{ host: 'FC.Slot.1-1', bitsPerSec: 16e6, rxBytes: 0, txBytes: 0, at: T0 }] } };
  const idrac = { ok: true, at: NOW, nics: [], fcs: [{ host: 'FC.Slot.1-1', bitsPerSec: 16e6, rxBytes: 0, txBytes: 500e6 * 300, at: NOW }] };
  const b = buildUsage({ target: TG, idrac, prev, now: NOW, intervalMs: 300_000 });
  assert.equal(b.row.hba_bps, 500e6, JSON.stringify(b.row));
  assert.ok(!b.notes.some((x) => x.includes('물리 상한')), JSON.stringify(b.notes));
});

test('GB-R2 ② 주기 중 재협상(16G→4G) — 상한은 직전·이번 속도 중 큰 쪽 · 평균 950MB/s 를 카운터 이상으로 버리지 않는다', () => {
  assert.equal(fcRateCapBps(4e9, 16e9), 1.6e9 * 2);
  assert.equal(fcRateCapBps(4e9), 0.4e9 * 2);
  const b = osCycle([{ host: 'host1', speedRaw: '4 Gbit', bits: 4e9, prevSpeedRaw: '16 Gbit', prevBits: 16e9, bps: 0.95e9 }]);
  assert.equal(b.row.hba_bps, 0.95e9, JSON.stringify(b.notes));
  assert.ok(!b.notes.some((x) => x.includes('물리 상한')), JSON.stringify(b.notes));
});

test('GB-R2 ③ 카운터 이상(2^40 단어/초 = 4.4e12 B/s)은 여전히 비운다(DEV-01 유지)', () => {
  const b = osCycle([{ host: 'host1', speedRaw: '16 Gbit', bits: 16e9, bps: 4.4e12 }]);
  assert.equal(b.row.hba_bps, null);
  assert.ok(b.notes.some((x) => x.includes('물리 상한')), JSON.stringify(b.notes));
  const i = buildUsage({
    target: TG, now: NOW, intervalMs: 300_000,
    prev: { at: T0, counters: null, idrac: { nics: [], fcs: [{ host: 'F', bitsPerSec: 16e6, rxBytes: 0, txBytes: 0, at: T0 }] } },
    idrac: { ok: true, at: NOW, nics: [], fcs: [{ host: 'F', bitsPerSec: 16e6, rxBytes: 0, txBytes: 4.4e12 * 300, at: NOW }] },
  });
  assert.equal(i.row.hba_bps, null, '속도를 믿지 않을 때도 절대 상한(1e12)은 적용된다');
});

// ───────────────────────────── GB-R3 ─────────────────────────────

test('GB-R3 ① 2^53 을 넘는 단어 카운터는 표지가 아니다 — 값으로 읽고(근사) countersInvalid 를 세우지 않는다', () => {
  const [big, sent, decSent, over64] = parseFcHosts([
    'host1|Online|32 Gbit|0x20000000000000a|0x20000000000000b',
    'host2|Online|32 Gbit|0xffffffffffffffff|0x10',
    'host3|Online|32 Gbit|18446744073709551615|16',
    'host4|Online|32 Gbit|0x10000000000000000|0x10',
  ]);
  assert.equal(big.countersInvalid, undefined, JSON.stringify(big));
  assert.equal(big.txBytes, Number.parseInt('20000000000000a', 16) * 4);
  assert.equal(big.rxBytes, Number.parseInt('20000000000000b', 16) * 4);
  assert.equal(sent.txBytes, null); assert.equal(sent.countersInvalid, true);
  assert.equal(decSent.txBytes, null); assert.equal(decSent.countersInvalid, true, '10진 2^64−1 도 -1 표지');
  assert.equal(over64.txBytes, null); assert.equal(over64.countersInvalid, true, '64비트를 넘는 값은 카운터가 아니다');
});

test('GB-R3 ② 2^57 근처 두 표본의 차이 — 처리량이 나오고 오차는 1 B/s 안이다', () => {
  const w0 = 2 ** 57 + 10;
  const w1 = w0 + (1.6e9 / 4) * 300;
  const hex = (w) => `0x${BigInt(Math.round(w)).toString(16)}`;
  const a = parseFcHosts([`host1|Online|32 Gbit|${hex(w0)}|0x0`]);
  const c = parseFcHosts([`host1|Online|32 Gbit|${hex(w1)}|0x0`]);
  const b = buildUsage({ target: TG, os: osAt(NOW, c), prev: { at: T0, counters: { hbas: a } }, now: NOW, intervalMs: 300_000 });
  assert.ok(b.row.hba_bps != null, JSON.stringify(b.notes));
  assert.ok(Math.abs(b.row.hba_bps - 1.6e9) < 1, String(b.row.hba_bps));
  assert.equal(b.row.hba_pct, 50);
  assert.ok(!b.notes.some((x) => x.includes("'-1'")), JSON.stringify(b.notes));
});

// ───────────────────────────── GB-R4 ─────────────────────────────

test('GB-R4 OS 값이 대표일 때 iDRAC FC 노트는 \'대표값도 비웠다 · 알림은 초과\' 라고 말하지 않는다', () => {
  const os = osAt(NOW, [hbaRow('host1', '16 Gbit', 16e9, 0.8e9 * 300)]);
  const prev = { at: T0, counters: { hbas: [hbaRow('host1', '16 Gbit', 16e9, 0)] },
    idrac: { nics: [], fcs: [{ host: 'FC.Slot.1-1', bitsPerSec: 16e9, rxBytes: 0, txBytes: 0, at: T0 }] } };
  const idrac = { ok: true, at: NOW, nics: [], fcs: [{ host: 'FC.Slot.1-1', bitsPerSec: 16e9, rxBytes: 0, txBytes: 2.0e9 * 300, at: NOW }] };
  const b = buildUsage({ target: TG, os, idrac, prev, now: NOW, intervalMs: 300_000 });
  assert.equal(b.row.hba_pct, 50); assert.equal(b.row.src, 'os'); assert.equal(b.row.hba_over, undefined);
  const iNote = b.notes.find((x) => x.startsWith('iDRAC FC 표준 데이터율의'));
  assert.ok(iNote, JSON.stringify(b.notes));
  assert.ok(!iNote.includes('대표값도 비웠습니다'), iNote);
  assert.ok(!iNote.includes('임계 알림은 초과로 봅니다'), iNote);
  assert.ok(iNote.includes('OS'), iNote);
  // 대표값을 실제로 비웠을 때(OS 없음)는 예전 문구 그대로
  const b2 = buildUsage({ target: TG, idrac, prev: { at: T0, idrac: prev.idrac }, now: NOW, intervalMs: 300_000 });
  assert.equal(b2.row.hba_over, true);
  assert.ok(b2.notes.some((x) => x.includes('대표값도 비웠습니다')), JSON.stringify(b2.notes));
  // 순수 함수 — usedForRep 기본은 참(예전 호출부 호환)
  assert.ok(fcRateNotes(b.detail.idracFc, 'iDRAC ').some((x) => x.includes('대표값도 비웠습니다')));
  assert.ok(!fcRateNotes(b.detail.idracFc, 'iDRAC ', { usedForRep: false }).some((x) => x.includes('대표값도 비웠습니다')));
});

// ───────────────────────────── GB-R5 ─────────────────────────────

function sensorsServer(mode) {
  const srv = http.createServer((req, res) => {
    if (req.url === '/redfish/v1/Chassis') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ Members: [{ '@odata.id': '/redfish/v1/Chassis/System.Embedded.1' }] }));
    }
    if (req.url.startsWith('/redfish/v1/Chassis/System.Embedded.1/Sensors')) {
      if (mode === 'redirect404') { res.writeHead(302, { Location: 'https://idrac-404.example.invalid/redfish/v1/x' }); return res.end(); }
      if (mode === 'notfound') { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end('{}'); }
    }
    res.writeHead(500); res.end();
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ srv, host: `http://127.0.0.1:${srv.address().port}` })));
}

test('GB-R5 호스트명 \'idrac-404\' 로의 리다이렉트 실패는 Sensors 없음(absent)이 아니라 실패다 · 진짜 404 는 absent', async () => {
  const a = await sensorsServer('redirect404');
  try {
    const r = await redfish.fetchSensorCollection({ host: a.host, username: 'root', password: 'x' });
    assert.equal(r.absent, 0, JSON.stringify(r)); assert.equal(r.failed, 1); assert.equal(r.ok, false);
    assert.ok(r.error && /리다이렉트/.test(r.error), JSON.stringify(r));
  } finally { a.srv.close(); }
  const b = await sensorsServer('notfound');
  try {
    const r = await redfish.fetchSensorCollection({ host: b.host, username: 'root', password: 'x' });
    assert.equal(r.absent, 1, JSON.stringify(r)); assert.equal(r.failed, 0); assert.equal(r.ok, true);
  } finally { b.srv.close(); }
});
