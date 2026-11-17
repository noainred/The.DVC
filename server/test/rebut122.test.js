/**
 * rebut122.test.js — 전체 점검 122회차: 111회차(도구 · 용량 · 인벤토리 · 상태) · 116회차(LLM · 검색 · 보고서 · NSX — 등록부 F1 제외) 수정의 반증.
 *
 *  R1(중간 · 실측) llm/nlSearch.js — 116 F3 의 상한(조건 20 · in 50)이 실행 비용을 묶지 못했다: 지역 → vCenter 집합을 항목마다 · 값마다 새로 만들었고,
 *      F4 가 가상 필드의 in 을 '값 중 하나' 로 풀면서 값 수만큼 곱해졌다(VM 6,000 · vCenter 30 · 상한 안 질의 1건 = 21초 루프 정지) → 조건을 질의당 한 번 푼다.
 *  R2(낮음 · 재현) llm/nlSearch.js normalizeLlmQuery — F3 이 막은 '조용히 다른 뜻' 이 옆 열쇠로 남아 있었다: `match:'ANY'|'or'` 는 AND ·
 *      `operator:'>'` 는 eq · `not:true` 는 버려져 반대 결과 · 조건을 `filter`/`conditions`/`where` 로 주면 조건 없이 전량.
 *  R3(중간 · 재현) routes/metricsExport.js — 116 F2 는 못 읽은 DS 만 뺐다. 수집이 멈춘 vCenter(점검중 · 수집 실패 이월 · 위임 push 끊김)의 호스트 사용률 ·
 *      DS 용량은 마지막 값이 지금 값으로 나갔다(위임은 vmware_vcenter_up 도 1) → 지표 샘플러와 같은 판정으로 내지 않는다 + HELP 에 결측 규칙.
 *  R4(낮음) routes/admin/deployLlm.js — 116 F6 이 남긴 형제: 엣지 노드 배포(단건 · 저장 대상)의 실패가 감사에 없고 성공 줄에 대상이 없었다.
 *  S(확인 — 111 이 '실제 요청으로 재현하지 않았다' 고 남긴 것) 범위 계정의 실제 요청: vm-finder · 고아 VMDK · 씬 VM · 낭비 · VM 내보내기에 남의 법인 행이 없다.
 */
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { stripComments } from './_stripComments.js';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const TMP =fs.mkdtempSync(path.join(os.tmpdir(), 'rebut122-'));
process.env.CONFIG_DIR = TMP;
process.env.DATA_DIR = TMP;
process.env.AUTH_ENABLED = 'false';
process.env.DATA_SOURCE = 'live';
process.env.METRICS_ALLOW_ANON = 'true';
process.env.METRICS_EXPORT_TOKEN = '';
fs.writeFileSync(path.join(TMP, 'runtime.json'), JSON.stringify({ dataSource: 'live' }));
// LLM 은 켜 둔다(주소는 쓰이지 않는다 — fetch 를 바꾼다).
fs.writeFileSync(path.join(TMP, 'llm.json'), JSON.stringify({ enabled: true, url: 'http://llm.corp.example:11434', model: 'm', timeoutMs: 5000 }));

const express = createRequire(import.meta.url)('express');
const { store } = await import('../src/store.js');
const NL = await import('../src/llm/nlSearch.js');
const { metricsExportRouter } = await import('../src/routes/metricsExport.js');
const DL = await import('../src/routes/admin/deployLlm.js');
const { unreadVcenterReasons } = await import('../src/metrics/unreadVcenters.js');

// 기준 시각: 실제 시각에서 정시 경계로 떨어뜨려 고정(docs/rules/common.md).
const NOW = Math.floor(Date.now() / 3_600_000) * 3_600_000;
const closers = [];
const rmTmp = () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ } };
after(async () => { for (const c of closers) { try { await c(); } catch { /* */ } } rmTmp(); process.once('exit', rmTmp); });

async function withSnap(snap, fn) {
  const orig = store.get;
  store.get = () => snap;
  try { return await fn(); } finally { store.get = orig; }
}
async function withFetch(stub, fn) {
  const orig = globalThis.fetch;
  globalThis.fetch = stub;
  try { return await fn(); } finally { globalThis.fetch = orig; }
}
async function withApp(mount, fn) {
  const app = express();
  app.use(express.json());
  mount(app);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  try { return await fn(`http://127.0.0.1:${srv.address().port}`); } finally { srv.closeAllConnections?.(); await new Promise((r) => srv.close(r)); }
}

