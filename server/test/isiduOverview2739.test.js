/**
 * test/isiduOverview2739.test.js — 아이실론 디렉터리 사용량 v2.739.
 *   ① 시한 기본값 이전(30분 → 120분, 표지가 있으면 다시 하지 않는다) ② 시한 상한 3시간(설정·세션·명령·데드라인이 같은 값)
 *   ③ 개요(서머리·법인 현황·전 법인 Top 10) — 상위 폴더 순위가 보고서와 같고, 7일 기준이 없으면 증감을 지어내지 않는다
 *   ④ 일괄 변경 — 순수 판정 + 실제 api 라우터(dryRun 은 저장하지 않음 · rev 충돌 409 · 맞지 않는 항목·거절된 대상은 따로 센다)
 * 픽스처 이름은 합성이다(공개 저장소 — v2.513).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import express from 'express';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'isidu2739-'));
Object.assign(process.env, { CONFIG_DIR: TMP, DATA_SOURCE: 'live', AUTH_ENABLED: 'false' });
delete process.env.CENTRAL_URL;
after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ } });

const SFILE = path.join(TMP, 'isidu-settings.json');
const writeSettings = (v) => fs.writeFileSync(SFILE, JSON.stringify(v, null, 2));
const readSettingsFile = () => JSON.parse(fs.readFileSync(SFILE, 'utf8'));
const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));

const S = await import('../src/isidu/settings.js');
const B = await import('../src/isidu/bulk.js');
const db = await import('../src/isidu/db.js');
const R = await import('../src/isidu/report.js');
const P = await import('../src/isidu/parse.js');

const G = 1024 ** 3;
const DAY = 86_400_000;
const ROOT = '/ifs/data/users';
const T0 = Math.floor(Date.now() / 3_600_000) * 3_600_000 - 30 * 60_000;   // 정시 −30분(경계에서 떨어뜨림 — v2.517 규약)
const scanRec = (targetId, ts, entries, extra = {}) => {
  const sum = entries.reduce((a, e) => a + e[1], 0);
  return {
    agent: '', node: '', targetId, ts, ok: true, path: ROOT, host: '10.0.0.5', sizeMode: 'h', durationMs: 42_000, trig: 'schedule',
    total: { bytes: sum + G, res: Math.round(0.1 * G) }, sumBytes: sum, sumRes: 0, count: entries.length, skipped: 0, errLines: 0,
    entries: entries.map(([name, bytes]) => ({ name, bytes, res: Math.round(0.1 * G) })), ...extra,
  };
};

async function call(method, url, body) {
  const { api } = await import('../src/routes/api.js');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { username: 'root', role: 'admin', superAdmin: true, scope: {} }; next(); });
  app.use('/api', api);
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => res.status(500).json({ error: String(err?.message || err) }));
  const srv = http.createServer(app); const port = await listen(srv);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api${url}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json().catch(() => null) };
  } finally { srv.closeAllConnections?.(); srv.close(); }
}

/* ═══════════════ ① 시한 기본값 이전 ═══════════════ */

test('① 순수 이전 — 표지가 없으면 30분인 대상만 120분 · 다른 값·빈 값은 그대로 · 표지가 있으면 아무것도 안 함', () => {
  const r = S.migrateTimeoutDefault({ targets: [{ id: 'a', timeoutMin: 30 }, { id: 'b', timeoutMin: 45 }, { id: 'c' }, { id: 'd', timeoutMin: '30' }, null] });
  assert.equal(r.needWrite, true);
  assert.equal(r.moved, 2, '숫자 30 과 문자열 "30" 둘 다 옛 기본값');
  assert.deepEqual(r.raw.targets.map((x) => x?.timeoutMin), [120, 45, undefined, 120, undefined]);
  assert.equal(r.raw[S.TIMEOUT_MARK], 120);
  const again = S.migrateTimeoutDefault(r.raw);
  assert.equal(again.needWrite, false); assert.equal(again.moved, 0);
  const marked = S.migrateTimeoutDefault({ [S.TIMEOUT_MARK]: 120, targets: [{ id: 'a', timeoutMin: 30 }] });
  assert.equal(marked.raw.targets[0].timeoutMin, 30, '표지가 있으면 사람이 다시 고른 30분을 되돌리지 않는다');
  assert.equal(S.migrateTimeoutDefault([1, 2]).needWrite, false);
});

