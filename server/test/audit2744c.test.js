/**
 * v2.744 감사 그룹 c — 중앙 puller 의 엣지 export 지속형 503 재시도(EDGE-02 = RECENT-03) · 503 본문의 엣지 정체(EDGE-04).
 *
 * EDGE-02 v2.743 엣지는 iDRAC 등록부를 읽지 못하면 export 를 503 registryUnreadable(Retry-After 60 — 지속형)으로 답한다. 그런데 중앙
 *   pullOne 은 resilientFetch(retries 2)를 써서 그 503 을 Retry-After(30초 상한 × 1~1.5)만큼 두 번 기다렸다 — 첫 실패 pull 이 약 75초(재현
 *   r3·a3), 위임 스캔 직후 즉시 당김(pullCollectorByAgent)은 pullOptionsFor 를 쓰지 않아 호출마다 같은 대기였다. 그리고 주기 경고는
 *   '응답하지 않은 엣지 — 주소·방화벽 확인' 이라는 틀린 원인을 말했다(엣지는 수 ms 만에 이유를 밝혀 거절했다).
 *   고친 뒤: 503 은 호출 안에서 다시 묻지 않는다(첫 시도 1회 · 수 초 안) · 그 밖의 재시도 대상(502 등)은 예전처럼 재시도 · 즉시 당김도
 *   pullOptionsFor(fails) · 경고는 거절을 응답 없음과 나눠 센다.
 * EDGE-04 503 본문에 version·agent·hostname 이 없어, 중앙 재시작 뒤 처음부터 503 이면 수집 서버 상태의 버전이 비었다('버전 미상' —
 *   iLO 전용 스캔 보류·파트 장애/CVP 버전 판정). 이제 엣지가 그 셋을 싣고 중앙 실패 분기가 그 값만 반영한다(서버·전력은 직전 그대로).
 * 실제 엣지 라우터(collectorRouter)·실제 puller·실제 수집 서버 등록부를 부른다.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 임시 폴더 기준: 환경변수(리드가 지정) → 없으면 OS 임시 폴더. 저장소 안에 만들지 않는다.
const TMP_ROOT = process.env.AUDIT2744C_TMP && fs.existsSync(process.env.AUDIT2744C_TMP) ? process.env.AUDIT2744C_TMP : os.tmpdir();
const CFG = fs.mkdtempSync(path.join(TMP_ROOT, 'dvc-2744c-'));
Object.assign(process.env, {
  CONFIG_DIR: CFG, COLLECTOR_TOKEN: 'col-2744c', AGENT_NAME: 'edge-gc-a',
  DATA_SOURCE: 'live', AUTH_ENABLED: 'true', IPAM_WRITE_WORKER: '0', SSRF_ALLOW_LOOPBACK: 'true',
});
fs.writeFileSync(path.join(CFG, 'vcenters.json'), JSON.stringify({ vcenters: [] }));
// 엣지 iDRAC 등록부를 처음부터 손상시켜 둔다 — export 는 503 registryUnreadable(v2.743 EDGE-01).
fs.writeFileSync(path.join(CFG, 'idrac.json'), '{ broken');

const express = (await import('express')).default;
const { collectorRouter } = await import('../src/routes/collector.js');
const { config, currentVersion } = await import('../src/config.js');
const puller = await import('../src/collector/puller.js');
const st = await import('../src/collector/state.js');
const inv = await import('../src/collector/remoteInventory.js');
const { addCollector, updateCollector } = await import('../src/collector/registry.js');

// 엣지(실제 collectorRouter) — export 요청 수를 센다. 응답을 20ms 늦춰 주기 소요가 0ms 로 떨어지지 않게 한다(경고 문구 확인용).
let exportHits = 0;
const edge = express();
edge.use('/api/collector', (req, _res, next) => { if (req.path === '/export') exportHits++; setTimeout(next, 20); }, collectorRouter);
const srvEdge = await new Promise((r) => { const s = edge.listen(0, '127.0.0.1', () => r(s)); });
const EDGE = `http://127.0.0.1:${srvEdge.address().port}`;

// 일시 오류 엣지(502) — 503 이 아닌 재시도 대상은 예전처럼 호출 안에서 재시도하는지 본다.
let hits502 = 0;
const flaky = express();
flaky.get('/api/collector/export', (_req, res) => { hits502++; res.status(502).json({ error: 'bad gateway' }); });
const srv502 = await new Promise((r) => { const s = flaky.listen(0, '127.0.0.1', () => r(s)); });
const FLAKY = `http://127.0.0.1:${srv502.address().port}`;

test.after(() => {
  srvEdge.close(); srv502.close();
  try { fs.rmSync(CFG, { recursive: true, force: true }); } catch { /* 정리는 best-effort */ }
});

