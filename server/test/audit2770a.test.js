/**
 * v2.770 5회차 점검 — 수정 그룹 G1(SAN 스위치) 회귀 테스트.
 *
 *  E3-1 카운터 리셋·기준선 행 없음이 월간 점검 '포트 에러' 를 '정상' 으로 만들던 것(장비 항목·포트 표 한 판정 코어)
 *  E3-2 엣지 축약(slimSnapshot) 필터가 enc_in/out·loss_sig·disc_c3·rx=-9 포트를 빼고, 부분 스냅샷의 ok 를 그대로 내던 것
 *  E3-3 연결 테스트가 실장비 id 로 처리량 기준값(rates._prev)을 덮던 것
 *  E3-4 연결 테스트의 저장 비밀번호 승계가 host 만 비교하던 것(저장 경로와 같은 판정 공유)
 *  E3-5 parseTrunkShow·parseLsanShow '없음' 정규식의 O(n²)
 *  E3-6 주기 수집이 _inFlight 를 보지 않아 수동 수집 중인 스위치에 세션을 하나 더 열던 것(리드 추가 — 스토리지 E2-04 와 같은 구조)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { stripComments } from './_stripComments.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '..', 'src');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2770a-'));
process.env.CONFIG_DIR = TMP;
process.env.DB_DIR = TMP;
process.env.DATA_SOURCE = 'live';
process.env.AUTH_ENABLED = 'false';

const H = await import('../src/sanswitch/healthCheck.js');
const { slimSnapshot } = await import('../src/sanswitch/push.js');
const R = await import('../src/sanswitch/rates.js');
const { buildSnapshot: sshBuild } = await import('../src/sanswitch/collectors/fosSsh.js');
const { sanAccessMoved } = await import('../src/sanswitch/registry.js');
const P = await import('../src/sanswitch/collectors/fosParse.js');
const { setDataSource } = await import('../src/runtime-settings.js');
setDataSource('live');
const REG = await import('../src/sanswitch/registry.js');
const POLLER = await import('../src/sanswitch/poller.js');
test.after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* noop */ } });

const Z = { errCrc: 0, errEncIn: 0, errEncOut: 0, errLinkFail: 0, errLossSync: 0, errLossSig: 0, discC3: 0 };
const port = (o) => ({ index: 0, state: 'online', stateRaw: 'Online', ...Z, ...o });
const snapOf = (list, { omitted = 0, sections = {} } = {}) => ({
  deviceId: 'sw1', ok: true, collectedAt: 1, switchState: 'Online', health: {}, extra: {},
  sections: { counters: 'ok', sfp: 'ok', health: 'skip', ports: 'ok', ...sections },
  ports: { list, portsOmitted: omitted, online: list.length, licensed: list.length, free: 0 },
});
const item = (snap, key, opts) => H.checkDevice(snap, opts).items.find((x) => x.key === key);

/* ── E3-1 ─────────────────────────────────────────────────────────────────── */

test('E3-1 카운터 리셋(cur<base) 뒤 신규는 \'리셋 이후 최소\' 로 센다 — 장비 항목·포트 표 모두 ok 가 아니다', () => {
  const baseline = { at: 1, ports: { 0: { ...Z, errCrc: 10000 } } };
  const s = snapOf([port({ index: 0, errCrc: 500 })]);
  const it = item(s, 'portErrors', { baseline });
  assert.equal(it.status, 'bad', `리셋 뒤 500건 → 최소 500건 신규(100 이상): ${it.detail}`);
  assert.match(it.detail, /리셋 이후 최소 신규/);
  const row = H.checkPorts(s, { baseline }).rows[0];
  assert.equal(row.errors, 'bad');
  assert.equal(row.errNew, null, '리셋이면 \'신규 N\' 을 숫자로 말하지 않는다(sanHealth2521 규약 유지)');
  assert.equal(row.errNewMin, 500);
  assert.equal(row.errHeld, 'reset');
  // 작은 값이면 warn
  const small = snapOf([port({ index: 0, errCrc: 7 })]);
  assert.equal(item(small, 'portErrors', { baseline }).status, 'warn');
  assert.equal(H.checkPorts(small, { baseline }).rows[0].errors, 'warn');
});