test('① 실제 읽기 — 옛 파일을 한 번 옮기고 표지를 남긴다 · 저장 뒤 30분으로 고친 값은 다시 읽어도 30분', () => {
  writeSettings({ retentionDays: 400, targets: [
    { id: 'o1', host: '10.0.0.5', username: 'admin', path: ROOT, timeoutMin: 30 },
    { id: 'o2', host: '10.0.0.6', username: 'admin', path: ROOT, timeoutMin: 45 },
  ] });
  S._resetForTest();
  const v = S.loadSettings();
  assert.deepEqual(v.targets.map((x) => x.timeoutMin), [120, 45]);
  assert.equal(readSettingsFile()[S.TIMEOUT_MARK], 120, '이전 결과를 파일에 남겼다');
  // 사람이 다시 30분으로 고쳐 저장
  const ctx = { devices: [], agents: [], dcs: [], pickAgent: (v2) => ({ value: v2 || '' }), pickDatacenter: (v2) => ({ value: v2 || '' }), ssrfBlockReason: () => null };
  const s = S.saveSettings({ targets: v.targets.map((x) => (x.id === 'o1' ? { ...x, timeoutMin: 30 } : x)) }, ctx);
  assert.equal(s.ok, true, JSON.stringify(s));
  S._resetForTest();
  assert.equal(S.loadSettings().targets.find((x) => x.id === 'o1').timeoutMin, 30);
  assert.equal(readSettingsFile()[S.TIMEOUT_MARK], 120, '저장도 표지를 싣는다');
  // 빈 값은 기본값(120)
  assert.equal(S.timeoutMsOf({ timeoutMin: '' }), 120 * 60_000);
});

/* ═══════════════ ② 시한 상한 3시간 ═══════════════ */

test('② 시한 상한 180분 — 설정 범위·세션 계획·SSH 긴 명령 관문·긴 데드라인이 같은 값(3시간)', async () => {
  const D = await import('../src/util/deadline.js');
  const X = await import('../src/proxy/sshExec.js');
  assert.equal(S.RANGES.timeoutMin.max, 180);
  assert.equal(S.RANGES.timeoutMin.def, 120);
  assert.equal(D.DEADLINE_LONG_MAX_MS, 3 * 3_600_000);
  assert.equal(X.EXEC_LONG_MAX_MS, D.DEADLINE_LONG_MAX_MS, '명령 상한 = 세션 상한(다르면 결과가 버려진다)');
  assert.equal(S.SESSION_MAX_MS, D.DEADLINE_LONG_MAX_MS);
  const plan = S.sessionPlanOf({ timeoutMin: 180 });
  assert.equal(plan.sessionMs, 3 * 3_600_000);
  assert.equal(plan.cmdMs, 3 * 3_600_000 - 15_000, '세션이 명령보다 먼저 끊기지 않게 명령을 15초 줄인다');
  assert.equal(S.sessionPlanOf({ timeoutMin: 999 }).sessionMs, 3 * 3_600_000, '범위 밖은 상한으로 자른다');
  // 긴 작업만 3시간 — 기본 관문은 그대로 2시간(다른 호출부의 env 가 넓어지지 않게)
  assert.equal(D.deadlineMs(4 * 3_600_000), 2 * 3_600_000);
  assert.equal(D.deadlineMs(4 * 3_600_000, 60_000, { long: true }), 3 * 3_600_000);
  assert.equal(X.execTimeoutMs(4 * 3_600_000), 1_800_000);
  assert.equal(X.execTimeoutMs(4 * 3_600_000, { long: true }), 3 * 3_600_000);
  // withDeadline 의 long 이 실제로 상한을 넓힌다(라벨의 초 = 좁힌 뒤 값)
  const msg = await D.withDeadline(4 * 3_600_000, async (sig) => { await new Promise((r) => setTimeout(r, 5)); return sig.aborted; }, 't', { long: true });
  assert.equal(msg, false);
  // 수집기가 세션에 long 을 넘긴다(소스 — 빠지면 2시간에서 잘린다)
  const src = fs.readFileSync(new URL('../src/isidu/collect.js', import.meta.url), 'utf8');
  assert.match(src, /'du 시한 초과', \{ long: true \}\)/);
});

