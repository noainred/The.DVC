/**
 * bmusageAudit82.test.js — 전체 점검 82회차(베어메탈 사용률 2차 ④ — 최상위 모듈 n~z).
 *
 *  F1 임계 초과 알림(bmusage/notify.js) — 주기 상한(MAX_SEND)을 넘겨 보내지 않은 초과가 ‘알림’ 으로 기록돼 재알림 간격(기본 6시간) 동안 억제됐다
 *     (형제 perfAlerts 는 상태를 되돌려 다음 주기에 다시 판정한다 — deferred). 이제 같은 규칙.
 *  F2 보존 정리(poller.pruneTick) — 보존 기간을 정하는 설정 파일(bmusage-settings.json · bm-perf-rules.json)을 못 읽은 동안 기본값으로 지웠다
 *     (관리자가 더 길게 둔 보존을 되돌릴 수 없게 삭제). 이제 그 파일이 정하는 정리를 멈춘다.
 *  F3 bm-perf-rules.json · bm-perf-slo.json · bmusage-portmap.json — 읽기 오류(EACCES · EIO · EISDIR)를 손상으로 보고 원본을 `.corrupt.*` 로 옮겼다
 *     (34회차 ‘남긴 것’ 꼴 — 77회차가 다른 범위에서 고친 것). 이제 공용 util/jsonFileLoad.js 로 가른다.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-audit82-'));
process.env.CONFIG_DIR = DIR;
process.env.BMUSAGE_ALERT_MAX = '1';   // F1 — 주기 상한 1건(모듈 로드 때 읽는다)
process.env.DATA_SOURCE = 'live';     // 데모(mock)면 알림을 판정하지 않는다
test.after(() => fs.rmSync(DIR, { recursive: true, force: true }));

const F = (n) => path.join(DIR, n);
const corruptCopies = (name) => fs.readdirSync(DIR).filter((f) => f.startsWith(`${name}.corrupt.`));
const realRead = fs.readFileSync;
/** 그 경로 읽기만 EACCES(root 로 도는 시험에서는 chmod 로 재현되지 않는다 — 77회차와 같은 방식). */
function denyRead(file, fn) {
  fs.readFileSync = function (p, ...a) {
    if (String(p) === file) { const e = new Error(`EACCES: permission denied, open '${p}'`); e.code = 'EACCES'; throw e; }
    return realRead.call(this, p, ...a);
  };
  try { return fn(); } finally { fs.readFileSync = realRead; }
}
const HOUR = 3_600_000;
const DAY = 86_400_000;
const BASE = Math.floor(Date.now() / HOUR) * HOUR;
let clock = BASE;
const JFL = await import('../src/util/jsonFileLoad.js');
JFL._setJsonFileLoadClockForTest(() => clock);
test.after(() => JFL._setJsonFileLoadClockForTest());

test('F1 알림 상한을 넘겨 보내지 않은 초과는 상태를 되돌려 다음 주기에 다시 판정한다(재알림 간격으로 억제하지 않는다)', async () => {
  const N = await import('../src/bmusage/notify.js');
  assert.equal(N.MAX_SEND, 1, '시험 전제 — 상한 1건');
  N._resetAlertStateForTest();
  const settings = { alertEnabled: true, alertPct: 90, alertSustainMin: 0, alertRepeatHours: 6, intervalMs: 300_000, runMs: 0, maintJudge: { stateFor: () => null } };
  const rows = [{ key: 'srv-a', name: 'a', vcenterId: 'vc1', cpu_pct: 95 }, { key: 'srv-b', name: 'b', vcenterId: 'vc1', cpu_pct: 97 }];
  const r1 = await N.runBmUsageAlerts(rows, settings);
  await N._drainBmUsageAlertsForTest();
  assert.equal(r1.queued, 1);
  assert.equal(r1.capped, 1, '한 건은 상한에 걸렸다');
  const sent1 = r1.fires.map((f) => f.key);
  const st = JSON.parse(fs.readFileSync(F('bmusage-alert-state.json'), 'utf8')).metrics;
  const cappedKey = sent1[0] === 'srv-a' ? 'srv-b' : 'srv-a';
  assert.equal(st[`${cappedKey}|cpu_pct`].notifiedAt, null, '보내지 않은 초과는 ‘알림’ 으로 기록하지 않는다');
  assert.ok(st[`${cappedKey}|cpu_pct`].since != null, '지속 구간은 그대로 들고 간다');
  assert.ok(st[`${sent1[0]}|cpu_pct`].notifiedAt != null, '보낸 초과는 기록');
  // 다음 주기 — 잘렸던 서버가 이번에 나간다(예전: 둘 다 재알림 간격 안이라 0건)
  const r2 = await N.runBmUsageAlerts(rows, settings);
  await N._drainBmUsageAlertsForTest();
  assert.deepEqual(r2.fires.map((f) => f.key), [cappedKey]);
  assert.equal(r2.capped, 0);
});

