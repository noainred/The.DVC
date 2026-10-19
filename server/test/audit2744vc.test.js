/**
 * test/audit2744vc.test.js — v2.744 최종 수정분 적대적 검토 생존분 그룹 VC.
 *
 * RV2744F-LOAD-01 — preserveCorrupt 를 거치지 않고 **스스로** `<파일>.corrupt.<시각>` 사본을 만드는 로더 6곳이 V8 JSON.parse 오류 원문을
 *   그대로 콘솔에 찍었다(게스트 조사 예약 · 패킷 캡처 모니터 · 중앙 엣지 토큰 · 위임 인벤토리 캐시 · OS 스캔 설정 · 로그인 모니터 설정).
 *   V8 은 오류 위치 앞뒤 원문 약 10자를 싣는다 — guest-scans.json·capture-monitors.json 은 기본 평문 모드에서 비밀번호가 원문 그대로라
 *   그 조각이 실제 비밀번호 앞부분이다(재현: `"guestPass": VcSecret2744!` → `Unexpected token 'V', ..."stPass": VcSecret27"... is not valid JSON`).
 *   콘솔 링버퍼는 /admin/logs·로그 분석의 원천이고 엣지에서는 엣지 로그로 중앙에 당겨진다. audit2744fc 의 소스 스윕은 catch 본문에
 *   `preserveCorrupt(` 가 있는 곳만 봐서 이 6곳을 보지 못했다(그 스윕도 이번에 넓혔다 — audit2744fc ②).
 *   여기서는 **실제 모듈 로드**를 손상 파일로 돌리고 콘솔을 가로채 원문 조각 0 · 접두 문구 · 보존 사본(.corrupt.*)을 본다.
 * RV2744F-LOAD-02 — GET /api/tools/isilon-dirusage 응답의 storageRegistryError 가 스토리지 등록부 로드 오류 원문(storage-devices.json 조각)을
 *   요약 없이 실었다. 형제 경로(partFaults·bmusage·central registryUnreadable)와 같은 규칙으로 바꿨다 — 관리자 상세(데모 계정 제외)에는
 *   분류 + 위치 숫자, 그 밖에는 분류 고정 문구 + reasonDetailHidden. 화면은 값이 **있는지만** 본다(오류가 없으면 null).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2744vc-'));
Object.assign(process.env, {
  CONFIG_DIR: TMP, DATA_SOURCE: 'live', AUTH_ENABLED: 'true', SSRF_ALLOW_LOOPBACK: 'true', IPAM_WRITE_WORKER: '0',
  COLLECTOR_TOKEN: 'col-2744vc', CENTRAL_TOKEN: 'ctok-2744vc', AGENT_NAME: 'central-vc',
});
delete process.env.CENTRAL_URL;
delete process.env.DEFAULT_ADMIN_PASSWORD;
fs.writeFileSync(path.join(TMP, 'runtime.json'), JSON.stringify({ dataSource: 'live' }));
fs.writeFileSync(path.join(TMP, 'vcenters.json'), JSON.stringify({ vcenters: [] }));

const SECRET = 'VcSecret2744!';
// 원문 조각의 흔적 — 비밀 값 앞 글자 · V8 조각 형식(요약 문구 'JSON 형식 오류' 는 여기에 걸리지 않는다).
const LEAK = /VcSecre|cSecret27|is not valid JSON|Unexpected token/;
// 비밀 값 바로 앞의 따옴표를 빠뜨린 손편집 — V8 메시지가 그 값의 앞 글자를 싣는다.
const BAD = {
  'central-inventory.json': `{"inventory":{"vc-a":{"agent":"edge-a","data":{"password": ${SECRET}}}}}`,
  'guest-scans.json': `[{"id":"g1","name":"scan","guestUser":"root","guestPass": ${SECRET}}]`,
  'capture-monitors.json': `[{"id":"m1","host":"10.9.0.7","username":"cap","password": ${SECRET}}]`,
  'central-agent-tokens.json': `{"tokens":[{"agent":"edge-a","hash": ${SECRET}}]}`,
  'os-scan.json': `{"enabled":true,"intervalMin":30,"note": ${SECRET}}`,
  'login-monitor.json': `{"enabled":true,"threshold":5,"note": ${SECRET}}`,
  // LOAD-02: 장비 비밀번호가 든 스토리지 등록부
  'storage-devices.json': `{"version":1,"devices":[{"id":"st1","type":"isilon","host":"10.9.0.21","password": ${SECRET}}]}`,
};
for (const [n, body] of Object.entries(BAD)) fs.writeFileSync(path.join(TMP, n), body);

const v8msg = (txt) => { try { JSON.parse(txt); } catch (e) { return e.message; } return ''; };

/** console.* 를 잡는다(줄은 링버퍼 → /admin/logs · 엣지 로그로 나간다). */
async function capture(fn) {
  const lines = []; const saved = { error: console.error, warn: console.warn, log: console.log, info: console.info };
  for (const k of Object.keys(saved)) console[k] = (...a) => { lines.push(a.map(String).join(' ')); };
  try { const v = await fn(); return { v, lines }; } finally { Object.assign(console, saved); }
}
const corruptCopies = (base) => fs.readdirSync(TMP).filter((n) => n.startsWith(`${base}.corrupt.`));