/** console.warn 을 잠깐 모은다(pull 경고 문구 확인). */
async function captureWarn(fn) {
  const lines = []; const orig = console.warn;
  console.warn = (...a) => { lines.push(a.map(String).join(' ')); };
  try { return { value: await fn(), lines }; } finally { console.warn = orig; }
}
const statusOf = (id) => st.allCollectorStatus()[id] || null;

// ─── EDGE-04 ① 엣지 503 본문 ─────────────────────────────────────────────────

test('EDGE-04 ① 엣지 export 503 registryUnreadable 본문에 version·agent·hostname(기존 export 와 같은 값 · 비밀 없음)', async () => {
  const r = await fetch(`${EDGE}/api/collector/export`, { headers: { 'X-Collector-Token': 'col-2744c', Accept: 'application/json' } });
  assert.equal(r.status, 503);
  const b = await r.json();
  assert.equal(b.reason, 'registryUnreadable');
  assert.equal(b.version, currentVersion(), `수정 전: version 없음 — ${JSON.stringify(b)}`);
  assert.equal(b.agent, 'edge-gc-a');
  assert.equal(b.hostname, os.hostname());
  assert.ok(!('servers' in b) && !('power' in b), '빈 목록·전력 0 은 여전히 싣지 않는다');
  assert.ok(!JSON.stringify(b).includes('col-2744c'), '토큰을 싣지 않는다');
});

test('EDGE-04 ② exportFailError — 거절 본문의 정체를 성공 경로와 같은 정제로 읽는다(모양이 틀린 값은 버린다)', async () => {
  const mk = (body) => new Response(JSON.stringify(body), { status: 503, headers: { 'content-type': 'application/json' } });
  const e1 = await puller.exportFailError(mk({ ok: false, reason: 'registryUnreadable', version: '2.744.0', agent: 'edge-x', hostname: 'h-x' }));
  assert.equal(e1.edgeReason, 'registryUnreadable');
  assert.deepEqual(puller.edgeIdentityPatch(e1), { version: '2.744.0', agent: 'edge-x', hostname: 'h-x' });
  // 모양이 틀린 값(객체·숫자 아닌 것) — 정제가 '' 로 만들고 패치는 그 키를 싣지 않는다(직전 값을 지우지 않는다).
  const e2 = await puller.exportFailError(mk({ ok: false, reason: 'registryUnreadable', version: { toString: 1 }, agent: ['a'], hostname: '' }));
  assert.equal(e2.edgeReason, 'registryUnreadable');
  assert.deepEqual(puller.edgeIdentityPatch(e2), {});
  // 이유를 모르는 503(앞단 프록시 등) — 정체를 읽지 않는다.
  const e3 = await puller.exportFailError(mk({ ok: false, reason: 'whatever', version: '9.9.9' }));
  assert.equal(e3.edgeReason, undefined);
  assert.deepEqual(puller.edgeIdentityPatch(e3), {});
  assert.deepEqual(puller.edgeIdentityPatch(null), {});
});

// ─── EDGE-02 · EDGE-04 ③ 실제 pullNow ────────────────────────────────────────