/* ═══════════════ ③ 개요 ═══════════════ */

test('③ 상위 폴더 — 같은 크기가 경계에 걸려도 보고서(sortBySize)와 같은 10개·같은 순서', async () => {
  const ents = [];
  for (let i = 0; i < 6; i++) ents.push([`big${i}`, (100 - i) * G]);
  // 7~14 위가 같은 크기(5G) — 이름 순으로 갈린다(바이트 순이 아니라 localeCompare: 대소문자·한글)
  for (const n of ['zeta', 'Alpha', 'beta', '가나', 'Beta2', 'alpha', 'Zz', 'mid']) ents.push([n, 5 * G]);
  const r = await db.insertScan(scanRec('ov-tie', T0, ents));
  const top = await db.topEntriesOf(r.id ?? r, 10);
  const want = P.sortBySize(ents.map(([name, bytes]) => ({ name, bytes }))).slice(0, 10).map((x) => x.name);
  assert.deepEqual(top.map((x) => x.name), want);
  assert.deepEqual(top.map((x) => x.rank), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.deepEqual(await db.topEntriesOf(null), []);
});

test('③ 개요 — 7일 기준이 없으면 증감·신규 null · 기준이 생기면 d7·new7 · 추이 점은 30개 이하(첫·마지막 포함) · 결과 없음은 사유', async () => {
  R._resetForTest();
  // 기준 없음: 스캔 1회
  await db.insertScan(scanRec('ov1', T0 - 2 * DAY, [['alice', 40 * G], ['bob', 12 * G]]));
  let [o] = await R.buildOverview(['ov1']);
  assert.equal(o.state, 'ok');
  assert.equal(o.base7, null);
  assert.equal(o.totalDelta7, null);
  assert.ok(o.top.every((x) => x.d7 === null && x.new7 === null), '기준이 없으면 증감을 지어내지 않는다');
  assert.equal(o.top[0].name, 'alice');
  assert.ok(Math.abs(o.top[0].share - (40 * G) / o.scan.denom) < 1e-9);
  // 40일치 매일 스캔 → 기준 생김 · 점 줄이기
  for (let d = 40; d >= 3; d--) await db.insertScan(scanRec('ov2', T0 - d * DAY, [['alice', (30 + (40 - d)) * G], ['carol', 5 * G]]));
  await db.insertScan(scanRec('ov2', T0, [['alice', 80 * G], ['carol', 5 * G], ['dave', 9 * G]]));
  [o] = await R.buildOverview(['ov2']);
  assert.ok(o.base7, '7일 이전 성공 스캔이 기준');
  assert.ok(o.points.length <= R.OVERVIEW_POINTS && o.points.length >= 2);
  assert.equal(o.points[o.points.length - 1].ts, T0, '마지막 점은 언제나 남긴다');
  const dave = o.top.find((x) => x.name === 'dave');
  assert.equal(dave.new7, true); assert.equal(dave.d7, null, '새 폴더는 증감 대신 신규');
  const alice = o.top.find((x) => x.name === 'alice');
  assert.equal(alice.new7, false); assert.ok(alice.d7 && alice.d7.bytes > 0);
  assert.ok(o.totalDelta7 && Number.isFinite(o.totalDelta7.bytes));
  // 결과 없음 · 실패만
  await db.insertScan({ agent: '', node: '', targetId: 'ov3', ts: T0, ok: false, path: ROOT, host: 'h', sizeMode: 'h', durationMs: 1, trig: 'schedule', kind: 'timeout', error: 'x' });
  const res = await R.buildOverview(['ov-none', 'ov3']);
  assert.deepEqual(res.map((x) => x.state), ['no-data', 'failed-only']);
  // 점 줄이기 순수
  const pts = Array.from({ length: 100 }, (_, i) => ({ ts: i }));
  const th = R.thinPoints(pts, 30);
  assert.equal(th.length, 30); assert.equal(th[0].ts, 0); assert.equal(th[29].ts, 99);
  assert.equal(R.thinPoints(pts.slice(0, 5), 30).length, 5);
});

test('③ GET /overview — 설정에 있는 대상만 · 최근 실행 기록도 설정에 있는 대상만', async () => {
  writeSettings({ [S.TIMEOUT_MARK]: 120, retentionDays: 400, targets: [
    { id: 'ov2', host: '10.0.0.5', username: 'admin', path: ROOT },
    { id: 'ov3', host: '10.0.0.6', username: 'admin', path: ROOT },
  ] });
  S._resetForTest(); R._resetForTest();
  const r = await call('GET', '/tools/isilon-dirusage/overview');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.targets.map((x) => x.id), ['ov2', 'ov3']);
  assert.equal(r.body.pool, R.OVERVIEW_POOL);
  assert.ok(r.body.recent.length > 0);
  assert.ok(r.body.recent.every((x) => ['ov2', 'ov3'].includes(x.targetId)), '설정에서 빠진 대상(ov1·ov-tie)의 기록은 싣지 않는다');
  assert.ok(r.body.recent.some((x) => x.ok === false), '실패 기록도 싣는다');
});

