/**
 * llmSearchNsxAudit116.test.js — 전체 점검 116회차(LLM 자연어 검색 · 챗옵스 · Ollama 배포 · 검색 · 보고서 · NSX 와 그 라우트 1차) 확정분 회귀.
 *
 *  F1(높음) nsx/registry.js — 읽기 오류(EMFILE · EIO)를 손상과 같은 catch 로 받아 온전한 nsx.json(매니저 계정 · 비밀번호)을 `.corrupt.*` 로 옮겼다.
 *      캐시 없이 주기 수집마다 읽는 등록부라 일시 오류 한 번으로 매니저 전부가 사라지고, 다음 등록이 한 건짜리 파일을 썼다.
 *      → 원본 유지 · 마지막으로 읽은 목록 · 쓰기 거절(registry-unreadable) · 30초 간격 재읽기 · 손상은 예전처럼 보존.
 *  F2(중간) routes/metricsExport.js — 용량 · 여유를 못 읽은 데이터스토어(null)를 0 byte 로 내보냈다(가득 찬 DS 와 구분 불가).
 *  F3(중간) llm/nlSearch.js — LLM 이 준 질의의 모양을 검증하지 않았다: filters 가 객체면 조건을 버리고 전량 · 모르는 엔티티는 가상머신 ·
 *      모르는 연산자는 eq · 스키마 밖 필드는 0건 · 조건 수 상한 없음 · 응답의 filters 가 목록이 아니라 화면이 죽었다.
 *  F4(중간) llm/nlSearch.js — 가상 필드(region · ip · tag)가 연산자를 보지 않았다('북미가 아닌' 이 북미만).
 *  F5(낮음) llm/ollamaDeploy.js — 온라인 설치 `curl … | sh` 는 curl 이 실패해도 종료값 0(설치 실패 판정이 걸리지 않았다).
 *  F6(낮음) routes/admin/deployLlm.js — Ollama 원격 설치의 감사 기록에 대상이 없고, 실패한 설치는 기록이 없었다.
 *  F7(낮음 · 결정) routes/api/overviewNsx.js — 보안그룹 라이브 멤버 조회가 비활성 · 인증 정지 매니저에 저장 계정으로 로그인했다.
 *  F8(낮음) search/deepSearch.js · routes/admin/backupNetSec.js — 게스트 탐침 상한 maxVms 가 음수면 slice(0, -n) 으로 상한 500 을 넘겼다.
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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'audit116-'));
process.env.CONFIG_DIR = TMP;
process.env.DATA_DIR = TMP;
process.env.AUTH_ENABLED = 'false';
process.env.DATA_SOURCE = 'live';
process.env.METRICS_ALLOW_ANON = 'true';
process.env.METRICS_EXPORT_TOKEN = '';
// LLM 은 켜 둔다(주소는 쓰이지 않는다 — 아래에서 fetch 를 바꾼다). 설정 파일은 모듈을 올리기 전에 한 번만 쓴다.
fs.writeFileSync(path.join(TMP, 'llm.json'), JSON.stringify({ enabled: true, url: 'http://llm.corp.example:11434', model: 'm', timeoutMs: 5000 }));

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '..', 'src');
const F = (n) => path.join(TMP, n);
const corruptOf = (n) => fs.readdirSync(TMP).filter((x) => x.startsWith(`${n}.corrupt.`));
const express = createRequire(import.meta.url)('express');

// 시계: 실제 시각에서 정시 경계로 떨어뜨려 고정(재읽기 간격 판정 — util/jsonFileRead.js nowMs).
const RD = await import('../src/util/jsonFileRead.js');
let NOW = Math.floor(Date.now() / 3_600_000) * 3_600_000;
RD._setJsonFileLoadClockForTest(() => NOW);
const pass = (ms = RD.READ_RETRY_MS + 1_000) => { NOW += ms; };

const REG = await import('../src/nsx/registry.js');
const { nsxAuthGuard } = await import('../src/nsx/store.js');
const { store } = await import('../src/store.js');
const NL = await import('../src/llm/nlSearch.js');
const DEP = await import('../src/llm/ollamaDeploy.js');
const { metricsExportRouter } = await import('../src/routes/metricsExport.js');
const DL = await import('../src/routes/admin/deployLlm.js');
const OV = await import('../src/routes/api/overviewNsx.js');
const DS = await import('../src/search/deepSearch.js');

const rmTmp = () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ } };
after(() => { RD._setJsonFileLoadClockForTest(); rmTmp(); process.once('exit', rmTmp); });

/** fs.readFileSync 에 읽기 오류를 주입한다(그 파일 이름만) — 읽은 횟수를 돌려준다. */
function withReadError(name, code, fn) {
  const orig = fs.readFileSync;
  let reads = 0;
  fs.readFileSync = (f, ...a) => { if (path.basename(String(f)) === name) { reads += 1; const e = new Error(`${code}: read`); e.code = code; throw e; } return orig.call(fs, f, ...a); };
  try { fn(); } finally { fs.readFileSync = orig; }
  return reads;
}
/** store.get 을 잠깐 바꾼다. */
async function withSnap(snap, fn) {
  const orig = store.get;
  store.get = () => snap;
  try { return await fn(); } finally { store.get = orig; }
}
/** globalThis.fetch 를 잠깐 바꾼다(LLM · NSX 왕복 대신). */
async function withFetch(stub, fn) {
  const orig = globalThis.fetch;
  globalThis.fetch = stub;
  try { return await fn(); } finally { globalThis.fetch = orig; }
}
/** 라우터를 띄우고 fn(base) 를 돌린다. */
async function withApp(mount, fn) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { username: 'adm', role: 'admin', scope: null }; next(); });
  mount(app);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  try { return await fn(`http://127.0.0.1:${srv.address().port}`); } finally { await new Promise((r) => srv.close(r)); }
}
const addMgr = (id, extra = {}) => REG.addManager({ id, name: id, host: `https://${id}.corp.example`, username: 'svc', password: `pw-${id}`, ...extra });