/* ── R1 자연어 검색 — 상한 안 질의의 실행 비용 ─────────────────────────────── */

const REGION4 = ['아시아', '중국', '유럽', '북미'];
/** vcenters.filter 호출 수를 센다(지역 → vCenter 집합을 몇 번 만들었는가 — 시간이 아니라 횟수로 고정). */
function countingSnap(nVm) {
  const vcenters = Array.from({ length: 30 }, (_, i) => ({ id: `vc-${i}`, location: { region: REGION4[i % 4] } }));
  const st = { regionScans: 0 };
  const origFilter = vcenters.filter;
  vcenters.filter = function countedFilter(...a) { st.regionScans += 1; return origFilter.apply(this, a); };
  const vms = Array.from({ length: nVm }, (_, i) => ({ id: `v${i}`, name: `vm-${i}`, vcenterId: `vc-${i % 30}`, powerState: 'POWERED_ON', memUsagePct: i % 100,
    ipAddresses: [`10.${i % 4}.0.${i % 200}`], tags: i % 2 ? ['prod', 'web'] : ['dev'] }));
  return { snap: { generatedAt: new Date(NOW).toISOString(), vcenters, vms, hosts: [], datastores: [], networks: [], alarms: [] }, st };
}
const askOn = (snap, llmJson, allowed = null) => withSnap(snap, () => withFetch(
  async () => Response.json({ response: JSON.stringify(llmJson) }),
  () => NL.nlSearch('질문', allowed),
));
const names = (r) => r.results.map((x) => x.name).sort();

test('R1 nlSearch: 상한 안 질의(조건 20 · in 50)가 지역 집합을 항목 × 값마다 다시 만들지 않는다(질의당 값마다 한 번)', async () => {
  const { snap, st } = countingSnap(400);
  const vals = Array.from({ length: NL.NL_IN_MAX }, (_, i) => `없는지역-${i}`);
  const q = { entity: 'vm', match: 'any', filters: Array.from({ length: NL.NL_FILTERS_MAX }, () => ({ field: 'region', op: 'in', value: vals })) };
  const r = await askOn(snap, q);
  assert.equal(r.source, 'llm', r.llmError);
  assert.equal(r.total, 0);
  const bound = NL.NL_FILTERS_MAX * NL.NL_IN_MAX;
  assert.ok(st.regionScans <= bound, `지역 집합을 ${st.regionScans}번 만들었다 — 상한은 조건 × 값(${bound}). 수정 전: 항목 × 조건 × 값(${400 * bound}번 — VM 6,000 이면 21초 정지)`);
  // ne · eq 한 조건도 항목 수만큼 만들지 않는다
  st.regionScans = 0;
  const ne = await askOn(snap, { entity: 'vm', filters: [{ field: 'region', op: 'ne', value: '북미' }] });
  assert.equal(ne.total, 400 - snap.vms.filter((v) => Number(v.vcenterId.slice(3)) % 4 === 3).length);
  assert.ok(st.regionScans <= 1, `수정 전: 항목마다(${st.regionScans})`);
});

