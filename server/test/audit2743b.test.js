/**
 * v2.743 감사 그룹 b — 엣지 iDRAC 등록부 손상(EDGE-01) · 스캔 HPE 강등 범위(LEFT-01).
 *
 * EDGE-01 엣지 idrac.json 을 읽지 못하면 export 가 표지 없이 200 + servers:[]·전력 0 을 보내 중앙이 그 법인의 위임 서버·원격 전력을
 *   통째로 지웠다(재현 — 원본이 .corrupt.<시각> 으로 옮겨져 재시작 뒤에도 계속 0대). 이제 idrac/registry.js registryLoadError()
 *   (util/registryCore.js — 원본 없이 보존본만 남은 경우 포함)가 사유를 들고, 엣지 GET /api/collector/export 는 503 registryUnreadable
 *   (지속형 503 머리)로 답하고, 중앙 puller 는 실패로 보고 직전 스냅샷을 유지한다(setCollectorServers 를 부르지 않는다). 상태 `edgeReason`·
 *   통신 지도 사유 `pull-edge-registry` 로 그 사유가 보인다.
 * LEFT-01 replace 강등 판정이 법인 전체의 HPE(hasHpeInDatacenter)를 봐서, 교체가 지우지 않는 범위 밖 HPE 하나로도 Dell 전용 엔트리의
 *   replace 가 매번 merge 로 떨어졌다. 이제 교체와 같은 술어(makeScanReplaceScope)로 '교체 범위 안의 HPE' 만 본다(hasHpeInScanReplaceScope).
 * 실제 함수·실제 라우터(collectorRouter)·실제 puller 를 부른다.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { stripComments } from './_stripComments.js';

const TMP_ROOT = process.env.AUDIT2743B_TMP && fs.existsSync(process.env.AUDIT2743B_TMP) ? process.env.AUDIT2743B_TMP : (await import('node:os')).tmpdir();
const CFG = fs.mkdtempSync(path.join(TMP_ROOT, 'dvc-2743b-'));
Object.assign(process.env, {
  CONFIG_DIR: CFG, COLLECTOR_TOKEN: 'col-2743b', AGENT_NAME: 'edge-gb-a',
  DATA_SOURCE: 'live', AUTH_ENABLED: 'true', IPAM_WRITE_WORKER: '0', SSRF_ALLOW_LOOPBACK: 'true',
});
fs.writeFileSync(path.join(CFG, 'vcenters.json'), JSON.stringify({ vcenters: [] }));
const IDRAC = path.join(CFG, 'idrac.json');
const GOOD = JSON.stringify({ servers: [
  { id: 's1', name: 'srv-1', host: 'https://10.9.0.11', username: 'root', password: 'x' },
  { id: 's2', name: 'srv-2', host: 'https://10.9.0.12', username: 'root', password: 'x' },
] });
fs.writeFileSync(IDRAC, GOOD);
const corruptFiles = () => fs.readdirSync(CFG).filter((n) => n.startsWith('idrac.json.corrupt.'));

const express = (await import('express')).default;
const { collectorRouter, EDGE_EXPORT_503_RETRY_AFTER_SEC } = await import('../src/routes/collector.js');
const registry = await import('../src/idrac/registry.js');
const registryScan = await import('../src/idrac/scan.js');
const app = express();
app.use('/api/collector', collectorRouter);
const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const BASE = `http://127.0.0.1:${srv.address().port}`;
test.after(() => { srv.close(); try { fs.rmSync(CFG, { recursive: true, force: true }); } catch { /* 정리는 best-effort */ } });
const getExport = () => fetch(`${BASE}/api/collector/export`, { headers: { 'X-Collector-Token': 'col-2743b', Accept: 'application/json' } });
const SRC = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../src');
const read = (rel) => stripComments(fs.readFileSync(path.join(SRC, rel), 'utf8'));

// ─── EDGE-01 ──────────────────────────────────────────────────────────────────
// 테스트 순서가 계약이다(같은 등록부 파일·같은 모듈 상태를 이어 쓴다).

