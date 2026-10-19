/**
 * v2.744 감사 GB 회귀 — 베어메탈 사용률 · iDRAC 텔레메트리.
 *
 *  RECENT-02 (v2.743 회귀) FC 사용률 분모를 표준 데이터율로 바꾼 뒤 포화 포트(>100%)가 null 이 되어, 서버 대표값(가장 높은 포트)이
 *            **다른 포트의 낮은 값**이 됐고 임계 알림이 울리지 않았다. 소폭 초과(≤110% — 카운터가 프레임 헤더까지 센다)는 100 + 표지,
 *            크게 넘으면 대표값을 비우고 `hba_over` → 알림은 초과로 본다.
 *  DEV-01    FC 통계 '-1 표지'(0xffffffffffffffff)를 카운터로 읽어 약 491 PB/s 가 원시 표본·5년 일 롤업 최대에 남았다.
 *  DEV-04    bmusage 폴러의 iDRAC 텔레메트리 경로에 장비 시한·signal 이 없었다 — 시한이 요청을 실제로 끊는지 소켓으로 본다.
 *  LEFT-02   redfish 의 문구 판정 `/\b40[134]\b/` 가 호스트명 속 '401'(idrac-401.corp)을 자격증명 거부로 읽었다 ·
 *            util/errors.js 가 ENOTFOUND 보다 401 을 먼저 봤다.
 *  LEFT-08 ② HBA 사용률 분모 근거(포트 수)가 응답 행(publicTarget.hbaBasis)에 실린다.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

// CONFIG_DIR 은 저장소 밖(작업 지시 — 스크래치패드 아래)에 둔다.
// v2.744(회귀 검토 GI-R3 형제): 세션 스크래치 경로를 박지 않는다(다른 환경에서는 EACCES). 필요하면 env 로 바꾼다.
const BASE = process.env.AUDIT2744B_TMP || os.tmpdir();
const TMP = fs.mkdtempSync(path.join(BASE, 'audit2744b-'));
process.env.CONFIG_DIR = TMP;
process.env.DATA_SOURCE = process.env.DATA_SOURCE || 'mock';
process.env.AUTH_ENABLED = 'false';
process.env.IPAM_WRITE_WORKER = '0';
after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* noop */ } });

// ⚠ 동적 import 는 첫 test() 등록 앞에 둔다(v2.743 audit2743l 의 교훈 — 루트 after 가 먼저 돌지 않게).
const { buildUsage } = await import('../src/bmusage/usage.js');
const { fcUtilization, fcRateCapBps, FC_OVER_CLAMP_PCT } = await import('../src/bmusage/parse/fcRate.js');
const { parseFcHosts } = await import('../src/bmusage/parse/linuxProc.js');
const { evaluateRows } = await import('../src/bmusage/alertRules.js');
const bdb = await import('../src/bmusage/db.js');
const redfish = await import('../src/idrac/redfish.js');
const { idracTelemetryJob } = await import('../src/bmusage/poller.js');
const { describeError } = await import('../src/util/errors.js');
const { recordHbaBasis, hbaBasisFor, pruneHbaBasis, summarizeHbaBasis, _resetHbaBasisForTest } = await import('../src/bmusage/hbaBasis.js');
const { publicTarget } = await import('../src/bmusage/targets.js');

const HOUR = 3_600_000;
const NOW = Math.floor(Date.now() / HOUR) * HOUR - 30 * 60_000;   // 정시 −30분(경계에서 떨어뜨린다 — v2.517 규약)
const TG = { key: 'GB1', name: 'bm-gb', vcenterId: 'vc1' };

