/**
 * full160.test.js — 전체 점검 160회차(4축 장비 · 스토리지 · 백업 도구 · IP 관리 — 155회차 반증 + 이어 읽기) 회귀.
 *
 *  S1  활성 조닝(Effective configuration · REST enabled-zone)은 zone 멤버를 WWN 으로 풀어 적는다 — zone 행의 aliasOf 가 늘 비고,
 *      수집해 둔 `zoning.aliases`(이름 → WWN 목록)를 WWN 으로 되찾는 곳이 없어 조닝 그림 · 불량 포트 상대편 · 스토리지 매핑의 '조닝 별칭' 이 늘 비었다.
 *      불량 포트 경로(routes/api/sanSwitch.js zoneDetailFor)는 그 맵을 뒤집지 않고 그대로 넘겼다(WWN 으로 찾으면 아무것도 맞지 않는다).
 *  V1  Veeam 백업 삭제 — 백업 뒤에 VM 이름이 바뀌면(개체 이름은 옛 이름 · moref 는 같다) ‘이 VM 의 백업이 없습니다 — 지울 것이 없습니다’(성공)로 답했다.
 *  I1  IP 스캔 기준선 맵 — 에이전트 이름 ‘__PROTO__’(소문자로 바꿔 키로 쓴다)가 Object.prototype 에 대역 줄을 열거 속성으로 써 넣었다.
 *  R1  155 F1ⓒ 반증 — 학습 계정 ‘__proto__’ 를 지워도 지운 표시(forgotten)가 남지 않아 곧바로 다시 배웠다.
 *  R2  155 F2 반증 — 스킴 없는 2,041~2,048자 host 는 등록되고 ‘https://’ 가 붙어 2,049자 넘게 저장돼 그 뒤 모든 수정이 거절됐다.
 *  E1  155 추정 E1 — MIG 미디어 확장 vGPU 프로파일(…-1-5cme)이 '해석 불가' 였다(서버 · 웹 미러 같은 규칙).
 *  E2  155 추정 E2 — Bareos 사전 점검의 리소스 종류 칸 ‘constructor’ · ‘toString’ 한 줄이 점검 해석 전체를 던졌다.
 *  C1  (메인이 뺌 — 결정 대기) Bareos 덮어쓰기 복원을 오래된 인벤토리에서 막는 권장안은 사용자 판단 뒤에: 회선이 끊긴 동안의 복원을 막는 동작 변화라 싣지 않았다.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from './_stripComments.js';

const TMP_DIRS = [];
const tmpDir = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); TMP_DIRS.push(d); return d; };
const rmTmpDirs = () => { for (const d of TMP_DIRS) { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* 정리 실패는 시험 결과가 아니다 */ } } };
after(() => { rmTmpDirs(); process.once('exit', () => { try { rmTmpDirs(); } catch { /* 종료 중 */ } }); });

const DIR = tmpDir('full160-');
process.env.CONFIG_DIR = DIR;
process.env.DB_DIR = DIR;
process.env.DATA_DIR = DIR;
process.env.TEMP_DB_PATH = path.join(DIR, 'host-temp.db');
process.env.IDRAC_DB_PATH = path.join(DIR, 'idrac-power.db');
process.env.AUTH_ENABLED = 'false';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../src');
const src = (p) => stripComments(fs.readFileSync(path.join(SRC, p), 'utf8'));

// 기준 시각: 실제 시각을 정시 경계로 떨어뜨려 고정(docs/rules/common.md)
const NOW = Math.floor(Date.now() / 3_600_000) * 3_600_000;

/* ───────────────────────── S1 활성 조닝의 별칭 ───────────────────────── */