test('F1 상한에 걸린 해제도 다음 주기에 다시 나간다(상태를 지우지 않는다)', async () => {
  const N = await import('../src/bmusage/notify.js');
  N._resetAlertStateForTest();
  const settings = { alertEnabled: true, alertPct: 90, alertSustainMin: 0, alertRepeatHours: 6, intervalMs: 300_000, runMs: 0, maintJudge: { stateFor: () => null } };
  // 두 서버 모두 알린 상태로 만든다(주기 둘)
  await N.runBmUsageAlerts([{ key: 'x1', cpu_pct: 95 }, { key: 'x2', cpu_pct: 95 }], settings);
  await N.runBmUsageAlerts([{ key: 'x1', cpu_pct: 95 }, { key: 'x2', cpu_pct: 95 }], settings);
  await N._drainBmUsageAlertsForTest();
  // 이번 주기: x1 은 새 초과는 아니고(억제) x2 · x1 둘 다 해제 — 해제 둘 중 하나는 상한에 걸린다
  const r = await N.runBmUsageAlerts([{ key: 'x1', cpu_pct: 10 }, { key: 'x2', cpu_pct: 10 }], settings);
  await N._drainBmUsageAlertsForTest();
  assert.equal(r.queued, 1); assert.equal(r.capped, 1);
  const first = r.fires[0].key;
  const other = first === 'x1' ? 'x2' : 'x1';
  const st = JSON.parse(fs.readFileSync(F('bmusage-alert-state.json'), 'utf8')).metrics;
  assert.ok(st[`${other}|cpu_pct`] && st[`${other}|cpu_pct`].notifiedAt != null, '보내지 않은 해제는 직전 상태(알린 기록)를 그대로 둔다');
  assert.equal(st[`${first}|cpu_pct`], undefined, '보낸 해제는 상태를 지운다');
  const r2 = await N.runBmUsageAlerts([{ key: 'x1', cpu_pct: 10 }, { key: 'x2', cpu_pct: 10 }], settings);
  await N._drainBmUsageAlertsForTest();
  assert.deepEqual(r2.fires.map((f) => `${f.kind}:${f.key}`), [`recovered:${other}`]);
});