/** sysfs FC 한 줄 — words 는 원문 문자열 그대로(16진·10진·표지). */
const fcLine = (host, tx, rx, speed = '16 Gbit') => `${host}|Online|${speed}|${tx}|${rx}`;
const osOf = (hbas, total = 1_000) => ({
  ok: true, osKind: 'linux', mem: { usedPct: 10 }, mounts: [], read: [], missing: [], absent: [],
  counters: { cpu: { total, idle: total * 0.9 }, disks: [], nets: [], hbas },
});
/** 두 주기(1초 간격) — 포트마다 [첫 주기 tx,rx 원문, 둘째 주기 tx,rx 원문]. */
function cycles(ports) {
  const a = buildUsage({ target: TG, os: osOf(parseFcHosts(ports.map((p) => fcLine(p.host, p.a[0], p.a[1], p.speed)))), prev: null, now: NOW });
  return buildUsage({ target: TG, os: osOf(parseFcHosts(ports.map((p) => fcLine(p.host, p.b[0], p.b[1], p.speed))), 2_000), prev: a.next, now: NOW + 1_000 });
}
/** 방향당 bytesPerSec 를 1초 동안 싣는 포트(단어 = 바이트 ÷ 4). */
const busyPort = (host, bps, speed) => ({ host, speed, a: ['0', '0'], b: [String(Math.round(bps / 4)), String(Math.round(bps / 4))] });

// ───────────────────────────── RECENT-02 ─────────────────────────────

test('RECENT-02 ① 16GFC 데이터율(1,600MB/s)을 조금 넘은 값(≤110%)은 100% + 표지, 크게 넘으면 사용률을 비운다', () => {
  const small = fcUtilization(1.7e9, 16e9);   // 106.3% — 카운터가 프레임 헤더까지 센다(측정 정의 차이)
  assert.equal(small.pct, 100); assert.equal(small.over, true); assert.equal(small.clamped, true);
  assert.ok(small.raw > 100 && small.raw <= FC_OVER_CLAMP_PCT, String(small.raw));
  const big = fcUtilization(2.0e9, 16e9);     // 125%
  assert.equal(big.pct, null); assert.equal(big.over, true); assert.equal(big.clamped, false);
  const ok = fcUtilization(0.8e9, 16e9);
  assert.equal(ok.pct, 50); assert.equal(ok.over, false);
});

test('RECENT-02 ② 한 포트가 크게 넘고 다른 포트가 낮으면 서버 HBA 사용률은 낮은 포트 값이 아니다(비움 + hba_over)', () => {
  const b = cycles([busyPort('host5', 2.0e9, '16 Gbit'), busyPort('host6', 0.16e9, '16 Gbit')]);
  const low = b.detail.fc.find((x) => x.host === 'host6');
  assert.equal(low.pct, 10, JSON.stringify(b.detail.fc));
  assert.notEqual(b.row.hba_pct, low.pct, '낮은 포트 값으로 대표하지 않는다');
  assert.equal(b.row.hba_pct, null);
  assert.equal(b.row.hba_over, true);
  assert.ok(b.row.hba_bps >= 4e9, String(b.row.hba_bps));   // 처리량은 그대로(두 방향 합)
  assert.ok(b.notes.some((x) => x.includes('크게') || x.includes('110%')), JSON.stringify(b.notes));
  // 소폭 초과 + 낮은 포트 → 100 이 대표값(낮은 포트가 아니다)
  const c = cycles([busyPort('host5', 1.7e9, '16 Gbit'), busyPort('host6', 0.16e9, '16 Gbit')]);
  assert.equal(c.row.hba_pct, 100);
  assert.ok(!c.row.hba_over);
  const hot = c.detail.fc.find((x) => x.host === 'host5');
  assert.equal(hot.pctOver, true); assert.equal(hot.pctClamped, true);
});

test('RECENT-02 ③ 임계 알림 — hba_over 행은 초과로 판정되어 지속 시간이 차면 알린다', () => {
  const b = cycles([busyPort('host5', 2.0e9, '16 Gbit'), busyPort('host6', 0.16e9, '16 Gbit')]);
  const { _perIf, _perFc, ...row } = b.row;   // 폴러가 적재 전에 떼는 것과 같다
  const cfg = { pct: 90, sustainMin: 1, repeatHours: 6, intervalMs: 60_000 };
  const s1 = evaluateRows([{ ...row, ts: NOW }], {}, cfg, NOW);
  assert.equal(s1.fires.length, 0);
  assert.equal(s1.counts.sustaining >= 1, true, JSON.stringify(s1.counts));
  const s2 = evaluateRows([{ ...row, ts: NOW + 60_000 }], s1.next, cfg, NOW + 60_000);
  const f = s2.fires.find((x) => x.metric === 'hba_pct');
  assert.ok(f, JSON.stringify(s2.fires));
  assert.equal(f.kind, 'over'); assert.equal(f.overRate, true);
  // 표지가 없고 값도 없는 행은 보류(초과가 아니다)
  const s3 = evaluateRows([{ key: 'GB2', name: 'x', hba_pct: null }], {}, cfg, NOW);
  assert.equal(s3.fires.length, 0); assert.ok(s3.counts.unknown >= 1);
});