test('EDGE-02 ③ 엣지 export 503 registryUnreadable — 첫 실패 pull 이 재시도 없이 1회로 수 초 안에 끝나고, 경고는 거절을 응답 없음과 나눠 말한다', { timeout: 120_000 }, async () => {
  puller._resetPullerForTest();
  const add = addCollector({ id: 'edge-gc', name: 'edge-gc', url: EDGE, token: 'col-2744c', enabled: true });
  assert.ok(add?.ok !== false, JSON.stringify(add));
  assert.equal(statusOf('edge-gc'), null, '전제: 이 수집 서버 상태가 비어 있다(중앙 재시작 직후와 같다)');
  const savedInterval = config.collector.pullIntervalMs;
  config.collector.pullIntervalMs = 10; // 주기 경고가 반드시 나오게(주기의 절반 = 5ms < 엣지 응답 지연 20ms)
  exportHits = 0;
  const t0 = Date.now();
  let lines;
  try { ({ lines } = await captureWarn(() => puller.pullNow())); } finally { config.collector.pullIntervalMs = savedInterval; }
  const ms = Date.now() - t0;
  assert.equal(exportHits, 1, `503 은 호출 안에서 다시 묻지 않는다(수정 전: 3회 · Retry-After 대기) — 요청 ${exportHits}회`);
  assert.ok(ms < 8_000, `첫 실패 pull 이 수 초 안에 끝나야 한다(수정 전: 약 75초) — ${ms}ms`);
  const s = statusOf('edge-gc');
  assert.equal(s.ok, false);
  assert.equal(s.edgeReason, 'registryUnreadable');
  assert.ok(!lines.some((l) => /재시도 \d+ \(HTTP 503\)/.test(l)), `503 재시도 로그가 없어야 한다: ${lines.join(' | ')}`);
  const slow = lines.find((l) => l.includes('pull 주기 소요'));
  assert.ok(slow, `주기 경고가 나와야 한다(주기 10ms): ${lines.join(' | ')}`);
  assert.ok(!slow.includes('응답하지 않은'), `거절을 '응답하지 않은 엣지' 로 말하지 않는다: ${slow}`);
  assert.match(slow, /거절/);
  assert.match(slow, /idrac\.json/);
});

test('EDGE-04 ④ 상태가 빈(재시작 직후) 수집 서버가 503 registryUnreadable 을 받으면 version·agent·hostname 이 채워지고 서버·전력은 건드리지 않는다', async () => {
  const s = statusOf('edge-gc');
  assert.equal(s.version, currentVersion(), `수정 전: version 없음('버전 미상') — ${JSON.stringify(s)}`);
  assert.equal(s.agent, 'edge-gc-a');
  assert.equal(s.hostname, os.hostname());
  assert.equal(s.neverOk, true, '한 번도 성공하지 못한 엣지 표지는 그대로');
  assert.equal(s.at, null, "at 은 '마지막 정상 pull' — 실패 시각을 넣지 않는다(v2.601)");
  assert.ok(!('hosts' in s), 'hosts(성공 경로만 채운다)를 지어내지 않는다');
  assert.equal(inv.allRemoteServers().filter((x) => x.collectorId === 'edge-gc').length, 0, '서버 목록을 만들지 않는다');

  // 직전까지 정상이던(성공 기록이 있는) 상태 위에서는 그 값을 덮지 않고 정체만 고친다(v2.548 H5 '직전 위에 덮는다').
  st.setCollectorStatus('edge-gc', { at: 1_700_000_000_000, ok: true, hosts: 3, version: '2.700.0', datacenter: 'DC-GC', agent: 'edge-old', hostname: 'old-host' });
  puller._resetPullerForTest();
  await captureWarn(() => puller.pullNow());
  const s2 = statusOf('edge-gc');
  assert.equal(s2.ok, false);
  assert.equal(s2.edgeReason, 'registryUnreadable');
  assert.equal(s2.version, currentVersion(), '거절 본문의 버전(엣지가 업그레이드됐으면 새 값)');
  assert.equal(s2.agent, 'edge-gc-a');
  assert.equal(s2.hostname, os.hostname());
  assert.equal(s2.hosts, 3, 'hosts 는 직전 값 그대로');
  assert.equal(s2.datacenter, 'DC-GC', 'datacenter 는 직전 값 그대로');
  assert.equal(s2.at, 1_700_000_000_000, "at('마지막 정상 pull')은 직전 값 그대로");
});