/* ═══════════════ ④ 일괄 변경 ═══════════════ */

const CTX = {
  devices: [
    { id: 'dev-a', type: 'isilon', host: '10.1.0.1', agent: 'EdgeA', datacenterId: 'dc1', name: 'isi-a', username: 'admin' },
    { id: 'dev-b', type: 'isilon', host: '10.1.0.2', agent: '', datacenterId: 'dc2', name: 'isi-b', username: 'admin' },
  ],
  agents: ['EdgeA', 'EdgeB'], dcs: [{ id: 'dc1', name: 'DC1' }, { id: 'dc2', name: 'DC2' }],
  pickAgent: (v, list, prev) => { const s = String(v || ''); if (!s) return { value: '' }; const hit = list.find((a) => a.toLowerCase() === s.toLowerCase()); return hit ? { value: hit } : (s === prev ? { value: s } : { error: `목록에 없는 엣지입니다: ${s}` }); },
  pickDatacenter: (v, list, prev) => { const s = String(v || ''); if (!s) return { value: '' }; return list.some((d) => d.id === s) || s === prev ? { value: s } : { error: '목록에 없는 DataCenter' }; },
  ssrfBlockReason: () => null,
};
const BASE = [
  { id: 'r1', label: '등록부 A', deviceId: 'dev-a', path: ROOT, sizeMode: 'h', intervalHours: 24, timeoutMin: 120, topN: 10, port: 22, enabled: true, auth: 'key', detach: true, username: '', runVia: 'device' },
  { id: 'r2', label: '등록부 B', deviceId: 'dev-b', path: ROOT, sizeMode: 'h', intervalHours: 24, timeoutMin: 120, topN: 10, port: 22, enabled: true, auth: 'device', detach: true, username: '', runVia: 'device' },
  { id: 'd1', label: '직접', host: '10.2.0.1', username: 'admin', agent: '', datacenterId: 'dc1', path: ROOT, sizeMode: 'h', intervalHours: 24, timeoutMin: 120, topN: 10, port: 22, enabled: true, auth: 'key', detach: true, mail: { to: ['a@corp.local'], excludeCommon: false, onlyOnChange: false, onFailure: false } },
];