const HBA = '10:00:00:10:9b:00:00:01'; const HBA2 = '10:00:00:10:9b:00:00:03'; const TGT = '50:06:01:60:00:00:00:02';
// 실장비 모양(저장소 데모 cfgshowText 와 같은 꼴): 정의 섹션은 별칭으로 zone 을 적고, 활성 섹션은 WWN 으로 풀어 적는다
const CFG_EFF = [
  'Defined configuration:',
  ' cfg:\tPROD_CFG\tZ_ESX01_UNITY',
  ' zone:\tZ_ESX01_UNITY', '\t\tESX01_HBA0; UNITY_SPA_P0',
  ' alias:\tESX01_HBA0', `\t\t${HBA}`,
  ' alias:\tUNITY_SPA_P0', `\t\t${TGT}`,
  '', 'Effective configuration:', ' cfg:\tPROD_CFG',
  ' zone:\tZ_ESX01_UNITY', `\t\t${HBA}`, `\t\t${TGT}`,
].join('\n');

const Z = await import('../src/sanswitch/zoning.js');
const { zoningFromText, zoningFromRest } = await import('../src/sanswitch/zoningCollect.js');

test('S1 활성 조닝(WWN 멤버)의 zone 멤버 · 조닝 그림 · 스토리지 매핑 문맥에 별칭이 붙는다', async () => {
  const z = JSON.parse(JSON.stringify(zoningFromText(CFG_EFF, 'PROD_CFG')));
  assert.equal(z.source, 'effective', '전제: 활성 섹션을 쓴다');
  assert.deepEqual(z.zones[0].aliasOf, {}, '전제: 활성 zone 행에는 별칭 표가 없다');
  assert.deepEqual(z.aliases, { ESX01_HBA0: [HBA], UNITY_SPA_P0: [TGT] });
  const zones = Z.zonesFromCompact(z);
  assert.deepEqual(zones[0].members.map((m) => [m.wwn, m.alias]), [[HBA, 'ESX01_HBA0'], [TGT, 'UNITY_SPA_P0']], '수정 전: 별칭이 전부 빈칸');
  const g = Z.buildZoneGraph(zones, {});
  assert.deepEqual(g.nodes.map((n) => [n.wwn, n.label, n.alias]).sort(), [[HBA, 'ESX01_HBA0', 'ESX01_HBA0'], [TGT, 'UNITY_SPA_P0', 'UNITY_SPA_P0']], '수정 전: 라벨이 WWN');
  // 네임서버 이름이 있으면 라벨은 그 이름(예전 우선순위 그대로) · 별칭 칸은 별칭
  const g2 = Z.buildZoneGraph(zones, { names: { [HBA]: 'esx01.corp' } });
  const n2 = g2.nodes.find((n) => n.wwn === HBA);
  assert.equal(n2.label, 'esx01.corp'); assert.equal(n2.alias, 'ESX01_HBA0');
  // 스토리지 매핑 · 성능의 '조닝 별칭' 폴백이 읽는 문맥(attribution.buildFabrics aliasOf)
  const { buildFabrics } = await import('../src/sanswitch/attribution.js');
  const [f] = buildFabrics([{ deviceId: 'd1', name: 'SW', zoning: z, ports: { list: [] } }]);
  assert.equal(f.aliasOf.get(TGT), 'UNITY_SPA_P0', '수정 전: undefined(별칭 폴백이 늘 비었다)');
  assert.equal(f.aliasOf.get(HBA), 'ESX01_HBA0');
});

