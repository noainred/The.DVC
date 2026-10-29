/**
 * v2.771 6회차 점검 G6(엣지 수집 서버 등록부·export) 회귀 테스트.
 *
 * F4-1: 엣지 export `power.byHost` 에 개수 상한이 없어 중앙 pull 한 번이 원소별 setRemoteHost·db.latest + insertMany 한 트랜잭션으로
 *   이벤트 루프를 수 초 동기 정지시켰다(10만 건 약 1초 · 100만 건 8초 재현). sanitizeEdgeExport 가 REMOTE_BYHOST_MAX 로 자르고
 *   뺀 수를 byHostDropped 로 밝힌다(serversDropped 규약).
 * F4-2: collectors.json 손상 시 표지 없이 빈 목록 → 엣지 자기등록이 빈 목록 위에 저장해 관리자 등록이 보존본에만 남은 채 굳었다.
 *   clearStaleRemote 가 빈 집합으로 전 원격 전력을 지웠고, /link-check-config 는 빈 목록으로 링크를 내렸다. agentTokens 는 손상 시
 *   cache=[] 를 '발급 없음' 과 구분할 수 없게 고정했다.
 *
 * ⚠ 한 파일이 CONFIG_DIR 하나를 공유한다(모듈이 import 시점에 경로를 굳힌다) — 테스트 순서가 곧 시나리오다.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { stripComments } from './_stripComments.js';

const CFG = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2771f-'));
process.env.CONFIG_DIR = CFG;
process.env.CENTRAL_TOKEN = 'shared-token-for-2771f-test-1234567890';
process.env.SSRF_ALLOW_LOOPBACK = 'true';
process.env.COLLECTOR_REMOTE_BYHOST_MAX = '150'; // 상한을 작게 — 동작은 같고 테스트가 빠르다(최소 100)
process.env.CENTRAL_VERIFY_SELF_REGISTER = 'false'; // 자기등록 검증 ping 은 이 테스트의 관심사가 아니다

const COL = path.join(CFG, 'collectors.json');
const TOK = path.join(CFG, 'central-agent-tokens.json');
const corruptOf = (file) => fs.readdirSync(CFG).filter((n) => n.startsWith(path.basename(file) + '.corrupt.'));
const rmCorrupt = (file) => { for (const n of corruptOf(file)) fs.rmSync(path.join(CFG, n), { force: true }); };

let reg; let ri; let puller; let state; let tokens; let server; let base; let edge; let edgeUrl; let edgeBody = '{}';
let agentTokA = '';
const edgeHits = [];

before(async () => {
  reg = await import('../src/collector/registry.js');
  ri = await import('../src/collector/remoteInventory.js');
  puller = await import('../src/collector/puller.js');
  state = await import('../src/collector/state.js');
  tokens = await import('../src/central/agentTokens.js');
  const express = (await import('express')).default;
  const { centralRouter } = await import('../src/routes/central.js');
  const app = express();
  app.use(express.json());
  app.use('/api/central', centralRouter);
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api/central`;
  edge = http.createServer((q, r) => { edgeHits.push(q.url); r.setHeader('content-type', 'application/json'); r.end(edgeBody); });
  await new Promise((r) => edge.listen(0, '127.0.0.1', r));
  edgeUrl = `http://127.0.0.1:${edge.address().port}`;
});
after(() => {
  try { server?.close(); } catch { /* */ }
  try { edge?.close(); } catch { /* */ }
  try { fs.rmSync(CFG, { recursive: true, force: true }); } catch { /* */ }
});

const req = (p, { token, method = 'GET', body } = {}) => fetch(`${base}${p}`, {
  method,
  headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Central-Token': token } : {}) },
  ...(body ? { body: JSON.stringify(body) } : {}),
});

// ───────────────────────────── F4-1 ─────────────────────────────

test('F4-1: sanitizeEdgeExport 는 power.byHost 를 REMOTE_BYHOST_MAX 로 자르고 버린 수를 byHostDropped 로 센다', () => {
  const MAX = ri.REMOTE_BYHOST_MAX;
  assert.equal(MAX, 150, 'env 로 준 상한');
  const byHost = [null, 'x', [1], ...Array.from({ length: MAX + 40 }, (_, i) => ({ host: `h${i}`, watts: 100 }))];
  const d = ri.sanitizeEdgeExport({ power: { byHost } });
  assert.equal(d.power.byHost.length, MAX);
  assert.deepEqual(d.byHostDropped, { notObject: 3, overCount: 40 });
  // 상한 안·형식 정상이면 0 · byHost 배열이 없으면 null(구버전·전력 없는 엣지 — 0 으로 지어내지 않는다)
  assert.deepEqual(ri.sanitizeEdgeExport({ power: { byHost: [{ host: 'a', watts: 1 }] } }).byHostDropped, { notObject: 0, overCount: 0 });
  assert.equal(ri.sanitizeEdgeExport({}).byHostDropped, null);
  // 기본 상한은 servers 상한과 같은 규모다(엣지는 서버 1대당 한 행)
  assert.ok(ri.REMOTE_BYHOST_MAX >= 100);
});