test('④ 바꿀 항목 정규화 — 빈 값은 그대로(뺀다) · 범위 밖·모르는 키·잘못된 주소는 오류(조용히 자르지 않는다)', () => {
  assert.deepEqual(B.normalizeBulkPatch({ timeoutMin: 180, intervalHours: '', enabled: false, sizeMode: '' }).patch, { enabled: false, timeoutMin: 180 });
  assert.equal(B.normalizeBulkPatch({ timeoutMin: 181 }).field, 'timeoutMin');
  assert.equal(B.normalizeBulkPatch({ timeoutMin: 12.5 }).field, 'timeoutMin');
  assert.equal(B.normalizeBulkPatch({ password: 'x' }).field, 'password');
  assert.equal(B.normalizeBulkPatch({}).field, 'patch');
  assert.equal(B.normalizeBulkPatch({ enabled: 'yes' }).field, 'enabled');
  assert.equal(B.normalizeBulkPatch({ mailTo: { mode: 'add', list: 'x@@corp' } }).field, 'mailTo');
  assert.equal(B.normalizeBulkPatch({ mailTo: { mode: 'add', list: '' } }).field, 'mailTo', '추가할 주소 없음');
  assert.deepEqual(B.normalizeBulkPatch({ mailTo: { mode: 'clear' } }).patch.mailTo, { mode: 'clear', list: [] });
  assert.equal(B.normalizeBulkPatch({ datacenterId: '__none__' }).patch.datacenterId, '');
  assert.equal(B.normalizeBulkPatch({ username: '__registry__' }).patch.username, '');
  assert.ok(B.BULK_KEYS.length >= 15);
});

test('④ 적용(순수) — 고른 대상만 · 대상에 맞지 않는 항목은 그 대상에서만 뺀다 · 정규화가 거절한 대상은 그대로 · 바뀐 키를 센다', () => {
  const p = B.normalizeBulkPatch({ timeoutMin: 180, datacenterId: 'dc2', runNode: B.RUN_FOLLOW, auth: 'device', mailTo: { mode: 'add', list: 'b@corp.local\nA@corp.local' }, mailOnFailure: true }).patch;
  const r = B.applyBulk(BASE, ['r1', 'd1', 'nope'], p, CTX);
  assert.deepEqual(r.notFound, ['nope']);
  const byId = new Map(r.targets.map((x) => [x.id, x]));
  assert.equal(byId.get('r2').timeoutMin, 120, '고르지 않은 대상은 그대로');
  assert.equal(byId.get('r1').timeoutMin, 180);
  assert.equal(byId.get('r1').auth, 'device');
  assert.equal(byId.get('d1').timeoutMin, 180);
  assert.equal(byId.get('d1').auth, 'key', '직접 입력 대상에는 등록부 계정 인증을 쓸 수 없다 — 그 항목만 뺀다');
  assert.equal(byId.get('d1').datacenterId, 'dc2', 'DataCenter 는 직접 입력 대상에만');
  assert.deepEqual(byId.get('d1').mail.to, ['a@corp.local', 'b@corp.local'], '추가는 같은 주소(대소문자 무시)를 겹치지 않는다');
  assert.equal(byId.get('d1').mail.onFailure, true);
  const na = r.notApplied.map((x) => `${x.id}:${x.key}:${x.reason}`).sort();
  assert.deepEqual(na, ['d1:auth:device-auth-needs-registry', 'd1:runNode:follow-needs-registry', 'r1:datacenterId:dc-from-registry']);
  assert.ok(r.notApplied.every((x) => B.NOT_APPLIED_CODES.includes(x.reason)));
  assert.deepEqual(r.changed.map((x) => x.id).sort(), ['d1', 'r1']);
  assert.ok(r.changed.find((x) => x.id === 'r1').keys.includes('timeoutMin'));
  // 거절: 다른 엣지에서 등록부 계정 인증 → r2 는 그대로, r1 은 바뀐다(키 인증이라 통과)
  const p2 = B.normalizeBulkPatch({ runNode: 'EdgeB' }).patch;
  const r2 = B.applyBulk(BASE, ['r1', 'r2'], p2, CTX);
  assert.deepEqual(r2.skipped.map((x) => x.id), ['r2']);
  assert.equal(r2.skipped[0].field, 'auth');
  assert.equal(r2.targets.find((x) => x.id === 'r2').runVia, 'device', '거절된 대상은 저장값 그대로');
  assert.equal(r2.targets.find((x) => x.id === 'r1').agent, 'EdgeB');
  // 이미 같은 값이면 unchanged
  const r3 = B.applyBulk(BASE, ['r1'], B.normalizeBulkPatch({ timeoutMin: 120 }).patch, CTX);
  assert.deepEqual(r3.unchanged, ['r1']); assert.equal(r3.changed.length, 0);
  // 빼기
  const rm = B.removeTargets(BASE, ['r2', 'x']);
  assert.deepEqual(rm.removed, ['r2']); assert.deepEqual(rm.notFound, ['x']); assert.equal(rm.targets.length, 2);
});