test('E3-1 리셋 뒤 0건이면 \'신규 없음\' 이 아니라 보류(unknown)', () => {
  const baseline = { at: 1, ports: { 0: { ...Z, errCrc: 10000 } } };
  const s = snapOf([port({ index: 0, errCrc: 0 })]);
  const it = item(s, 'portErrors', { baseline });
  assert.equal(it.status, 'unknown', it.detail);
  assert.match(it.detail, /리셋/);
  const row = H.checkPorts(s, { baseline }).rows[0];
  assert.equal(row.errors, 'unknown');
  assert.equal(row.errHeld, 'reset');
});

test('E3-1 기준선에 행 자체가 없는 포트(누적>0)는 장비 항목도 ok 가 아니다 — 포트 표와 같은 판정', () => {
  const baseline = { at: 1, ports: { 0: { ...Z } } };
  const s = snapOf([port({ index: 0 }), port({ index: 1, errCrc: 300 })]);
  const it = item(s, 'portErrors', { baseline });
  assert.equal(it.status, 'warn', it.detail);
  assert.match(it.detail, /기준선에 없는 포트 1개/);
  const rows = H.checkPorts(s, { baseline }).rows;
  assert.equal(rows[1].errors, 'warn');
  assert.equal(rows[1].errHeld, 'noRow');
  // 행이 없어도 누적 0 이면 정상(에러가 한 번도 없었다)
  const clean = snapOf([port({ index: 0 }), port({ index: 1 })]);
  assert.equal(item(clean, 'portErrors', { baseline }).status, 'ok');
});

test('E3-1 행은 있고 키 하나만 없는 옛 기준선은 보류가 아니다(sanHealthCheck2519 유지)', () => {
  const baseline = { at: 1, ports: { 0: { errCrc: 40000 } } };
  const s = snapOf([port({ index: 0, errCrc: 40000 })]);
  assert.equal(item(s, 'portErrors', { baseline }).status, 'ok');
  assert.equal(H.checkPorts(s, { baseline }).rows[0].errors, 'ok');
});