/* ── F1 NSX 등록부 — 읽기 오류 ≠ 손상 ───────────────────────────────────────── */

test('F1 NSX 등록부: 읽기 오류면 원본 유지 · 마지막으로 읽은 목록 · 쓰기 거절 · 간격 안 재읽기 없음 · 읽히면 풀림', () => {
  assert.equal(addMgr('a').ok, true);
  assert.equal(addMgr('b').ok, true);
  assert.deepEqual(REG.loadRegistry().map((m) => m.id), ['a', 'b']);
  const before = fs.readFileSync(F('nsx.json'), 'utf8');

  const reads = withReadError('nsx.json', 'EMFILE', () => {
    const during = REG.loadRegistry();
    assert.deepEqual(during.map((m) => m.id), ['a', 'b'], '수정 전: 빈 목록 — 주기 수집이 매니저 전부를 잃었다');
    assert.equal(during.find((m) => m.id === 'a').password, 'pw-a', '마지막으로 읽은 값(복호된 자격증명)으로 수집을 잇는다');
    assert.deepEqual(corruptOf('nsx.json'), [], '수정 전: 온전한 원본을 nsx.json.corrupt.* 로 옮겼다');
    assert.ok(fs.existsSync(F('nsx.json')), '원본은 그 자리에');
    assert.equal(REG.registryLoadError()?.readError, true);
    for (const r of [addMgr('c'), REG.updateManager('a', { name: 'A2' }), REG.removeManager('b')]) {
      assert.equal(r.ok, false, '수정 전: 등록이 성공해 한 건짜리 파일이 원본 자리를 채웠다');
      assert.equal(r.code, 'registry-unreadable');
      assert.match(r.reason, /NSX 등록부\(nsx\.json\)를 읽지 못한 상태라 저장하지 않았습니다/);
    }
    assert.equal(REG.registryWriteRefusal()?.code, 'registry-unreadable');
    // 돌려받은 목록 · 원소를 고쳐도 다음 호출에 새지 않는다(사본)
    during[0].password = 'tampered'; during.length = 0;
    assert.equal(REG.loadRegistry().find((m) => m.id === 'a').password, 'pw-a');
  });
  assert.equal(reads, 1, `간격 안의 호출은 디스크를 다시 읽지 않는다(읽은 횟수 ${reads})`);
  assert.equal(fs.readFileSync(F('nsx.json'), 'utf8'), before, '읽기 오류 동안 파일은 한 글자도 바뀌지 않는다');

  pass();
  assert.deepEqual(REG.loadRegistry().map((m) => m.id), ['a', 'b']);
  assert.equal(REG.registryLoadError(), null, '읽히면 사람 조치 없이 풀린다');
  assert.equal(REG.registryWriteRefusal(), null);
  assert.equal(addMgr('c').ok, true);
  assert.deepEqual(REG.loadRegistry().map((m) => m.id), ['a', 'b', 'c']);
});