test('EDGE-02 ⑤ 즉시 당김(pullCollectorByAgent) — 503 엣지도 수 초 안에 1회로 끝난다(fails 0 이어도)', { timeout: 120_000 }, async () => {
  puller._resetPullerForTest(); // fails 0 — 수정 전에는 언제나 retries 2 였다
  exportHits = 0;
  const t0 = Date.now();
  const { value } = await captureWarn(() => puller.pullCollectorByAgent('edge-gc'));
  const ms = Date.now() - t0;
  assert.equal(value, false);
  assert.equal(exportHits, 1, `즉시 당김도 503 을 다시 묻지 않는다 — 요청 ${exportHits}회`);
  assert.ok(ms < 8_000, `즉시 당김이 Retry-After 를 기다리지 않는다 — ${ms}ms`);
});

test('EDGE-02 ⑥ 503 이 아닌 재시도 대상(502)은 예전처럼 호출 안에서 재시도(재시도 로그 포함) · 즉시 당김은 pullOptionsFor(fails) 를 쓴다', { timeout: 60_000 }, async () => {
  assert.equal(updateCollector('edge-gc', { enabled: false }).ok, true); // 이 단계는 502 엣지만 본다
  const add = addCollector({ id: 'edge-gc-502', name: 'edge-gc-502', url: FLAKY, token: 'col-2744c', enabled: true });
  assert.ok(add?.ok !== false, JSON.stringify(add));
  puller._resetPullerForTest();
  hits502 = 0;
  const { lines } = await captureWarn(() => puller.pullNow());
  assert.equal(hits502, 3, `fails 0 의 502 는 재시도 2회(예전과 같다) — 요청 ${hits502}회`);
  assert.ok(lines.some((l) => /edge-gc-502 재시도 1 \(HTTP 502\)/.test(l)), `재시도 로그(로그 분석 규칙 collector-pull-retry)가 남는다: ${lines.join(' | ')}`);
  const s = statusOf('edge-gc-502');
  assert.equal(s.edgeReason, null, '이유를 밝히지 않은 실패는 edgeReason 없음');

  // 직전 주기 실패(fails 1) — 즉시 당김도 재시도 없이 1회(수정 전: pullOptionsFor 를 쓰지 않아 늘 3회).
  hits502 = 0;
  const { value } = await captureWarn(() => puller.pullCollectorByAgent('edge-gc-502'));
  assert.equal(value, false);
  assert.equal(hits502, 1, `직전 실패 엣지의 즉시 당김은 재시도 없이 1회 — 요청 ${hits502}회`);
});

// ─── EDGE-02 ⑦ 경고 문구(순수) ────────────────────────────────────────────────

test('EDGE-02 ⑦ slowCycleText — 거절(이유를 밝힌 실패)은 응답 없음과 따로 센다 · 예전 인자만 주면 예전 문구', () => {
  const rej = puller.slowCycleText({ took: 76_000, count: 1, concurrency: 4, intervalMs: 60_000, rejectedCount: 1, rejectedMs: 76_000, rejectedBy: { registryUnreadable: 1 } });
  assert.ok(!rej.includes('응답하지 않은'), rej);
  assert.match(rej, /거절/);
  assert.match(rej, /idrac\.json/);
  // 둘 다 있으면 각각 말한다.
  const both = puller.slowCycleText({ took: 40_000, count: 5, concurrency: 4, intervalMs: 60_000, failedCount: 4, failedMs: 160_000, suspectCount: 4, rejectedCount: 1, rejectedMs: 10, rejectedBy: { registryUnreadable: 1 } });
  assert.match(both, /응답하지 않은 엣지 4곳/);
  assert.match(both, /거절/);
  // 예전 호출(거절 인자 없음)은 예전 문구 그대로(audit2620a 와 같은 입력).
  const old = puller.slowCycleText({ took: 40_000, count: 5, concurrency: 4, intervalMs: 60_000, failedCount: 4, failedMs: 160_000, suspectCount: 4 });
  assert.match(old, /응답하지 않은 엣지 4곳/);
  assert.ok(!old.includes('거절'), old);
  for (const t of [rej, both, old]) assert.ok(!t.includes('`') && !t.includes('**'), '문구에 백틱·별표 금지');
});