test('F4-1: pull 한 번이 상한 안에서만 적재한다(insertMany 표본 수 ≤ 상한) + 상태에 byHostDropped', async () => {
  const MAX = ri.REMOTE_BYHOST_MAX;
  const N = MAX * 20; // 3,000 — 상한이 없으면 전량이 insertMany 로 간다
  edgeBody = JSON.stringify({ version: '2.771.0', agent: 'edge-x', datacenter: 'dc', servers: [], power: { byHost: Array.from({ length: N }, (_, i) => ({ host: `h${i}`, watts: 100 })) } });
  fs.writeFileSync(COL, JSON.stringify({ collectors: [{ id: 'edge-x', name: 'edge-x', url: edgeUrl, token: 't', enabled: true }] }));
  const idb = await (await import('../src/idrac/db.js')).getDb();
  const seen = [];
  const orig = idb.insertMany;
  idb.insertMany = (s) => { seen.push(s.length); return orig.call(idb, s); };
  try {
    const ok = await puller.pullCollectorByAgent('edge-x');
    assert.ok(ok, 'pull 성공');
  } finally { idb.insertMany = orig; }
  assert.equal(seen.length, 1);
  assert.ok(seen[0] <= MAX, `insertMany 표본 ${seen[0]} ≤ 상한 ${MAX}`);
  const mine = state.remotePowerEntries().filter((v) => v.collectorId === 'edge-x');
  assert.ok(mine.length <= MAX, `원격 전력 호스트 ${mine.length} ≤ ${MAX}`);
  const st = state.getCollectorStatus('edge-x');
  assert.deepEqual(st.byHostDropped, { notObject: 0, overCount: N - MAX });
  // 정상 규모면 표지가 없다(null — 0 을 실어 화면이 카드를 띄우지 않게)
  assert.equal(puller.statusFromPull({ hosts: 1 }).byHostDropped, null);
});

// ───────────────────────────── F4-2 ─────────────────────────────

test('F4-2: 첫 설치(파일·보존본 모두 없음)는 오류가 아니고 엣지 자기등록이 막히지 않는다', () => {
  fs.rmSync(COL, { force: true }); rmCorrupt(COL);
  assert.equal(reg.registryLoadError(), null);
  const r = reg.upsertCollectorFromAgent({ name: 'first-edge', url: 'https://10.0.0.9:4443', token: 'tokF' });
  assert.equal(r.ok, true, r.reason);
  assert.deepEqual(reg.loadCollectors().map((c) => c.id), ['first-edge']);
});

const GOOD = { collectors: [
  { id: 'edge-a', name: 'A(관리자 등록)', url: 'https://10.0.0.5:4443', token: 'tokA', enabled: true, managed: true, vcenterId: 'vc-a' },
  { id: 'edge-b', name: 'edge-b', url: 'https://10.0.0.6:4443', token: 'tokB', enabled: true },
] };

