// 물리서버 기능 디버깅 회차 6(v3.52 — 5회차 수정 반영본 ae3d045c4 · 5축 × 1인) 회귀. 5회차 수정이 만든 회귀(멈춘 회차의 옛 기록 · 다시 켜기의 lp ·
//   긴급중단 중 이벤트 표지)와 남은 경로(lp 정책 넘겨받기 · 제품군 + 세대 권고 줄 · 평문 점검 import)를 동작으로 고정한다. 픽스처는 합성(SYNTH · example.test).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'bmdebug3-'));
const rmTmp = () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 정리 실패는 시험 결과가 아니다 */ } };
after(() => { rmTmp(); process.once('exit', rmTmp); });
Object.assign(process.env, { CONFIG_DIR: tmp, DATA_SOURCE: 'live', AUTH_ENABLED: 'true', SSRF_ALLOW_LOOPBACK: 'true', COLLECTOR_TOKEN: 'tok-dbg3' });
delete process.env.CENTRAL_URL;

const MIN = 60_000;
const step = (a, m) => ({ afterMin: a, emails: [m], channels: false, oncall: false });
const F = { id: 'pf', name: 'fault', agents: [], states: ['fault'], steps: [step(15, 'a1@example.test'), step(60, 'amgr@example.test'), step(240, 'adir@example.test')] };
const W = { id: 'pw', name: 'warn', agents: [], states: ['warn'], steps: [step(15, 'b1@example.test'), step(60, 'bmgr@example.test'), step(240, 'bdir@example.test')] };
const PN = { ...F, id: 'pnew', steps: [step(15, 'n1@example.test'), step(60, 'nmgr@example.test'), step(240, 'ndir@example.test')] };
const part = (state) => ({ agent: '', partKey: 'k1', state, scope: 'idrac', deviceId: 'SYNTH61', kind: 'disk', partId: 'p1' });
// v3.51 엔진이 남긴 꼴(정책 열 · ps 없음) — 이상 장애에 1선(15분) · 2선(60분)이 갔다
const legacy = () => ({ items: { '|k1': { since: 0, sig: 'x', sent: [[0, 15 * MIN, 'x', 'ok'], [1, 60 * MIN, 'x', 'ok']], ackedAt: null, ackBy: '' } }, enabledAt: 1 });
// escalationRun 과 같게 돈다 — 멈춘 회차(점검 꺼짐 · 데모)는 enabled:false 로 계획한다
async function run(at, from, to, stOf, init, paused = () => false, enabledAtOf = () => 1) {
  const X = await import('../src/partfault/escalation.js');
  let st = init; const got = [];
  for (let m = from; m <= to; m += 1) {
    const s0 = { enabled: true, enabledAt: enabledAtOf(m), oncall: {}, policies: at(m) };
    const pl = X.escalationPlan({ settings: paused(m) ? { ...s0, enabled: false } : s0, state: st, open: [part(stOf(m))], now: m * MIN });
    for (const s of pl.sends) got.push(`${m} ${s.policy.id}:${s.step + 2}${s.skipped.length ? '(건너뜀)' : ''}`);
    st = { items: X.recordSends(pl.items, pl.sends, pl.sends.map(() => ({ delivered: true })), m * MIN), enabledAt: pl.enabledAt };
  }
  return { got, st };
}

test('6회차 판정 #1 — 멈춘 회차에 업그레이드된 옛 기록: 멈춘 동안 새로 만든 정책은 넘겨받지 않는다(지금부터) · 그 동안 행 표지도 그 정책의 진행이 아니다', async () => {
  const X = await import('../src/partfault/escalation.js');
  const at = (m) => (m < 500 ? [F] : [PN]);
  const r = await run(at, 100, 1000, () => 'fault', legacy(), (m) => m < 700);
  assert.deepEqual(r.got, ['715 pnew:2', '760 pnew:3', '940 pnew:4'], '켠 때부터 1선 · 2선 · 3선 차례로(가장 높은 단계로 바로 가지 않음)');
  const mid = await run(at, 100, 600, () => 'fault', legacy(), () => true);
  assert.deepEqual(mid.st.items['|k1'].lp, ['pf'], '그때 있던 정책은 멈춘 회차에도 적는다');
  assert.ok(!mid.st.items['|k1'].pol, '멈춘 회차는 굳히지 않는다(5회차 판정 #1)');
  assert.equal(X.escalationMarkOf(part('fault'), mid.st.items, { enabled: true, enabledAt: 1, oncall: {}, policies: [PN] }, { why: 'partfault-off', heldKeys: new Set() }).step, null, '새 정책의 받는 곳은 아무것도 받지 않았다');
  assert.equal(X.escalationMarkOf(part('fault'), mid.st.items, { enabled: true, enabledAt: 1, oncall: {}, policies: [F] }, null).step, 3, '그때 있던 정책에는 옛 줄이 보인다');
});

