/**
 * test/audit2785d.test.js — v2.785 점검(GE 묶음) 회귀.
 *
 *  ① E-B3  통신 점검 SSH 단계(`linkcheck/protocols.js stepSsh`): 협상 전에 상대가 끊으면 'reset' 이다.
 *     예전에는 ssh2 의 'Connection lost before handshake' 가 phases.js 의 /handshake/i 에 걸려 'tls-fail'(조치가 정반대)이 되고,
 *     배너를 보낸 뒤 닫는 장비는 'close' 처리기가 없어 시한(12초)을 다 기다린 뒤 'timeout'(방화벽 안내)이 됐다.
 *  ② A-B3  `collector/upgradePush.js mergeAutoPushStatus`: 스스로 새 판이 된 수집 서버(pull 상태 version ≥ 결과 판)에
 *     파일에 남은 '업그레이드 실패(자동)' 를 다시 칠하지 않는다. 버전을 못 읽으면 실패를 그대로 둔다(못 읽음 ≠ 성공).
 *  ③ O-B1  토큰 점검 프로브 보관분이 등록부 토큰·URL 변경, 나이와 무관하게 '정상·같음(증명)' 으로 남던 것.
 *  ④ 개선  PORTALCHECK_BUDGET_MS 상한(웹 요청 시한 180초보다 짧게).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { stepSsh } from '../src/linkcheck/protocols.js';
import { mergeAutoPushStatus } from '../src/collector/upgradePush.js';
import { scanTokens, mergeProbe, withRowStates, kpisOf, rowStateOf, PROBE_STATE, ROW_STATE } from '../src/portalcheck/tokenScan.js';
import { probeAll, putProbeResults, listProbeResults, _resetProbeStore, PROBE_BUDGET_MS } from '../src/portalcheck/tokenProbe.js';
import { tokenFingerprintParts } from '../src/util/tokenFingerprint.js';
import { STALE_MS as EDGE_REPORT_STALE_MS } from '../src/central/tokenCheckPull.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/* ── ① E-B3 ───────────────────────────────────────────────────────────── */