test('R1 nlSearch: 조건을 미리 풀어도 판정은 예전과 같다(가상 필드 eq · ne · in · contains · 일반 필드 in · 범위)', async () => {
  const { snap } = countingSnap(60);
  const expectNames = (pred) => snap.vms.filter(pred).map((v) => v.name).sort();
  const regionOf = (v) => REGION4[Number(v.vcenterId.slice(3)) % 4];
  const ask = (q, allowed) => askOn(snap, { limit: 500, ...q }, allowed);
  assert.deepEqual(names(await ask({ entity: 'vm', filters: [{ field: 'region', op: 'eq', value: '유럽' }] })), expectNames((v) => regionOf(v) === '유럽'));
  assert.deepEqual(names(await ask({ entity: 'vm', filters: [{ field: 'region', op: 'in', value: ['아시아', '북미', '없음'] }] })), expectNames((v) => ['아시아', '북미'].includes(regionOf(v))));
  assert.deepEqual(names(await ask({ entity: 'vm', filters: [{ field: 'region', op: 'ne', value: '없는지역' }] })), expectNames(() => true), '없는 지역의 부정은 전부(예전과 같다)');
  assert.deepEqual(names(await ask({ entity: 'vm', filters: [{ field: 'ip', op: 'contains', value: '10.1.' }] })), expectNames((v) => v.ipAddresses[0].includes('10.1.')));
  assert.deepEqual(names(await ask({ entity: 'vm', filters: [{ field: 'ip', op: 'in', value: ['10.1.', '10.2.'] }] })), expectNames((v) => /^10\.[12]\./.test(v.ipAddresses[0])));
  assert.deepEqual(names(await ask({ entity: 'vm', filters: [{ field: 'tag', op: 'ne', value: 'PROD' }] })), expectNames((v) => !v.tags.includes('prod')));
  assert.deepEqual(names(await ask({ entity: 'vm', filters: [{ field: 'tag', op: 'in', value: ['WEB', 'none'] }] })), expectNames((v) => v.tags.includes('web')));
  assert.deepEqual(names(await ask({ entity: 'vm', filters: [{ field: 'name', op: 'in', value: ['vm-1', 'vm-7', 'VM-9'] }] })), ['vm-1', 'vm-7'], '일반 필드의 in 은 글자 그대로(예전과 같다)');
  assert.deepEqual(names(await ask({ entity: 'vm', filters: [{ field: 'memUsagePct', op: 'in', value: [3, '5'] }] })), ['vm-3', 'vm-5']);
  assert.deepEqual(names(await ask({ entity: 'vm', match: 'any', filters: [{ field: 'region', op: 'eq', value: '중국' }, { field: 'tag', op: 'eq', value: 'dev' }] })),
    expectNames((v) => regionOf(v) === '중국' || v.tags.includes('dev')));
  // 범위가 질의보다 먼저 — 미리 푼 지역 집합이 범위를 넓히지 않는다
  const scoped = await ask({ entity: 'vm', filters: [{ field: 'region', op: 'in', value: REGION4 }] }, new Set(['vc-0']));
  assert.deepEqual(names(scoped), expectNames((v) => v.vcenterId === 'vc-0'));
  // 응답에 싣는 질의는 모델이 준 조건 그대로다(미리 푼 내부 값이 새지 않는다)
  const echoed = await ask({ entity: 'vm', filters: [{ field: 'region', op: 'in', value: ['아시아'] }, { field: 'name', op: 'in', value: ['vm-1'] }] });
  assert.deepEqual(echoed.query.filters, [{ field: 'region', op: 'in', value: ['아시아'] }, { field: 'name', op: 'in', value: ['vm-1'] }]);
});

/* ── R2 normalizeLlmQuery — 옆 열쇠로 남은 '조용히 다른 뜻' ────────────────── */

test('R2 normalizeLlmQuery: match 는 대소문자 · 별칭을 받고 모르는 값은 던진다(AND 로 바꾸지 않는다)', () => {
  const n = NL.normalizeLlmQuery;
  const two = [{ field: 'memUsagePct', op: 'gt', value: 90 }, { field: 'cpuUsagePct', op: 'gt', value: 90 }];
  for (const m of ['any', 'ANY', ' Any ', 'or', 'OR', 'some']) assert.equal(n({ entity: 'vm', filters: two, match: m }).match, 'any', `match=${m} — 수정 전: 'any' 글자 그대로만 OR 였다`);
  for (const m of [undefined, null, '', 'all', 'ALL', 'and', 'AND', 'every']) assert.equal(n({ entity: 'vm', filters: two, match: m }).match, 'all', `match=${m}`);
  for (const m of ['none', 'xor', 'not', true, 1, {}]) assert.throws(() => n({ entity: 'vm', filters: two, match: m }), (e) => e.code === 'llm-bad-query' && /모르는 조건 결합/.test(e.message), `match=${JSON.stringify(m)}`);
});