test('6회차 판정 #2 — 단계 알림을 다시 켜면 그때 정책(lp)도 놓는다: 정책이 다시 덮는 때부터 1선부터', async () => {
  const stOf = (m) => (m < 100 ? 'fault' : m < 1000 ? 'warn' : 'fault');
  // 200 업그레이드(첫 회차 정책 밖 → 굳힘) → 300 끔 → 400 켬(아직 주의) → 1000 이상
  const r = await run(() => [F], 200, 1300, stOf, legacy(), (m) => m >= 300 && m < 400, (m) => (m < 400 ? 1 : 400 * MIN));
  assert.deepEqual(r.got, ['1015 pf:2', '1060 pf:3', '1240 pf:4'], '켠 때(400)부터 세어 앞 단계를 건너뛰지 않는다');
  // 업그레이드 첫 회차가 곧 다시 켜기(정책 밖) → 200 이상
  const r2 = await run(() => [F], 100, 500, (m) => (m < 200 ? 'warn' : 'fault'), legacy(), () => false, (m) => (m < 100 ? 1 : 100 * MIN));
  assert.deepEqual(r2.got, ['215 pf:2', '260 pf:3', '440 pf:4']);
});

test('6회차 판정 #3 — 굳힌 옛 기록에 lp 밖 정책이 먼저 덮어도, 원래 정책으로 돌아오면 이어받는다(같은 단계를 두 번 보내지 않음) · 표지와 엔진이 같다', async () => {
  const X = await import('../src/partfault/escalation.js');
  const at = (m) => (m < 1000 ? [F] : [F, W]);
  const stOf = (m) => (m < 100 ? 'fault' : m < 1300 ? 'warn' : 'fault');
  const before = await run(at, 200, 1299, stOf, legacy());
  assert.deepEqual(before.got, ['1015 pw:2', '1060 pw:3', '1240 pw:4']);
  assert.equal(X.escalationMarkOf(part('fault'), before.st.items, { enabled: true, enabledAt: 1, oncall: {}, policies: at(1300) }, null).step, 3, '돌아오기 직전 표지 — v3.51 에서 간 단계');
  const r = await run(at, 1300, 1700, () => 'fault', before.st);
  assert.deepEqual(r.got, ['1300 pf:4'], '1선 · 2선은 다시 보내지 않고 남은 3선만');
  assert.equal(X.escalationMarkOf(part('fault'), r.st.items, { enabled: true, enabledAt: 1, oncall: {}, policies: at(1300) }, null).step, 4);
});

test('6회차 판정 #4 — 제품군 + 세대 낱말뿐인 권고 줄은 그 제품군 모델에만(다른 제조사 같은 세대에 맞지 않음)', async () => {
  const A = await import('../src/bmcheck/advisory.js');
  const m = (server, row) => A.modelTokensMatch(server, row);
  assert.deepEqual([m('PRIMERGY RX2540 M5', 'PRIMERGY M5'), m('System x3650 M5 -[8871AC1]-', 'PRIMERGY M5'), m('UCSB-B200-M5', 'PRIMERGY M5')], [true, false, false]);
  assert.deepEqual([m('ProLiant DL380 Gen10', 'ProLiant Gen10'), m('Synergy 480 Gen10 Compute Module', 'ProLiant Gen10'), m('Apollo 4200 Gen10', 'HPE ProLiant Gen10 Servers')], [true, false, false]);
  assert.deepEqual([m('UCSB-B200-M5', 'UCS M5'), m('PRIMERGY RX2540 M5', 'UCS M5'), m('PRIMERGY RX2540 M6', 'Cisco UCS M6')], [true, false, false]);
  assert.deepEqual([m('ProLiant DL380 Gen10', 'DL380 Gen10'), m('PowerEdge R740xd', 'R740xd'), m('ThinkSystem SR650 V2', 'ThinkSystem V2')], [true, true, true], '모델 낱말이 있는 줄 · 제품군 + 판 줄은 그대로');
  const csv = 'advisory_id,component_type,model,fixed_version\nFJ-1,BIOS,Fujitsu PRIMERGY M5,1.40.0\n';
  const rows = A.parseAdvisoryCsv(csv).rows;
  const tbl = rows.map((r) => r.model);
  assert.equal(tbl.length, 1);
  assert.equal(m('System x3650 M5 -[8871AC1]-', tbl[0]), false, '검증 ‘맞지 않는 줄’ 이 이 줄을 알리게 된다(같은 판정)');
});