test('EDGE-01 ① 등록부: 정상 → null · 손상 → 사유(보존본으로 옮김) · 원본 없이 보존본만 남은 재시작도 못 읽음 · 저장하면 풀림', async () => {
  assert.equal(registry.registryLoadError(), null);
  assert.equal(registry.loadRegistry().length, 2);
  // 손상(수동 편집·복원 실수·디스크 문제) — 다음 읽기에서 보존본으로 옮겨진다.
  fs.writeFileSync(IDRAC, '{"servers":[{"id":"s1"');
  assert.deepEqual(registry.loadRegistry(), [], '빈 목록은 그대로(소비 코드 무변경)');
  const e1 = registry.registryLoadError();
  assert.ok(e1 && typeof e1.reason === 'string' && e1.reason.length > 0, `사유가 있어야 한다(수정 전: 함수 자체가 없었다): ${JSON.stringify(e1)}`);
  assert.equal(fs.existsSync(IDRAC), false, '원본은 .corrupt.<시각> 으로 옮겨졌다');
  assert.equal(corruptFiles().length, 1);
  assert.ok(registry.registryLoadError(), '파일이 없어도 오류는 남는다(다음 pull 에서도 빈 목록을 보내지 않게)');
  // 재시작 흉내 — 새 모듈 인스턴스(같은 CONFIG_DIR): 원본 없이 보존본만 있으면 못 읽은 것이다(corruptOnlyReason).
  const fresh = await import('../src/idrac/registry.js?restart=1');
  const e2 = fresh.registryLoadError();
  assert.ok(e2 && /손상 보존본/.test(e2.reason), `보존본만 남은 재시작도 못 읽은 것: ${JSON.stringify(e2)}`);
  // 사람이 보존본을 되돌리면(파일이 다시 정상) 풀린다.
  fs.writeFileSync(IDRAC, GOOD);
  assert.equal(fresh.registryLoadError(), null, '되돌린 파일을 정상으로 읽으면 풀린다');
  // 저장이 성공해도 풀린다(첫 인스턴스 — 아직 오류를 들고 있다가 저장으로 풀림).
  fs.rmSync(IDRAC);
  assert.ok(registry.registryLoadError());
  const r = registry.importServers([{ id: 's9', name: 'srv-9', host: 'https://10.9.0.19', username: 'root', password: 'x' }], 'merge');
  assert.equal(r.ok, true);
  assert.equal(registry.registryLoadError(), null, '저장 성공 → 풀림(형제 등록부와 같다)');
  // 원상 복구(다음 테스트용)
  fs.writeFileSync(IDRAC, GOOD);
  assert.equal(registry.loadRegistry().length, 2);
  for (const f of corruptFiles()) fs.rmSync(path.join(CFG, f));
});

test('EDGE-01 ② 엣지 /api/collector/export — 등록부를 못 읽으면 2xx 빈 목록 대신 503 registryUnreadable(지속형 503 머리)', async () => {
  const ok = await getExport();
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).servers.length, 2);

  fs.writeFileSync(IDRAC, '{ broken');
  const bad = await getExport();
  assert.equal(bad.status, 503, '수정 전: 200 + servers:[] (표지 없음)');
  assert.equal(bad.headers.get('retry-after'), String(EDGE_EXPORT_503_RETRY_AFTER_SEC));
  assert.match(String(bad.headers.get('cache-control')), /no-store/);
  const body = await bad.json();
  assert.equal(body.ok, false);
  assert.equal(body.reason, 'registryUnreadable');
  assert.equal(body.registry, 'idrac');
  assert.ok(!('servers' in body) && !('power' in body), '빈 목록·전력 0 을 싣지 않는다');
  assert.ok(typeof body.detail === 'string');
  // 다음 export(원본은 이미 보존본으로 옮겨졌다)도 계속 503 — 재시작 뒤 보존본만 남은 경우와 같은 상태.
  assert.equal(fs.existsSync(IDRAC), false);
  assert.equal((await getExport()).status, 503);
  // 중앙 지속형 503 과 같은 값(routes/central.js PERSISTENT_503_RETRY_AFTER_SEC).
  const { PERSISTENT_503_RETRY_AFTER_SEC } = await import('../src/routes/central.js');
  assert.equal(EDGE_EXPORT_503_RETRY_AFTER_SEC, PERSISTENT_503_RETRY_AFTER_SEC);
  // 원상 복구
  fs.writeFileSync(IDRAC, GOOD);
  assert.equal((await getExport()).status, 200);
  for (const f of corruptFiles()) fs.rmSync(path.join(CFG, f));
});