test('R2 normalizeLlmQuery: operator 열쇠는 op 로 읽고 · 부정 표지는 던지고 · filter/conditions/where 는 filters 로 읽는다', () => {
  const n = NL.normalizeLlmQuery;
  assert.equal(n({ entity: 'vm', filters: [{ field: 'memUsagePct', operator: '>', value: 90 }] }).filters[0].op, 'gt', '수정 전: eq(> 90 이 = 90)');
  assert.equal(n({ entity: 'vm', filters: [{ field: 'memUsagePct', op: 'lte', operator: '>', value: 90 }] }).filters[0].op, 'lte', 'op 가 있으면 op 가 먼저');
  assert.equal(n({ entity: 'vm', filters: [{ field: 'name', value: 'a' }] }).filters[0].op, 'eq', '둘 다 없으면 eq(예전과 같다)');
  for (const k of ['not', 'negate', 'negated']) {
    assert.throws(() => n({ entity: 'vm', filters: [{ field: 'powerState', op: 'eq', value: 'POWERED_ON', [k]: true }] }), (e) => e.code === 'llm-bad-query' && /부정 표지/.test(e.message), k);
    assert.equal(n({ entity: 'vm', filters: [{ field: 'powerState', op: 'eq', value: 'POWERED_ON', [k]: false }] }).filters.length, 1, `${k}:false 는 그대로 받는다`);
  }
  const cond = [{ field: 'name', op: 'contains', value: 'esx' }];
  for (const k of ['filter', 'conditions', 'where']) assert.deepEqual(n({ entity: 'host', [k]: cond }).filters, cond, `${k} — 수정 전: 조건 없음(전량)`);
  assert.deepEqual(n({ entity: 'host', filter: cond[0] }).filters, cond, '조건 하나짜리 객체도 같다');
  assert.deepEqual(n({ entity: 'host', filters: [], filter: cond }).filters, [], 'filters 가 있으면 filters 가 먼저');
  assert.deepEqual(n({ entity: 'host' }).filters, [], '조건이 없는 질의는 예전처럼 전량');
  for (const odd of ['none', {}, 0, true]) assert.deepEqual(n({ entity: 'host', filter: odd, where: odd }).filters, [], `조건 모양이 아닌 값(${JSON.stringify(odd)})은 읽지 않는다 — 새로 거절하지 않는다`);
  // 상한은 별칭 열쇠에도 걸린다
  assert.throws(() => n({ entity: 'vm', where: Array.from({ length: NL.NL_FILTERS_MAX + 1 }, () => cond[0]) }), (e) => e.code === 'llm-bad-query');
});

test('R2 nlSearch(가짜 LLM): 다른 열쇠로 온 조건 · 연산자가 적용되고, 옮길 수 없는 뜻은 규칙 기반으로 돌린 뒤 사유를 밝힌다', async () => {
  const { snap } = countingSnap(60);
  const byFilter = await askOn(snap, { entity: 'vm', filter: [{ field: 'name', op: 'eq', value: 'vm-7' }] });
  assert.equal(byFilter.source, 'llm', byFilter.llmError);
  assert.deepEqual(names(byFilter), ['vm-7'], '수정 전: 조건을 버리고 VM 전부');
  const byOperator = await askOn(snap, { entity: 'vm', limit: 500, filters: [{ field: 'memUsagePct', operator: '>=', value: 58 }] });
  assert.deepEqual(names(byOperator), snap.vms.filter((v) => v.memUsagePct >= 58).map((v) => v.name).sort(), '수정 전: = 58 인 한 대');
  const anyOf = await askOn(snap, { entity: 'vm', limit: 500, match: 'OR', filters: [{ field: 'name', op: 'eq', value: 'vm-1' }, { field: 'name', op: 'eq', value: 'vm-2' }] });
  assert.deepEqual(names(anyOf), ['vm-1', 'vm-2'], "수정 전: 'OR' 를 AND 로 읽어 0건");
  assert.equal(anyOf.query.match, 'any');
  const negated = await askOn(snap, { entity: 'vm', filters: [{ field: 'name', op: 'eq', value: 'vm-1', not: true }] });
  assert.equal(negated.source, 'fallback', '수정 전: not 을 버리고 vm-1 한 대를 LLM 해석으로 줬다(반대 결과)');
  assert.match(String(negated.llmError), /부정 표지/);
});

/* ── R3 /metrics — 수집이 멈춘 vCenter 의 마지막 값 ────────────────────────── */