test('6회차 보안 #1 — 손상된 설정 파일이 있어도 평문 점검은 그 파일만 ‘파싱 실패’ 로 남기고 끝까지 돈다(500 아님)', async () => {
  fs.writeFileSync(path.join(tmp, 'bm-events.json'), '{"secret":"abc');   // 잘린 JSON
  const S = await import('../src/security/secretScan.js');
  const r = await S.runSecretScan({ fresh: true, sourceDirs: [] });
  const row = r.configFiles.find((f) => f.file === 'bm-events.json');
  assert.ok(row, '손상 파일 행이 있다');
  assert.match(row.note, /^파싱 실패\(/);
  assert.doesNotMatch(row.note, /abc/, '파일 조각을 싣지 않는다');
  fs.rmSync(path.join(tmp, 'bm-events.json'), { force: true });
});

test('6회차 보안 #2 — 긴급중단 중에 받은 이벤트는 재읽기 표지를 남긴다(해제 뒤 첫 주기가 다시 읽음) · 이벤트 읽기는 못 읽은 서버를 돌려준다', async () => {
  const ES = await import('../src/security/emergencyStop.js');
  const C = await import('../src/idrac/invCache.js');
  const P = await import('../src/idrac/poller.js');
  const E = await import('../src/idrac/eventSub.js');
  const registry = await import('../src/idrac/registry.js');
  registry.importServers([{ id: 'es-1', name: 'synth-es1', host: 'https://192.0.2.61', username: 'u', password: 'p', serviceTag: 'SYNTHES1' }], 'replace');
  C.setInventory('es-1', { collectedAt: Date.now(), system: {} });   // 방금 읽음 — 나이로는 다시 읽지 않는다
  ES.setEmergencyStop(true, ['synthA', 'synthB']);
  try {
    const r = await P.pollNowForEvent(['es-1']);
    assert.deepEqual([r.busy, r.invRefreshed, r.unread], [false, 0, ['es-1']], '긴급중단이면 읽지 않고 못 읽은 서버로 돌려준다');
    E._resetEventsForTest(); E._setEventDepsForTest({ debounceMs: 5 });   // runCheck 는 기본(실제 폴러)
    const s = { enabled: true, base: 'https://portal.example.test', secret: 'E'.repeat(43), ctxKey: 'F'.repeat(43) };
    E.acceptEvents(s, { context: E.contextOf(s, 'es-1'), events: [{ sev: 'critical', msgId: 'PSU0001' }] });
    for (let i = 0; i < 200 && !(E.eventStatus().checkedAt && !E.eventStatus().running); i += 1) await new Promise((res) => setTimeout(res, 10));
    assert.deepEqual([C.isForcedStale('es-1'), C.inventoryStale('es-1', 30 * MIN)], [true, true], '해제 뒤 첫 정규 주기가 인벤토리를 다시 읽고 urgent 로 보낸다');
  } finally {
    ES.setEmergencyStop(false, ['synthA', 'synthB']);
    E._setEventDepsForTest(null); E._resetEventsForTest(); C.removeInventory('es-1');
  }
});

test('6회차 엣지 #2 — 느린 서버가 든 묶음에서도 빠른 서버의 판정은 그 서버를 다시 읽은 직후(묶음 끝까지 기다리지 않음) · 판정은 겹치면 한 번 · 마지막 판정은 느린 서버까지', async (t) => {
  const express = (await import('express')).default;
  const C = await import('../src/idrac/invCache.js');
  const health = { s: 'OK', f: 'OK' };
  const app = express();
  app.use('/bmc/:box', async (req, res) => {
    const box = req.params.box; const u = req.url.split('?')[0];
    await new Promise((r) => setTimeout(r, box === 's' ? 120 : 2));
    if (u === '/redfish/v1/Systems') return res.json({ Members: [{ '@odata.id': '/redfish/v1/Systems/System.Embedded.1' }] });
    if (u === '/redfish/v1/Systems/System.Embedded.1') return res.json({ SKU: `SYNTHJ${box}`, Model: 'PowerEdge R650', PowerState: 'On', Status: { Health: health[box] } });
    if (u === '/redfish/v1/Chassis') return res.json({ Members: [{ '@odata.id': '/redfish/v1/Chassis/System.Embedded.1' }] });
    if (u.includes('/Power')) return res.json({ PowerControl: [{ PowerConsumedWatts: 300 }] });
    if (u.includes('/Thermal')) return res.json({ Temperatures: [{ Name: 'Inlet', ReadingCelsius: 22 }], Fans: [] });
    return res.json({ Members: [] });
  });
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  t.after(() => { srv.closeAllConnections?.(); srv.close(); });
  const base = `http://127.0.0.1:${srv.address().port}/bmc`;
  const registry = await import('../src/idrac/registry.js');
  registry.importServers(['s', 'f'].map((b) => ({ id: `j-${b}`, name: `synth-j${b}`, host: `${base}/${b}`, username: 'u', password: 'p', serviceTag: `SYNTHJ${b}` })), 'replace');
  for (const b of ['s', 'f']) C.setInventory(`j-${b}`, { collectedAt: Date.now(), system: { health: 'OK' } });
  const E = await import('../src/idrac/eventSub.js');
  E._resetEventsForTest();
  const judged = [];
  E._setEventDepsForTest({ debounceMs: 5, judgeGapMs: 50, judge: async () => { judged.push([C.getInventory('j-f')?.system?.health, C.getInventory('j-s')?.system?.health]); } });
  try {
    health.s = 'Critical'; health.f = 'Critical';
    const s = { enabled: true, base: 'https://portal.example.test', secret: 'E'.repeat(43), ctxKey: 'F'.repeat(43) };
    E.acceptEvents(s, { context: E.contextOf(s, 'j-s'), events: [{ sev: 'critical' }] });
    E.acceptEvents(s, { context: E.contextOf(s, 'j-f'), events: [{ sev: 'critical' }] });
    for (let i = 0; i < 1500 && !(E.eventStatus().checkedAt && !E.eventStatus().running); i += 1) await new Promise((r) => setTimeout(r, 10));
    assert.ok(E.eventStatus().checkedAt, '묶음이 끝났다');
    // 9회차 — 묶음은 마지막 판정을 기다리지 않고 끝난다(판정은 뒤에서 끝까지) — 마지막 판정까지 기다린다
    for (let i = 0; i < 300 && !(judged.length && judged.at(-1)[1] === 'Critical'); i += 1) await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(judged[0], ['Critical', 'OK'], '첫 판정은 빠른 서버를 다시 읽은 직후 — 느린 서버는 아직 읽는 중');
    assert.deepEqual(judged.at(-1), ['Critical', 'Critical'], '마지막 판정은 느린 서버까지 본다');
    assert.ok(judged.length <= 3, `판정은 겹치면 한 번으로 묶는다(${judged.length}회)`);
  } finally { E._setEventDepsForTest(null); E._resetEventsForTest(); C.removeInventory('j-s'); C.removeInventory('j-f'); }
});

test('6회차 성능 P1 — 동시 상한 1 에서 주기 도중 온 이벤트 읽기는 그 주기의 다음 서버보다 먼저 자리를 잡지 않는다(정규 대기자 먼저)', async (t) => {
  const express = (await import('express')).default;
  const { config } = await import('../src/config.js');
  const keep = config.idrac.pollConcurrency;
  config.idrac.pollConcurrency = 1;
  const log = []; let firstR1 = null; const r1Seen = new Promise((r) => { firstR1 = r; });
  const app = express();
  app.use('/bmc/:box', async (req, res) => { log.push(req.params.box); if (req.params.box === 'r1') firstR1(); await new Promise((r) => setTimeout(r, 15)); res.status(404).end(); });
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  t.after(() => { config.idrac.pollConcurrency = keep; srv.closeAllConnections?.(); srv.close(); });
  const base = `http://127.0.0.1:${srv.address().port}/bmc`;
  const registry = await import('../src/idrac/registry.js');
  registry.importServers(['r1', 'r2', 'r3', 'x'].map((b) => ({ id: `p1-${b}`, name: `synth-p1${b}`, host: `${base}/${b}`, username: 'u', password: 'p', serviceTag: `SYNTHP1${b}` })), 'replace');
  const P = await import('../src/idrac/poller.js');
  const cyc = P.pollNowManual();
  await r1Seen;   // 주기가 첫 서버를 읽는 중
  const ev = P.pollNowForEvent(['p1-x']);
  const [m] = await Promise.all([cyc, ev]);
  assert.equal(m.ran, true);
  const firstX = log.indexOf('x');
  const lastR = Math.max(log.lastIndexOf('r2'), log.lastIndexOf('r3'));
  assert.ok(firstX > lastR, `주기의 r2 · r3 를 다 읽은 뒤에야 x 를 읽는다(순서 ${[...new Set(log)].join('→')})`);
});