test('F1 NSX 등록부: 손상은 예전처럼 보존하고 관리자 저장이 새 등록부를 만든다 · 한 번도 못 읽은 상태의 읽기 오류도 원본을 덮지 않는다', () => {
  fs.writeFileSync(F('nsx.json'), '{ "managers": [ broken');
  assert.deepEqual(REG.loadRegistry(), [], '손상은 빈 목록(예전과 같다)');
  assert.equal(corruptOf('nsx.json').length, 1, '손상본은 보존본으로');
  assert.equal(fs.existsSync(F('nsx.json')), false);

  // 마지막으로 읽은 목록이 없는 상태(방금 손상으로 비웠다)에서 온전한 원본 + 읽기 오류
  const full = JSON.stringify({ managers: ['x', 'y'].map((id) => ({ id, name: id, host: `https://${id}.corp.example`, username: 'svc', password: `pw-${id}`, location: { region: 'Unknown' }, enabled: true })) }, null, 2);
  fs.writeFileSync(F('nsx.json'), full);
  withReadError('nsx.json', 'EIO', () => {
    assert.deepEqual(REG.loadRegistry(), [], '읽은 적이 없으면 빈 목록');
    const r = addMgr('z');
    assert.equal(r.ok, false); assert.equal(r.code, 'registry-unreadable');
  });
  assert.equal(fs.readFileSync(F('nsx.json'), 'utf8'), full, '수정 전: z 한 건짜리 파일로 덮였다');
  assert.equal(corruptOf('nsx.json').length, 1, '읽기 오류는 보존본을 더 만들지 않는다');
  pass();
  assert.deepEqual(REG.loadRegistry().map((m) => m.id), ['x', 'y']);

  // 손상 뒤의 관리자 저장은 예전처럼 새 등록부를 만든다(v2.612 규약 — 손상은 읽기 오류가 아니다)
  fs.writeFileSync(F('nsx.json'), 'not json at all');
  assert.deepEqual(REG.loadRegistry(), []);
  assert.equal(fs.existsSync(F('nsx.json')), false, '손상본은 옮겨졌다');
  assert.ok(REG.registryLoadError() && REG.registryLoadError().readError !== true, '손상은 읽기 오류가 아니다');
  assert.equal(REG.registryWriteRefusal(), null);
  assert.equal(addMgr('n1').ok, true);
  assert.equal(REG.registryLoadError(), null, '저장으로 풀린다');
  assert.deepEqual(REG.loadRegistry().map((m) => m.id), ['n1']);
});

/* ── F2 /metrics — 못 읽은 데이터스토어 ────────────────────────────────────── */

test('F2 /metrics: 용량 · 여유를 못 읽은 데이터스토어는 0 byte 가 아니라 그 시계열을 내지 않는다(보고된 0 은 그대로)', async () => {
  const snap = { generatedAt: new Date(NOW).toISOString(), source: 'live', vcenters: [{ id: 'vc-a', status: 'connected', version: '8.0' }], hosts: [], vms: [], networks: [], alarms: [],
    datastores: [
      { id: 'd1', name: 'ds-ok', vcenterId: 'vc-a', type: 'VMFS', capacityGB: 100, freeGB: 40, usagePct: 60 },
      { id: 'd2', name: 'ds-unread', vcenterId: 'vc-a', type: 'VMFS', capacityGB: null, freeGB: null, usedGB: null, usagePct: null },
      { id: 'd3', name: 'ds-free-unread', vcenterId: 'vc-a', type: 'NFS', capacityGB: 500, freeGB: null, usedGB: null, usagePct: null },
      { id: 'd4', name: 'ds-full', vcenterId: 'vc-a', type: 'VMFS', capacityGB: 10, freeGB: 0, usagePct: 100 },
    ] };
  const txt = await withSnap(snap, () => withApp((app) => app.use('/metrics', metricsExportRouter), async (base) => (await fetch(`${base}/metrics`)).text()));
  const lines = txt.split('\n').filter((l) => l.startsWith('vmware_datastore'));
  const of = (metric, ds) => lines.filter((l) => l.startsWith(`${metric}{`) && l.includes(`datastore="${ds}"`)).map((l) => l.split(' ').pop());
  assert.deepEqual(of('vmware_datastore_free_bytes', 'ds-ok'), [String(40 * 1073741824)]);
  assert.deepEqual(of('vmware_datastore_capacity_bytes', 'ds-unread'), [], '수정 전: 0 — 용량을 못 읽은 DS 가 0 byte 로 나갔다');
  assert.deepEqual(of('vmware_datastore_free_bytes', 'ds-unread'), [], '수정 전: 0');
  assert.deepEqual(of('vmware_datastore_capacity_bytes', 'ds-free-unread'), [String(500 * 1073741824)], '읽은 값은 낸다');
  assert.deepEqual(of('vmware_datastore_free_bytes', 'ds-free-unread'), [], '수정 전: 0 — 500GB DS 가 여유 0(가득 참)으로 나갔다');
  assert.deepEqual(of('vmware_datastore_usage_percent', 'ds-free-unread'), []);
  assert.deepEqual(of('vmware_datastore_free_bytes', 'ds-full'), ['0'], '보고된 0 은 값이다');
  assert.deepEqual(of('vmware_datastore_usage_percent', 'ds-full'), ['100']);
});