// ───────────────────────────── DEV-01 ─────────────────────────────

test('DEV-01 ① parseFcHosts — -1 표지(0xffffffffffffffff)·10진 -1 은 카운터가 아니다(null + countersInvalid) · 2^53 초과는 값(GB-R3)', () => {
  const [s, big, ok, dec] = parseFcHosts([
    fcLine('host5', '0xffffffffffffffff', '0xffffffffffffffff'),
    fcLine('host6', '0x20000000000000', '0x1f4'),     // 2^53 — 표지가 아니다(근사로 읽는다 — v2.744 회귀 검토 GB-R3)
    fcLine('host7', '0x1f4', '0x10'),
    fcLine('host8', '-1', '500'),
  ]);
  assert.equal(s.txBytes, null); assert.equal(s.rxBytes, null); assert.equal(s.countersInvalid, true);
  assert.equal(big.txBytes, 0x20000000000000 * 4); assert.equal(big.rxBytes, 0x1f4 * 4); assert.equal(big.countersInvalid, undefined);
  assert.equal(ok.txBytes, 0x1f4 * 4); assert.equal(ok.rxBytes, 0x10 * 4); assert.equal(ok.countersInvalid, undefined);
  assert.equal(dec.txBytes, null); assert.equal(dec.rxBytes, 2000); assert.equal(dec.countersInvalid, true);
});

const SENT = '0xffffffffffffffff';
test('DEV-01 ② 정상→표지 · 표지→정상 · 표지→표지 — 처리량이 491 PB/s·0 B/s 가 되지 않는다', () => {
  const normal = ['0x100000', '0x100000'];
  const normal2 = ['0x200000', '0x200000'];
  for (const [label, a, b] of [['정상→표지', normal, [SENT, SENT]], ['표지→정상', [SENT, SENT], normal2], ['표지→표지', [SENT, SENT], [SENT, SENT]]]) {
    const r = cycles([{ host: 'host5', speed: '16 Gbit', a, b }]);
    assert.equal(r.row.hba_bps, null, `${label}: ${r.row.hba_bps}`);
    assert.equal(r.row.hba_pct, null, label);
    assert.ok(r.notes.some((x) => x.includes("'-1'")), `${label}: ${JSON.stringify(r.notes)}`);
  }
});

test('DEV-01 ③ 물리 상한을 넘는 처리량(카운터 이상 — 표지 아님)은 비우고 사유를 센다', () => {
  assert.equal(fcRateCapBps(16e9), 1.6e9 * 2);
  assert.equal(fcRateCapBps(null), 1e12);
  const r = cycles([{ host: 'host5', speed: '16 Gbit', a: ['0x10', '0x10'], b: ['0x10000000000', '0x10'] }]);   // 2^40 단어/초 = 4.4e12 B/s
  assert.equal(r.row.hba_bps, null, String(r.row.hba_bps));
  assert.ok(r.notes.some((x) => x.includes('물리 상한')), JSON.stringify(r.notes));
});

test('DEV-01 ④ 일 롤업 hba_bps_max 에 거대한 값이 남지 않는다(실제 SQLite)', async () => {
  const r1 = cycles([{ host: 'host5', speed: '16 Gbit', a: ['0x100000', '0x100000'], b: [SENT, SENT] }]);
  const r2 = cycles([busyPort('host5', 0.8e9, '16 Gbit')]);
  const strip = (b, ts) => { const { _perIf, _perFc, ...row } = b.row; return { ...row, ts }; };
  const res = await bdb.insertUsage([strip(r1, NOW), strip(r2, NOW + 300_000)], '');
  assert.equal(res.ok, true, JSON.stringify(res));
  const daily = await bdb.usageDaily({ key: TG.key, agent: '', days: 3 });
  assert.ok(daily.length >= 1, JSON.stringify(daily));
  for (const d of daily) assert.ok(d.hba_bps_max == null || d.hba_bps_max < 1e12, String(d.hba_bps_max));
});

// ───────────────────────────── DEV-04 ─────────────────────────────