test('S1 별칭 뒤집기 — zone 행의 별칭이 먼저 · 한 WWN 에 별칭이 둘이면 먼저 적힌 이름 · 모양이 틀린 값은 무시 · REST 조닝도 같다', () => {
  assert.equal(Z.aliasByWwn({ A: [HBA], B: [HBA, TGT] }).get(HBA), 'A', '먼저 나온 이름이 이긴다(매번 같은 답)');
  assert.equal(Z.aliasByWwn({ A: [HBA], B: [HBA, TGT] }).get(TGT), 'B');
  for (const bad of [null, undefined, 'x', 7, [], [[HBA]], { A: 'x', B: 3, C: [1, {}, 'zz', null] }]) assert.equal(Z.aliasByWwn(bad).size, 0, JSON.stringify(bad));
  assert.equal(Z.aliasByWwn({ UP: ['10:00:00:10:9B:00:00:01'] }).get(HBA), 'UP', 'WWN 표기는 정규화한다');
  // zone 행이 가진 별칭(정의 섹션으로 푼 zone — 그 zone 이 실제로 쓴 이름)이 맵보다 먼저
  const own = Z.zonesFromCompact({ zones: [{ name: 'z', members: [HBA, TGT], aliasOf: { [HBA]: 'IN_ZONE' } }], aliases: { OTHER: [HBA], T: [TGT] } });
  assert.deepEqual(own[0].members.map((m) => m.alias), ['IN_ZONE', 'T']);
  // 별칭 맵이 없거나 모양이 틀려도 던지지 않는다(예전과 같은 결과 — 빈 별칭)
  for (const aliases of [undefined, null, 'x', []]) assert.deepEqual(Z.zonesFromCompact({ zones: [{ name: 'z', members: [HBA] }], aliases })[0].members.map((m) => m.alias), ['']);
  // REST: enabled-zone 멤버는 WWN · 정의에 별칭
  const r = JSON.parse(JSON.stringify(zoningFromRest(
    { 'effective-configuration': { 'cfg-name': 'PROD_CFG', 'enabled-zone': [{ 'zone-name': 'Z1', 'member-entry': { 'entry-name': [HBA, TGT] } }] } },
    { 'defined-configuration': { alias: [{ 'alias-name': 'ESX01_HBA0', 'member-entry': { 'alias-entry-name': [HBA] } }, { 'alias-name': 'UNITY_SPA_P0', 'member-entry': { 'alias-entry-name': [TGT] } }] } })));
  assert.equal(r.source, 'effective');
  assert.deepEqual(Z.zonesFromCompact(r)[0].members.map((m) => [m.wwn, m.alias]), [[HBA, 'ESX01_HBA0'], [TGT, 'UNITY_SPA_P0']]);
});