test('F3 알림 규칙 파일 — 읽기 오류는 원본을 옮기지 않고 저장을 409 로 거절하며, 다시 읽히면 스스로 풀린다 · 손상은 예전처럼 보존', async () => {
  const R = await import('../src/bmusage/perfRules.js');
  const file = F('bm-perf-rules.json');
  fs.writeFileSync(file, JSON.stringify({ changes: { keepDays: 400 }, by: 'owner', at: 1 }));
  R._resetPerfRulesForTest();
  denyRead(file, () => {
    const v = R.loadPerfRules();
    assert.equal(v.changes.keepDays, 30, '못 읽은 동안 값은 기본값');
    const e = R.perfRulesLoadError();
    assert.ok(e && e.readError === true, '로드 오류 = 읽기 오류');
    assert.ok(fs.existsSync(file), '원본은 그 자리에');
    assert.equal(corruptCopies('bm-perf-rules.json').length, 0, '보존본을 만들지 않는다');
    assert.throws(() => R.savePerfRules({}, { by: 't' }), (err) => err.status === 409 && err.code === 'settings-unreadable');
  });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).changes.keepDays, 400, '저장 거절 — 원본 그대로');
  // 간격 안: 디스크를 보지 않는다(여전히 오류) → 간격 뒤 다시 읽혀 풀린다
  assert.ok(R.perfRulesLoadError()?.readError);
  clock += JFL.READ_RETRY_MS + 1;
  assert.equal(R.perfRulesLoadError(), null, '다시 읽혀 풀림');
  assert.equal(R.loadPerfRules().changes.keepDays, 400);
  // 손상은 예전처럼 보존본으로
  fs.writeFileSync(file, '{ bad json');
  R._resetPerfRulesForTest();
  R.loadPerfRules();
  assert.equal(corruptCopies('bm-perf-rules.json').length, 1);
  assert.ok(R.perfRulesLoadError() && !R.perfRulesLoadError().readError);
  // 객체가 아닌 JSON(null)도 예전처럼 손상
  fs.writeFileSync(file, 'null');
  R._resetPerfRulesForTest();
  R.loadPerfRules();
  assert.ok(R.perfRulesLoadError() && !R.perfRulesLoadError().readError);
  for (const f of corruptCopies('bm-perf-rules.json')) fs.rmSync(F(f));
  fs.rmSync(file, { force: true });
  R._resetPerfRulesForTest();
});

test('F3 목표선(SLO) 파일 — 읽기 오류는 원본 유지 · 저장 409 · 재읽기로 풀림', async () => {
  const L = await import('../src/bmusage/slo.js');
  const file = F('bm-perf-slo.json');
  fs.writeFileSync(file, JSON.stringify({ v: 1, servers: {}, by: 'owner', at: 2 }));
  L._resetSloForTest();
  denyRead(file, () => {
    L.loadSlo();
    assert.ok(L.sloLoadError()?.readError === true);
    assert.equal(corruptCopies('bm-perf-slo.json').length, 0);
    assert.throws(() => L.saveSlo({}, { by: 't' }), (err) => err.status === 409);
  });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).by, 'owner');
  clock += JFL.READ_RETRY_MS + 1;
  assert.equal(L.sloLoadError(), null);
  assert.equal(L.loadSlo().by, 'owner');
  fs.rmSync(file, { force: true });
  L._resetSloForTest();
});

test('F3 포트 매핑 파일 — 읽기 오류는 원본 유지 · 저장 거절 · 재읽기로 풀림(재시작 뒤 ‘매핑 없음’ 으로 굳지 않는다)', async () => {
  const PM = await import('../src/bmusage/portMap.js');
  const file = F('bmusage-portmap.json');
  fs.writeFileSync(file, JSON.stringify({ v: 1, entries: [{ agent: '', key: 'k1', nic: 'eth0', cvpId: 'c1', deviceKey: 'd1', port: 'Et1' }] }));
  PM._resetPortMapForTest();
  denyRead(file, () => {
    assert.equal(PM.listPortMap().length, 0);
    assert.ok(PM.portMapLoadError()?.readError === true);
    assert.equal(corruptCopies('bmusage-portmap.json').length, 0);
    const r = PM.setPortMapping({ agent: '', key: 'k2', nic: 'eth1', cvpId: 'c1', deviceKey: 'd1', port: 'Et2' });
    assert.equal(r.ok, false);
  });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).entries.length, 1, '원본 그대로');
  clock += JFL.READ_RETRY_MS + 1;
  assert.equal(PM.listPortMap().length, 1, '다시 읽혀 매핑이 돌아온다');
  assert.equal(PM.portMapLoadError(), null);
  // 손상은 예전처럼 보존 + 저장 거절
  fs.writeFileSync(file, '{"x":1}');
  PM._resetPortMapForTest();
  assert.equal(PM.listPortMap().length, 0);
  assert.equal(corruptCopies('bmusage-portmap.json').length, 1);
  assert.equal(PM.setPortMapping({ agent: '', key: 'k2', nic: 'eth1', cvpId: 'c1', deviceKey: 'd1', port: 'Et2' }).ok, false);
  for (const f of corruptCopies('bmusage-portmap.json')) fs.rmSync(F(f));
  fs.rmSync(file, { force: true });
  PM._resetPortMapForTest();
});