test('EDGE-01 ③ 중앙 puller — 503 은 실패이고 직전 스냅샷(위임 서버)을 지우지 않는다 · 상태 edgeReason · 통신 지도 pull-edge-registry', { timeout: 30_000 }, async () => {
  const inv = await import('../src/collector/remoteInventory.js');
  const { addCollector, updateCollector } = await import('../src/collector/registry.js');
  const puller = await import('../src/collector/puller.js');
  const st = await import('../src/collector/state.js');
  const { buildCommMap } = await import('../src/commmap/build.js');
  puller._resetPullerForTest();
  // 앞 테스트가 등록부를 정상으로 되돌렸어야 한다 — 아니면 아래 즉시 당김이 503 의 Retry-After 를 기다린다(빠르게 실패시킨다).
  assert.equal((await getExport()).status, 200, '전제: 엣지 export 정상');
  const add = addCollector({ id: 'edge-gb', name: 'edge-gb', url: BASE, token: 'col-2743b', enabled: true });
  assert.ok(add?.ok !== false, JSON.stringify(add));
  // 정상 pull — 서버 2대가 중앙에 들어온다.
  assert.equal(await puller.pullCollectorByAgent('edge-gb'), true);
  const mine = () => inv.allRemoteServers().filter((s) => s.collectorId === 'edge-gb');
  assert.deepEqual(mine().map((s) => s.id).sort(), ['s1', 's2']);

  // 주기 pull 의 재시도 0회 경로로 보내려고 한 주기를 빠르게 실패시킨다(토큰 거부 403 은 재시도 대상이 아니다).
  //   그래야 503 의 Retry-After(60초 — 상한 30초로 기다림)를 테스트가 기다리지 않는다. 엣지의 503 판정은 ② 가 고정한다.
  assert.equal(updateCollector('edge-gb', { token: 'wrong-token' }).ok, true);
  await puller.pullNow();
  assert.equal(st.getCollectorStatus('edge-gb').ok, false);
  assert.match(st.getCollectorStatus('edge-gb').error, /토큰/);
  assert.equal(updateCollector('edge-gb', { token: 'col-2743b' }).ok, true);

  // 엣지 등록부 손상 → 엣지 503 → 중앙: 실패 · 직전 서버 유지(수정 전: 200 servers:[] 로 2대 → 0대).
  fs.writeFileSync(IDRAC, '{ broken');
  await puller.pullNow();
  const s = st.getCollectorStatus('edge-gb');
  assert.equal(s.ok, false);
  assert.equal(s.edgeReason, 'registryUnreadable', `상태에 사유 코드: ${JSON.stringify(s)}`);
  assert.match(s.error, /iDRAC 등록부/);
  assert.ok(!/토큰/.test(s.error), '인증 실패로 읽히지 않는다(통신 지도 pull-auth 오판 방지)');
  assert.deepEqual(mine().map((x) => x.id).sort(), ['s1', 's2'], '직전 스냅샷을 지우지 않는다(setCollectorServers 를 부르지 않는다)');

  const map = buildCommMap({ now: Date.now(), collectors: [{ id: 'edge-gb', name: 'edge-gb', url: BASE, enabled: true }], status: { 'edge-gb': s } });
  const e = map.edges.find((x) => x.id === 'edge-gb');
  assert.ok(e.reasons.includes('pull-edge-registry'), JSON.stringify(e.reasons));
  assert.ok(!e.reasons.includes('pull-fail') && !e.reasons.includes('pull-auth'));
  assert.equal(e.state, 'fail');

  // 등록부를 되돌리면 다음 pull 이 정상으로 돌아오고 사유가 사라진다.
  fs.writeFileSync(IDRAC, GOOD);
  await puller.pullNow();
  const s2 = st.getCollectorStatus('edge-gb');
  assert.equal(s2.ok, true);
  assert.ok(!s2.edgeReason, '성공 상태에는 edgeReason 이 없다');
  for (const f of corruptFiles()) fs.rmSync(path.join(CFG, f));
});