test('S1 라우트 — 조닝 그림과 불량 포트의 상대편이 별칭으로 보인다(수정 전: WWN · 별칭 빈칸)', { timeout: 60_000 }, async () => {
  const express = (await import('express')).default;
  const { api } = await import('../src/routes/api.js');
  const reg = await import('../src/sanswitch/registry.js');
  const edge = await import('../src/central/sanSwitchEdge.js');
  const dev = reg.saveDevice({ type: 'brocade', name: 'SW160', host: '10.160.1.1', username: 'u', password: 'p', agent: 'edge-160' });
  const zoning = zoningFromText(CFG_EFF, 'PROD_CFG');
  edge.saveEdgeSanSwitch('edge-160', [{ deviceId: dev.id, type: 'brocade', name: 'SW160', ok: true, collectedAt: NOW - 60_000,
    ports: { total: 2, list: [{ index: 3, state: 'faulty', stateRaw: 'Faulty', attached: [HBA] }, { index: 4, state: 'online', attached: [TGT] }] },
    sections: { ports: 'ok', zoning: 'ok' }, zoning }]);
  const app = express(); app.use(express.json());
  app.use((req, _r, n) => { req.user = { username: 'root', role: 'admin', scope: null }; n(); });
  app.use('/api', api);
  const s = await new Promise((r) => { const x = app.listen(0, '127.0.0.1', () => r(x)); });
  try {
    const base = `http://127.0.0.1:${s.address().port}/api/tools/sanswitch`;
    const j = async (p) => (await fetch(base + p)).json();
    const zv = await j(`/devices/${dev.id}/zoning`);
    assert.equal(zv.ok, true);
    assert.equal(zv.graph.nodes.find((n) => n.wwn === TGT).alias, 'UNITY_SPA_P0', '조닝 그림 노드의 별칭');
    assert.equal(zv.graph.nodes.find((n) => n.wwn === HBA).label, 'ESX01_HBA0', '이름을 모르는 WWN 의 라벨은 별칭');
    const hc = await j(`/devices/${dev.id}/healthcheck`);
    assert.equal(hc.ok, true);
    const row = hc.problemPorts.find((p) => p.index === 3);
    assert.ok(row, '불량(faulty) 포트가 지목된다');
    assert.deepEqual(row.wwns.map((w) => [w.wwn, w.alias, w.label]), [[HBA, 'ESX01_HBA0', 'ESX01_HBA0']], '불량 포트 WWN 의 별칭');
    assert.deepEqual(row.zones[0].partners.map((p) => [p.wwn, p.label]), [[TGT, 'UNITY_SPA_P0']], '상대편 라벨 — 수정 전: WWN 그대로');
  } finally { s.close(); }
  // 소스: 별칭 맵(이름 → WWN 목록)을 WWN → 별칭 자리에 그대로 넘기는 꼴이 다시 생기지 않게
  assert.doesNotMatch(src('routes/api/sanSwitch.js'), /aliasOf\s*=\s*\{\s*\.\.\.\(z\.aliases/);
});

/* ───────────────────────── V1 Veeam 백업 삭제 — 이름이 바뀐 VM ───────────────────────── */

function fakeVbr(routes) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const u = new URL(url);
    const key = `${init.method || 'GET'} ${u.pathname}`;
    calls.push({ key });
    const h = routes[key];
    if (!h) return new Response(JSON.stringify({ message: 'no route' }), { status: 404 });
    return new Response(h.status === 204 ? null : (h.json !== undefined ? JSON.stringify(h.json) : ''), { status: h.status || 200, headers: { 'content-type': 'application/json' } });
  };
  fn.writes = () => calls.filter((c) => c.key.startsWith('POST /api/v1/') || c.key.startsWith('PUT ') || c.key.startsWith('DELETE ')).map((c) => c.key);
  return fn;
}
const TOKEN = { 'POST /api/oauth2/token': { json: { access_token: 't' } }, 'POST /api/oauth2/logout': { status: 200 } };
const SRV = { id: 'vbr-160', name: 'OC2', host: 'vbr.corp.local', port: 9419, username: 'svc', password: 'pw', enabled: true, agent: '' };
const JOBNAME = 'PORTAL-OC2-d6c8d5';
const INC = (n, o) => ({ type: 'VirtualMachine', hostName: 'oc2-vc.corp.local', name: n, objectId: o });
const OBJ = (id, name, moref) => ({ id, name, objectId: moref, platformName: 'VMware' });
const vbrBase = (objs) => ({ ...TOKEN,
  'GET /api/v1/jobs': { json: { data: [{ id: 'job-1', name: JOBNAME }] } },
  'GET /api/v1/jobs/job-1': { json: { id: 'job-1', name: JOBNAME, description: 'x [vmware-portal:managed] y', virtualMachines: { includes: [INC('APP01', 'vm-77'), INC('b', 'vm-2')] } } },
  'PUT /api/v1/jobs/job-1': { json: {} },
  'GET /api/v1/backups': { json: { data: [{ id: 'bk-1', jobId: 'job-1' }] } },
  'GET /api/v1/backups/bk-1/objects': { json: { data: objs } },
  'GET /api/v1/backupObjects/obj-77/restorePoints': { json: { data: [{ id: 'p1', backupId: 'bk-1' }] } },
  'DELETE /api/v1/backupObjects/obj-77': { status: 202, json: {} } });