const closers = [];
after(async () => {
  for (const c of closers) { try { await c(); } catch { /* */ } }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ }
});

/* ════════════════════ RV2744F-LOAD-01 실제 모듈 로드 ════════════════════ */

test('RV2744F-LOAD-01 전제: 손편집 파일의 V8 원문은 비밀 값 조각을 싣는다', () => {
  for (const [n, body] of Object.entries(BAD)) assert.match(v8msg(body), LEAK, `${n}: ${v8msg(body)}`);
});

/**
 * 한 파일의 로드를 콘솔 가로채기 안에서 돌리고, 그 파일의 호출부 줄(prefix)이 남았는지 · 원문 조각이 없는지 본다.
 * 보존(.corrupt.*)은 예전 그대로여야 한다(이 수정은 콘솔 문구만 바꾼다).
 */
async function checkLoad(file, prefix, fn) {
  assert.equal(corruptCopies(file).length, 0, `${file}: 전제 — 아직 보존 사본이 없다(다른 모듈이 먼저 읽지 않았다)`);
  const { lines } = await capture(fn);
  const all = lines.join('\n');
  const own = lines.filter((l) => prefix.test(l));
  assert.ok(own.length >= 1, `${file}: 호출부 줄(${prefix})이 남아야 한다 — 로그 분석 규칙이 그 문구를 본다\n${all}`);
  for (const l of own) assert.match(l, /JSON 형식 오류/, `${file}: 분류는 남긴다 — ${l}`);
  assert.doesNotMatch(all, LEAK, `${file}: 콘솔에 원문 조각이 남았다\n${all}`);
  assert.equal(corruptCopies(file).length, 1, `${file}: 손상본 보존(.corrupt.*)은 그대로`);
  assert.equal(fs.existsSync(path.join(TMP, file)), false, `${file}: 원본은 보존 사본으로 옮겨졌다`);
  return own;
}