/** 응답하지 않는 가짜 Redfish — 요청 수와 서버 쪽 소켓이 닫힌 시각을 센다. */
function hangServer() {
  const st = { reqs: 0, closedAt: [], paths: [] };
  const srv = http.createServer((req) => { st.reqs += 1; st.paths.push(req.url); /* 응답하지 않는다 */ });
  srv.on('connection', (sock) => sock.on('close', () => st.closedAt.push(Date.now())));
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ srv, st, host: `http://127.0.0.1:${srv.address().port}` })));
}

test('DEV-04 ① 장비 시한(1초)이 텔레메트리 GET 을 실제로 끊는다 — 소켓이 닫히고 kind 는 timeout(인증 정지 아님)', async () => {
  const { srv, st, host } = await hangServer();
  try {
    redfish._resetReportListForTest?.();
    const t0 = Date.now();
    const r = await idracTelemetryJob({ host, username: 'root', password: 'calvin' }, { full: false, timeoutMs: 1_000 });
    const took = Date.now() - t0;
    assert.equal(r.ok, false);
    assert.equal(r.kind, 'timeout', JSON.stringify(r));
    assert.ok(took < 4_000, `시한(1초) 안팎에서 끝나야 한다: ${took}ms`);
    // 서버 쪽 소켓이 끊겼는지 — 결과만 버리고 요청을 남기면 BMC 세션·동시성 슬롯을 잡는다(v2.417 규약)
    const until = Date.now() + 2_000;
    while (!st.closedAt.length && Date.now() < until) await new Promise((res) => setTimeout(res, 50));
    assert.ok(st.closedAt.length >= 1, `소켓이 닫히지 않았다(요청 ${st.reqs})`);
    assert.ok(st.closedAt[0] - t0 < 3_500, String(st.closedAt[0] - t0));
  } finally { srv.closeAllConnections?.(); srv.close(); }
});

test('DEV-04 ② 전수 모드도 시한 뒤에는 남은 GET 을 보내지 않는다', async () => {
  const { srv, st, host } = await hangServer();
  try {
    redfish._resetReportListForTest?.();
    const r = await idracTelemetryJob({ host, username: 'root', password: 'calvin' }, { full: true, allowList: true, timeoutMs: 1_000 });
    assert.equal(r.kind, 'timeout', JSON.stringify(r));
    const n0 = st.reqs;
    await new Promise((res) => setTimeout(res, 800));
    assert.equal(st.reqs, n0, `시한 뒤 새 요청 ${st.reqs - n0}건(${st.paths.slice(n0).join(',')})`);
  } finally { srv.closeAllConnections?.(); srv.close(); }
});

// ───────────────────────────── LEFT-02 ─────────────────────────────

/** 모든 요청에 다른 주소로 리다이렉트(대상 호스트명에 '401' 이 든다) 또는 지정 상태로 답한다. */
function rfServer(mode) {
  const srv = http.createServer((req, res) => {
    if (mode === 'redirect') { res.writeHead(302, { Location: 'https://idrac-401.example.invalid/redfish/v1/x' }); return res.end(); }
    res.writeHead(mode, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `status ${mode}` } }));
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ srv, host: `http://127.0.0.1:${srv.address().port}` })));
}

test("LEFT-02 ① 리다이렉트 대상 호스트명의 '401' 을 자격증명 거부로 읽지 않는다(fetchUsage 단독·전수·Enterprise 센서)", async () => {
  const { srv, host } = await rfServer('redirect');
  try {
    const entry = { host, username: 'root', password: 'calvin' };
    const one = await redfish.fetchUsage(entry, { full: false });
    assert.equal(one.ok, false);
    assert.match(one.error, /idrac-401/, one.error);   // 문구에는 호스트가 실린다 — 그래도 auth 가 아니다
    assert.notEqual(one.kind, 'auth', JSON.stringify(one));
    redfish._resetReportListForTest?.();
    const full = await redfish.fetchUsage(entry, { full: true, allowList: true });
    assert.notEqual(full.kind, 'auth', JSON.stringify(full));
    const sens = await redfish.fetchUsageSensors(entry, { allowProbe: true });
    assert.notEqual(sens?.kind, 'auth', JSON.stringify(sens));
  } finally { srv.close(); }
});