test('EDGE-01 ④ exportFailError — 사유 없는 비-2xx 는 예전 문구 · 모르는 사유 코드는 표지로 읽지 않는다', async () => {
  const { exportFailError } = await import('../src/collector/puller.js');
  const mk = (status, body, text = 'X') => new Response(body == null ? null : JSON.stringify(body), { status, statusText: text, headers: { 'content-type': 'application/json' } });
  const plain = await exportFailError(mk(502, null, 'Bad Gateway'));
  assert.equal(plain.message, 'export -> 502 Bad Gateway');
  assert.equal(plain.edgeReason, undefined);
  const unknown = await exportFailError(mk(503, { reason: '__proto__' }, 'Service Unavailable'));
  assert.equal(unknown.edgeReason, undefined, '모르는 코드(프로토타입 이름 포함)는 표지로 쓰지 않는다');
  const known = await exportFailError(mk(503, { reason: 'registryUnreadable', detail: 'x'.repeat(500) }, 'Service Unavailable'));
  assert.equal(known.edgeReason, 'registryUnreadable');
  assert.ok(known.message.length < 400, '사유 원문은 잘린다');
});

// ─── LEFT-01 ──────────────────────────────────────────────────────────────────

const found = (ip, vendor = 'dell') => ({ host: `https://${ip}`, ip, vendor, serviceTag: `T${ip.split('.').pop()}`, model: vendor === 'hpe' ? 'ProLiant' : 'R750', hostName: `h${ip.split('.').pop()}` });
const SCOPE_A = { datacenterId: 'DC1', scanRangeId: 'entryA', ranges: ['10.9.1.0/24'] };
const reset = (extra = []) => {
  const base = [
    { id: '10.9.1.5', name: 'd5', host: '10.9.1.5', username: 'u', password: 'p', datacenterId: 'DC1', scanRangeId: 'entryA' },
    { id: '10.9.1.6', name: 'd6', host: '10.9.1.6', username: 'u', password: 'p', datacenterId: 'DC1', scanRangeId: 'entryA' },
    { id: '10.9.2.5', name: 'h25', host: '10.9.2.5', username: 'iu', password: 'ip', datacenterId: 'DC1', scanRangeId: 'entryB', vendor: 'hpe' },
  ];
  const r = registry.importServers([...base, ...extra], 'replace');
  assert.equal(r.ok, true, JSON.stringify(r));
};
/** 교체를 실제로 돌려 HPE 가 지워졌는지(헬퍼가 '강등이 필요하다' 고 말하는 것과 같아야 한다). */
const replaceDropsHpe = () => {
  const before = registry.loadRegistry().filter((s) => registry.isHpeEntry(s)).map((s) => s.id);
  const r = registry.registerScanned([found('10.9.1.5')], 'u', 'p', 'replace-datacenter', '', 'DC1', { scanRangeId: 'entryA', scanRanges: ['10.9.1.0/24'] });
  assert.equal(r.ok, true, JSON.stringify(r));
  const after = new Set(registry.loadRegistry().map((s) => s.id));
  return before.some((id) => !after.has(id));
};

test('LEFT-01 ① 교체 범위 밖에만 HPE 가 있으면 강등하지 않는다 — 법인 전체 판정(수정 전)은 강등했다', () => {
  reset();
  assert.equal(registry.hasHpeInDatacenter('DC1'), true, '법인에는 HPE 가 있다(다른 엔트리 등록)');
  assert.equal(registry.hasHpeInScanReplaceScope(SCOPE_A), false, '엔트리 A 의 교체는 그 HPE 를 지우지 않는다');
  const { scanPartialReasons } = registryScan;
  const dellOnly = { aborted: false, truncated: false, authSkipped: 0, noCreds: 0, authFailed: 0, iloEnabled: false };
  assert.deepEqual(scanPartialReasons(dellOnly, { registeredHpe: registry.hasHpeInScanReplaceScope(SCOPE_A) }), [], '강등 사유 없음 → replace 그대로');
  assert.equal(replaceDropsHpe(), false, '실제 교체도 범위 밖 HPE 를 남긴다(강등이 필요 없었다는 근거)');
  assert.equal(registry.loadRegistry().some((s) => s.id === '10.9.1.6'), false, 'replace 가 돌았다 — 범위 안 퇴역 등록(10.9.1.6)이 정리된다');
});

