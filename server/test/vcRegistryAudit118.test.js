/**
 * vcRegistryAudit118.test.js — 전체 점검 118회차(vCenter 등록부 vcenters.json · 표시 순서 vcenter-order.json 의 '읽기 오류 ≠ 손상') 확정분 회귀.
 *
 *  F1(높음) vcenter/registry.js — 읽기 오류(EMFILE · EIO · EACCES · EISDIR)를 손상과 같은 catch 로 받아 온전한 vcenters.json(전 vCenter 접속 계정)을
 *      `.corrupt.*` 로 옮기고 빈 목록으로 돌았다. 화면 조회 · 점검 폴러마다 읽는 등록부라 일시 오류 한 번에 원본이 사라졌고, 다음 등록이 한 건짜리 파일을 썼다.
 *      → 원본 유지 · 마지막으로 읽은 목록 · 쓰기 거절(registry-unreadable) · 30초 간격 재읽기 · 손상은 예전처럼 보존.
 *  F2(높음) config.js loadVcenterConfig — 같은 파일을 따로 읽는 수집 경로. 읽기 오류에 빈 목록을 줘 store 가 그 주기에 'vCenter 0개' 로 돌며
 *      수집 캐시(lastGood) · 위임 인벤토리를 지웠다 → 마지막으로 읽은 원문으로 답하고 `readError` 를 싣는다. 마지막 원문이 없으면 store 는 주기를 건너뛴다.
 *  F3(중간) agent/fleetPush.js — vCenter 등록부를 못 읽으면 '호스트 못 읽은 vCenter' 보류가 빈 목록으로 통과했다(84회차 남긴 것 ①) → 보내지 않는다.
 *  F4(중간) vcenter/order.js — 읽기 오류에도 순서 파일을 `.corrupt.*` 로 옮기고 빈 순서를 재시작까지 캐시했다 → 원본 유지 · 캐시하지 않음 · 저장 거절.
 *  F5(중간) routes/admin/vcenters.js · VCenterAdmin.jsx — 못 읽은 동안의 조회에 표지가 없어 화면이 빈 목록 + '추가' 를 열었다 → 표지 · 쓰기 503 · 화면 잠금.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { stripComments } from './_stripComments.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '..', 'src');

/* ── 자식 프로세스: '기동 때부터 못 읽음'(마지막으로 읽은 목록이 없다) — 새 프로세스라야 진짜 기동 조건이다 ─────────────── */
if (process.env.VC118_CHILD === 'boot-unreadable') {
  const dir = process.env.CONFIG_DIR;
  const out = {};
  const REG = await import('../src/vcenter/registry.js');
  const CFG = await import('../src/config.js');
  await CFG.secretsReady;
  out.list = REG.loadRegistry().length;
  out.loadError = REG.registryLoadError();
  out.add = REG.addVcenter({ id: 'vc-new', name: 'NEW', host: 'https://new.corp.example', username: 'u', password: 'p' });
  out.stillDir = fs.statSync(path.join(dir, 'vcenters.json')).isDirectory();
  out.corrupt = fs.readdirSync(dir).filter((n) => n.includes('.corrupt.')).length;
  const c = CFG.loadVcenterConfig();
  out.cfg = { file: c.file, n: c.vcenters.length, readError: c.readError || null };
  // store: 수집 캐시 · 위임 인벤토리를 지우지 않고 주기를 건너뛴다
  const { store } = await import('../src/store.js');
  const INV = await import('../src/central/inventory.js');
  store.vcCache.set('vc-1', { ok: true, data: { marker: 1 }, at: 1 });
  store.vcLast.set('vc-1', 1);
  const before = store.get();
  await store._refreshBody();
  out.store = { cache: [...store.vcCache.keys()], last: [...store.vcLast.keys()], sameSnapshot: store.get() === before, pruneExported: typeof INV.pruneInventory === 'function' };
  // fleetPush: 베어메탈 목록을 보내지 않는다(요청 자체가 나가지 않는다)
  let fetched = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { fetched += 1; throw new Error('no-network-in-test'); };
  const FP = await import('../src/agent/fleetPush.js');
  const r = await FP.pushFleetNow();
  globalThis.fetch = realFetch;
  out.fleet = { skipped: r.skipped === true, vcRegistryUnreadable: r.vcRegistryUnreadable === true, fetched, lastErr: !!FP.fleetPushStatus().last?.vcRegistryUnreadable };
  process.stdout.write(`\nVC118=${JSON.stringify(out)}\n`);
  process.exit(0);
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'audit118-'));
process.env.CONFIG_DIR = TMP;
process.env.DATA_DIR = TMP;
process.env.AUTH_ENABLED = 'false';
process.env.DATA_SOURCE = 'live';
delete process.env.CENTRAL_URL;
delete process.env.VCENTERS_EXAMPLE_FALLBACK;