// ⚠ 순서: central/inventory.js 는 **모듈 로드 때** 파일을 읽는다 — 다른 모듈(store 등)이 먼저 끌고 오기 전에 첫 테스트로 import 한다.
test('RV2744F-LOAD-01 central-inventory.json(모듈 로드) — [central] 줄에 원문 조각이 없다 · 로그 분석 규칙이 그대로 분류한다', async () => {
  const own = await checkLoad('central-inventory.json', /\[central\] \S+central-inventory\.json 파싱 실패\(/, () => import('../src/central/inventory.js'));
  const { CATALOG_RULES } = await import('../src/loganalysis/catalog.js');
  const rule = CATALOG_RULES.find((x) => x.id === 'central-inventory-corrupt');
  assert.ok(rule, 'central-inventory-corrupt 규칙');
  for (const l of own) assert.match(l, new RegExp(rule.re), `로그 분석 규칙(central-inventory-corrupt): ${l}`);
});

test('RV2744F-LOAD-01 guest-scans.json(게스트 비밀번호) — [gscan] 줄에 원문 조각이 없다', async () => {
  const m = await import('../src/security/guestScanScheduler.js');
  await checkLoad('guest-scans.json', /\[gscan\] \S+guest-scans\.json 읽기\/파싱 실패\(/, () => m.listGuestScans());
});

test('RV2744F-LOAD-01 capture-monitors.json(SSH 비밀번호) — [netmon] 줄에 원문 조각이 없다', async () => {
  const m = await import('../src/net/monitor.js');
  await checkLoad('capture-monitors.json', /\[netmon\] \S+capture-monitors\.json 읽기\/파싱 실패\(/, () => m.listMonitors());
});

test('RV2744F-LOAD-01 central-agent-tokens.json — [central-token] 줄에 원문 조각이 없다 · 로그 분석 규칙이 그대로 분류한다', async () => {
  const m = await import('../src/central/agentTokens.js');
  m._resetAgentTokenCache();
  const own = await checkLoad('central-agent-tokens.json', /\[central-token\] central-agent-tokens\.json 파싱 실패\(/, () => m.listAgentTokens());
  const { CATALOG_RULES } = await import('../src/loganalysis/catalog.js');
  const rule = CATALOG_RULES.find((x) => x.id === 'central-token-store-corrupt');
  assert.ok(rule, 'central-token-store-corrupt 규칙');
  for (const l of own) assert.match(l, new RegExp(rule.re), `로그 분석 규칙(central-token-store-corrupt): ${l}`);
});

test('RV2744F-LOAD-01 os-scan.json — [osscan] 줄에 원문 조각이 없다(기본값으로 시작)', async () => {
  const m = await import('../src/inventory/osScanner.js');
  const own = await checkLoad('os-scan.json', /\[osscan\] \S+os-scan\.json 읽기\/파싱 실패\(/, () => m.loadOsScanSettings());
  assert.ok(own.length === 1);
  assert.equal(m.loadOsScanSettings().enabled, false, '손상이면 기본값(꺼짐)으로 시작 — 동작은 예전 그대로');
});

test('RV2744F-LOAD-01 login-monitor.json — [loginmon] 줄에 원문 조각이 없다(기본값으로 시작)', async () => {
  const m = await import('../src/security/loginMonitor.js');
  await checkLoad('login-monitor.json', /\[loginmon\] \S+login-monitor\.json 읽기\/파싱 실패\(/, () => m.loadLoginMonitor());
  assert.equal(m.loadLoginMonitor().threshold, 5, '손상이면 기본값으로 시작 — 동작은 예전 그대로');
});

test('RV2744F-LOAD-01 요약 문구 — 사람이 만든 사유(따옴표 없음)는 그대로, 원문 조각만 요약한다(safeLoadText 계약)', async () => {
  const { safeLoadText } = await import('../src/util/atomicWrite.js');
  assert.equal(safeLoadText(new Error('배열이 아님')), '배열이 아님', '형식 불일치 사유는 조치 단서라 그대로');
  assert.match(safeLoadText(new Error(v8msg(BAD['guest-scans.json']))), /^JSON 형식 오류/);
  assert.doesNotMatch(safeLoadText(new Error(v8msg(BAD['guest-scans.json']))), LEAK);
});

/* ════════════════════ RV2744F-LOAD-02 아이실론 응답의 스토리지 등록부 손상 사유 ════════════════════ */

test('RV2744F-LOAD-02 단위 — storageRegistryErrorView: 관리자 상세는 분류 + 위치 · 그 밖은 분류 고정 문구만 · 오류 없으면 null', async () => {
  const { storageRegistryErrorView } = await import('../src/routes/api/isilonDirUsage.js');
  const AT = 1_790_000_000_000; // 고정 기준 시각(정시 경계와 무관한 표지 값)
  assert.equal(storageRegistryErrorView(null), null, '오류가 없으면 null — 화면은 있는지만 본다');
  assert.equal(storageRegistryErrorView(undefined, { detail: true }), null);
  // 원문(V8 조각)
  const leak = { at: AT, reason: v8msg(BAD['storage-devices.json']).slice(0, 200) };
  assert.match(leak.reason, LEAK, '전제: 등록부 원문에 조각이 있다');
  const before = structuredClone(leak);
  const ad = storageRegistryErrorView(leak, { detail: true });
  const op = storageRegistryErrorView(leak, { detail: false });
  assert.deepEqual(leak, before, '원본(등록부 로드 오류 — 다른 경로와 공유)은 바꾸지 않는다');
  assert.deepEqual(ad, { at: AT, code: 'parse-error', reason: 'JSON 형식 오류' });
  assert.deepEqual(op, { at: AT, code: 'parse-error', reason: 'JSON 형식 오류', reasonDetailHidden: true });
  // 위치를 주는 V8 형식 — 관리자에게는 위치 숫자(조치 단서), 그 밖에는 분류만
  const pos = { at: AT, reason: v8msg('{\n  "devices": [\n    {"id": "st1" "host": "10.9.0.21"}\n  ]\n}') };
  assert.match(storageRegistryErrorView(pos, { detail: true }).reason, /^JSON 형식 오류\(\d+번째 줄 \d+번째 칸\)$/);
  assert.equal(storageRegistryErrorView(pos).reason, 'JSON 형식 오류');
  // 손상 보존본만 남은 재시작 · 읽기 오류(경로는 옮기지 않는다)
  const only = storageRegistryErrorView({ at: AT, reason: '등록부 파일이 없고 손상 보존본(storage-devices.json.corrupt.1)만 있습니다' });
  assert.equal(only.code, 'corrupt-only');
  assert.doesNotMatch(only.reason, /storage-devices\.json\.corrupt/);
  const rd = storageRegistryErrorView({ at: AT, reason: "EACCES: permission denied, open '/etc/vmportal/storage-devices.json'" }, { detail: true });
  assert.deepEqual(rd, { at: AT, code: 'read-error', reason: '등록부 읽기 오류(EACCES)' });
  assert.doesNotMatch(JSON.stringify([ad, op, only, rd]), LEAK);
  assert.doesNotMatch(JSON.stringify(rd), /\/etc\/vmportal/);
});

test('RV2744F-LOAD-02 라우트 — GET /api/tools/isilon-dirusage 의 storageRegistryError 에 원문 조각이 없다(admin · 데모 계정)', async () => {
  const express = (await import('express')).default;
  const { api } = await import('../src/routes/api.js');
  const storage = await import('../src/storage/registry.js');
  // 손상 등록부 — 로드는 preserveCorrupt 콘솔 줄(요약)과 메모리의 원문 사유를 남긴다(원문은 응답 경로에서만 요약한다).
  const { lines } = await capture(() => storage.registryLoadError());
  assert.doesNotMatch(lines.join('\n'), LEAK, 'preserveCorrupt 콘솔 줄은 이미 요약(v2.744 RY)');
  assert.match(String(storage.registryLoadError()?.reason || ''), LEAK, '전제: 메모리의 로드 오류는 원문(V8 조각)');

  const app = express(); app.use(express.json());
  app.use((req, _r, n) => {
    const who = req.get('x-who') || 'admin';
    req.user = who === 'demo' ? { username: 'demo', role: 'admin', demoGuest: true, scope: null } : { username: 'adm', role: 'admin', scope: null };
    n();
  });
  app.use('/api', api);
  const base = await new Promise((res) => { const s = app.listen(0, '127.0.0.1', () => { closers.push(() => new Promise((q) => { s.closeAllConnections?.(); s.close(q); })); res(`http://127.0.0.1:${s.address().port}`); }); });
  const get = async (who) => {
    const r = await fetch(`${base}/api/tools/isilon-dirusage`, { headers: { 'x-who': who } });
    const text = await r.text();
    return { status: r.status, text, body: JSON.parse(text) };
  };

  const ad = await get('admin');
  assert.equal(ad.status, 200, ad.text.slice(0, 300));
  assert.doesNotMatch(ad.text, LEAK, `admin 응답에 등록부 원문 조각이 실렸다: ${ad.text.slice(0, 400)}`);
  assert.ok(ad.body.storageRegistryError, '화면이 안내를 띄우는 근거(값이 있음)는 그대로');
  assert.equal(ad.body.storageRegistryError.code, 'parse-error');
  assert.equal(ad.body.storageRegistryError.reason, 'JSON 형식 오류');
  assert.equal(ad.body.storageRegistryError.reasonDetailHidden, undefined, '관리자 상세는 가림 표지가 없다');

  const dm = await get('demo');
  assert.equal(dm.status, 200, dm.text.slice(0, 300));
  assert.doesNotMatch(dm.text, LEAK, `데모 계정 응답에 등록부 원문 조각이 실렸다: ${dm.text.slice(0, 400)}`);
  assert.ok(dm.body.storageRegistryError);
  assert.equal(dm.body.storageRegistryError.reason, 'JSON 형식 오류');
  assert.equal(dm.body.storageRegistryError.reasonDetailHidden, true, '데모 계정은 관리자 상세가 아니다(isAdminDetailUser)');
});