test('LEFT-01 ② 교체 범위 안에 HPE 가 있으면 강등을 유지한다 — 표지(scanRangeId)·옛 스캔 등록(id = 주소, 대역 안) 둘 다', () => {
  // ⓐ 같은 엔트리 표지가 붙은 HPE
  reset([{ id: '10.9.1.9', name: 'h19', host: '10.9.1.9', username: 'iu', password: 'ip', datacenterId: 'DC1', scanRangeId: 'entryA', vendor: 'hpe' }]);
  assert.equal(registry.hasHpeInScanReplaceScope(SCOPE_A), true);
  assert.ok(registryScan.scanPartialReasons({ iloEnabled: false }, { registeredHpe: true }).some((x) => /iLO/.test(x)));
  assert.equal(replaceDropsHpe(), true, '강등하지 않으면 실제 교체가 그 HPE 를 지운다(헬퍼 판정과 같다)');
  // ⓑ 표지 없는 옛 스캔 등록(id 가 주소이고 엔트리 대역 안)
  reset([{ id: '10.9.1.7', name: 'h17', host: '10.9.1.7', username: 'iu', password: 'ip', datacenterId: 'DC1', vendor: 'hpe' }]);
  assert.equal(registry.hasHpeInScanReplaceScope(SCOPE_A), true);
  assert.equal(replaceDropsHpe(), true);
  // ⓒ 표지 없지만 대역 밖 / 사람이 정한 id(수동 등록) / 다른 법인 — 교체가 지우지 않으므로 강등도 없다.
  reset([
    { id: '10.9.3.7', name: 'h37', host: '10.9.3.7', username: 'iu', password: 'ip', datacenterId: 'DC1', vendor: 'hpe' },
    { id: 'manual-hpe', name: 'mh', host: '10.9.1.8', username: 'iu', password: 'ip', datacenterId: 'DC1', vendor: 'hpe' },
    { id: '10.9.1.10', name: 'h110', host: '10.9.1.10', username: 'iu', password: 'ip', datacenterId: 'DC2', scanRangeId: 'entryA', vendor: 'hpe' },
  ]);
  assert.equal(registry.hasHpeInScanReplaceScope(SCOPE_A), false);
  assert.equal(replaceDropsHpe(), false);
  // 법인이 비면 교체가 아무것도 지우지 않는다 → false
  assert.equal(registry.hasHpeInScanReplaceScope({ ...SCOPE_A, datacenterId: '' }), false);
});

test('LEFT-01 ③ 엣지 runLocalIdracScan — 범위 밖 HPE 만이면 replace 를 강등하지 않고, 범위 안 HPE 면 강등한다', async () => {
  const { runLocalIdracScan } = await import('../src/idrac/localScan.js');
  // ips 는 루프백(스캐너가 찌르지 않는다 — 장비 접속 0) · 엔트리 표지로 범위를 정한다.
  const opts = { ips: '127.0.0.1', username: 'u', password: 'p', mode: 'replace-datacenter', datacenterId: 'DC1', rangeId: 'entryA' };
  reset();
  const r1 = await runLocalIdracScan(opts);
  assert.equal(r1.modeDowngraded, false, `범위 밖 HPE 만 — 강등 없음(수정 전: true · ${r1.modeDowngradedReason || ''})`);
  reset([{ id: '10.9.1.9', name: 'h19', host: '10.9.1.9', username: 'iu', password: 'ip', datacenterId: 'DC1', scanRangeId: 'entryA', vendor: 'hpe' }]);
  const r2 = await runLocalIdracScan(opts);
  assert.equal(r2.modeDowngraded, true);
  assert.match(String(r2.modeDowngradedReason), /iLO 계정 없이/);
});

test('LEFT-01 ④ 중앙 scanPoller·엣지 localScan 은 같은 헬퍼를 교체와 같은 인자로 부른다(법인 전체 판정 0)', () => {
  const sp = read('idrac/scanPoller.js');
  const ls = read('idrac/localScan.js');
  assert.match(sp, /registeredHpe: hasHpeInScanReplaceScope\(\{ datacenterId: e\.datacenterId, scanRangeId: e\.id \|\| '', ranges: e\.ranges \}\)/);
  assert.match(sp, /registerScanned\([^;]*scanRangeId: e\.id \|\| '', scanRanges: e\.ranges/, '교체에 넘기는 인자와 같은 엔트리 id·대역');
  assert.match(ls, /registeredHpe: hasHpeInScanReplaceScope\(\{ datacenterId, scanRangeId: rangeId, ranges: ips \}\)/);
  assert.match(ls, /registerScanned\([^;]*scanRangeId: rangeId, scanRanges: ips/);
  for (const [name, src] of [['scanPoller', sp], ['localScan', ls]]) assert.ok(!/hasHpeInDatacenter/.test(src), `${name}: 법인 전체 판정을 쓰지 않는다`);
});

