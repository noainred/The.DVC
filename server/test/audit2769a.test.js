/**
 * v2.769(점검 R4 — G1 통신 점검·서비스 점검) 회귀 테스트.
 *  D3-1 linkcheck stepSmtp 가 응답 없는 FIN 에 영구 미해결 → 통신 점검 폴러 running 영구 true(중앙·엣지 정지).
 *       close 판정 + 실제 setTimeout 하드 시한, 폴러에 항목 단위 시한(runWithItemDeadline).
 *  D3-3 svcmon runNow/sweep 이 SVCMON_ROLE=central·SVCMON_ENABLED=false 를 무시하고 직접 점검 → 실행 가드 + 라우트 409.
 *  D3-4 svcmonEdge 재전송 measuredAt 1ms 역행 시 snapId 미갱신 → 완결 GC 가 정상 행·메타 삭제.
 *  D3-5 snapId 역행 시 GC 보류에 시한이 없었다 → REGRESS_GC_HOLD_MS 뒤 재기준(역행 즉시 GC 는 여전히 금지).
 *  D3-6 svcmon ping 이 RTT 를 못 읽으면 0ms 로 기록 → null('RTT 미상') · 한국어 Windows 출력 판독.
 * (D3-2 는 웹 linkCheckText.test.js 'R4-D3-2' 블록 + 아래 서버 ageMs 정적 확인.)
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stripComments } from './_stripComments.js';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2769a-'));
process.env.CONFIG_DIR = DIR;
const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8');
after(() => { try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* */ } });

const { stepSmtp } = await import('../src/linkcheck/protocols.js');
const LP = await import('../src/linkcheck/poller.js');

const HANG = Symbol('hang');
const race = (p, ms) => {
  let t;
  return Promise.race([p, new Promise((r) => { t = setTimeout(() => r(HANG), ms); })]).finally(() => clearTimeout(t));
};
const listen = (onConn) => new Promise((r) => { const s = net.createServer(onConn); s.listen(0, '127.0.0.1', () => r(s)); });

/* ── D3-1 ── */
test('R4-D3-1 · stepSmtp — 응답 없는 FIN 3종(배너 없음·EHLO 뒤·개행 없는 부분 배너)이 시한 전에 실패로 끝난다', async () => {
  const servers = [
    ['배너 없이 FIN', await listen((c) => c.end())],
    ['EHLO 뒤 FIN', await listen((c) => { c.write('220 mail ESMTP\r\n'); c.on('data', () => c.end()); })],
    ['부분 배너 + FIN', await listen((c) => c.end('220 partial-no-newline'))],
  ];
  try {
    for (const [name, s] of servers) {
      // 시한(timeoutMs)은 넉넉히 길게 — close 판정이 없으면 이 시한까지(또는 영원히) 기다린다.
      const r = await race(stepSmtp('127.0.0.1', s.address().port, { timeoutMs: 20_000 }), 5_000);
      assert.notEqual(r, HANG, `${name}: Promise 가 끝나지 않았다(폴러 running 영구 true 의 원인)`);
      assert.equal(r.ok, false, name);
      assert.equal(r.failKind, 'smtp-refused', `${name}: ${JSON.stringify(r)}`);
      assert.ok(r.ms < 5_000, `${name}: 비활동 시한이 아니라 close 로 끝나야 한다`);
    }
    // 부분 배너는 결과에 남는다(이슈 분석 자료)
    const r3 = await stepSmtp('127.0.0.1', servers[2][1].address().port, { timeoutMs: 20_000 });
    assert.match(r3.banner || '', /220 partial/);
  } finally { for (const [, s] of servers) s.close(); }
});

test('R4-D3-1 · stepSmtp — 정상 대화(220 → EHLO 250)는 그대로 ok · 닫힌 포트는 refused(settingsCheck2553 유지)', async () => {
  const s = await listen((c) => {
    c.write('220 mx ESMTP\r\n');
    c.on('data', (d) => { if (/^EHLO/.test(String(d))) c.write('250-mx\r\n250-STARTTLS\r\n250 OK\r\n'); });
  });
  try {
    const r = await stepSmtp('127.0.0.1', s.address().port, { timeoutMs: 5_000 });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.starttls, true);
  } finally { s.close(); }
  const b = await stepSmtp('127.0.0.1', 1, { timeoutMs: 3_000 });
  assert.equal(b.failKind, 'refused');
});