/** 접속을 받는 즉시 `onConn(sock)` 을 부르는 루프백 TCP 서버. */
async function tcpServer(onConn) {
  const socks = new Set();
  const srv = net.createServer((sock) => { socks.add(sock); sock.on('error', () => {}); onConn(sock); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return {
    port: srv.address().port,
    close: () => new Promise((r) => { for (const k of socks) k.destroy(); srv.close(() => r()); }),
  };
}

test('① E-B3: 접속 직후 닫는 장비는 reset 이다(TLS 실패가 아니다)', async () => {
  const s = await tcpServer((sock) => sock.destroy());
  try {
    const r = await stepSsh('127.0.0.1', s.port, { timeoutMs: 4_000 });
    assert.equal(r.ok, false);
    assert.equal(r.failKind, 'reset', JSON.stringify(r));
    assert.notEqual(r.failKind, 'tls-fail');
    assert.match(r.error, /MaxStartups|접근 제한|닫/);
  } finally { await s.close(); }
});

test('① E-B3: 배너를 보낸 뒤 닫는 장비도 reset 이고, 시한을 기다리지 않는다', async () => {
  const s = await tcpServer((sock) => { sock.end('SSH-2.0-OpenSSH_8.0\r\n'); });
  try {
    const timeoutMs = 4_000;
    // stepSsh 의 시한 타이머는 unref 다 — 고치기 전 판본에서 이벤트 루프가 비어 테스트가 취소되지 않게 붙잡아 둔다.
    const keep = setTimeout(() => {}, timeoutMs + 2_000);
    const t0 = Date.now();
    const r = await stepSsh('127.0.0.1', s.port, { timeoutMs }).finally(() => clearTimeout(keep));
    const took = Date.now() - t0;
    assert.equal(r.ok, false);
    assert.equal(r.failKind, 'reset', JSON.stringify(r));
    assert.ok(took < timeoutMs / 2, `시한(${timeoutMs}ms)을 기다리면 안 된다: ${took}ms`);
  } finally { await s.close(); }
});

test('① E-B3: 소스 — phases.js 는 그대로 두고 stepSsh 안에서만 고친다(close 처리기 · 협상 전 끊김 분류)', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(path.join(HERE, '../src/linkcheck/protocols.js'), 'utf8');
  const body = src.slice(src.indexOf('export async function stepSsh'), src.indexOf('export function stepSmtp'));
  assert.match(body, /conn\.on\('close'/, 'close 처리기가 있어야 배너 뒤 끊김이 시한까지 가지 않는다');
  assert.match(body, /connection lost before handshake/i);
});

/* ── ② A-B3 ───────────────────────────────────────────────────────────── */

const LAST = { at: 1_000_000, version: '2.785.0', collectorPush: { total: 1, ok: 0, items: [{ id: 'c1', name: 'C1', ok: false, status: 0, reason: 'connect ETIMEDOUT' }] } };

test('② A-B3: pull 상태 판이 결과 판과 같거나 높으면 자동 실패를 칠하지 않는다', () => {
  const same = mergeAutoPushStatus({ c1: { ok: true, version: '2.785.0' } }, LAST);
  assert.equal(same.c1.upgrade, undefined, '스스로 새 판이 됐는데 빨간 실패가 남는다');
  assert.equal(same.c1.version, '2.785.0');
  const higher = mergeAutoPushStatus({ c1: { ok: true, version: '2.786.1' } }, LAST);
  assert.equal(higher.c1.upgrade, undefined);
});

test('② A-B3: 판이 낮거나 못 읽으면 실패를 그대로 둔다(못 읽음 ≠ 성공)', () => {
  const lower = mergeAutoPushStatus({ c1: { ok: true, version: '2.784.0' } }, LAST);
  assert.equal(lower.c1.upgrade.ok, false);
  assert.equal(lower.c1.upgrade.auto, true);
  // ⚠ cmpVersion 은 못 읽으면 null 이고 `null >= 0` 은 JS 에서 true 다 — 그 함정에 빠지면 아래가 깨진다.
  const none = mergeAutoPushStatus({ c1: { ok: true } }, LAST);
  assert.equal(none.c1.upgrade?.ok, false, '버전이 없으면 실패를 지우면 안 된다');
  const absent = mergeAutoPushStatus({}, LAST);
  assert.equal(absent.c1.upgrade?.ok, false);
  const junk = mergeAutoPushStatus({ c1: { version: 'dev' } }, LAST);
  assert.equal(junk.c1.upgrade?.ok, false);
});

test('② A-B3: 항목 판(it.version)이 있으면 그것과 비교하고, 성공 항목은 그대로 기록한다', () => {
  const lr = { ...LAST, collectorPush: { items: [{ id: 'c1', ok: false, version: '2.790.0', reason: 'x' }, { id: 'c2', ok: true, version: '2.785.0' }] } };
  const st = mergeAutoPushStatus({ c1: { version: '2.785.0' }, c2: { version: '2.785.0' } }, lr);
  assert.equal(st.c1.upgrade?.ok, false, '항목 판(2.790.0)보다 낮으면 실패 유지');
  assert.equal(st.c2.upgrade?.ok, true, '성공 항목은 판과 무관하게 기록');
});

/* ── ③ O-B1 ───────────────────────────────────────────────────────────── */

const TOK_A = '9f3c1a7be2d84f06a5c1e9b7d2f04a6c8e1b3d5f';
const TOK_B = '0b7e2d9c4a1f3e5d7c9b1a3f5e7d9c1b3a5f7e9d';
const URL_A = 'https://kr.example:3001';
const mk = (token, url = URL_A) => scanTokens({
  collectors: [{ id: 'kr-edge', name: 'kr-edge', url, token }],
  sharedCentralToken: 'C', sharedCollectorToken: '', agentTokens: [{ agent: 'kr-edge' }],
  deployTargets: [], knownAgents: ['kr-edge'], status: {}, minEdgeVersion: '2.560.0',
});
const okProbe = (at) => ({ at, ms: 900, state: PROBE_STATE.OK, httpStatus: 200, evidence: 'proven-same' });

test('③ O-B1: probeAll 은 결과에 프로브 당시 등록부 지문(8자)·URL 을 함께 싣는다(평문·전체 해시는 없다)', async () => {
  const row = mk(TOK_A).rows[0];
  const fake = async () => ({ status: 200, ok: true, json: async () => ({ ok: true, agent: 'kr-edge' }) });
  const out = await probeAll([row], { tokenOf: () => TOK_A, fetchImpl: fake, budgetMs: 60_000, timeoutMs: 2_000, withCentralRole: false });
  const p = out.probes[0];
  assert.equal(p.probe.state, PROBE_STATE.OK);
  assert.equal(p.tokenShort, tokenFingerprintParts(TOK_A).short);
  assert.equal(p.tokenShort.length, 8);
  assert.equal(p.url, URL_A);
  const json = JSON.stringify(out);
  assert.ok(!json.includes(TOK_A), '평문');
  assert.deepEqual(json.match(/[0-9a-f]{40,}/g) || [], [], '전체 해시');
  _resetProbeStore();
  putProbeResults(out.probes);
  const kept = listProbeResults()[0];
  assert.equal(kept.tokenShort, p.tokenShort, '보관소도 지문을 함께 둔다');
  assert.equal(kept.url, URL_A);
  _resetProbeStore();
});

test('③ O-B1: 등록부 수집 토큰이 바뀐 뒤의 옛 프로브는 증명이 아니다(not-run)', () => {
  const now = Date.now();
  const probes = [{ agent: 'kr-edge', probe: okProbe(now - 60_000), centralRole: null, tokenShort: tokenFingerprintParts(TOK_A).short, url: URL_A }];
  const same = withRowStates(mergeProbe(mk(TOK_A), probes, { now }));
  assert.equal(same.rows[0].probe.state, PROBE_STATE.OK, '같은 값이면 그대로');
  assert.equal(same.rows[0].state, ROW_STATE.OK);

  const changed = withRowStates(mergeProbe(mk(TOK_B), probes, { now }));
  const r = changed.rows[0];
  assert.equal(r.probe.state, PROBE_STATE.NOT_RUN, '토큰이 바뀌었는데 같음(증명)이 남는다');
  assert.equal(r.probe.changed, true);
  assert.match(r.probe.reason, /바뀐 뒤/);
  assert.notEqual(r.state, ROW_STATE.OK);
  const k = kpisOf(changed);
  assert.equal(k.ok, 0); assert.equal(k.probeOk, 0); assert.equal(k.measured, 0); assert.equal(k.okRate, null);
});

test('③ O-B1: 등록부 URL 이 바뀐 뒤의 옛 프로브도 not-run 이다', () => {
  const now = Date.now();
  const probes = [{ agent: 'kr-edge', probe: okProbe(now - 60_000), centralRole: null, tokenShort: tokenFingerprintParts(TOK_A).short, url: URL_A }];
  const s = withRowStates(mergeProbe(mk(TOK_A, 'https://kr2.example:3001'), probes, { now }));
  assert.equal(s.rows[0].probe.state, PROBE_STATE.NOT_RUN);
  // 끝 슬래시 차이는 같은 주소다(프로브가 base() 로 다듬는다).
  const s2 = withRowStates(mergeProbe(mk(TOK_A, `${URL_A}/`), probes, { now }));
  assert.equal(s2.rows[0].probe.state, PROBE_STATE.OK);
});

test('③ O-B1: 낡은 프로브(낡음 경계 초과)는 정상으로 세지 않고 나이를 싣는다', () => {
  const now = Date.now();
  const old = now - 3 * 86_400_000;
  const probes = [{ agent: 'kr-edge', probe: okProbe(old), centralRole: null, tokenShort: tokenFingerprintParts(TOK_A).short, url: URL_A }];
  const s = withRowStates(mergeProbe(mk(TOK_A), probes, { now }));
  const r = s.rows[0];
  assert.equal(r.probe.state, PROBE_STATE.OK, '응답 기록 자체는 지우지 않는다');
  assert.equal(r.probe.stale, true);
  assert.equal(r.probe.ageMs, now - old);
  assert.equal(r.probe.staleMs, EDGE_REPORT_STALE_MS);
  assert.equal(r.state, ROW_STATE.UNKNOWN, '3일 전 200 을 지금 정상이라 말하면 안 된다');
  const k = kpisOf(s);
  assert.equal(k.ok, 0); assert.equal(k.probeOk, 0); assert.equal(k.okRate, null, '낡은 응답은 지금 성공률에 넣지 않는다');
  // 경계 안이면 그대로 정상
  const fresh = withRowStates(mergeProbe(mk(TOK_A), [{ ...probes[0], probe: okProbe(now - 60_000) }], { now }));
  assert.equal(fresh.rows[0].probe.stale, false);
  assert.equal(fresh.rows[0].state, ROW_STATE.OK);
  // rowStateOf 단독(병합 밖)도 같은 판정
  assert.equal(rowStateOf({ ...fresh.rows[0], probe: { ...fresh.rows[0].probe, stale: true } }), ROW_STATE.UNKNOWN);
});

test('③ O-B1: 지문·URL 이 없는 옛 보관분(데모 시드 등)은 대조하지 않는다 — 나이 판정만', () => {
  const now = Date.now();
  const s = withRowStates(mergeProbe(mk(TOK_B), [{ agent: 'kr-edge', probe: okProbe(now - 60_000), centralRole: null }], { now }));
  assert.equal(s.rows[0].probe.state, PROBE_STATE.OK);
  assert.equal(s.rows[0].state, ROW_STATE.OK);
  // 시각이 없는 프로브(단위 테스트 입력 모양)는 낡음을 판정하지 않는다
  const noAt = withRowStates(mergeProbe(mk(TOK_B), [{ agent: 'kr-edge', probe: { state: PROBE_STATE.OK } }], { now }));
  assert.equal(noAt.rows[0].probe.stale, undefined);
  assert.equal(noAt.rows[0].state, ROW_STATE.OK);
});

/* ── ④ 개선: PORTALCHECK_BUDGET_MS 상한 ─────────────────────────────── */

function budgetWith(env) {
  const mod = path.join(HERE, '../src/portalcheck/tokenProbe.js');
  const out = execFileSync(process.execPath, ['--input-type=module', '-e',
    `const m = await import(${JSON.stringify(`file://${mod}`)}); process.stdout.write(String(m.PROBE_BUDGET_MS));`],
  { env: { ...process.env, PORTALCHECK_BUDGET_MS: env }, encoding: 'utf8' });
  return Number(out.trim());
}

test('④ PORTALCHECK_BUDGET_MS: 기본 90초 · 하한 10초 · 상한 150초(웹 요청 시한 180초보다 짧게)', () => {
  assert.equal(PROBE_BUDGET_MS > 0, true);
  assert.equal(budgetWith(''), 90_000);
  assert.equal(budgetWith('5000'), 10_000);
  assert.equal(budgetWith('120000'), 120_000);
  assert.equal(budgetWith('999999'), 150_000, '웹 백스톱(180초)이 먼저 끊으면 화면은 실패, 서버는 계속 돈다');
});