/* ── F3 · F4 자연어 검색 — LLM 이 준 질의의 검증 · 가상 필드 연산자 ─────────── */

const NL_SNAP = {
  generatedAt: new Date(NOW).toISOString(),
  vcenters: [{ id: 'vc-kr', location: { region: '아시아' } }, { id: 'vc-us', location: { region: '북미' } }, { id: 'vc-pl', location: { region: '유럽' } }],
  hosts: [
    { id: 'h1', name: 'esx-1', vcenterId: 'vc-kr', connectionState: 'CONNECTED', cpuUsagePct: 30 },
    { id: 'h2', name: 'esx-2', vcenterId: 'vc-us', connectionState: 'CONNECTED', cpuUsagePct: 60 },
    { id: 'h3', name: 'esx-3', vcenterId: 'vc-pl', connectionState: 'CONNECTED', cpuUsagePct: 90 },
  ],
  vms: [1, 2, 3, 4, 5].map((i) => ({ id: `v${i}`, name: `vm-${i}`, vcenterId: i <= 3 ? 'vc-kr' : 'vc-us', powerState: 'POWERED_ON', memUsagePct: i * 10,
    ipAddresses: [`10.${i <= 3 ? 1 : 2}.0.${i}`], tags: i % 2 ? ['prod'] : ['dev'] })),
  datastores: [], networks: [], alarms: [],
};
/** 가짜 LLM 이 llmJson 을 답하게 하고 nlSearch 를 돌린다. */
const ask = (llmJson, allowed = null) => withSnap(NL_SNAP, () => withFetch(
  async () => Response.json({ response: typeof llmJson === 'string' ? llmJson : JSON.stringify(llmJson) }),
  () => NL.nlSearch('질문', allowed),
));
const names = (r) => r.results.map((x) => x.name).sort();

test('F3 normalizeLlmQuery: 스키마에 맞는 질의만 — 엔티티 대소문자 · 복수형 · 연산자 기호 · 조건 하나(객체)는 받아 주고 그 밖은 던진다', () => {
  const n = NL.normalizeLlmQuery;
  assert.deepEqual(n({ entity: 'Hosts', filters: { field: 'name', op: 'contains', value: 'esx' } }),
    { entity: 'host', filters: [{ field: 'name', op: 'contains', value: 'esx' }], match: 'all', sort: null, limit: undefined });
  assert.equal(n({ entity: 'vm', filters: [{ field: 'memUsagePct', op: '>=', value: 90 }] }).filters[0].op, 'gte');
  assert.equal(n({ entity: 'vm', filters: [{ field: 'name', value: 'a' }] }).filters[0].op, 'eq', '연산자가 없으면 eq(예전과 같다)');
  assert.deepEqual(n({ entity: 'vm', filters: [{ field: 'region', op: 'in', value: '아시아' }] }).filters[0].value, ['아시아'], 'in 의 값 하나는 목록으로');
  assert.deepEqual(n({ entity: 'vm', sort: { field: 'memUsagePct', dir: 'DESC' }, match: 'any' }), { entity: 'vm', filters: [], match: 'any', sort: { field: 'memUsagePct', dir: 'desc' }, limit: undefined });
  assert.equal(n({ entity: 'vm', sort: {} }).sort, null);
  const bad = [
    null, 'vm', [{ entity: 'vm' }],
    { entity: 'cluster' }, { entity: 'constructor' }, { filters: [] },
    { entity: 'vm', filters: 'memUsagePct > 30' }, { entity: 'vm', filters: [null] }, { entity: 'vm', filters: ['x'] },
    { entity: 'vm', filters: [{ field: 'memoryUsage', op: 'gt', value: 1 }] }, { entity: 'vm', filters: [{ field: 'constructor', value: 1 }] },
    { entity: 'vm', filters: [{ field: 'name', op: 'regex', value: 'a' }] }, { entity: 'vm', filters: [{ field: 'name', op: 'constructor', value: 'a' }] },
    { entity: 'vm', filters: [{ field: 'name', op: 'contains', value: { a: 1 } }] }, { entity: 'vm', filters: [{ field: 'name', op: 'eq', value: null }] },
    { entity: 'vm', filters: [{ field: 'name', op: 'eq', value: 'x'.repeat(NL.NL_VALUE_MAX + 1) }] },
    { entity: 'vm', filters: [{ field: 'name', op: 'in', value: Array.from({ length: NL.NL_IN_MAX + 1 }, (_, i) => `v${i}`) }] },
    { entity: 'vm', filters: [{ field: 'region', op: 'gt', value: '북미' }] },
    { entity: 'vm', filters: Array.from({ length: NL.NL_FILTERS_MAX + 1 }, () => ({ field: 'name', op: 'contains', value: 'vm' })) },
    { entity: 'vm', sort: { field: 'nope' } }, { entity: 'vm', sort: { field: 'region' } },
  ];
  for (const q of bad) assert.throws(() => n(q), (e) => e.code === 'llm-bad-query' && /^LLM 응답 형식 오류/.test(e.message), JSON.stringify(q)?.slice(0, 80));
  assert.equal(n({ entity: 'vm', filters: Array.from({ length: NL.NL_FILTERS_MAX }, () => ({ field: 'name', op: 'contains', value: 'vm' })) }).filters.length, NL.NL_FILTERS_MAX);
});