const F = (n) => path.join(TMP, n);
const corruptOf = (n) => fs.readdirSync(TMP).filter((x) => x.startsWith(`${n}.corrupt.`));
const express = createRequire(import.meta.url)('express');

// 시계: 실제 시각에서 정시 경계로 떨어뜨려 고정(재읽기 간격 판정 — util/jsonFileRead.js nowMs).
const RD = await import('../src/util/jsonFileRead.js');
let NOW = Math.floor(Date.now() / 3_600_000) * 3_600_000;
RD._setJsonFileLoadClockForTest(() => NOW);
const pass = (ms = RD.READ_RETRY_MS + 1_000) => { NOW += ms; };

// 순서 파일은 모듈을 올리기 전에 둔다 — order.js 는 한 번 읽으면 캐시한다(첫 읽기가 읽기 오류인 경우를 시험한다).
fs.writeFileSync(F('vcenter-order.json'), JSON.stringify({ order: ['vc-b', 'vc-a'] }, null, 2));

const REG = await import('../src/vcenter/registry.js');
const ORD = await import('../src/vcenter/order.js');
const CFG = await import('../src/config.js');
const VAULT = await import('../src/security/secretVault.js');
const { store } = await import('../src/store.js');
await CFG.secretsReady;

const rmTmp = () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ } };
let srv = null;
after(() => { RD._setJsonFileLoadClockForTest(); srv?.close(); rmTmp(); process.once('exit', rmTmp); });