test('V1 백업 뒤에 VM 이름이 바뀌었으면 ‘지울 것이 없습니다’(성공)로 답하지 않는다 — 같은 moref 의 다른 이름 개체가 있다고 말하고 지우지 않는다', async () => {
  const manage = await import('../src/veeam/run/manage.js');
  // 백업 개체 이름은 옛 이름(APP01) · 지금 인벤토리 이름은 APP01-OLD · moref 는 같다
  const f = fakeVbr(vbrBase([OBJ('obj-77', 'APP01', 'vm-77'), OBJ('obj-2', 'b', 'vm-2')]));
  const r = await manage.opDeleteBackup(SRV, { jobName: JOBNAME, vm: { name: 'APP01-OLD', objectId: 'vm-77', hostName: 'oc2-vc.corp.local' }, fetchImpl: f });
  assert.equal(r.ok, false, '수정 전: ok true + ‘지울 것이 없습니다’');
  assert.equal(r.notSent, true);
  assert.equal(r.excluded, true, '잡에서 뺀 사실은 그대로 돌려준다(기록 · 감사)');
  assert.equal(r.deleted, 0);
  assert.match(r.reason, /moref 가 같은 백업 개체가 다른 이름\(‘APP01’\)/);
  assert.ok(!f.writes().some((k) => k.startsWith('DELETE')), '이름으로 고르지 않는 규칙은 그대로 — 지우지 않는다');
  // 이름도 moref 도 다른 개체뿐이면 예전처럼 ‘지울 것이 없습니다’(성공)
  const none = fakeVbr(vbrBase([OBJ('obj-2', 'b', 'vm-2'), OBJ('obj-9', 'APP01-OLD', 'vm-99')]));
  const r0 = await manage.opDeleteBackup(SRV, { jobName: JOBNAME, vm: { name: 'APP01-OLD', objectId: 'vm-77', hostName: 'oc2-vc.corp.local' }, fetchImpl: none });
  assert.equal(r0.ok, true); assert.equal(r0.deleted, 0);
  // 이름과 moref 가 같으면 예전처럼 그 개체만 지운다
  const ok = fakeVbr(vbrBase([OBJ('obj-77', 'APP01', 'vm-77'), OBJ('obj-2', 'b', 'vm-2')]));
  const r1 = await manage.opDeleteBackup(SRV, { jobName: JOBNAME, vm: { name: 'APP01', objectId: 'vm-77', hostName: 'oc2-vc.corp.local' }, fetchImpl: ok });
  assert.equal(r1.ok, true, r1.reason); assert.equal(r1.deleted, 1);
  assert.deepEqual(ok.writes(), ['PUT /api/v1/jobs/job-1', 'DELETE /api/v1/backupObjects/obj-77']);
});

/* ───────────────────────── I1 IP 스캔 기준선 — 에이전트 이름 ‘__PROTO__’ ───────────────────────── */

test('I1 에이전트 이름이 ‘__PROTO__’(대소문자 섞임)여도 완료 보고가 Object.prototype 에 대역 줄을 써 넣지 않는다', async () => {
  const S = await import('../src/ipam/scanStore.js');
  const RANGES = ['10.160.7.0/24', '10.160.8.1-10.160.8.9'];
  try {
    for (const name of ['__PROTO__', '__Proto__']) {
      S.saveScanSettings(name, { enabled: true, ranges: RANGES });
      const r = S.recordAgentReport(name, { scanned: 254, alive: 3 });
      assert.equal(r.ok, true, name);
      assert.equal(({})[RANGES[0]], undefined, `${name}: 빈 객체가 대역 줄을 물려받지 않는다 — 수정 전: 완료 시각(수)`);
      assert.deepEqual(Object.keys(Object.prototype), [], `${name}: Object.prototype 에 열거 속성이 생기지 않는다`);
      const leak = []; for (const k in {}) leak.push(k);   // eslint-disable-line guard-for-in
      assert.deepEqual(leak, []);
      // 기준선은 그 에이전트의 자기 속성으로 남는다(다음 완료 보고는 같은 줄을 다시 표시하지 않는다)
      assert.deepEqual(Object.keys(S.changeBaselineOf(name)).sort(), [...RANGES].sort(), name);
    }
  } finally { for (const k of Object.keys(Object.prototype)) delete Object.prototype[k]; }   // 수정 전 판본이 남긴 오염을 다른 시험에 넘기지 않는다
  // 보통 이름 — 예전과 같다(첫 완료 보고가 줄을 표시하고, 다시 보고해도 같은 시각)
  S.saveScanSettings('edge-160', { enabled: true, ranges: ['10.160.9.0/24'] });
  S.recordAgentReport('edge-160', { scanned: 254, alive: 1 });
  const first = S.changeBaselineOf('edge-160');
  assert.deepEqual(Object.keys(first), ['10.160.9.0/24']);
  S.recordAgentReport('Edge-160', { scanned: 254, alive: 1 });
  assert.deepEqual(S.changeBaselineOf('EDGE-160'), first, '이름은 대소문자 무시 · 이미 표시한 줄은 그대로');
  assert.deepEqual(S.changeBaselineOf('nobody'), {});
  assert.deepEqual(S.changeBaselineOf('constructor'), {}, '상속 값을 표시로 읽지 않는다');
});