test('F3 nlSearch(가짜 LLM): 조건 하나를 객체로 줘도 조건이 적용된다 · 응답의 filters 는 언제나 목록', async () => {
  const r = await ask({ entity: 'host', filters: { field: 'name', op: 'contains', value: 'esx-1' } });
  assert.equal(r.source, 'llm', r.llmError);
  assert.deepEqual(names(r), ['esx-1'], '수정 전: 조건을 버리고 호스트 3대 전부');
  assert.deepEqual(r.query.filters, [{ field: 'name', op: 'contains', value: 'esx-1' }], '수정 전: 객체 그대로 — 화면의 filters.map 이 TypeError');
});

test('F3 nlSearch(가짜 LLM): 복수형 · 대문자 엔티티는 그 엔티티로 · 연산자 기호는 그 뜻으로', async () => {
  const plural = await ask({ entity: 'hosts', filters: [{ field: 'cpuUsagePct', op: 'gt', value: 50 }] });
  assert.equal(plural.entity, 'host', '수정 전: 가상머신으로 바꿔 찾았다(0건)');
  assert.deepEqual(names(plural), ['esx-2', 'esx-3']);
  assert.equal((await ask({ entity: 'Host', filters: [] })).entity, 'host');
  const sym = await ask({ entity: 'vm', filters: [{ field: 'memUsagePct', op: '>', value: 30 }] });
  assert.deepEqual(names(sym), ['vm-4', 'vm-5'], '수정 전: > 를 eq 로 읽어 vm-3 하나');
  assert.equal(sym.query.filters[0].op, 'gt');
});

test('F3 nlSearch(가짜 LLM): 스키마에 맞지 않는 응답은 실행하지 않고 규칙 기반으로 돌린 뒤 사유를 밝힌다', async () => {
  const cases = {
    'filters 원소 null': { entity: 'vm', filters: [null] },
    'filters 원소 글자': { entity: 'vm', filters: ['memUsagePct > 30'] },
    '스키마 밖 필드': { entity: 'vm', filters: [{ field: 'memoryUsage', op: 'gt', value: 30 }] },
    '모르는 엔티티': { entity: 'cluster', filters: [] },
    '값이 객체': { entity: 'vm', filters: [{ field: 'name', op: 'contains', value: { a: 1 } }] },
    '조건 5000개': { entity: 'vm', filters: Array.from({ length: 5000 }, () => ({ field: 'name', op: 'contains', value: 'vm' })) },
  };
  for (const [label, q] of Object.entries(cases)) {
    const r = await ask(q);
    assert.equal(r.source, 'fallback', `${label}: 수정 전에는 'llm' 로 실행했다`);
    assert.match(String(r.llmError), /^LLM 응답 형식 오류/, label);
    assert.ok(Array.isArray(r.query.filters) && r.query.filters.every((f) => f && typeof f === 'object' && typeof f.field === 'string'), `${label}: 응답 filters 는 {field, op, value} 목록`);
  }
});

test('F3 nlSearch(가짜 LLM): 모델이 무엇을 답해도 사용자 범위 밖은 나오지 않는다(범위가 질의보다 먼저)', async () => {
  const allowed = new Set(['vc-kr']);
  const all = await ask({ entity: 'vm', filters: [], limit: 500 }, allowed);
  assert.deepEqual(names(all), ['vm-1', 'vm-2', 'vm-3']);
  assert.equal(all.total, 3, '합계도 범위 안만');
  const aimed = await ask({ entity: 'vm', filters: [{ field: 'vcenterId', op: 'eq', value: 'vc-us' }] }, allowed);
  assert.equal(aimed.total, 0);
  const anyOf = await ask({ entity: 'host', match: 'any', filters: [{ field: 'region', op: 'eq', value: '북미' }, { field: 'vcenterId', op: 'ne', value: 'vc-kr' }] }, allowed);
  assert.deepEqual(names(anyOf), []);
});