test('R3 /metrics: 수집이 멈춘 vCenter(위임 push 끊김 · 수집 실패 이월 · 점검중)의 호스트 사용률 · DS 용량은 내지 않는다(정상 vCenter 는 그대로)', async () => {
  const host = (vc, n, extra = {}) => ({ id: `${vc}:h${n}`, name: `${vc}-esx${n}`, vcenterId: vc, cluster: 'c1', connectionState: 'CONNECTED', cpuUsagePct: 40 + n, memUsagePct: 50 + n, ...extra });
  const ds = (vc) => ({ id: `${vc}:ds`, name: `${vc}-ds`, vcenterId: vc, type: 'VMFS', capacityGB: 100, freeGB: 40, usagePct: 60 });
  const snap = { generatedAt: new Date(NOW).toISOString(), source: 'live',
    vcenters: [
      { id: 'vc-ok', status: 'connected', version: '8.0' },
      { id: 'vc-site', status: 'connected', version: '8.0', collectSource: 'site', stale: true },                 // 위임 push 끊김 — 상태는 엣지가 준 값 그대로
      { id: 'vc-down', status: 'unreachable', version: '8.0', stale: true, staleSince: NOW - 3_600_000 },        // 수집 실패 이월
      { id: 'vc-maint', status: 'maintenance', maintenance: true, version: '8.0' },                              // 점검중
    ],
    hosts: [host('vc-ok', 1), host('vc-site', 1, { gpuUtilPct: 77 }), host('vc-down', 1), host('vc-maint', 1), host('vc-ok', 2, { connectionState: 'DISCONNECTED' })],
    datastores: [ds('vc-ok'), ds('vc-site'), ds('vc-down'), ds('vc-maint')],
    vms: [{ id: 'v1', vcenterId: 'vc-site', powerState: 'POWERED_ON' }, { id: 'v2', vcenterId: 'vc-ok', powerState: 'POWERED_OFF' }], networks: [], alarms: [] };
  assert.deepEqual([...unreadVcenterReasons(snap).keys()].sort(), ['vc-down', 'vc-maint', 'vc-site'], '전제: 지표 샘플러가 지금 값으로 적재하지 않는 vCenter');
  const txt = await withSnap(snap, () => withApp((app) => app.use('/metrics', metricsExportRouter), async (base) => (await fetch(`${base}/metrics`)).text()));
  const lines = txt.split('\n');
  const of = (metric, vc) => lines.filter((l) => l.startsWith(`${metric}{`) && l.includes(`vcenter="${vc}"`)).map((l) => l.split(' ').pop());
  for (const vc of ['vc-site', 'vc-down', 'vc-maint']) {
    assert.deepEqual(of('vmware_host_cpu_percent', vc), [], `${vc}: 수정 전 — 마지막 값(41)을 지금 값으로 냈다`);
    assert.deepEqual(of('vmware_host_mem_percent', vc), [], vc);
    assert.deepEqual(of('vmware_datastore_free_bytes', vc), [], `${vc}: 수정 전 — 마지막 여유를 지금 값으로`);
    assert.deepEqual(of('vmware_datastore_capacity_bytes', vc), [], vc);
    assert.deepEqual(of('vmware_datastore_usage_percent', vc), [], vc);
    assert.deepEqual(of('vmware_host_up', vc), ['1'], `${vc}: 연결 상태(인벤토리)는 예전 그대로 낸다`);
  }
  assert.deepEqual(of('vmware_host_gpu_percent', 'vc-site'), [], '스냅샷의 GPU 사용률도 지금 값이 아니다');
  assert.deepEqual(of('vmware_vm_count', 'vc-site'), ['1'], 'VM 수(인벤토리)는 예전 그대로');
  // 정상 vCenter 는 그대로 — 끊긴 호스트(v2.743 VC-04)만 빠진다
  assert.deepEqual(of('vmware_host_cpu_percent', 'vc-ok'), ['41']);
  assert.deepEqual(of('vmware_host_mem_percent', 'vc-ok'), ['51']);
  assert.deepEqual(of('vmware_host_up', 'vc-ok'), ['1', '0']);
  assert.deepEqual(of('vmware_datastore_free_bytes', 'vc-ok'), [String(40 * 1073741824)]);
  assert.deepEqual(of('vmware_datastore_usage_percent', 'vc-ok'), ['60']);
  // 결측 규칙은 HELP 에 적혀 있다(0 과 '시계열 없음' 은 다르다 — 외부 경보가 absent 로 봐야 한다)
  for (const m of ['vmware_host_cpu_percent', 'vmware_host_mem_percent', 'vmware_datastore_usage_percent', 'vmware_datastore_capacity_bytes', 'vmware_datastore_free_bytes']) {
    const help = lines.find((l) => l.startsWith(`# HELP ${m} `));
    assert.match(help, /못 읽으면 이 시계열을 내지 않는다\(0 이 아니다/, m);
    assert.doesNotMatch(help, /\n/);
  }
});

/* ── R4 엣지 노드 배포 감사 ────────────────────────────────────────────────── */

test('R4 agentDeployAuditDetail: 대상 · 엣지 이름 · 포탈 포트 · 사유만 싣고 비밀번호 · 개인키 · 토큰은 싣지 않는다', () => {
  const d = DL.agentDeployAuditDetail({
    target: { host: '10.9.8.7', port: 2222, username: 'root', password: 'S3CRET-PW', privateKey: '-----BEGIN KEY-----', agentName: 'edge-pl', centralToken: 'CT-TOKEN-VALUE', collectorToken: 'COL-TOKEN-VALUE' },
    portalPort: '4100', result: { ok: false, reason: 'install.sh 실패:\nglibc\ttoo old' },
  });
  assert.equal(d, '대상 root@10.9.8.7:2222 · 엣지 edge-pl · 포탈 포트 4100 · 사유 install.sh 실패: glibc too old');
  assert.doesNotMatch(d, /S3CRET|BEGIN KEY|TOKEN-VALUE/);
  assert.equal(DL.agentDeployAuditDetail({ target: { host: 'h', username: 'root' }, result: { ok: true } }), '대상 root@h:22 · 포탈 포트 4000');
  assert.equal(DL.agentDeployAuditDetail({ target: {}, result: { ok: false, reason: 'x'.repeat(500) } }), `대상 ?@?:22 · 포탈 포트 4000 · 사유 ${'x'.repeat(160)}`);
  assert.equal(DL.agentDeployAuditDetail(), '대상 ?@?:22 · 포탈 포트 4000 · 사유 ');
});

test('R4 POST /admin/agent-deploy: 실패한 배포도 감사 기록에 남는다(대상 포함 · 비밀 없음) · 저장 대상 배포 · 전체 배포도 같은 기록을 쓴다(소스)', async () => {
  // 저장 대상 배포(/targets/:id/deploy)와 전체 배포(/deploy-all)는 실제 SSH 가 필요해 호출하지 못한다 — 같은 기록 함수를 쓰는지만 소스로 고정한다.
  const src = stripComments(fs.readFileSync(path.join(SRC, 'routes/admin/deployLlm.js'), 'utf8'));
  assert.equal((src.match(/(?<!function )auditAgentDeploy\(req, res, /g) || []).length, 2, '단건 배포 · 저장 대상 배포 두 곳(정의 제외)');
  assert.match(src, /auditAgentDeploy\(req, res, target, portalPort, r\);\s+res\.status\(r\.ok \? 200 : 400\)/, '단건 배포');
  assert.match(src, /auditAgentDeploy\(req, res, t, t\.portalPort, r\)/, '저장 대상 배포');
  assert.match(src, /res\.locals\.auditDetail = `대상 \$\{results\.length\} · 성공/, '전체 배포는 자동 감사 줄에 대상 수 · 실패 주소');
  const auditFile = path.join(TMP, 'audit.ndjson');
  const count = () => (fs.existsSync(auditFile) ? fs.readFileSync(auditFile, 'utf8').split('\n').filter(Boolean).length : 0);
  const before0 = count();
  const res = await withApp((app) => {
    app.use((req, _res, next) => { req.user = { username: 'adm', role: 'admin', scope: null }; next(); });
    const r = express.Router(); DL.registerDeployLlm(r); app.use('/admin', r);
  }, async (base) => {
    // username 이 없어 SSH 에 닿기 전에 거절된다(host/username을 입력하세요.) — 그 실패도 기록돼야 한다
    const x = await fetch(`${base}/admin/agent-deploy`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ host: 'edge-122.corp.example', port: 2200, password: 'S3CRET-PW', agentName: 'edge-122', centralToken: 'CT-TOKEN-VALUE', portalPort: 4100 }) });
    return { status: x.status, body: await x.json() };
  });
  assert.equal(res.status, 400, JSON.stringify(res.body));
  const lines = fs.readFileSync(auditFile, 'utf8').split('\n').filter(Boolean).slice(before0).map((l) => JSON.parse(l));
  const hit = lines.filter((l) => l.action === '엣지 노드 배포 실패');
  assert.equal(hit.length, 1, `수정 전: 실패한 배포는 감사 기록이 없었다(${JSON.stringify(lines)})`);
  assert.equal(hit[0].target, 'edge-122.corp.example');
  assert.equal(hit[0].user, 'adm');
  assert.match(hit[0].detail, /^대상 \?@edge-122\.corp\.example:2200 · 엣지 edge-122 · 포탈 포트 4100 · 사유 host\/username/);
  assert.doesNotMatch(JSON.stringify(hit), /S3CRET|TOKEN-VALUE/);
});

/* ── S 범위 계정의 실제 요청(111 이 남긴 것) ───────────────────────────────── */

let base;
let USER = { username: 'adm', role: 'admin', scope: null };
const SCOPED = { username: 'kr-admin', role: 'admin', scope: { vcenters: ['vc-kr'] } };
const VM = (vc, n, extra = {}) => ({ id: `${vc}:vm-${n}`, vcenterId: vc, name: `${vc}-vm${n}`, powerState: 'POWERED_ON', cpuUsagePct: 3, memUsagePct: 5, host: `${vc}-esx1`, cluster: `${vc}-cl`,
  folder: `${vc}-folder`, resourcePool: `${vc}-pool`, cpuCount: 2, memMB: 4096, guestOS: 'Rocky Linux 9', ipAddress: vc === 'vc-kr' ? `10.1.0.${n}` : `10.2.0.${n}`, thin: true, storageGB: 10, uncommittedGB: 30, ...extra });
before(async () => {
  store.snapshot = {
    ...(store.get() || {}), source: 'live', generatedAt: new Date(NOW).toISOString(),
    vcenters: [{ id: 'vc-kr', name: 'VC-KR', status: 'connected', location: { region: '아시아' } }, { id: 'vc-us', name: 'VC-US', status: 'connected', location: { region: '북미' } }],
    vms: [VM('vc-kr', 1), VM('vc-kr', 2, { powerState: 'POWERED_OFF' }), VM('vc-us', 1), VM('vc-us', 2), VM('vc-us', 3, { template: true })],
    hosts: [{ id: 'vc-kr:h1', vcenterId: 'vc-kr', name: 'vc-kr-esx1', cluster: 'vc-kr-cl', connectionState: 'CONNECTED', cpuTotalMhz: 48000, cpuCores: 16 },
      { id: 'vc-us:h1', vcenterId: 'vc-us', name: 'vc-us-esx1', cluster: 'vc-us-cl', connectionState: 'CONNECTED', cpuTotalMhz: 48000, cpuCores: 16 }],
    datastores: [{ id: 'vc-kr:datastore-1', vcenterId: 'vc-kr', name: 'kr-ds1', type: 'VMFS', capacityGB: 100, usedGB: 10, freeGB: 90 },
      { id: 'vc-us:datastore-9', vcenterId: 'vc-us', name: 'us-ds9', type: 'VMFS', capacityGB: 100, usedGB: 70, freeGB: 30 }],
    networks: [], alarms: [],
  };
  const { api } = await import('../src/routes/api.js');
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { req.user = USER; next(); });
  app.use('/api', api);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  closers.push(() => new Promise((r) => { srv.closeAllConnections?.(); srv.close(r); }));
  base = `http://127.0.0.1:${srv.address().port}`;
});
const call = async (user, m, p, body) => {
  USER = user;
  const r = await fetch(base + p, { method: m, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { j = t; }
  return { status: r.status, j, text: t };
};
/** 응답에 범위 밖 법인의 이름 · 주소 · 데이터스토어가 없다. `scope` 는 요청자가 보낸 vcenterId 를 되돌려 준 것이라 뺀다(남의 데이터가 아니다). */
const noUs = (r, label) => {
  const body = r.j && typeof r.j === 'object' && !Array.isArray(r.j) ? JSON.stringify({ ...r.j, scope: undefined }) : r.text;
  assert.doesNotMatch(body, /vc-us|us-ds9|10\.2\.0\./, `${label}: 범위 밖 법인(vc-us)의 이름 · 주소 · 데이터스토어가 응답에 있다`);
};

test('S 범위 계정: VM 정밀 검색 — 범위 밖 vCenter 를 요청 필터로 넣어도 결과 · 선택지 · 유휴 분석에 남의 법인이 없다', async () => {
  const all = await call(USER = { username: 'adm', role: 'admin', scope: null }, 'POST', '/api/tools/vm-finder', {});
  assert.equal(all.status, 200);
  assert.equal(all.j.items.length, 4, '전제: 전체 범위 계정은 두 법인 VM(템플릿 제외) 4대');
  for (const body of [{}, { vcenterIds: ['vc-us'] }, { vcenterIds: ['vc-kr', 'vc-us'], includeTemplates: true }, { q: 'vc-us' }, { q: '10.2.0.' }, { folders: ['vc-us-folder'] }, { clusters: ['vc-us-cl'] }]) {
    const r = await call(SCOPED, 'POST', '/api/tools/vm-finder', body);
    assert.equal(r.status, 200, JSON.stringify(body));
    noUs(r, `vm-finder ${JSON.stringify(body)}`);
    assert.ok(r.j.items.every((x) => x.vcenterId === 'vc-kr'));
    assert.deepEqual(r.j.facets.vcenters.filter((x) => x !== 'vc-kr'), []);
  }
  // 유휴 분석(withAvg): 대상도 범위 안만 — 이 포탈에 접속 정보가 없어 평균을 못 읽으므로 전부 판정 불가(111 B)
  const avg = await call(SCOPED, 'POST', '/api/tools/vm-finder', { withAvg: true, vcenterIds: ['vc-us'] });
  noUs(avg, 'vm-finder withAvg');
  assert.equal(avg.j.items.length, 0, '범위 밖만 고르면 0건(존재를 흘리지 않는다)');
  const avg2 = await call(SCOPED, 'POST', '/api/tools/vm-finder', { withAvg: true });
  noUs(avg2, 'vm-finder withAvg 전체');
  assert.equal(avg2.j.items.length, 2);
  assert.equal(avg2.j.idleCount, 0);
  assert.equal(avg2.j.idleUnknown, 2, '평균을 못 읽은 VM 은 유휴에도 사용에도 넣지 않는다');
  assert.ok(avg2.j.items.every((x) => x.idle === null));
});

test('S 범위 계정: 고아 VMDK — 데이터스토어 목록은 범위 안만 · 범위 밖 데이터스토어 스캔은 404(없는 것과 같은 응답)', async () => {
  const list = await call(SCOPED, 'GET', '/api/tools/orphan-vmdk/datastores');
  assert.equal(list.status, 200);
  noUs(list, 'orphan-vmdk/datastores');
  assert.deepEqual(list.j.items.map((x) => x.id), ['vc-kr:datastore-1']);
  const byVc = await call(SCOPED, 'GET', '/api/tools/orphan-vmdk/datastores?vcenterId=vc-us');
  assert.equal(byVc.j.total, 0);
  assert.doesNotMatch(JSON.stringify(byVc.j.items), /us-ds9/);
  const out = await call(SCOPED, 'GET', `/api/tools/orphan-vmdk?datastoreId=${encodeURIComponent('vc-us:datastore-9')}&recentHours=0`);
  const none = await call(SCOPED, 'GET', `/api/tools/orphan-vmdk?datastoreId=${encodeURIComponent('vc-zz:datastore-0')}&recentHours=0`);
  assert.equal(out.status, 404);
  assert.deepEqual(out.j, none.j, '범위 밖과 없는 데이터스토어의 응답이 같다(존재 은닉)');
  // 전체 범위 계정에는 그 데이터스토어가 보인다(전제 — 404 가 범위 때문임을 확인)
  const adm = await call({ username: 'adm', role: 'admin', scope: null }, 'GET', '/api/tools/orphan-vmdk/datastores');
  assert.deepEqual(adm.j.items.map((x) => x.id).sort(), ['vc-kr:datastore-1', 'vc-us:datastore-9']);
});

test('S 범위 계정: 씬 VM · 낭비 보고서 · VM 내보내기 — 요청 vcenterId 로 범위를 넘지 못한다', async () => {
  for (const p of ['/api/tools/thin-vms', '/api/tools/thin-vms?vcenterId=vc-us', '/api/tools/waste', '/api/tools/waste?vcenterId=vc-us', '/api/tools/capacity', '/api/tools/capacity?vcenterId=vc-us',
    '/api/tools/capacity-forecast', '/api/tools/capacity-forecast?vcenterId=vc-us']) {
    const r = await call(SCOPED, 'GET', p);
    assert.equal(r.status, 200, p);
    noUs(r, p);
  }
  const thin = await call(SCOPED, 'GET', '/api/tools/thin-vms');
  assert.equal(thin.j.totalVms, 2, '합계도 범위 안만');
  // 전체 범위 계정의 캐시가 범위 계정에 새지 않는다(memoJson extraKey — 같은 URL 을 전체 범위로 먼저 부른다)
  const admThin = await call({ username: 'adm', role: 'admin', scope: null }, 'GET', '/api/tools/thin-vms');
  assert.equal(admThin.j.totalVms, 5);
  const thinAgain = await call(SCOPED, 'GET', '/api/tools/thin-vms');
  assert.equal(thinAgain.j.totalVms, 2);
  noUs(thinAgain, 'thin-vms(전체 범위 호출 뒤)');
  // VM 내보내기(단건 vCenter) — 범위 밖은 없는 vCenter 와 같은 404
  for (const [m, p] of [['GET', '/api/tools/vm-export?vcenterId=vc-us'], ['GET', '/api/tools/vm-export/catalog?vcenterId=vc-us'], ['POST', '/api/tools/vm-export/preview?vcenterId=vc-us'], ['POST', '/api/tools/vm-export.csv?vcenterId=vc-us'], ['GET', '/api/tools/vm-export.csv?vcenterId=vc-us']]) {
    const r = await call(SCOPED, m, p, m === 'POST' ? {} : undefined);
    assert.equal(r.status, 404, `${m} ${p}`);
    noUs(r, `${m} ${p}`);
  }
});