test('F4-2: collectors.json 손상 → 표지가 서고 엣지 자기등록은 저장하지 않는다(관리자 등록이 보존본에만 남은 채 굳지 않게)', () => {
  rmCorrupt(COL);
  fs.writeFileSync(COL, JSON.stringify(GOOD).slice(0, 60)); // 원자 쓰기 밖의 손상(디스크·수동 편집·복원 실수)
  assert.deepEqual(reg.listCollectors(), []);
  const err = reg.registryLoadError();
  assert.ok(err && err.reason, '읽지 못함 표지');
  const sum = reg.registryLoadErrorSummary();
  assert.equal(sum.code, 'parse-error');
  assert.ok(!String(sum.text).includes('tokA') && !String(sum.text).includes('10.0.0.5'), '요약에 파일 조각(토큰·주소)이 실리지 않는다');
  assert.equal(corruptOf(COL).length, 1, '손상본 보존');

  const r = reg.upsertCollectorFromAgent({ name: 'edge-b', url: 'https://10.0.0.6:4443', token: 'tokB', datacenter: 'B' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'registry-unreadable');
  assert.ok(!fs.existsSync(COL), '빈 목록 위에 새 파일을 쓰지 않는다');
  // 관리자 화면이 아닌 추가(배포 후 자동 등록·데모 시드)도 같은 판단
  const a = reg.addCollector({ id: 'auto-1', name: 'auto-1', url: 'https://10.0.0.7:4443', token: 'x' });
  assert.equal(a.ok, false);
  assert.equal(a.code, 'registry-unreadable');
  assert.ok(!fs.existsSync(COL));
  // 표지는 남아 있다(자동 경로가 지우지 않는다)
  assert.ok(reg.registryLoadError());
});

test('F4-2: 재시작 뒤(파일 없음 + 보존본만)도 읽지 못함이고 자기등록이 막힌다', async () => {
  const fresh = await import('../src/collector/registry.js?restart=1'); // 새 모듈 인스턴스 = 메모리 표지 없음(재시작)
  assert.ok(!fs.existsSync(COL));
  const e = fresh.registryLoadError();
  assert.ok(e, '보존본만 남은 상태는 못 읽음');
  assert.equal(fresh.registryLoadErrorSummary().code, 'corrupt-only');
  const r = fresh.upsertCollectorFromAgent({ name: 'edge-b', url: 'https://10.0.0.6:4443', token: 'tokB' });
  assert.equal(r.code, 'registry-unreadable');
  assert.ok(!fs.existsSync(COL));
});

test('F4-2: 표지가 선 동안 puller 는 clearStaleRemote 를 건너뛴다(전 원격 전력을 지우지 않는다)', async () => {
  state.setRemoteHost('keep-host', { watts: 123, ts: Date.now(), collectorId: 'edge-a', source: 'remote' });
  assert.ok(reg.registryLoadError());
  await puller.pullNow();
  assert.ok(state.remotePowerEntries().some((v) => v.host === 'keep-host'), '등록부를 못 읽은 동안 원격 전력이 남아 있다');
  assert.ok(puller.pullerStatus().registryUnreadableAt, '건너뛴 사실이 상태에 남는다');
});

test('F4-2: 표지가 선 동안 /link-check-config 와 /register-collector 는 503 registryUnreadable', async () => {
  agentTokA = tokens.issueAgentToken('edge-a').token;
  const lc = await req('/link-check-config', { token: agentTokA });
  assert.equal(lc.status, 503);
  const lj = await lc.json();
  assert.equal(lj.reason, 'registryUnreadable');
  assert.ok(!String(lj.detail).includes('tokA'));
  // 검증 ping(엣지로 나가는 요청)보다 먼저 거절한다 — 손상된 동안 엣지가 60초마다 재시도해도 중앙이 엣지를 두드리지 않는다.
  process.env.CENTRAL_VERIFY_SELF_REGISTER = 'true';
  edgeHits.length = 0;
  let rg;
  try {
    rg = await req('/register-collector', { token: agentTokA, method: 'POST', body: { name: 'edge-a', urlHint: edgeUrl, collectorToken: 'tokA2' } });
  } finally { process.env.CENTRAL_VERIFY_SELF_REGISTER = 'false'; }
  assert.equal(rg.status, 503);
  assert.equal((await rg.json()).reason, 'registryUnreadable');
  assert.deepEqual(edgeHits, [], '검증 ping 이 나가지 않았다');
  assert.ok(!fs.existsSync(COL), '자기등록이 파일을 만들지 않았다');
});

test('F4-2: 관리자 등록(managed)만 표지를 지우고, 그 뒤 자기등록·링크 설정이 정상으로 돌아온다', async () => {
  const r = reg.addCollector({ id: 'edge-a', name: 'A', url: 'https://10.0.0.5:4443', token: 'tokA' }, { managed: true });
  assert.equal(r.ok, true, r.reason);
  assert.equal(reg.registryLoadError(), null);
  const u = reg.upsertCollectorFromAgent({ name: 'edge-b', url: 'https://10.0.0.6:4443', token: 'tokB' });
  assert.equal(u.ok, true, u.reason);
  const lc = await req('/link-check-config', { token: agentTokA });
  assert.equal(lc.status, 200);
});

test('F4-2: 정상 파일로 되돌리면(보존본 복원) 표지가 풀린다 — 캐시 없는 등록부라 다음 읽기에 바로', () => {
  fs.writeFileSync(COL, '{"collectors": [');
  reg.loadCollectors();
  assert.ok(reg.registryLoadError());
  fs.writeFileSync(COL, JSON.stringify(GOOD));
  assert.equal(reg.registryLoadError(), null);
  assert.deepEqual(reg.loadCollectors().map((c) => c.id), ['edge-a', 'edge-b']);
});

test('F4-2: 표지가 선 뒤 파일·보존본을 모두 치우면(첫 설치와 같은 상태) 표지가 풀리고 자기등록이 다시 된다', () => {
  fs.writeFileSync(COL, '{"collectors": [');
  assert.ok(reg.registryLoadError());
  fs.rmSync(COL, { force: true }); rmCorrupt(COL);
  assert.equal(reg.registryLoadError(), null);
  const r = reg.upsertCollectorFromAgent({ name: 'edge-c', url: 'https://10.0.0.8:4443', token: 'tokC' });
  assert.equal(r.ok, true, r.reason);
});

test('F4-2: markSelfRegVerification 도 저장 전에 자동 저장 거절을 본다(소스 고정)', () => {
  const src = stripComments(fs.readFileSync(new URL('../src/collector/registry.js', import.meta.url), 'utf8'));
  const body = src.slice(src.indexOf('function markSelfRegVerification('));
  const fn = body.slice(0, body.indexOf('\n}') + 2);
  assert.ok(fn.indexOf('collectorsAutoWriteRefusal()') !== -1, 'markSelfRegVerification 에 거절 판정');
  assert.ok(fn.indexOf('collectorsAutoWriteRefusal()') < fn.indexOf('loadCollectors()'), '읽기·저장 전에 본다');
  const up = src.slice(src.indexOf('export function upsertCollectorFromAgent('));
  const upFn = up.slice(0, up.indexOf('\n}') + 2);
  assert.ok(upFn.indexOf('collectorsAutoWriteRefusal()') < upFn.indexOf('updateCollector('), 'upsert 는 내부 updateCollector 전에 거절');
});

// ─────────────────────────── F4-2 agentTokens ───────────────────────────

test('F4-2: 토큰 파일 손상 → loadError 표지 · 관리 화면 수치는 null(0 = 발급 없음 으로 보이지 않게) · 개별 토큰 요청은 503', async () => {
  fs.writeFileSync(TOK, '{"tokens": [{"agent": "edge-a", "hash": "ab');
  tokens._resetAgentTokenCache();
  const e = tokens.agentTokensLoadError();
  assert.ok(e, '읽지 못함 표지');
  assert.equal(e.code, 'parse-error');
  assert.deepEqual(tokens.listAgentTokens(), []);
  assert.equal(corruptOf(TOK).length, 1, '손상본 보존');
  const { getCentralAuthStats } = await import('../src/routes/central.js');
  const st = getCentralAuthStats();
  assert.equal(st.agentTokens, null);
  assert.ok(st.agentTokensUnreadable);
  // 개별 토큰 엣지(지금은 해석 불가)의 요청은 403 '토큰 불일치' 가 아니라 503 registryUnreadable
  const r = await req('/idrac-scan-jobs?busy=1', { token: agentTokA });
  assert.equal(r.status, 503);
  assert.equal((await r.json()).reason, 'registryUnreadable');
  // 공유 토큰 엣지는 영향이 없다(허용 범위를 바꾸지 않는다)
  const s = await req('/idrac-scan-jobs?busy=1&agent=edge-z', { token: process.env.CENTRAL_TOKEN });
  assert.equal(s.status, 200);
});

test('F4-2: 토큰 보존본을 되돌리면 재시작 없이 다시 읽는다(빈 목록을 프로세스 수명 동안 고정하지 않는다)', () => {
  // 손상본 대신 정상 파일을 되돌린 상황 — 발급 1건
  fs.writeFileSync(TOK, JSON.stringify({ tokens: [{ agent: 'edge-r', hash: 'a'.repeat(64), createdAt: 1 }] }));
  assert.equal(tokens.agentTokensLoadError(), null);
  assert.deepEqual(tokens.listAgentTokens().map((t) => t.agent), ['edge-r']);
});

test('F4-2: 토큰 파일 없음 + 보존본만(재시작 뒤) → 표지 · 관리자 발급이 표지를 지운다', async () => {
  fs.rmSync(TOK, { force: true });
  const fresh = await import('../src/central/agentTokens.js?restart=1');
  assert.equal(fresh.agentTokensLoadError()?.code, 'corrupt-only');
  const r = fresh.issueAgentToken('edge-n');
  assert.equal(r.ok, true);
  assert.equal(fresh.agentTokensLoadError(), null);
  assert.deepEqual(fresh.listAgentTokens().map((t) => t.agent), ['edge-n']);
  // 첫 설치(파일·보존본 모두 없음)는 오류가 아니다
  fs.rmSync(TOK, { force: true }); rmCorrupt(TOK);
  const fresh2 = await import('../src/central/agentTokens.js?restart=2');
  assert.equal(fresh2.agentTokensLoadError(), null);
  assert.deepEqual(fresh2.listAgentTokens(), []);
});