test('E3-1 장비 항목과 포트 표가 같은 판정 함수를 쓴다(복제 금지 — 소스 스윕)', () => {
  const src = stripComments(fs.readFileSync(path.join(SRC, 'sanswitch/healthCheck.js'), 'utf8'));
  const body = (name) => { const i = src.indexOf(`function ${name}(`); return src.slice(i, src.indexOf('\n}\n', i)); };
  for (const fn of ['portErrorItem', 'checkPorts']) {
    assert.match(body(fn), /judgePortErrors\(/, `${fn} 가 공용 판정 코어를 써야 한다`);
    assert.doesNotMatch(body(fn), /errorDelta\(/, `${fn} 가 errorDelta 를 직접 돌리면 판정이 다시 두 벌이 된다`);
  }
});

/* ── E3-2 ─────────────────────────────────────────────────────────────────── */

test('E3-2 slimSnapshot 은 점검이 보는 에러 키 전부와 rx<=-9 포트를 남긴다', () => {
  const list = [
    port({ index: 0, discC3: 25000 }), port({ index: 1, errEncOut: 900 }), port({ index: 2, errEncIn: 3 }),
    port({ index: 3, errLossSig: 2 }), port({ index: 4, rxPowerDbm: -9 }), port({ index: 5, rxPowerDbm: -8.9 }),
    port({ index: 6, errCrc: '4' }),
  ];
  const kept = slimSnapshot(snapOf(list)).ports.list.map((p) => p.index);
  assert.deepEqual(kept, [0, 1, 2, 3, 4, 6]);
  assert.equal(slimSnapshot(snapOf(list)).ports.portsOmitted, 1);
});

test('E3-2 축약 스냅샷에서 이상이 정상으로 바뀌지 않는다(재현 slim.mjs)', () => {
  const list = [port({ index: 0, discC3: 25000 }), port({ index: 1, errEncOut: 900 }), port({ index: 2, state: 'disabled' })];
  const base = { at: 0, ports: { 0: { ...Z }, 1: { ...Z }, 2: { ...Z } } };
  const s2 = slimSnapshot(snapOf(list));
  assert.equal(item(s2, 'portErrors', { baseline: base }).status, 'bad');
});

test('E3-2 portsOmitted>0 이면 portErrors·optical 의 ok 를 \'일부 포트만\' warn 으로', () => {
  const list = [port({ index: 0, errCrc: 5, rxPowerDbm: -3 })];
  const base = { at: 0, ports: { 0: { ...Z, errCrc: 5 } } };
  const full = snapOf(list);
  assert.equal(item(full, 'portErrors', { baseline: base }).status, 'ok');
  assert.equal(item(full, 'optical', { baseline: base }).status, 'ok');
  const part = snapOf(list, { omitted: 40 });
  const pe = item(part, 'portErrors', { baseline: base });
  const op = item(part, 'optical', { baseline: base });
  assert.equal(pe.status, 'warn'); assert.match(pe.detail, /일부 포트만.*40개 누락/);
  assert.equal(op.status, 'warn'); assert.match(op.detail, /일부 포트만.*40개 누락/);
});

test('E3-2 올라온 포트가 0개인 부분 스냅샷은 \'카운터를 읽지 못했다\' 가 아니라 그 사유를 말한다', () => {
  const s = snapOf([], { omitted: 48 });
  const pe = item(s, 'portErrors', { baseline: { at: 0, ports: {} } });
  assert.equal(pe.status, 'unknown');
  assert.doesNotMatch(pe.detail, /읽지 못했습니다/);
  assert.match(pe.detail, /문제 포트만.*48개 누락/);
  assert.match(item(s, 'optical').detail, /문제 포트만/);
  assert.match(item(s, 'ports').detail, /문제 포트만/);
});

/* ── E3-3 ─────────────────────────────────────────────────────────────────── */

const SW = 'switchName: A\nswitchState: Online\nIndex Port Address Media Speed State Proto\n==============================================\n  0   0   010000   id    N16   Online      FC  F-Port  10:00:00:00:00:00:00:01\n';
const PE = (tx, rx) => '          frames      enc    crc    crc    too    too    bad    enc   disc   link   loss   loss   frjt   fbsy  c3timeout    pcs    uncor\n'
  + '       tx     rx      in    err    g_eof  shrt   long   eof     out   c3    fail    sync   sig\n'
  + `  0:  ${tx} ${rx}  0   0   0   0   0   0   0   0   0   0   0   0   0\n`;

test('E3-3 연결 테스트(noRates)는 처리량 기준값·마지막 결과를 덮지 않는다(재현 ratepollute.mjs)', () => {
  R._resetForTest();
  const HOUR = 3_600_000;
  const T0 = Math.floor(Date.now() / HOUR) * HOUR - 30 * 60_000;
  const dev = { id: 'sw-real', type: 'brocade', host: '10.0.0.1' };
  sshBuild(dev, { switchshow: SW, porterrshow: PE(1000000, 2000000) }, {}, {}, { countersAt: T0 });
  let s = sshBuild(dev, { switchshow: SW, porterrshow: PE(1003000, 2006000) }, {}, {}, { countersAt: T0 + 300_000 });
  const normal = [s.ports.list[0].inFps, s.ports.list[0].outFps];
  const lastBefore = JSON.stringify({ ...R.lastRateResult('sw-real'), calledAt: 0 });
  const t = sshBuild({ ...dev, host: '10.0.0.9' }, { switchshow: SW, porterrshow: PE(500, 900) }, {}, {}, { countersAt: T0 + 400_000, noRates: true });
  assert.equal(t.ports.list[0].inFps, null, '테스트 스냅샷의 처리량은 비운다');
  assert.equal(t.extra.rateReady, false);
  assert.equal(JSON.stringify({ ...R.lastRateResult('sw-real'), calledAt: 0 }), lastBefore, '_last 도 건드리지 않는다');
  s = sshBuild(dev, { switchshow: SW, porterrshow: PE(1006000, 2012000) }, {}, {}, { countersAt: T0 + 600_000 });
  assert.deepEqual([s.ports.list[0].inFps, s.ports.list[0].outFps], normal, `다음 주기 처리량이 테스트에 오염되면 안 된다(예전 10056/5028)`);
  R._resetForTest();
});

test('E3-3 testDeviceConnection 은 SSH·REST 수집 모두 noRates 로 부른다(소스 스윕)', () => {
  const src = stripComments(fs.readFileSync(path.join(SRC, 'sanswitch/poller.js'), 'utf8'));
  const i = src.indexOf('export async function testDeviceConnection(');
  const body = src.slice(i, src.indexOf('\n}\n', i));
  assert.match(body, /fosRest\.collect\([^)]*noRates:\s*true/);
  assert.match(body, /fosSsh\.collect\([^)]*noRates:\s*true/);
  const rest = stripComments(fs.readFileSync(path.join(SRC, 'sanswitch/collectors/fosRest.js'), 'utf8'));
  assert.match(rest, /noRates \? skipRates\(list\) : applyRates\(/);
});

/* ── E3-4 ─────────────────────────────────────────────────────────────────── */

test('E3-4 sanAccessMoved — host·계정·포트(같은 방식일 때만)가 바뀌면 승계 금지', () => {
  const ex = { host: '10.0.0.1', username: 'admin', collectMethod: 'ssh', sshPort: 22, httpsPort: 443 };
  const inp = (o) => ({ type: 'brocade', host: '10.0.0.1', username: 'admin', collectMethod: 'ssh', sshPort: 22, httpsPort: 443, ...o });
  assert.equal(sanAccessMoved(ex, inp({})), false, '같은 접속처');
  assert.equal(sanAccessMoved(ex, inp({ host: '10.0.0.9' })), true, 'host');
  assert.equal(sanAccessMoved(ex, inp({ username: 'root' })), true, 'username');
  assert.equal(sanAccessMoved(ex, inp({ sshPort: 2222 })), true, 'SSH 포트');
  assert.equal(sanAccessMoved(ex, inp({ httpsPort: 8443 })), false, 'SSH 방식이면 쓰지 않는 REST 포트는 비교하지 않는다');
  assert.equal(sanAccessMoved(ex, inp({ agent: 'edge-2' })), false, '수집 엣지 변경은 승계');
  assert.equal(sanAccessMoved(null, inp({})), false, '새 장비');
});

test('E3-4 연결 테스트 라우트는 host 단독 비교가 아니라 sanAccessMoved 를 쓴다(복제 금지)', () => {
  const route = stripComments(fs.readFileSync(path.join(SRC, 'routes/api/sanSwitch.js'), 'utf8'));
  const i = route.indexOf("api.post('/tools/sanswitch/test'");
  const body = route.slice(i, route.indexOf('\n});', i));
  assert.match(body, /sanAccessMoved\(saved, b\)/);
  assert.doesNotMatch(body, /saved\.host\s*===/);
  const reg = stripComments(fs.readFileSync(path.join(SRC, 'sanswitch/registry.js'), 'utf8'));
  const j = reg.indexOf('export function saveDevice(');
  assert.match(reg.slice(j, reg.indexOf('\n}\n', j)), /sanAccessMoved\(existing, input\)/, 'saveDevice 도 같은 함수');
});

/* ── E3-5 ─────────────────────────────────────────────────────────────────── */

const timeOf = (fn, s) => {
  let best = Infinity;
  for (let k = 0; k < 3; k++) { const a = performance.now(); fn(s); best = Math.min(best, performance.now() - a); }
  return Math.max(best, 1);
};

test('E3-5 trunk·lsan \'없음\' 판정은 입력 길이에 선형(4배 입력에 시간 8배 미만)', () => {
  for (const [fn, unit] of [[P.parseTrunkShow, 'trunking'], [P.parseLsanShow, 'fc router ']]) {
    const small = timeOf(fn, unit.repeat(20000));
    const big = timeOf(fn, unit.repeat(80000));
    assert.ok(big / small < 8, `${unit.trim()}: ${small.toFixed(1)}ms → ${big.toFixed(1)}ms(예전 O(n²) — 4배 입력에 약 16배)`);
  }
});

test('E3-5 \'없음\' 판정 의미는 같은 줄 안에서 유지된다', () => {
  assert.match(P.parseTrunkShow('Trunking is disabled on this switch').note, /트렁크 없음/);
  assert.match(P.parseTrunkShow('trunking not enabled').note, /트렁크 없음/);
  assert.match(P.parseTrunkShow('No trunking port').note, /트렁크 없음/);
  assert.equal(P.parseTrunkShow('trunking\ndisabled').note, '', '다른 줄이면 \'없음\' 이 아니다');
  assert.match(P.parseLsanShow('FC Router is not enabled').note, /LSAN 구성 없음/);
  assert.equal(P.parseLsanShow('fc router\nnot').note, '');
});

/* ── E3-6(리드 추가) 주기 수집 _inFlight ───────────────────────────────────── */

const quiet = async (fn) => {
  const w = console.warn; const l = console.log; const lines = [];
  console.warn = (...a) => lines.push(a.map(String).join(' '));
  console.log = (...a) => lines.push(a.map(String).join(' '));
  try { return { r: await fn(), lines }; } finally { console.warn = w; console.log = l; }
};

test('E3-6 ① 수동 수집 중인 스위치는 주기 수집이 건너뛰고(실패 아님 — inFlightSkipped) 진행중 항목을 지우지 않는다', async () => {
  const d = REG.saveDevice({ type: 'brocade', name: 'e36', host: 'e36.a2770a.invalid', username: 'u', password: 'p', collectMethod: 'ssh' });
  let manual;
  await quiet(() => { manual = POLLER.collectDeviceNow(d.id); });
  assert.ok(POLLER.sanSwitchPollerStatus().inFlight.some((x) => x.id === d.id), '수동 수집이 진행중이어야 한다(전제)');
  const { r, lines } = await quiet(() => POLLER.pollSanSwitchOnce());
  assert.equal(r.inFlightSkipped, 1, `건너뛴 수를 따로 센다: ${JSON.stringify(r)}`);
  assert.equal(r.failed, 0, '이미 수집 중인 장비를 실패로 세지 않는다');
  assert.equal(r.collected, 0);
  assert.equal(POLLER.sanSwitchPollerStatus().inFlightSkipped, 1, '상태에도 남긴다');
  assert.ok(lines.some((x) => x.includes('이미 수집 중인 장비 1대') && x.includes(d.id)), `콘솔에 남긴다(무음 금지): ${lines.join(' | ')}`);
  assert.ok(POLLER.sanSwitchPollerStatus().inFlight.some((x) => x.id === d.id), '주기 쪽이 수동 수집의 진행중 항목을 지우면 안 된다');
  await quiet(() => manual);
  assert.equal(POLLER.sanSwitchPollerStatus().inFlight.some((x) => x.id === d.id), false, '수동 수집이 끝나면 지운다');
  const { r: r2 } = await quiet(() => POLLER.pollSanSwitchOnce());
  assert.equal(r2.inFlightSkipped, undefined, '겹치지 않은 주기는 키가 생기지 않는다');
  assert.equal(r2.collected + r2.failed, 1);
});

test('E3-6 ② 소스 — collectOne 은 확인과 등록 사이에 await 가 없고 finally 는 자기 항목만 지운다(주석 제거 후)', () => {
  const s = stripComments(fs.readFileSync(path.join(SRC, 'sanswitch/poller.js'), 'utf8'));
  const i = s.indexOf('async function collectOne(');
  const fn = s.slice(i, s.indexOf('export async function pollSanSwitchOnce', i));
  const has = fn.indexOf('_inFlight.has(dev.id)'); const set = fn.indexOf('_inFlight.set(dev.id');
  assert.ok(has > 0 && set > has, '수집 시작 전에 진행중인지 확인한다');
  assert.equal(fn.slice(has, set).includes('await'), false, '확인과 등록 사이에 await 가 있으면 두 실행이 함께 통과한다');
  assert.match(fn, /finally\s*\{[^}]*_inFlight\.get\(dev\.id\)\s*===\s*entry[^}]*_inFlight\.delete\(dev\.id\)/, 'finally 는 소유 대조 후 지운다');
});