/** 그 파일의 readFileSync 를 code 로 실패시키고 fn 을 돌린다 — 시도한 읽기 횟수를 돌려준다(원본은 건드리지 않는다). */
function withReadError(name, code, fn) {
  const target = F(name);
  const orig = fs.readFileSync;
  let reads = 0;
  fs.readFileSync = function patched(p, ...a) {
    if (String(p) === target) { reads += 1; const e = new Error(`${code}: injected`); e.code = code; throw e; }
    return orig.call(fs, p, ...a);
  };
  try { fn(); } finally { fs.readFileSync = orig; }
  return reads;
}
async function withReadErrorAsync(name, code, fn) {
  const target = F(name);
  const orig = fs.readFileSync;
  fs.readFileSync = function patched(p, ...a) {
    if (String(p) === target) { const e = new Error(`${code}: injected`); e.code = code; throw e; }
    return orig.call(fs, p, ...a);
  };
  try { return await fn(); } finally { fs.readFileSync = orig; }
}
const U = { username: 'adm', role: 'admin', scope: null };
const base = async () => {
  if (srv) return `http://127.0.0.1:${srv.address().port}`;
  const { adminRouter } = await import('../src/routes/admin.js');
  const app = express(); app.use(express.json());
  app.use((req, _r, next) => { req.user = U; next(); });
  app.use('/api/admin', adminRouter);
  srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  return `http://127.0.0.1:${srv.address().port}`;
};
const call = async (method, p, body) => {
  const r = await fetch(`${await base()}${p}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch { j = null; }
  return { status: r.status, body: j };
};
const vc = (id, extra = {}) => ({ id, name: `VC ${id}`, host: `https://${id}.corp.example`, username: 'svc', password: `pw-${id}`, location: { city: '', country: '', region: '아시아' }, ...extra });
const ids = (l) => l.map((v) => v.id);

/* ── F4 표시 순서 — 첫 읽기가 읽기 오류(가장 먼저 돌린다 — order.js 는 읽으면 캐시한다) ───────────────────────────── */

test('F4 표시 순서: 읽기 오류면 원본 유지 · 빈 순서를 캐시로 굳히지 않는다 · 저장 거절(503) · 읽히면 저장된 순서', async () => {
  const before = fs.readFileSync(F('vcenter-order.json'), 'utf8');
  const reads = withReadError('vcenter-order.json', 'EIO', () => {
    assert.deepEqual(ORD.getOrder(), [], '마지막으로 읽은 순서가 없으면 빈 순서(등록 순서)');
    assert.deepEqual(ORD.getOrder(), []);
    assert.equal(ORD.orderWriteRefusal()?.code, 'registry-unreadable');
    assert.equal(ORD.orderWriteRefusal()?.readError, true);
    assert.throws(() => ORD.saveOrder(['vc-a', 'vc-b']), (e) => e.code === 'registry-unreadable', '마지막 방어선 — 읽히지 않는 원본을 덮지 않는다');
    const items = [{ id: 'vc-a' }, { id: 'vc-b' }];
    assert.deepEqual(ids(ORD.sortByOrder(items)), ['vc-a', 'vc-b']);
  });
  assert.equal(reads, 1, `간격 안의 호출은 디스크를 다시 읽지 않는다(읽은 횟수 ${reads})`);
  assert.equal(fs.readFileSync(F('vcenter-order.json'), 'utf8'), before, '원본은 글자 그대로');
  assert.deepEqual(corruptOf('vcenter-order.json'), [], '읽기 오류는 손상 보존본을 만들지 않는다');
  // 라우트: 조회 표지 + 저장 503(간격 안 — 디스크를 다시 보지 않아 아직 읽기 오류 상태)
  const g = await call('GET', '/api/admin/vcenter-order');
  assert.equal(g.status, 200);
  assert.equal(g.body.loadError?.readError, true, '못 읽은 동안의 순서 조회는 표지를 싣는다');
  const p = await call('PUT', '/api/admin/vcenter-order', { order: ['vc-a', 'vc-b'] });
  assert.equal(p.status, 503);
  assert.equal(p.body.code, 'registry-unreadable');
  assert.equal(p.body.ok, false);
  assert.equal(fs.readFileSync(F('vcenter-order.json'), 'utf8'), before);
  // 읽히면 풀린다 — 저장된 순서가 돌아온다(재시작 없이)
  pass();
  assert.deepEqual(ORD.getOrder(), ['vc-b', 'vc-a']);
  assert.equal(ORD.orderWriteRefusal(), null);
  assert.deepEqual(ids(ORD.sortByOrder([{ id: 'vc-a' }, { id: 'vc-b' }, { id: 'vc-c' }])), ['vc-b', 'vc-a', 'vc-c']);
  const g2 = await call('GET', '/api/admin/vcenter-order');
  assert.equal(g2.body.loadError, undefined);
  // 정상 저장은 예전과 같다(파일 모양 · 반환값 · 중복 · 공백 정리)
  assert.deepEqual(ORD.saveOrder([' vc-a ', 'vc-b', 'vc-a', '']), ['vc-a', 'vc-b']);
  assert.equal(fs.readFileSync(F('vcenter-order.json'), 'utf8'), JSON.stringify({ order: ['vc-a', 'vc-b'] }, null, 2));
  assert.deepEqual(ORD.getOrder(), ['vc-a', 'vc-b']);
});

/* ── 정상 경로 계약(예전과 글자 그대로) ───────────────────────────────────────────────────────────── */

test('정상 경로: 파일 없음 = 빈 목록(오류 아님) · 등록 · 수정(비밀번호 생략 = 유지) · 삭제 · 파일 모양은 예전과 같다', () => {
  assert.equal(fs.existsSync(F('vcenters.json')), false);
  assert.deepEqual(REG.loadRegistry(), []);
  assert.equal(REG.registryLoadError(), null, '등록 전 포탈은 파일이 없는 것이 정상이다');
  assert.equal(REG.registryWriteRefusal(), null);
  assert.deepEqual(CFG.loadVcenterConfig(), { file: null, vcenters: [] }, '수집 경로도 예전 모양 그대로(readError 키 없음)');

  const a = REG.addVcenter(vc('vc-a'));
  assert.equal(a.ok, true);
  assert.equal(a.vcenter.hasPassword, true);
  assert.equal('password' in a.vcenter, false);
  assert.equal(REG.addVcenter(vc('vc-b', { collectMode: 'site', pollIntervalSec: 120 })).ok, true);
  assert.deepEqual(REG.addVcenter(vc('vc-a')), { ok: false, reason: '이미 존재하는 id: vc-a' });
  assert.equal(REG.addVcenter({ id: 'x' }).ok, false);

  const list = REG.loadRegistry();
  assert.deepEqual(ids(list), ['vc-a', 'vc-b']);
  assert.equal(list[0].password, 'pw-vc-a');
  // 파일은 { vcenters: [...] } 2칸 들여쓰기 — 저장 형식이 바뀌지 않았다
  assert.equal(fs.readFileSync(F('vcenters.json'), 'utf8'), JSON.stringify({ vcenters: list }, null, 2));
  assert.equal(fs.statSync(F('vcenters.json')).mode & 0o777, 0o600);
  assert.deepEqual(ids(CFG.loadVcenterConfig().vcenters), ['vc-a', 'vc-b']);
  assert.equal(CFG.loadVcenterConfig().file, F('vcenters.json'));
  assert.equal('readError' in CFG.loadVcenterConfig(), false);

  const u = REG.updateVcenter('vc-a', { name: '이름만 바꿈' });
  assert.equal(u.ok, true);
  assert.deepEqual(u.droppedSecrets, []);
  assert.equal(REG.loadRegistry()[0].name, '이름만 바꿈');
  assert.equal(REG.loadRegistry()[0].password, 'pw-vc-a', '비밀번호를 생략하면 유지');
  assert.deepEqual(REG.updateVcenter('nope', {}), { ok: false, reason: '없는 vCenter: nope' });
  assert.deepEqual(REG.removeVcenter('nope'), { ok: false, reason: '없는 vCenter: nope' });

  assert.equal(REG.addVcenter(vc('vc-c')).ok, true);
  assert.deepEqual(REG.removeVcenter('vc-c'), { ok: true });
  assert.deepEqual(ids(REG.loadRegistry()), ['vc-a', 'vc-b']);
  assert.deepEqual(REG.listRegistry().map((v) => [v.id, v.hasPassword, 'password' in v]), [['vc-a', true, false], ['vc-b', true, false]]);
  // 가져오기(병합) — 기존 항목 갱신 + 새 항목 추가
  const imp = REG.importVcenters([vc('vc-b', { name: 'B2' }), { id: '' }], 'merge');
  assert.deepEqual([imp.ok, imp.added, imp.updated, imp.skipped.length, imp.total], [true, 0, 1, 1, 2]);
  assert.equal(REG.importVcenters([], 'replace').ok, false, '빈 전체 교체는 거절(예전 그대로)');
  assert.equal(REG.registryLoadError(), null);
  // 받은 목록을 고쳐도 다음 로드에 묻지 않는다(호출부와 객체를 나누지 않는다)
  const l1 = REG.loadRegistry(); l1[0].password = 'tampered'; l1.push({ id: 'ghost' });
  assert.deepEqual(REG.loadRegistry().map((v) => [v.id, v.password]), [['vc-a', 'pw-vc-a'], ['vc-b', 'pw-vc-b']]);
});

/* ── F1 등록부 — 읽기 오류 ≠ 손상 ──────────────────────────────────────────────────────────────── */

test('F1 등록부: 읽기 오류 한 번에 원본이 옮겨지지 않는다 · 마지막 목록 · 쓰기 4종 거절 · 간격 안 재읽기 없음 · 읽히면 풀림', () => {
  const before = fs.readFileSync(F('vcenters.json'), 'utf8');
  const reads = withReadError('vcenters.json', 'EMFILE', () => {
    const l = REG.loadRegistry();
    assert.deepEqual(l.map((v) => [v.id, v.password]), [['vc-a', 'pw-vc-a'], ['vc-b', 'pw-vc-b']], '마지막으로 읽은 목록(비밀번호 포함 — 연결 테스트 · 점검이 이어진다)');
    l[0].password = 'tampered';
    assert.equal(REG.loadRegistry()[0].password, 'pw-vc-a', '마지막 목록도 호출마다 새 객체');
    assert.deepEqual(ids(REG.listRegistry()), ['vc-a', 'vc-b']);
    const le = REG.registryLoadError();
    assert.equal(le?.readError, true);
    assert.equal(le?.code, 'EMFILE');
    assert.doesNotMatch(le.reason, /pw-|corp\.example/, '사유에 파일 조각이 없다');
    for (const r of [
      REG.addVcenter(vc('vc-new')),
      REG.updateVcenter('vc-a', { name: 'x' }),
      REG.removeVcenter('vc-a'),
      REG.importVcenters([vc('vc-imp')], 'merge'),
      REG.importVcenters([vc('vc-imp')], 'replace'),
    ]) {
      assert.equal(r.ok, false);
      assert.equal(r.code, 'registry-unreadable', JSON.stringify(r).slice(0, 120));
      assert.equal(r.readError, true);
    }
    assert.equal(REG.registryWriteRefusal()?.code, 'registry-unreadable');
  });
  assert.equal(reads, 1, `간격 안의 호출은 디스크를 다시 읽지 않는다(읽은 횟수 ${reads})`);
  assert.equal(fs.readFileSync(F('vcenters.json'), 'utf8'), before, '원본은 글자 그대로(한 건짜리로 덮이지 않았다)');
  assert.deepEqual(corruptOf('vcenters.json'), [], '읽기 오류는 손상 보존본을 만들지 않는다');
  // 간격 안: 파일은 읽히지만 아직 다시 보지 않았다 — 쓰기는 계속 거절(원본 보호 쪽)
  assert.equal(REG.addVcenter(vc('vc-new')).code, 'registry-unreadable');
  // 간격이 지나면 다시 읽고 풀린다(재시작 · 사람 조치 없이)
  pass();
  assert.deepEqual(ids(REG.loadRegistry()), ['vc-a', 'vc-b']);
  assert.equal(REG.registryLoadError(), null);
  assert.equal(REG.registryWriteRefusal(), null);
  assert.equal(REG.addVcenter(vc('vc-new')).ok, true);
  assert.deepEqual(REG.removeVcenter('vc-new'), { ok: true });
  assert.equal(fs.readFileSync(F('vcenters.json'), 'utf8'), before);
});

test('F1 등록부: 저장 직후의 읽기 오류는 저장 전 목록(지운 vCenter · 옛 비밀번호)을 되살리지 않는다', () => {
  assert.equal(REG.addVcenter(vc('vc-tmp')).ok, true);
  assert.equal(REG.updateVcenter('vc-a', { password: 'rotated!' }).ok, true);
  assert.deepEqual(REG.removeVcenter('vc-tmp'), { ok: true });
  withReadError('vcenters.json', 'EIO', () => {
    assert.deepEqual(REG.loadRegistry().map((v) => [v.id, v.password]), [['vc-a', 'rotated!'], ['vc-b', 'pw-vc-b']]);
  });
  pass();
  assert.equal(REG.updateVcenter('vc-a', { password: 'pw-vc-a' }).ok, true);
  assert.equal(REG.registryLoadError(), null);
});

test('F2 수집 경로(loadVcenterConfig): 읽기 오류면 마지막으로 읽은 목록 + readError 표지 · 손상 · 삭제는 예전과 같다', () => {
  assert.deepEqual(ids(CFG.loadVcenterConfig().vcenters), ['vc-a', 'vc-b']);
  withReadError('vcenters.json', 'EMFILE', () => {
    const c = CFG.loadVcenterConfig();
    assert.deepEqual(c.vcenters.map((v) => [v.id, v.password]), [['vc-a', 'pw-vc-a'], ['vc-b', 'pw-vc-b']], '빈 목록이 아니라 마지막으로 읽은 목록');
    assert.equal(c.readError, 'EMFILE');
    assert.equal(c.file, F('vcenters.json'), '소비처의 "파일은 있는데 못 읽음" 판정(!file)이 걸리지 않는다 — 목록이 있다');
    c.vcenters[0].password = 'tampered';
    assert.equal(CFG.loadVcenterConfig().vcenters[0].password, 'pw-vc-a', '호출마다 새 객체');
  });
  assert.equal('readError' in CFG.loadVcenterConfig(), false, '읽히면 표지가 없다(간격 없이 매번 읽는다)');
});

test('F2 store: 읽기 오류 주기에 수집 캐시 · 마지막 수집 시각을 지우지 않고 vCenter 목록이 스냅샷에 남는다', async () => {
  // 수집 대상이 없게(비활성) — 망을 타지 않는다. 캐시 정리 · 병합만 돈다.
  assert.equal(REG.updateVcenter('vc-a', { enabled: false }).ok, true);
  assert.equal(REG.updateVcenter('vc-b', { enabled: false }).ok, true);
  await store._refreshBody();
  assert.deepEqual(ids(store.get().vcenters), ['vc-a', 'vc-b']);
  store.vcCache.set('vc-a', { ok: true, data: { marker: 1 }, at: 1 });
  store.vcLast.set('vc-a', 1);
  const snapBefore = store.get();
  await withReadErrorAsync('vcenters.json', 'EMFILE', () => store._refreshBody());
  assert.notEqual(store.get(), snapBefore, '마지막으로 읽은 목록이 있으면 주기는 그대로 돈다(수집을 멈추지 않는다)');
  assert.deepEqual([...store.vcCache.keys()], ['vc-a'], '등록부를 한 번 못 읽었다고 수집 캐시(lastGood)를 지우지 않는다');
  assert.deepEqual([...store.vcLast.keys()], ['vc-a']);
  assert.deepEqual(ids(store.get().vcenters), ['vc-a', 'vc-b'], '스냅샷이 vCenter 0개로 바뀌지 않는다');
  store.vcCache.clear(); store.vcLast.clear();
  pass();
  assert.equal(REG.updateVcenter('vc-a', { enabled: true }).ok, true);
  assert.equal(REG.updateVcenter('vc-b', { enabled: true }).ok, true);
});

/* ── F5 라우트 — 조회 표지 · 쓰기 503 ───────────────────────────────────────────────────────────── */

test('F5 라우트: 못 읽은 동안 조회는 표지 + 마지막 목록 · 등록 · 수정 · 삭제 · 가져오기는 503 registry-unreadable · 읽히면 풀림', async () => {
  const before = fs.readFileSync(F('vcenters.json'), 'utf8');
  const ok0 = await call('GET', '/api/admin/vcenters');
  assert.equal(ok0.status, 200);
  assert.equal(ok0.body.loadError, undefined, '읽을 수 있으면 표지가 없다');
  assert.deepEqual(ids(ok0.body.vcenters), ['vc-a', 'vc-b']);

  await withReadErrorAsync('vcenters.json', 'EACCES', async () => {
    const g = await call('GET', '/api/admin/vcenters');
    assert.equal(g.status, 200);
    assert.equal(g.body.loadError?.readError, true);
    assert.equal(g.body.loadError?.code, 'EACCES');
    assert.doesNotMatch(JSON.stringify(g.body.loadError), /pw-|audit118-/, '표지에 파일 경로 · 원문 조각이 없다');
    assert.deepEqual(ids(g.body.vcenters), ['vc-a', 'vc-b'], '마지막으로 읽은 목록');
    assert.equal(JSON.stringify(g.body).includes('pw-vc-a'), false, '비밀번호는 싣지 않는다');
    for (const r of [
      await call('POST', '/api/admin/vcenters', vc('vc-new')),
      await call('PUT', '/api/admin/vcenters/vc-a', { name: 'x', password: '' }),
      await call('DELETE', '/api/admin/vcenters/vc-a'),
      await call('POST', '/api/admin/vcenters/import', { vcenters: [vc('vc-imp')], mode: 'replace' }),
    ]) {
      assert.equal(r.status, 503, JSON.stringify(r.body).slice(0, 160));
      assert.equal(r.body.ok, false);
      assert.equal(r.body.code, 'registry-unreadable');
      assert.match(r.body.reason, /읽지 못한 상태라 저장하지 않았습니다/);
    }
  });
  assert.equal(fs.readFileSync(F('vcenters.json'), 'utf8'), before);
  assert.deepEqual(corruptOf('vcenters.json'), []);
  pass();
  const g2 = await call('GET', '/api/admin/vcenters');
  assert.equal(g2.body.loadError, undefined);
  const p = await call('PUT', '/api/admin/vcenters/vc-a', { name: 'VC vc-a', password: '' });
  assert.equal(p.status, 200);
  assert.equal(p.body.ok, true);
  const bad = await call('POST', '/api/admin/vcenters', { id: 'no-name' });
  assert.equal(bad.status, 400, '형식 오류는 예전처럼 400');
  const gone = await call('DELETE', '/api/admin/vcenters/nope');
  assert.equal(gone.status, 404, '없는 id 삭제는 예전처럼 404');
});

test('F5 화면 스윕: vCenter 관리 화면은 조회 표지를 읽고 쓰기 버튼을 잠근다', () => {
  const s = stripComments(fs.readFileSync(path.join(HERE, '..', '..', 'web', 'src', 'views', 'VCenterAdmin.jsx'), 'utf8'));
  assert.match(s, /const unread = unreadMarkOf\(data\)/);
  assert.match(s, /const locked = saveLockedByUnread\(unread\)/);
  assert.match(s, /<SettingsUnreadBanner le=\{unread\}/);
  for (const what of ['onClick={openAdd}', 'onClick={() => remove(vc)}', 'onClick={() => toggleMaintenance(vc)}', 'onClick={importFromServer}', 'onClick={save}']) {
    const line = s.split('\n').find((l) => l.includes(what) && l.includes('<button'));
    assert.ok(line, what);
    assert.match(line, /disabled=\{[^}]*locked[^}]*\}/, `${what} — 못 읽은 동안 잠근다`);
  }
  assert.doesNotMatch(s, /`[^`\n]*`\s*<\/td>/, '화면 문구에 백틱 없음');
});

/* ── 손상은 예전대로 ───────────────────────────────────────────────────────────────────────── */

test('손상(JSON 형식)은 예전대로: 보존본으로 옮기고 빈 목록 · 그 사실이 표지에 남는다 · 관리자 저장이 새 등록부를 만든다', async () => {
  const good = fs.readFileSync(F('vcenters.json'), 'utf8');
  fs.writeFileSync(F('vcenters.json'), '{"vcenters":[{"id":"vc-a","password":"SuperSecret12');
  // 수집 경로가 먼저 손상본을 본 경우: 빈 목록(예전 그대로) — 그리고 손상 전 목록을 '마지막으로 읽은 목록' 으로 되살리지 않는다
  assert.deepEqual(CFG.loadVcenterConfig().vcenters, []);
  withReadError('vcenters.json', 'EIO', () => {
    const c = CFG.loadVcenterConfig();
    assert.deepEqual(c.vcenters, [], '손상을 본 뒤의 읽기 오류가 손상 전 목록으로 손상을 가리지 않는다');
    assert.equal(c.file, null);
    assert.equal(c.readError, 'EIO');
  });
  assert.deepEqual(REG.loadRegistry(), []);
  assert.equal(corruptOf('vcenters.json').length, 1, '손상본은 보존본으로');
  assert.equal(fs.existsSync(F('vcenters.json')), false);
  const le = REG.registryLoadError();
  assert.ok(le && !le.readError, '손상은 읽기 오류가 아니다');
  assert.equal(REG.registryWriteRefusal(), null, '손상은 쓰기를 거절하지 않는다(관리자 저장이 해제 길 — v2.612 규약)');
  assert.deepEqual(CFG.loadVcenterConfig().vcenters, [], '수집 경로도 예전처럼 빈 목록(마지막 원문으로 가리지 않는다)');
  const g = await call('GET', '/api/admin/vcenters');
  assert.ok(g.body.loadError && g.body.loadError.readError !== true);
  assert.doesNotMatch(JSON.stringify(g.body.loadError), /SuperSecret/, '손상 사유에 파일 조각이 없다');
  assert.deepEqual(g.body.vcenters, []);
  assert.equal(REG.addVcenter(vc('vc-fresh')).ok, true);
  assert.equal(REG.registryLoadError(), null, '저장으로 풀린다');
  assert.deepEqual(ids(REG.loadRegistry()), ['vc-fresh']);
  assert.equal(corruptOf('vcenters.json').length, 1, '보존본은 그대로 남는다');
  // 모양만 다른 파일(vcenters 배열 없음)은 예전처럼 빈 목록 · 보존하지 않는다
  fs.writeFileSync(F('vcenters.json'), '{}');
  assert.deepEqual(REG.loadRegistry(), []);
  assert.equal(corruptOf('vcenters.json').length, 1);
  assert.equal(fs.readFileSync(F('vcenters.json'), 'utf8'), '{}');
  // 되돌려 둔다(다음 시험)
  for (const n of corruptOf('vcenters.json')) fs.rmSync(F(n));
  fs.writeFileSync(F('vcenters.json'), good);
  assert.deepEqual(ids(REG.loadRegistry()), ['vc-a', 'vc-b']);
});

/* ── 봉인 모드 ──────────────────────────────────────────────────────────────────────────── */

test('봉인 모드: 읽기 오류 동안의 마지막 목록은 봉인본에서 다시 푼다 · 파일(암호문)은 그대로 · 읽히면 저장이 암호문을 재사용한다', () => {
  VAULT.saveSecretsPolicy({ mode: 'encrypted', level: 1 });
  try {
    assert.equal(REG.updateVcenter('vc-a', { name: 'VC vc-a' }).ok, true);   // 봉인해서 다시 쓴다
    const sealed = fs.readFileSync(F('vcenters.json'), 'utf8');
    assert.match(sealed, /"password": "enc\$1\$/);
    assert.equal(sealed.includes('pw-vc-a'), false, '파일에 평문 비밀번호가 없다');
    assert.equal(REG.loadRegistry()[0].password, 'pw-vc-a');
    withReadError('vcenters.json', 'EIO', () => {
      assert.deepEqual(REG.loadRegistry().map((v) => [v.id, v.password]), [['vc-a', 'pw-vc-a'], ['vc-b', 'pw-vc-b']]);
      assert.deepEqual(CFG.loadVcenterConfig().vcenters.map((v) => [v.id, v.password]), [['vc-a', 'pw-vc-a'], ['vc-b', 'pw-vc-b']]);
      assert.equal(REG.updateVcenter('vc-a', { password: 'x' }).code, 'registry-unreadable');
    });
    assert.equal(fs.readFileSync(F('vcenters.json'), 'utf8'), sealed, '암호문 원본은 글자 그대로');
    assert.deepEqual(corruptOf('vcenters.json'), []);
    pass();
    assert.equal(REG.updateVcenter('vc-b', { pollIntervalSec: 90 }).ok, true);
    const after2 = fs.readFileSync(F('vcenters.json'), 'utf8');
    const pwOf = (t) => JSON.parse(t).vcenters.map((v) => v.password);
    assert.deepEqual(pwOf(after2), pwOf(sealed), '비밀이 안 바뀐 저장은 암호문이 글자 그대로(재사용 — v2.598)');
    assert.equal(REG.loadRegistry()[1].pollIntervalSec, 90);
  } finally {
    VAULT.saveSecretsPolicy({ mode: 'plain' });
  }
});

/* ── 기동 때부터 못 읽음(새 프로세스) ─────────────────────────────────────────────────────────── */

test('기동 때부터 못 읽음: 빈 목록이지만 표지가 선다 · 원본 그대로 · 쓰기 거절 · store 는 주기를 건너뛰고 · fleetPush 는 보내지 않는다', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit118c-'));
  try {
    fs.mkdirSync(path.join(dir, 'vcenters.json'));   // 읽으면 EISDIR — 권한과 무관하게(root 로 도는 CI 에서도) 읽기 단계 실패
    const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
      env: { ...process.env, VC118_CHILD: 'boot-unreadable', CONFIG_DIR: dir, DATA_DIR: dir, DATA_SOURCE: 'live', AUTH_ENABLED: 'false', CENTRAL_URL: 'http://127.0.0.1:9', AGENT_NAME: 'edge-118', NODE_TEST_CONTEXT: '' },
      encoding: 'utf8', timeout: 60_000,
    });
    const line = String(r.stdout || '').split('\n').find((l) => l.startsWith('VC118='));
    assert.ok(line, `자식 출력 없음: ${String(r.stderr || '').slice(-600)}`);
    const out = JSON.parse(line.slice('VC118='.length));
    assert.equal(out.list, 0);
    assert.equal(out.loadError?.readError, true, '빈 목록이지만 "못 읽음" 표지가 선다(등록 0개가 아니다)');
    assert.equal(out.loadError?.code, 'EISDIR');
    assert.equal(out.add.ok, false);
    assert.equal(out.add.code, 'registry-unreadable');
    assert.equal(out.stillDir, true, '원본을 옮기지 않았다');
    assert.equal(out.corrupt, 0);
    assert.deepEqual(out.cfg, { file: null, n: 0, readError: 'EISDIR' });
    assert.deepEqual(out.store.cache, ['vc-1'], 'store 는 그 주기를 건너뛴다(캐시를 지우지 않는다)');
    assert.deepEqual(out.store.last, ['vc-1']);
    assert.equal(out.store.sameSnapshot, true, '빈 스냅샷으로 바꾸지 않는다');
    assert.deepEqual(out.fleet, { skipped: true, vcRegistryUnreadable: true, fetched: 0, lastErr: true }, 'fleetPush 는 베어메탈 목록을 보내지 않는다');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

/* ── 스윕 ──────────────────────────────────────────────────────────────────────────────── */

test('스윕: 등록부 · 순서 파일은 공용 읽기(loadErr.read)로 읽고 손상 보존을 직접 부르지 않는다 · 쓰기는 거절을 먼저 본다', () => {
  for (const rel of ['vcenter/registry.js', 'vcenter/order.js']) {
    const s = stripComments(fs.readFileSync(path.join(SRC, rel), 'utf8'));
    assert.match(s, /loadErr\.read\(FILE,/, rel);
    assert.doesNotMatch(s, /preserveCorrupt\(/, `${rel}: 읽기와 parse 를 한 catch 로 받는 손상 보존으로 되돌리지 말 것`);
    assert.doesNotMatch(s, /fs\.readFileSync\(FILE/, rel);
    assert.match(s, /loadErr\.assertWritable\(WHAT\)/, `${rel}: 저장 직전 마지막 방어선`);
  }
  const reg = stripComments(fs.readFileSync(path.join(SRC, 'vcenter/registry.js'), 'utf8'));
  for (const fn of ['addVcenter', 'updateVcenter', 'removeVcenter', 'importVcenters']) {
    const at = reg.indexOf(`export function ${fn}(`);
    assert.ok(at >= 0, fn);
    const body = reg.slice(at, reg.indexOf('\nexport function ', at + 10) > 0 ? reg.indexOf('\nexport function ', at + 10) : undefined);
    const ref = body.indexOf('loadErr.writeRefusal(WHAT)');
    const save = body.indexOf('saveRegistry(');
    assert.ok(ref >= 0 && save > ref, `${fn}: 저장 전에 읽기 오류 거절을 본다`);
  }
  const st = stripComments(fs.readFileSync(path.join(SRC, 'store.js'), 'utf8'));
  assert.match(st, /if \(vcCfg\.readError && !vcCfg\.file\)/, 'store: 못 읽고 마지막 목록도 없으면 주기를 건너뛴다');
});