/* ───────────────────────── R1 155 F1ⓒ 반증 — 지운 학습 계정 ‘__proto__’ ───────────────────────── */

test('R1 학습 계정 ‘__proto__’ 를 지우면 다른 계정처럼 지운 표시가 남아 다시 배우지 않는다(파일에도 남고 다시 읽어도 같다)', async () => {
  const SE = await import('../src/veeam/snapEvents.js');
  SE._resetForTest();
  const FILE = path.join(DIR, 'veeam-vc-accounts.json');
  try { fs.rmSync(FILE, { force: true }); } catch { /* 없음 */ }
  for (const name of ['__proto__', 'constructor', 'svc-veeam']) {
    assert.equal(SE.rememberLearned([{ account: name, vm: 'vm-a' }, { account: name, vm: 'vm-b' }], NOW), 2, name);
  }
  assert.equal(SE.forgetLearned(['__proto__', 'constructor', 'svc-veeam'], NOW + 1000), 3);
  const saved = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  for (const name of ['__proto__', 'constructor', 'svc-veeam']) assert.equal(Object.hasOwn(saved.forgotten, name) ? saved.forgotten[name] : null, NOW + 1000, `${name}: 지운 표시가 파일에 있다 — 수정 전: ‘__proto__’ 만 없음`);
  for (const name of ['__proto__', 'constructor', 'svc-veeam']) {
    assert.equal(SE.rememberLearned([{ account: name, vm: 'vm-a' }], NOW + 2000), 0, `${name}: 지운 계정은 다시 배우지 않는다 — 수정 전: ‘__proto__’ 는 1`);
  }
  assert.deepEqual(SE.accountView(NOW + 2000).learned, []);
  // 파일에서 다시 읽어도 같은 판정(읽을 때도 자기 속성)
  SE._resetForTest();
  assert.equal(SE.rememberLearned([{ account: '__proto__', vm: 'vm-c' }], NOW + 3000), 0, '다시 읽은 뒤에도 지운 표시가 살아 있다');
  assert.equal(SE.rememberLearned([{ account: 'other', vm: 'vm-c' }], NOW + 3000), 1, '다른 계정은 배운다');
  SE._resetForTest();
});

/* ───────────────────────── R2 155 F2 반증 — 저장되는 꼴의 길이 ───────────────────────── */

test('R2 iDRAC 등록 — 등록된 서버는 언제나 다시 고칠 수 있다(스킴을 붙인 저장값도 2,048자 안)', async () => {
  const R = await import('../src/idrac/registry.js');
  const base = { name: 'x', username: 'root', password: 'p' };
  const hostOf = (n) => `${'a'.repeat(n - 8)}.example`;   // 스킴 없는 n자 host
  // 스킴 없는 2,048자 — 수정 전: 등록되고(저장 2,056자) 그 뒤 수정이 전부 ‘너무 깁니다’
  const over = R.addServer({ ...base, id: 'r2-over', host: hostOf(2048) });
  assert.equal(over.ok, false, '저장되는 꼴이 상한을 넘으면 등록하지 않는다');
  assert.match(over.reason, /너무 깁니다/);
  assert.equal(R.idracInputIssue({ ...base, id: 'r2-over', host: hostOf(2041) }).host, '', '2,041자도 스킴을 붙이면 2,049자');
  // 스킴 없는 2,040자(저장 2,048자) · 스킴 있는 2,048자 — 등록되고, 그 뒤 이름 · 사용 여부 수정이 된다
  for (const [id, host] of [['r2-a', hostOf(2040)], ['r2-b', `https://${hostOf(2040)}`]]) {
    const add = R.addServer({ ...base, id, host });
    assert.equal(add.ok, true, `${id}: ${add.reason || ''}`);
    const stored = R.loadRegistry().find((s) => s.id === id).host;
    assert.equal(stored.length, 2048, id);
    const up = R.updateServer(id, { enabled: false });
    assert.equal(up.ok, true, `${id}: 등록된 서버는 고칠 수 있다 — ${up.reason || ''}`);
    assert.equal(R.updateServer(id, { name: 'renamed' }).ok, true, id);
    const merged = R.importServers([{ id, name: 'via-import' }], 'merge');
    assert.deepEqual(merged.skipped, [], `${id}: 병합 가져오기도 저장값을 다시 읽는다`);
    assert.equal(R.removeServer(id).ok, true);
  }
});