test('R4-D3-1 · stepSmtp 는 소켓 비활동 타이머와 별도로 실제 setTimeout 하드 시한을 갖고 fin 에서 해제한다', () => {
  const src = stripComments(read('linkcheck/protocols.js'));
  const body = src.slice(src.indexOf('export function stepSmtp'), src.indexOf('export function stepPortOnly'));
  assert.match(body, /hard = setTimeout\(/, '하드 시한 없음 — FIN 뒤 sock.setTimeout 은 해제돼 발화하지 않는다');
  assert.match(body, /clearTimeout\(hard\)/);
  assert.match(body, /sock\.once\('close'/);
});

test('R4-D3-1 · 폴러 항목 시한 — 끝나지 않는 항목도 시한 뒤 skipped 사유로 돌아온다(재진입 가드를 붙잡지 않는다)', async () => {
  const never = () => new Promise(() => {});
  const r = await race(LP.runWithItemDeadline(never, 50, () => ({ skipped: 'deadline' })), 3_000);
  assert.notEqual(r, HANG);
  assert.deepEqual(r, { skipped: 'deadline' });
  // 정상 항목은 결과 그대로 · 던지면 그대로 던진다(poolSettled 가 rejected 로 센다)
  assert.deepEqual(await LP.runWithItemDeadline(async () => ({ ok: 1 }), 1_000, () => 'x'), { ok: 1 });
  await assert.rejects(LP.runWithItemDeadline(async () => { throw new Error('boom'); }, 1_000, () => 'x'), /boom/);
  // 시한 = 모든 단계 시한 합 + 여유 → 정상 점검(단계 합)을 자르지 않는다
  const tmo = { dnsMs: 5_000, tcpMs: 8_000, tlsMs: 10_000, httpMs: 15_000, sshMs: 12_000, smtpMs: 12_000 };
  const sum = Object.values(tmo).reduce((a, b) => a + b, 0);
  assert.ok(LP.itemDeadlineMs(tmo) > sum);
  assert.ok(LP.itemDeadlineMs({}) >= LP.ITEM_DEADLINE_SLACK_MS);
});

test('R4-D3-1 · pollOnce 의 두 풀(링크·설정 대상)이 모두 항목 시한으로 감싸져 있다', () => {
  const src = stripComments(read('linkcheck/poller.js'));
  assert.match(src, /runWithItemDeadline\(\(\) => runLink\(/);
  assert.match(src, /runWithItemDeadline\(\(\) => runSettingsTarget\(/);
  assert.doesNotMatch(src, /\(l\) => runLink\(l/, '시한 없는 runLink 직접 호출이 남았다');
  assert.doesNotMatch(src, /\(x\) => runSettingsTarget\(x/, '시한 없는 runSettingsTarget 직접 호출이 남았다');
});

/* ── D3-2(서버 쪽) ── */
test('R4-D3-2 · /tools/link-check 는 latest 에 서버 시계 ageMs 를 싣는다(못 읽으면 null)', () => {
  const src = stripComments(read('routes/api/linkCheck.js'));
  assert.match(src, /ageMs: \(Number\.isFinite\(Number\(r\.ts\)\) && Number\(r\.ts\) > 0\) \? Math\.max\(0, nowTs - Number\(r\.ts\)\) : null/);
});

/* ── D3-3 ── */
function runChild(env, script) {
  const dir = fs.mkdtempSync(path.join(DIR, 'child-'));
  const file = path.join(dir, 'c.mjs');
  fs.writeFileSync(file, script);
  const r = spawnSync(process.execPath, ['--experimental-sqlite', file], {
    env: { ...process.env, CONFIG_DIR: dir, SVCMON_WORKERS: '0', AUTH_ENABLED: 'false', SSRF_ALLOW_LOOPBACK: 'true', ...env }, encoding: 'utf8', timeout: 60_000,
  });
  const line = String(r.stdout || '').trim().split('\n').filter((l) => l.startsWith('{')).pop();
  assert.ok(line, `자식 출력 없음: ${r.stderr}`);
  return JSON.parse(line);
}
const childScript = () => `
  const S = ${JSON.stringify(pathToFileURL(SRC).href)};
  const store = await import(S + '/svcmon/store.js');
  const poller = await import(S + '/svcmon/poller.js');
  const express = (await import(${JSON.stringify(import.meta.resolve('express'))})).default;
  const { svcmonRouter } = await import(S + '/routes/svcmon.js');
  const t = store.addTarget({ kind: 'infra', path: 'Poland', name: 'pl-dc1', host: '127.0.0.1' });
  store.addTest(t.id, { type: 'tcp', name: 'tcp-1', port: 1, intervalSec: 60 });
  const ran = await poller.runNow();
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { req.user = { username: 't', role: 'admin' }; next(); });
  app.use('/api/svcmon', svcmonRouter);
  const srv = app.listen(0, '127.0.0.1'); await new Promise((r) => srv.once('listening', r));
  const base = 'http://127.0.0.1:' + srv.address().port + '/api/svcmon';
  const rr = await fetch(base + '/refresh', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  const body = await rr.json();
  const st = await (await fetch(base + '/state?limit=1')).json();
  srv.close();
  console.log(JSON.stringify({ role: poller.pollerRole(), ran, results: poller.getResults().size, lastCount: poller.pollerStats().lastCount, status: rr.status, body, executes: st.executes }));
  process.exit(0);
`;

test('R4-D3-3 · SVCMON_ROLE=central 이면 runNow 가 점검하지 않고 /refresh 는 409 · /state.executes=false', () => {
  const o = runChild({ SVCMON_ROLE: 'central', SVCMON_ENABLED: 'true' }, childScript());
  assert.equal(o.role.executes, false);
  assert.equal(o.ran, false, '중앙에서 runNow 가 실행됐다');
  assert.equal(o.results, 0, '중앙이 원격 대상을 직접 찔러 결과가 남았다');
  assert.equal(o.lastCount, 0);
  assert.equal(o.status, 409, JSON.stringify(o.body));
  assert.equal(o.body.reason, 'not-executing');
  assert.equal(o.executes, false);
});

test('R4-D3-3 · 킬스위치(SVCMON_ENABLED=false)는 수동 경로로도 우회되지 않는다', () => {
  const o = runChild({ SVCMON_ROLE: '', SVCMON_ENABLED: 'false' }, childScript());
  assert.equal(o.ran, false);
  assert.equal(o.results, 0);
  assert.equal(o.status, 409);
  assert.equal(o.body.reason, 'disabled');
});

test('R4-D3-3 · 기본 역할은 예전처럼 runNow 가 실행된다(svcmon.test.js·audit2719a1 고정 유지)', () => {
  const o = runChild({ SVCMON_ROLE: '', SVCMON_ENABLED: 'true' }, childScript());
  assert.equal(o.role.executes, true);
  assert.equal(o.ran, true);
  assert.equal(o.results, 1);
  assert.notEqual(o.status, 409);
  assert.equal(o.executes, true);
});

/* ── D3-4 · D3-5 ── */
const EDGE = await import('../src/central/svcmonEdge.js');
const BASE_TS = Math.floor(Date.now() / 3_600_000) * 3_600_000; // 정시 경계로 고정(docs/rules/common.md)

test('R4-D3-4 · 같은 측정 재전송의 지연이 1ms 씩 줄어도 행·메타가 GC 되지 않는다(재현 repro_edge_gc)', () => {
  EDGE._resetEdgeCache();
  const M = BASE_TS;
  const meta = [{ i: 't-cert', p: 'PL', n: 'pl-web', h: '10.1.1.1', t: 'cert', y: 'cert', iv: 300 },
    { i: 't-ping', p: 'PL', n: 'pl-web', h: '10.1.1.1', t: 'ping', y: 'ping', iv: 60 }];
  const lat = [820, 819, 818, 817];
  for (let k = 0; k < lat.length; k += 1) {
    const at = M + 60_000 * k;
    const recv = at + lat[k];
    const rows = [{ i: 't-cert', s: 'ok', r: 'D-80', m: 30, k: k + 1, a: at - M }, { i: 't-ping', s: 'ok', r: '1 ms', m: 1, k: k + 1, a: 0 }];
    const r = EDGE.ingestReport('PL-EDGE', { snapId: at * 1000, seq: 1, total: 1, rows, meta: k === 0 ? meta : undefined, metaSig: 's1', items: 2, reported: 2 }, recv);
    const st = EDGE.edgeState('PL-EDGE', {}, recv);
    const ids = st.items.map((x) => x.id).sort();
    assert.deepEqual(ids, ['t-cert', 't-ping'], `push ${k + 1}: ${JSON.stringify(ids)}`);
    assert.ok(st.items.every((x) => x.target), `push ${k + 1}: 메타가 지워졌다`);
    assert.equal(r.needMeta, false, `push ${k + 1}: needMeta 반복`);
  }
});

test('R4-D3-4 · 건너뛴 행은 값(최신 측정)을 유지한다 — measuredAt 최댓값 채택 규칙', () => {
  EDGE._resetEdgeCache();
  const recv = BASE_TS + 10_000;
  const meta = [{ i: 'x', p: 'P', n: 'n', h: 'h', t: 'x', y: 'tcp', iv: 60 }];
  EDGE.ingestReport('E9', { snapId: 1, seq: 1, total: 1, rows: [{ i: 'x', s: 'bad', r: 'new', m: 5, k: 1, a: 0 }], meta, metaSig: 's', items: 1, reported: 1 }, recv);
  // 더 오래된 측정(a 큼)이 늦게 와도 값은 바뀌지 않는다
  EDGE.ingestReport('E9', { snapId: 2, seq: 1, total: 1, rows: [{ i: 'x', s: 'ok', r: 'old', m: 1, k: 1, a: 5_000 }], metaSig: 's', items: 1, reported: 1 }, recv + 1);
  const it = EDGE.edgeState('E9', {}, recv + 2).items.find((x) => x.id === 'x');
  assert.equal(it.reply, 'new');
  assert.equal(it.status, 'bad');
});

function regressPush(agent, recv, snapMs, ids) {
  return EDGE.ingestReport(agent, {
    snapId: snapMs * 1000, seq: 1, total: 1, items: ids.length, reported: ids.length,
    rows: ids.map((i) => ({ i, s: 'ok', r: 'x', m: 1, k: 1, a: 0 })),
    meta: ids.map((i) => ({ i, p: 'P', n: 'n', h: 'h', t: i, y: 'tcp', iv: 60 })), metaSig: 's',
  }, recv);
}

test('R4-D3-5 · snapId 역행 보류에는 시한이 있다 — 시한 뒤 엣지에서 지운 점검이 정리된다(재현 repro_snap_regress)', () => {
  EDGE._resetEdgeCache();
  let recv = BASE_TS;
  recv += 60_000; regressPush('E1', recv, recv + 2 * 3_600_000, ['a', 'b']); // 엣지 시계 +2h 인 동안의 완결
  // 바로잡힌 직후: 역행 즉시 GC 금지 — b 가 아직 남아 있어야 한다(늦게 온 옛 청크가 대량 삭제하지 않게)
  recv += 60_000; regressPush('E1', recv, recv, ['a']);
  assert.equal(EDGE.edgeSummary(recv)[0].rows, 2, '역행 즉시 GC 했다');
  // 시한(REGRESS_GC_HOLD_MS)을 넘길 때까지 보고 → 재기준 후 b 정리
  const steps = Math.ceil(EDGE.REGRESS_GC_HOLD_MS / 60_000) + 2;
  for (let k = 0; k < steps; k += 1) { recv += 60_000; regressPush('E1', recv, recv, ['a']); }
  const s = EDGE.edgeSummary(recv)[0];
  assert.equal(s.rows, 1, `시한 뒤에도 GC 보류 중: ${JSON.stringify(s.counts)}`);
  assert.equal(s.counts.stale, 0);
  // 재기준 뒤에는 정상 순행 GC 가 다시 돈다
  recv += 60_000; regressPush('E1', recv, recv, ['a', 'c']);
  recv += 60_000; regressPush('E1', recv, recv, ['c']);
  recv += 60_000; regressPush('E1', recv, recv, ['c']);
  assert.equal(EDGE.edgeSummary(recv)[0].rows, 1);
});

test('R4-D3-5 · 보류 시한은 받는 쪽 행 낡음 판정(기본 5분)보다 짧다', () => {
  assert.ok(EDGE.REGRESS_GC_HOLD_MS < 5 * 60_000, String(EDGE.REGRESS_GC_HOLD_MS));
  assert.ok(EDGE.REGRESS_GC_HOLD_MS > 0);
});

/* ── D3-6 ── */
test('R4-D3-6 · ping 출력 판독 — 영어·한국어 Windows·Linux, RTT 를 못 읽으면 null(0 이 아니다)', async () => {
  const { parsePingOutput } = await import('../src/util/ping.js');
  assert.deepEqual(parsePingOutput('64 bytes from 10.0.0.1: icmp_seq=1 ttl=64 time=0.512 ms'), { alive: true, rttMs: 0.512 });
  assert.deepEqual(parsePingOutput('Reply from 10.0.0.1: bytes=32 time<1ms TTL=128'), { alive: true, rttMs: 1 });
  assert.deepEqual(parsePingOutput('10.0.0.1의 응답: 바이트=32 시간<1ms TTL=128'), { alive: true, rttMs: 1 });
  assert.deepEqual(parsePingOutput('10.0.0.1의 응답: 바이트=32 시간=3ms TTL=128'), { alive: true, rttMs: 3 });
  assert.deepEqual(parsePingOutput('Antwort von 10.0.0.1: Bytes=32 Zeit=3ms TTL=128'), { alive: true, rttMs: null }, '모르는 로케일은 null');
  assert.deepEqual(parsePingOutput('Reply from 10.0.0.1: bytes=32 time=3ms TTL=128', new Error('x')), { alive: false, rttMs: null });
  assert.deepEqual(parsePingOutput(''), { alive: false, rttMs: null });
  // 큰 출력도 앞부분만 보고 선형(ReDoS 회귀는 비율로 — 절대 ms 단언 금지)
  const t0 = process.hrtime.bigint(); parsePingOutput('time='.repeat(100)); const small = Number(process.hrtime.bigint() - t0);
  const t1 = process.hrtime.bigint(); parsePingOutput('time='.repeat(2_000_000)); const big = Number(process.hrtime.bigint() - t1);
  assert.ok(big < Math.max(small, 1e6) * 200, `small=${small} big=${big}`);
});

test('R4-D3-6 · svcmon ping 은 RTT 미상을 0ms 로 기록하지 않는다 · 중앙은 엣지의 null ms 를 0 으로 바꾸지 않는다', () => {
  const src = stripComments(read('svcmon/checker.js'));
  assert.doesNotMatch(src, /rttMs \?\? 0/, 'RTT 를 못 읽은 값을 0 으로 둔갑시킨다');
  assert.match(src, /ok\('응답함 · RTT 미상', null\)/);
  EDGE._resetEdgeCache();
  EDGE.ingestReport('E7', { snapId: 1, seq: 1, total: 1, rows: [{ i: 'p', s: 'ok', r: '응답함 · RTT 미상', m: null, k: 1, a: 0 }], meta: [{ i: 'p', p: 'P', n: 'n', h: 'h', t: 'p', y: 'ping', iv: 60 }], metaSig: 's', items: 1, reported: 1 }, BASE_TS);
  assert.equal(EDGE.edgeState('E7', {}, BASE_TS).items[0].ms, null);
});