test('F2 보존 정리 — 규칙 파일을 못 읽은 동안 변경 이벤트를 기본 보관(30일)으로 지우지 않는다 · 설정 파일을 못 읽으면 사용률 보존 정리도 멈춘다', async () => {
  const P = await import('../src/bmusage/poller.js');
  const O = await import('../src/bmusage/opsDb.js');
  const R = await import('../src/bmusage/perfRules.js');
  const S = await import('../src/bmusage/settings.js');
  const now = Date.now();
  // 관리자가 400일로 둔 변경 이벤트 보관 — 100일 전 이벤트
  const w = await O.changeWriteBatch({ agent: '', items: [{ key: 'srv1', at: now, facts: {}, events: [{ ts: now - 100 * DAY, kind: 'pkg', item: 'kernel', before: 'a', after: 'b' }] }] });
  assert.equal(w.ok, true, 'DB 준비');
  const rulesFile = F('bm-perf-rules.json');
  fs.writeFileSync(rulesFile, '{ corrupt');   // 손상(보존본만 남는다 — 재시작 뒤에도 못 읽음)
  R._resetPerfRulesForTest();
  const r = await P.pruneTick({ every: 1 });
  assert.ok(Array.isArray(r.held) && r.held.includes('perf-rules'), '규칙 파일 정리 보류를 밝힌다');
  const ev = await O.changeEventsRange({ key: 'srv1', agent: '', from: now - 200 * DAY, to: now });
  assert.equal((ev?.rows || ev || []).length, 1, '100일 전 이벤트가 남아 있다(기본 30일로 지우지 않았다)');
  // 규칙 파일을 기본값으로 확정(= 관리자가 30일을 받아들임)하면 다시 정리한다
  for (const f of corruptCopies('bm-perf-rules.json')) fs.rmSync(F(f));
  fs.rmSync(rulesFile, { force: true });
  R._resetPerfRulesForTest();
  const r2 = await P.pruneTick({ every: 1 });
  assert.ok(!r2.held, '보류 없음');
  const ev2 = await O.changeEventsRange({ key: 'srv1', agent: '', from: now - 200 * DAY, to: now });
  assert.equal((ev2?.rows || ev2 || []).length, 0, '기본 보관(30일) 밖이라 지웠다');
  // 사용률 설정 파일 손상 — 설정값(기본값)으로는 지우지 않는다. 83회차(반증): 멈춤에 끝이 없으면 무상한 증가라 설정이 허용하는 가장 긴 보존으로만 정리한다(heldMax).
  fs.writeFileSync(F('bmusage-settings.json'), '{ corrupt');
  S._resetForTest();
  assert.ok(S.bmUsageLocalLoadError(), '로컬 설정 로드 오류');
  const r3 = await P.pruneTick({ every: 1 });
  assert.ok(r3.held.includes('settings'));
  assert.equal(r3.heldMax, true, '83회차: 상한 보존으로만 정리(기본값 정리는 하지 않는다 — rebut83 이 지운 범위를 고정)');
  assert.deepEqual(P.bmUsageStatus().lastPrune.held, ['settings']);
});