/* ───────────────────────── E1 MIG 미디어 확장 프로파일(…cme) ───────────────────────── */

test('E1 vGPU 프로파일 …-1-5cme(MIG 미디어 확장)를 읽는다 — 서버와 웹 미러가 같은 값', async () => {
  const P = await import('../src/gpu/vgpuProfile.js');
  const W = await import('../../web/src/views/tools/gpuAllocText.js');
  for (const [p, gb] of [['grid_a100-1-5cme', 5], ['GRID_A100X-1-5CME', 5], ['nvidia_h100-1-10cme', 10], ['  grid_a30-1-6cme  ', 6]]) {
    assert.equal(P.vgpuProfileGB(p), gb, `${p}: 수정 전 null(프로파일 해석 불가)`);
    assert.equal(P.vgpuProfileIsMig(p), true, `${p}: MIG 꼴`);
    assert.equal(P.vmVgpuAllocGB({ vgpu: 2, profile: p }), gb * 2);
  }
  // 예전 판정은 그대로 · 4자 넘는 꼬리는 여전히 읽지 않는다
  const same = ['grid_a100-10c', 'nvidia_l40s-48q', 'grid_m60-0b', 'grid_m10-2b4', 'grid_a100-4-20c', 'grid_a100-1-5cme', 'nvidia_h100-1-10cme', 'weird', '', null, 'grid_a100-10cmex', 'grid_a100-1-5cmex', 'synthetic_x-1-2b4'];
  assert.equal(P.vgpuProfileGB('grid_a100-10cmex'), null);
  assert.equal(P.vgpuProfileIsMig('grid_a100-1-5cmex'), false);
  assert.equal(P.vgpuProfileGB('grid_m10-2b4'), 2); assert.equal(P.vgpuProfileGB('grid_m60-0b'), 0.5); assert.equal(P.vgpuProfileIsMig('grid_a100-10c'), false);
  for (const p of same) {
    assert.equal(W.profileGB(p), P.vgpuProfileGB(p), `웹 profileGB: ${p}`);
    assert.equal(W.profileIsMig(p), P.vgpuProfileIsMig(p), `웹 profileIsMig: ${p}`);
  }
  assert.deepEqual(W.profileFamily('grid_a100-1-5cme'), { family: 'a100', mig: true }, '배치 추천의 계열 판정도 같은 이름을 읽는다');
});

/* ───────────────────────── E2 Bareos 사전 점검 리소스 줄 ───────────────────────── */

test('E2 사전 점검의 리소스 종류 칸이 ‘constructor’ · ‘toString’ 이어도 해석이 던지지 않고 아는 종류만 모은다', async () => {
  const { parsePreflight } = await import('../src/bareos/autoSetup.js');
  const out = ['@@res', 'client bareos-fd', 'constructor x', 'toString y', 'valueOf z', '__proto__ w', 'hasOwnProperty v', 'storage File', 'pool Full', 'schedule Weekly', 'client second-fd', '@@end'].join('\n');
  let r;
  assert.doesNotThrow(() => { r = parsePreflight(out); }, '수정 전: resources[t].push is not a function');
  assert.deepEqual(r.resources, { client: ['bareos-fd', 'second-fd'], storage: ['File'], pool: ['Full'], schedule: ['Weekly'] });
  assert.match(r.items.find((i) => i.key === 'resources').detail, /client bareos-fd,second-fd/);
});