test('④ POST /bulk — dryRun 은 저장하지 않음 · 적용은 저장 + 새 rev · 옛 rev 는 409 · 잘못된 patch 400 · 대상 없음 400 · 빼기', async () => {
  writeSettings({ [S.TIMEOUT_MARK]: 120, retentionDays: 400, mail: { commonTo: ['ops@corp.local'] }, targets: BASE.filter((x) => !x.deviceId).concat([
    { id: 'd2', label: '직접2', host: '10.2.0.2', username: 'admin', agent: '', datacenterId: '', path: ROOT, timeoutMin: 60 },
  ]) });
  S._resetForTest();
  const g = await call('GET', '/tools/isilon-dirusage/settings');
  assert.equal(g.status, 200); assert.ok(g.body.rev); assert.deepEqual(g.body.bulkKeys, B.BULK_KEYS);
  const before = fs.readFileSync(SFILE, 'utf8');
  const dry = await call('POST', '/tools/isilon-dirusage/bulk', { ids: ['d1', 'd2'], patch: { timeoutMin: 180, enabled: false }, dryRun: true, rev: g.body.rev });
  assert.equal(dry.status, 200, JSON.stringify(dry.body));
  assert.equal(dry.body.saved, false); assert.equal(dry.body.changed.length, 2);
  assert.equal(fs.readFileSync(SFILE, 'utf8'), before, 'dryRun 은 파일을 건드리지 않는다');
  const ap = await call('POST', '/tools/isilon-dirusage/bulk', { ids: ['d1', 'd2'], patch: { timeoutMin: 180, enabled: false }, rev: g.body.rev });
  assert.equal(ap.status, 200, JSON.stringify(ap.body));
  assert.equal(ap.body.saved, true);
  assert.notEqual(ap.body.rev, g.body.rev);
  assert.ok(ap.body.settings.targets.every((x) => x.timeoutMin === 180 && x.enabled === false));
  assert.deepEqual(ap.body.settings.mail.commonTo, ['ops@corp.local'], '공통 수신자·보존일은 건드리지 않는다');
  assert.equal(ap.body.settings.retentionDays, 400);
  const stale = await call('POST', '/tools/isilon-dirusage/bulk', { ids: ['d1'], patch: { topN: 20 }, rev: g.body.rev });
  assert.equal(stale.status, 409); assert.equal(stale.body.code, 'rev-changed');
  assert.equal((await call('POST', '/tools/isilon-dirusage/bulk', { ids: ['d1'], patch: { timeoutMin: 999 } })).status, 400);
  assert.equal((await call('POST', '/tools/isilon-dirusage/bulk', { ids: [], patch: { topN: 20 } })).status, 400);
  // 바뀐 것이 없으면 저장하지 않는다
  const same = await call('POST', '/tools/isilon-dirusage/bulk', { ids: ['d1'], patch: { timeoutMin: 180 } });
  assert.equal(same.status, 200); assert.equal(same.body.saved, false); assert.deepEqual(same.body.unchanged, ['d1']);
  // 빼기
  const rm = await call('POST', '/tools/isilon-dirusage/bulk', { ids: ['d2'], remove: true, rev: ap.body.rev });
  assert.equal(rm.status, 200, JSON.stringify(rm.body)); assert.deepEqual(rm.body.removed, ['d2']);
  assert.deepEqual(rm.body.settings.targets.map((x) => x.id), ['d1']);
});