test('F4 nlSearch(가짜 LLM): 가상 필드(region · ip · tag)는 연산자를 본다 — ne 는 부정 · in 은 값 중 하나', async () => {
  const ne = await ask({ entity: 'host', filters: [{ field: 'region', op: 'ne', value: '북미' }] });
  assert.deepEqual(names(ne), ['esx-1', 'esx-3'], '수정 전: 북미가 아닌 호스트를 물으면 북미 호스트(esx-2)만 줬다');
  const eq = await ask({ entity: 'host', filters: [{ field: 'region', op: 'eq', value: '북미' }] });
  assert.deepEqual(names(eq), ['esx-2']);
  const inn = await ask({ entity: 'host', filters: [{ field: 'region', op: 'in', value: ['아시아', '유럽'] }] });
  assert.deepEqual(names(inn), ['esx-1', 'esx-3'], '수정 전: 배열을 글자로 바꿔 0건');
  const ipNe = await ask({ entity: 'vm', filters: [{ field: 'ip', op: 'ne', value: '10.1.' }] });
  assert.deepEqual(names(ipNe), ['vm-4', 'vm-5']);
  const tagIn = await ask({ entity: 'vm', filters: [{ field: 'tag', op: 'in', value: ['dev', 'none'] }] });
  assert.deepEqual(names(tagIn), ['vm-2', 'vm-4']);
  const tagHas = await ask({ entity: 'vm', filters: [{ field: 'tag', op: 'contains', value: 'PROD' }] });
  assert.deepEqual(names(tagHas), ['vm-1', 'vm-3', 'vm-5'], 'contains · eq 는 예전과 같다');
});

/* ── F5 Ollama 온라인 설치 명령 ────────────────────────────────────────────── */

test('F5 Ollama 온라인 설치: 스크립트를 받지 못하면 종료값이 0 이 아니다 · 받은 스크립트의 종료값을 그대로 낸다', () => {
  const bin = fs.mkdtempSync(path.join(TMP, 'bin-'));
  const out = path.join(TMP, 'installed.txt');
  const curl = (body) => { fs.writeFileSync(path.join(bin, 'curl'), `#!/bin/sh\n${body}\n`, { mode: 0o755 }); };
  const run = (cmd) => spawnSync('/bin/sh', ['-c', cmd], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, OUT116: out }, encoding: 'utf8', timeout: 30_000 });

  curl('echo "curl: (6) Could not resolve host: ollama.com" >&2; exit 6');
  assert.equal(run('curl -fsSL https://ollama.com/install.sh | sh').status, 0, '전제(수정 전 명령): curl 이 실패해도 파이프라인 종료값은 sh 의 0');
  const fail = run(DEP.OLLAMA_ONLINE_INSTALL_CMD);
  assert.notEqual(fail.status, 0, '수정 전: 0 — 설치 실패 판정이 걸리지 않았다');
  assert.match(fail.stderr, /Could not resolve host/, '받기 실패 사유(stderr)가 그대로 남는다');
  assert.equal(fs.existsSync(out), false);

  curl('printf \'%s\\n\' \'echo "ran $0 with \\$HOME" > "$OUT116"\' \'exit 0\'');
  const ok = run(DEP.OLLAMA_ONLINE_INSTALL_CMD);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(fs.readFileSync(out, 'utf8'), /^ran /, '받은 스크립트가 실행된다');

  curl('echo "exit 7"');
  assert.equal(run(DEP.OLLAMA_ONLINE_INSTALL_CMD).status, 7, '설치 스크립트의 종료값이 그대로');

  const src = stripComments(fs.readFileSync(path.join(SRC, 'llm/ollamaDeploy.js'), 'utf8'));
  assert.match(src, /exec\(OLLAMA_ONLINE_INSTALL_CMD\)/, 'installOllama 가 그 명령을 쓴다');
  assert.doesNotMatch(src, /install\.sh \| sh/, '받기 실패를 삼키는 파이프 꼴이 다시 생기지 않게');
});

/* ── F6 Ollama 원격 설치 감사 기록 ─────────────────────────────────────────── */