test('LEFT-02 ② 상태 표지(401·403·404)로는 예전대로 가른다', async () => {
  for (const [code, want] of [[401, 'auth'], [403, 'forbidden'], [404, 'no-telemetry']]) {
    const { srv, host } = await rfServer(code);
    try {
      const r = await redfish.fetchUsage({ host, username: 'root', password: 'calvin' }, { full: false });
      assert.equal(r.kind, want, `${code}: ${JSON.stringify(r)}`);
    } finally { srv.close(); }
  }
  assert.equal(redfish.redfishFailKind(new Error('x idrac-401.corp'), 'absent'), 'unreachable');
  assert.equal(redfish.redfishFailKind(Object.assign(new Error('x'), { status: 401 }), 'absent'), 'auth');
  assert.equal(redfish.redfishFailKind(Object.assign(new Error('x'), { status: 404 }), 'absent'), 'absent');
});

test('LEFT-02 ③ describeError — DNS·연결 거부를 401 보다 먼저, 401 은 HTTP 문맥일 때만', () => {
  assert.match(describeError(new Error('getaddrinfo ENOTFOUND vc-401.corp')).hint, /DNS/);
  const enot = Object.assign(new Error('fetch failed'), { cause: Object.assign(new Error('getaddrinfo ENOTFOUND vc-401.corp'), { code: 'ENOTFOUND' }) });
  assert.match(describeError(enot).hint, /DNS/);
  assert.match(describeError(new Error('connect ECONNREFUSED vc-401.corp:443')).hint, /연결 거부/);
  assert.doesNotMatch(describeError(new Error('BMC 가 다른 주소로 리다이렉트했습니다(302 → idrac-401.corp)')).hint || '', /인증 실패/);
  assert.match(describeError(new Error('HTTP 401 Unauthorized')).hint, /인증 실패/);
  assert.match(describeError(new Error('POST /api/session -> 401 Unauthorized')).hint, /인증 실패/);
  assert.match(describeError(new Error('Cannot complete login due to an incorrect user name or password')).hint, /인증 실패/);
  assert.match(describeError(Object.assign(new Error('x'), { status: 401 })).hint, /인증 실패/);
});

// ───────────────────────────── LEFT-08 ② ─────────────────────────────

test('LEFT-08 ② HBA 분모 근거 — 포트 수를 세어 응답 행(publicTarget.hbaBasis)에 싣는다', () => {
  _resetHbaBasisForTest();
  const b = cycles([busyPort('host5', 1.7e9, '16 Gbit'), busyPort('host6', 0.2e9, '10 Gbit'), busyPort('host7', 0.1e9, 'unknown'),
    { host: 'host8', speed: '16 Gbit', a: [SENT, SENT], b: [SENT, SENT] }]);
  const s = summarizeHbaBasis(b.detail.fc);
  assert.equal(s.ports, 4);
  assert.equal(s.dataRate, 2);   // host5·host8(16G — 표에 있다)
  assert.equal(s.nominal, 1);    // 10 Gbit(표에 없다)
  assert.equal(s.noSpeed, 1);
  assert.equal(s.clamped, 1);
  assert.equal(s.unread, 1);
  recordHbaBasis('GB1', b, { at: NOW, ok: true });
  const pt = publicTarget({ key: 'GB1', name: 'bm-gb', idrac: { host: 'https://10.0.0.1', password: 'secret' }, osHost: null });
  assert.equal(pt.hbaBasis.ports, 4); assert.equal(pt.hbaBasis.clampMaxPct, FC_OVER_CLAMP_PCT);
  assert.ok(!JSON.stringify(pt).includes('secret'));
  // 성공했는데 FC 가 없으면 지우고, 실패한 주기는 직전 근거를 둔다
  recordHbaBasis('GB1', { detail: { fc: [] }, row: {} }, { ok: false });
  assert.ok(hbaBasisFor('GB1'));
  recordHbaBasis('GB1', { detail: { fc: [] }, row: {} }, { ok: true });
  assert.equal(hbaBasisFor('GB1'), null);
  recordHbaBasis('GB9', b, { ok: true });
  pruneHbaBasis(new Set(['GB1']));
  assert.equal(hbaBasisFor('GB9'), null);
  assert.equal(publicTarget({ key: 'none' }).hbaBasis, null);
});
