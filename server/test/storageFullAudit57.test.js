/**
 * storageFullAudit57.test.js — 전체 점검 57회차(스토리지 모니터링 2차) 회귀 고정.
 *
 *  F1 VMAX/PowerMax 용량 기준 1회 재시작(v2.534)이 대상 장비가 없던 첫 기동에 마커를 남기지 않아, 나중에 PowerMax 를 등록하면
 *     다음 재시작이 새 기준으로 쌓인 이력을 통째로 지웠다(사유 'v2.534 기준 변경' 이라는 거짓 기록까지) — 재현 후 수정.
 *  F2 사용량 보고(메일 · 엑셀 · 화면)의 합계 '직전 주 대비' 가 그 사이 새로 등록한 장비의 사용량 전체를 증가로 셌다
 *     (A +1 TB · 새 장비 B 300 TB → '+301 TB') — 두 합계의 장비 구성이 같을 때만 뺀다.
 *  I1 isilon getAny 가 401 뒤에도 다음 후보 경로로 같은 자격증명을 보냈다(형제 restCommon.tryAny 는 즉시 던진다).
 *  C1 XtremIO 목록 응답에 키가 없으면(`|| []`) 컨트롤러 0 · 경보 0 이 '정상' 으로 보였다 · Unity 경보도 entries 없는 응답을 0 건으로.
 *  I2 PowerScale 점검 이력 저장 실패 뒤 '저장할 것 있음' 표지가 내려간 채라 종료 flush 가 건너뛰었다.
 *
 * 기준 시각: 일 인덱스는 실제 시각을 하루 경계로 떨어뜨린 값(고정 epoch 를 쓰지 않는다).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { stripComments } from './_stripComments.js';

const SRC = path.resolve(import.meta.dirname, '../src');
const mod = (p) => JSON.stringify(pathToFileURL(path.join(SRC, p)).href);
const DAY = 86_400_000;
const TODAY = Math.floor(Date.now() / DAY);   // 정시(하루) 경계로 떨어뜨린 기준일

/** 새 CONFIG_DIR 에서 스크립트를 돌리고 마지막 줄(JSON)을 돌려준다. */
function runIsolated(code, { prepare } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st57-'));
  try {
    if (prepare) prepare(dir);
    const out = execFileSync(process.execPath, ['--experimental-sqlite', '--no-warnings', '--input-type=module', '-e', code], {
      env: { ...process.env, CONFIG_DIR: dir, DATA_SOURCE: 'mock' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000,
    });
    return { json: JSON.parse(out.trim().split('\n').pop()), dir };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

const SEED = `
  const db = await import(${mod('storage/db.js')});
  const seed = async (id, n) => { const now = Date.now(); for (let i = 0; i < n; i++) await db.saveCapacityPoint({ deviceId: id, ok: true, collectedAt: now - i * 86400000, capacity: { totalBytes: 100e12, usedBytes: 40e12 } }); };
  const { runCapacityBasisMigration } = await import(${mod('storage/capacityBasisMigration.js')});
`;

test('F1 — 대상 장비가 없던 첫 기동은 마커만 남기고, 나중에 등록한 PowerMax 의 새 기준 이력을 지우지 않는다', () => {
  const { json } = runIsolated(`${SEED}
    const boot1 = await runCapacityBasisMigration({ devices: [{ id: 'un1', type: 'unity' }] });
    await seed('pm1', 5);
    const before = (await db.dailySeries('pm1', 0)).length;
    const boot2 = await runCapacityBasisMigration({ devices: [{ id: 'un1', type: 'unity' }, { id: 'pm1', type: 'powermax' }] });
    const after = (await db.dailySeries('pm1', 0)).length;
    console.log(JSON.stringify({ boot1, boot2, before, after, resets: Object.keys(await db.capacityResets()) }));`);
  assert.equal(json.boot1.ran, false);
  assert.equal(json.boot1.marked, true, '대상이 0대여도 마커를 남긴다');
  assert.ok(json.before > 0);
  assert.equal(json.boot2.ran, false, '두 번째 기동은 지우지 않는다');
  assert.equal(json.after, json.before, '새 기준으로 쌓인 PowerMax 이력이 그대로다');
  assert.deepEqual(json.resets, [], "'기준 변경' 재시작 기록이 생기지 않는다");
});

test('F1 — 등록부(파일)를 읽어 대상이 0대면 마커 · 등록부를 못 읽으면 판정을 미룬다(마커 없음)', () => {
  const ok = runIsolated(`${SEED}
    const r = await runCapacityBasisMigration();
    await seed('pm1', 3);
    const again = await runCapacityBasisMigration({ devices: [{ id: 'pm1', type: 'powermax' }] });
    console.log(JSON.stringify({ r, again, left: (await db.dailySeries('pm1', 0)).length }));`,
  { prepare: (dir) => fs.writeFileSync(path.join(dir, 'storage-devices.json'), JSON.stringify({ version: 1, devices: [{ id: 'un1', type: 'unity', host: 'u1', name: 'u1' }] })) });
  assert.equal(ok.json.r.marked, true);
  assert.equal(ok.json.again.ran, false);
  assert.ok(ok.json.left > 0);

  const bad = runIsolated(`${SEED}
    const r = await runCapacityBasisMigration();
    await seed('pm1', 3);
    const again = await runCapacityBasisMigration({ devices: [{ id: 'pm1', type: 'powermax' }] });
    console.log(JSON.stringify({ r, again }));`,
  { prepare: (dir) => fs.writeFileSync(path.join(dir, 'storage-devices.json'), '{ 손상') });
  assert.equal(bad.json.r.deferred, 'registry-unreadable', '못 읽은 등록부를 0대로 보지 않는다');
  assert.equal(bad.json.again.ran, true, '마커가 없으므로 등록부를 읽게 된 뒤 원래 마이그레이션이 돈다(v2.534 전 이력 정리 보존)');
});

/* ── F2 ─────────────────────────────────────────────────────────────── */
const TB = 1024 ** 4;
async function repWithNewDevice({ addB = true } = {}) {
  const { buildPeriods, buildUsageReport } = await import('../src/storage/usageReport.js');
  const periods = buildPeriods({ gran: 'weekly', asOfDay: TODAY, count: 5, weekday: 1 });
  const p = periods.map((x) => x.toDay);
  const rows = [];
  p.forEach((d, i) => rows.push({ device_id: 'A', day: d, total_bytes: 100 * TB, used_bytes: (50 + i) * TB }));
  if (addB) rows.push({ device_id: 'B', day: p[p.length - 1], total_bytes: 500 * TB, used_bytes: 300 * TB });
  const devices = [{ id: 'A', name: 'A', type: 'unity', datacenterId: 'dc1' }, ...(addB ? [{ id: 'B', name: 'B', type: 'unity', datacenterId: 'dc1' }] : [])];
  const spans = { A: { firstDay: p[0], lastDay: p[p.length - 1] }, ...(addB ? { B: { firstDay: p[p.length - 1], lastDay: p[p.length - 1] } } : {}) };
  return { ok: true, periods, asOfDay: TODAY, asOfLabel: '', devices: buildUsageReport({ rows, periods, devices, spans }),
    types: [{ type: 'unity', label: 'Unity' }], datacenters: [{ id: 'dc1', name: '법인1' }] };
}

test('F2 — 새로 등록한 장비의 사용량 전체를 합계 증가로 세지 않는다(전체 · 법인 · 종류)', async () => {
  const { buildInsights } = await import('../src/storage/usageInsights.js');
  const ins = buildInsights(await repWithNewDevice());
  assert.equal(ins.total.cur.partial, false, '두 주 모두 완전한 합계(새 장비는 직전 주에 기대되지 않는다)');
  assert.equal(ins.total.delta, null, '예전에는 +301 TB');
  assert.equal(ins.total.deltaWhy, 'changed');
  assert.equal(ins.total.changed, 1);
  assert.equal(ins.byCorp[0].delta, null);
  assert.equal(ins.byType[0].deltaWhy, 'changed');
  // 평균: 구성이 같은 앞 걸음들만(+1 TB/주) — 새 장비 걸음은 빠진다
  assert.equal(ins.total.avg, 1 * TB);
  // 장비 단위 증가 상위는 그대로(A +1 TB)
  assert.equal(ins.growthTop[0].deviceId, 'A');
  assert.equal(ins.growthTop[0].trend.delta, 1 * TB);
});

test('F2 — 구성이 같으면 예전처럼 뺀다', async () => {
  const { buildInsights } = await import('../src/storage/usageInsights.js');
  const ins = buildInsights(await repWithNewDevice({ addB: false }));
  assert.equal(ins.total.delta, 1 * TB);
  assert.equal(ins.total.deltaWhy, '');
  assert.equal(ins.total.changed, undefined);
});

test('F2 — 메일 본문 · 엑셀 요약이 이유를 말한다(빈 칸으로 두지 않는다)', async () => {
  const { buildMailModel, renderUsageMail } = await import('../src/storage/usageMailRules.js');
  const m = buildMailModel(await repWithNewDevice());
  const { html } = renderUsageMail(m, { mail: { enabled: true } });
  assert.match(html, /장비 구성이 바뀌어 내지 않음\(한쪽 주에만 있는 장비 1대\)/);
  assert.match(html, /— \(장비 구성 바뀜\)/);
  assert.doesNotMatch(html, /\+301/);
  const xsrc = stripComments(fs.readFileSync(path.join(SRC, 'storage/usageXlsx.js'), 'utf8'));
  assert.match(xsrc, /deltaWhy === 'changed'/, '엑셀 요약 시트도 같은 사유');
});

test('F2 — setChangeOf: 한쪽에만 사용량 값이 있는 장비 수(사용량 미상 칸은 값 없음)', async () => {
  const { setChangeOf } = await import('../src/storage/usageReport.js');
  const c = (u) => ({ totalBytes: 1, usedBytes: u, exact: true });
  const devs = [{ cells: [c(1), c(2)] }, { cells: [null, c(3)] }, { cells: [c(1), null] }, { cells: [c(null), c(5)] }, { cells: [null, null] }];
  assert.equal(setChangeOf(devs, 0, 1), 3);
  assert.equal(setChangeOf([], 0, 1), 0);
  assert.equal(setChangeOf(null, 0, 1), 0);
});

/* ── 개선 ───────────────────────────────────────────────────────────── */
/** globalThis.fetch 를 경로 라우터로 바꾼다(audit2742k 와 같은 모양). route(path) → { status, body }. */
function stubFetch(route) {
  const orig = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    const u = new URL(url); const p = u.pathname + u.search;
    calls.push(p);
    const { status = 404, body = { error: 'not found' } } = route(p) || {};
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  };
  return { calls, restore: () => { globalThis.fetch = orig; } };
}

test('I1 — isilon getAny 는 자격증명 거부(401)에서 다음 후보 경로로 같은 자격증명을 보내지 않는다', async () => {
  const { getAny } = await import('../src/storage/collectors/isilon.js');
  const f = stubFetch(() => ({ status: 401, body: { message: 'unauthorized' } }));
  try {
    await assert.rejects(getAny({ host: 'isi.corp', username: 'u', password: 'bad' }, ['/platform/3/cluster/nodes', '/platform/1/cluster/nodes']), (e) => e.authFailed === true);
    assert.equal(f.calls.length, 1, '예전에는 두 경로 모두 두드렸다(로그인 실패 2회)');
  } finally { f.restore(); }
  const g = stubFetch((p) => (p.startsWith('/platform/3') ? { status: 404, body: { message: 'nope' } } : { status: 200, body: { nodes: [] } }));
  try {
    assert.deepEqual(await getAny({ host: 'isi.corp', username: 'u', password: 'p' }, ['/platform/3/cluster/nodes', '/platform/1/cluster/nodes']), { nodes: [] });
    assert.equal(g.calls.length, 2, '401 이 아닌 실패는 예전처럼 다음 후보로');
  } finally { g.restore(); }
});

test('C1 — XtremIO 목록 응답에 그 키가 없으면 컨트롤러 0 · 경보 0 · 정상이 아니라 섹션 오류', async () => {
  const x = await import('../src/storage/collectors/xtremio.js');
  const f = stubFetch((p) => {
    if (p === '/api/json/v3/types/clusters') return { status: 200, body: { clusters: [{ name: 'xc1' }] } };
    if (p.startsWith('/api/json/v3/types/clusters?name=')) return { status: 200, body: { content: { name: 'xc1', 'ud-ssd-space': '1000', 'ud-ssd-space-in-use': '100' } } };
    if (p.includes('/types/storage-controllers')) return { status: 200, body: { links: [] } };
    if (p.includes('/types/user-accounts')) return { status: 200, body: { 'user-accounts': [{ name: 'admin', role: 'admin' }] } };
    if (p.includes('/types/alerts')) return { status: 200, body: { links: [] } };
    return { status: 404, body: { message: 'nope' } };
  });
  try {
    const out = await x.collect({ id: 'x1', type: 'xtremio', name: 'x1', host: 'xms.corp', username: 'admin', password: 'pw' });
    assert.match(String(out.sections.nodes), /^오류: 응답 형식 미인식\('storage-controllers'/);
    assert.match(String(out.sections.alerts), /^오류: 응답 형식 미인식\('alerts'/, '예전에는 경보 0 · ok');
    assert.equal(out.sections.accounts, 'ok', '키가 있는 섹션은 그대로');
  } finally { f.restore(); }
  assert.deepEqual(x.listOrThrow({ alerts: [] }, 'alerts'), [], '빈 목록(키 있음)은 0건 — 정상');
});

test('C1 — Unity 경보 응답에 entries · entryCount 가 다 없으면 섹션 오류(있으면 예전과 같다)', async () => {
  const { normalizeUnity } = await import('../src/storage/collectors/unity.js');
  const bad = normalizeUnity({ id: 'u', name: 'u' }, { alerts: { links: [] } });
  assert.match(String(bad.sections.alerts), /^오류: 응답 형식 미인식/);
  const cnt = normalizeUnity({ id: 'u', name: 'u' }, { alerts: { entryCount: 0 } });
  assert.equal(cnt.sections.alerts, 'ok'); assert.equal(cnt.alerts.unresolved, 0);
  const ent = normalizeUnity({ id: 'u', name: 'u' }, { alerts: { entries: [{ content: { id: 'a' } }] } });
  assert.equal(ent.sections.alerts, 'ok'); assert.equal(ent.alerts.unresolved, 1);
});

test('I2 — 점검 이력 저장이 실패하면 종료 flush 가 다시 쓴다(표지를 내린 채 두지 않는다)', () => {
  const { json } = runIsolated(`
    const fs = await import('node:fs'); const path = await import('node:path');
    const file = path.join(process.env.CONFIG_DIR, 'storage-inspect-runs.json');
    const st = await import(${mod('storage/inspect/store.js')});
    const ef = await import(${mod('util/exitFlush.js')});
    st.inspectStoreStatus();   // 먼저 읽어 둔다(파일 없음 — 빈 이력). 읽기 전에 디렉터리를 두면 로드가 손상으로 보고 치운다
    fs.mkdirSync(file);   // 원자 쓰기의 rename 이 실패하게(디렉터리 자리)
    const r = st.recordRun('isi-1', { at: Date.now() - 1000, method: 'api', facts: {}, why: {}, errors: [] });
    await new Promise((res) => setTimeout(res, 2600));   // 2초 디바운스 flush 가 실패한다
    const failed = st.inspectStoreStatus().persist.error != null;
    fs.rmdirSync(file);
    ef.runExitFlush('test');
    const ok = fs.existsSync(file) && fs.statSync(file).isFile() && Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')).devices).includes('isi-1');
    console.log(JSON.stringify({ saved: r.saved, failed, ok }));`);
  assert.equal(json.saved, true);
  assert.equal(json.failed, true, '첫 저장은 실패해야 한다(전제)');
  assert.equal(json.ok, true, '종료 flush 가 기록을 파일에 남긴다');
});

test('I3 — 보존 일수 env 폴백은 음수를 통과시키지 않는다(envPositive)', () => {
  const src = stripComments(fs.readFileSync(path.join(SRC, 'storage/db.js'), 'utf8'));
  const body = src.slice(src.indexOf('function keepDays()'), src.indexOf('let _db = null;'));
  assert.doesNotMatch(body, /Number\(process\.env\./);
  assert.equal((body.match(/envPositive\(process\.env\./g) || []).length, 7);
});