test('F6 ollamaDeployAuditDetail: 대상 · 방식 · 포트 · 모델 · 사유만 싣고 비밀 · 파일 경로는 싣지 않는다', () => {
  const d = DL.ollamaDeployAuditDetail({
    target: { host: '10.9.8.7', port: 2222, username: 'root', password: 'S3CRET-PW', privateKey: '-----BEGIN KEY-----' },
    mode: 'offline', model: 'llama3.1:8b', ollamaPort: '11500', applyToPortal: false, result: { ok: false, reason: '압축 해제 실패:\ntar: error\tx' },
  });
  assert.match(d, /대상 root@10\.9\.8\.7:2222/);
  assert.match(d, /방식 오프라인\(파일 전송\)/);
  assert.match(d, /Ollama 포트 11500/);
  assert.match(d, /모델 llama3\.1:8b/);
  assert.match(d, /포탈 LLM 설정 반영 요청 안 함/);
  assert.match(d, /사유 압축 해제 실패: tar: error x/, '줄바꿈 · 탭은 공백으로');
  assert.doesNotMatch(d, /S3CRET|BEGIN KEY/);
  const ok = DL.ollamaDeployAuditDetail({ target: { host: 'h', username: 'root' }, result: { ok: true } });
  assert.match(ok, /대상 root@h:22 · 방식 온라인 · Ollama 포트 11434 · 포탈 LLM 설정 반영 요청함$/);
  assert.match(DL.ollamaDeployAuditDetail({ target: { host: 'h', username: 'u' }, ollamaPort: 'x', result: { ok: true } }), /Ollama 포트 형식 오류/);
});

test('F6 POST /admin/ollama-deploy: 실패한 설치도 감사 기록에 남는다(대상 포함 · 비밀번호 없음)', async () => {
  const auditFile = F('audit.ndjson');
  const before = fs.existsSync(auditFile) ? fs.readFileSync(auditFile, 'utf8').split('\n').filter(Boolean).length : 0;
  const res = await withApp((app) => { const r = express.Router(); DL.registerDeployLlm(r); app.use('/admin', r); }, async (base) => {
    const x = await fetch(`${base}/admin/ollama-deploy`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ host: 'target-116.corp.example', port: 22, username: 'root', password: 'S3CRET-PW', mode: 'online', ollamaPort: '99999' }) });
    return { status: x.status, body: await x.json() };
  });
  assert.equal(res.status, 400, JSON.stringify(res.body));   // 포트 형식 오류 — SSH 에 닿기 전에 거절된다
  const lines = fs.readFileSync(auditFile, 'utf8').split('\n').filter(Boolean).slice(before).map((l) => JSON.parse(l));
  const hit = lines.filter((l) => l.action === 'Ollama 원격 설치 실패');
  assert.equal(hit.length, 1, `수정 전: 실패한 설치는 감사 기록이 없었다(${JSON.stringify(lines)})`);
  assert.equal(hit[0].target, 'target-116.corp.example');
  assert.match(hit[0].detail, /대상 root@target-116\.corp\.example:22 · 방식 온라인 · Ollama 포트 형식 오류/);
  assert.match(hit[0].detail, /사유 Ollama 포트는 1~65535/);
  assert.doesNotMatch(JSON.stringify(hit[0]), /S3CRET/);
});

/* ── F7 NSX 보안그룹 라이브 멤버 조회 ──────────────────────────────────────── */

test('F7 nsxLiveSkip: 비활성 · 인증 정지 매니저는 건너뛴다(그 밖은 null)', () => {
  assert.equal(OV.nsxLiveSkip({ id: 'm', enabled: true }, null), null);
  assert.equal(OV.nsxLiveSkip({ id: 'm' }, null), null, 'enabled 가 없으면 켜짐(등록부 규약)');
  assert.equal(OV.nsxLiveSkip({ id: 'm', enabled: false }, null).code, 'nsx-disabled');
  const s = OV.nsxLiveSkip({ id: 'm', enabled: true }, { since: 1, at: 2, attempts: 3, reason: 'GET /api/v1/node -> 403 secret-ish' });
  assert.equal(s.code, 'nsx-auth-stopped');
  assert.deepEqual(s.authStopped, { since: 1, at: 2, attempts: 3 }, '장비가 준 오류 원문은 싣지 않는다');
  assert.equal(OV.nsxLiveSkip({ id: 'm', enabled: false }, { since: 1, at: 2, attempts: 3 }).code, 'nsx-disabled', '비활성이 먼저');
  for (const x of [OV.nsxLiveSkip({ enabled: false }), s]) { assert.equal(x.error, x.reason); assert.doesNotMatch(x.reason, /`/); }
});

test('F7 GET /nsx/group-members: 비활성 · 인증 정지 매니저에는 로그인하지 않고 409 · 정상 매니저는 예전처럼 조회', async () => {
  // 등록부를 이 시험의 것으로(앞 시험이 남긴 것은 지운다 · 앞 시험의 읽기 오류 간격이 남아 있지 않게 시계를 넘긴다)
  pass();
  for (const m of REG.loadRegistry()) REG.removeManager(m.id);
  assert.equal(addMgr('live').ok, true);
  assert.equal(addMgr('off', { enabled: false }).ok, true);
  assert.equal(addMgr('stopped').ok, true);
  const full = REG.loadRegistry();
  nsxAuthGuard.markAuthStopped('stopped', full.find((m) => m.id === 'stopped'), 'GET /api/v1/node -> 403 Forbidden');
  const calls = [];
  const realFetch = globalThis.fetch;
  const stub = async (url, init) => {
    const u = new URL(String(url));
    if (u.hostname === '127.0.0.1') return realFetch(url, init);   // 이 시험의 라우트 호출
    calls.push({ host: u.hostname, auth: !!(init?.headers?.Authorization) });
    return Response.json({ results: [{ display_name: 'vm-a' }], result_count: 1 });
  };
  const snap = { generatedAt: new Date(NOW).toISOString(), vcenters: [], hosts: [], vms: [], datastores: [], networks: [], alarms: [] };
  const out = await withSnap(snap, () => withFetch(stub, () => withApp((app) => { const r = express.Router(); OV.registerOverviewNsx(r); app.use('/api', r); }, async (base) => {
    const get = async (id) => { const x = await realFetch(`${base}/api/nsx/group-members?managerId=${id}&groupId=${id}:grp-1`); return { status: x.status, body: await x.json() }; };
    return { off: await get('off'), stopped: await get('stopped'), live: await get('live'), none: await get('nope') };
  })));
  assert.equal(out.off.status, 409, JSON.stringify(out.off.body));
  assert.equal(out.off.body.code, 'nsx-disabled');
  assert.equal(out.stopped.status, 409, JSON.stringify(out.stopped.body));
  assert.equal(out.stopped.body.code, 'nsx-auth-stopped');
  assert.equal(out.stopped.body.authStopped.attempts, 1);
  assert.equal(out.none.status, 404);
  assert.equal(out.live.status, 200, JSON.stringify(out.live.body));
  assert.equal(out.live.body.vmCount, 1);
  assert.deepEqual([...new Set(calls.map((c) => c.host))], ['live.corp.example'], `수정 전: 비활성 · 인증 정지 매니저에도 저장 계정으로 로그인했다(${JSON.stringify(calls)})`);
  assert.ok(calls.length >= 2 && calls.every((c) => c.auth), '정상 매니저는 VM · IP 멤버 두 번 조회');
  assert.ok(nsxAuthGuard.peekAuthStop(full.find((m) => m.id === 'stopped')), '조회가 정지 기록을 지우지 않는다(읽기만)');
});

/* ── F8 심층 검색 게스트 탐침 상한 ─────────────────────────────────────────── */

test('F8 게스트 탐침 대상 수: 1~500 정수(0 · 음수 · 숫자 아님은 기본 100) — 음수로 뒤에서 잘라 상한을 넘기지 않는다', async () => {
  assert.deepEqual([-5, 0, 'x', undefined, null, 7.9, 3, 9999, '250'].map(DS.probeMaxVms), [100, 100, 100, 100, 100, 7, 3, 500, 250]);
  // 비활성 vCenter 는 로그인하지 않고 '탐침하지 않은 후보 수' 를 돌려준다 — 그 수로 자른 결과를 본다(vCenter 왕복 0).
  fs.writeFileSync(F('vcenters.json'), JSON.stringify({ vcenters: [{ id: 'vc-off', name: 'off', host: 'https://vc-off.corp.example', username: 'u', password: 'p', enabled: false }] }));
  const cand = (n) => Array.from({ length: n }, (_, i) => ({ id: `vc-off:vm-${i}`, name: `vm-${i}`, vcenterId: 'vc-off', powerState: 'POWERED_ON', toolsStatus: 'RUNNING' }));
  const count = async (n, maxVms) => {
    const r = await DS.guestProbe(cand(n), { type: 'gpuDriver' }, { maxVms });
    assert.equal(r.checked, 0); assert.equal(r.notCollected[0]?.why, 'disabled');
    return r.notCollected[0].vms;
  };
  assert.equal(await count(600, -5), 100, '수정 전: slice(0, -5) → 595대(상한 500 을 넘겨 게스트 명령 실행)');
  assert.equal(await count(10, -5), 10, '수정 전: 5대(뒤 5대를 뺐다)');
  assert.equal(await count(600, 1e9), 500);
  assert.equal(await count(600, undefined), 100);
  assert.equal(await count(10, 3), 3);
  const src = stripComments(fs.readFileSync(path.join(SRC, 'routes/admin/backupNetSec.js'), 'utf8'));
  assert.match(src, /const maxVms = probeMaxVms\(b\.maxVms\)/, '라우트(감사 줄의 상한 포함)도 같은 판정');
  assert.doesNotMatch(src, /Math\.min\(500, Number\(b\.maxVms\)/);
});
