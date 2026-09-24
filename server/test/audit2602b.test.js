// v2.602 감사 수정 그룹 b — 가림 성능(RECENT2602-01) · svcmon 범위 계정 변경 차단(AUTHZ-2602-01).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2602b-'));
process.env.CONFIG_DIR = TMP;
process.env.AUTH_ENABLED = 'true';

const {
  scrubHosts, makeScrubber, addressMatcher, hostVariants, maskActivityEvents, maskPollerStatus,
} = await import('../src/auth/addressMask.js');
const { maskPartRow } = await import('../src/routes/api/partFaults.js');
const { maskTargetAddress } = await import('../src/bmusage/targets.js');

/* 수정 전(9c1b4c1) 구현 — 결과 동일성의 기준. 부를 때마다 변형·Set·정렬을 다시 만든다. */
const HIDDEN = '(주소 가림)';
function oldScrub(v, host) { if (!host || typeof v !== 'string' || !v.includes(host)) return v; return v.split(host).join(HIDDEN); }
function oldScrubHosts(v, hosts = []) {
  if (typeof v !== 'string') return v;
  const hs = [...new Set((hosts || []).flatMap(hostVariants))].sort((a, b) => b.length - a.length);
  return hs.reduce((acc, h) => oldScrub(acc, h), v);
}

// 운영 규모 합성: 등록 주소 1,200개(스킴 붙은 iDRAC 형태 + 호스트명 일부)
const HOSTS = [];
for (let i = 0; i < 1200; i++) {
  const a = Math.floor(i / 250); const b = i % 250;
  HOSTS.push(i % 10 === 0 ? `idrac-${a}-${b}.corp.example` : `https://10.${a}.${b}.5`);
}
function partRows(n) {
  const rows = [];
  for (let i = 0; i < n; i++) {
    const h = HOSTS[i % HOSTS.length].replace(/^https:\/\//, '');
    rows.push({
      agent: 'edge-a', scope: 'idrac', deviceId: h, deviceKey: h, deviceName: h,
      partKey: `idrac:${h}:psu:PSU.Slot.1`,
      detail: `connect ECONNREFUSED ${h}:443 (also 10.0.0.50 vs 10.0.0.5)`,
      label: `PSU 1 on ${h}`, rawState: i % 3 ? 'Critical' : `https://${h}/redfish`,
    });
  }
  return rows;
}

test('RECENT2602-01: scrubHosts 결과는 수정 전 구현과 같다(긴 것 먼저 · 스킴 변형 · 겹침)', () => {
  const hosts = [...HOSTS.slice(0, 50), '10.0.0.5', '10.0.0.50', 'https://cs01.corp:443/', 'ab', 'abc'];
  const samples = [
    'connect ECONNREFUSED 10.0.0.50:22 and 10.0.0.5', 'getaddrinfo ENOTFOUND cs01.corp', 'https://cs01.corp:443/api fail',
    'no address here', '', 'abcab x ab', `https://10.0.3.5 down ${HOSTS[7]}`, 'idrac-0-0.corp.example timed out',
  ];
  for (const s of samples) assert.equal(scrubHosts(s, hosts), oldScrubHosts(s, hosts), s);
  const sc = makeScrubber(hosts);
  for (const s of samples) {
    assert.equal(sc(s, ['10.9.9.9', 'CS01.corp']), oldScrubHosts(s, ['10.9.9.9', 'CS01.corp', ...hosts]), `extra: ${s}`);
  }
  assert.equal(scrubHosts(42, hosts), 42);
});

test('RECENT2602-01: 파트 장애 2,000행 × 주소 1,200개 가림이 200ms 안에 끝나고 결과는 예전과 같다', () => {
  const rows = partRows(2000);
  const match = addressMatcher(HOSTS);
  const t0 = performance.now();
  const out = rows.map((r) => maskPartRow(r, match, HOSTS));
  const ms = performance.now() - t0;
  assert.ok(ms < 200, `가림 ${ms.toFixed(0)}ms — 200ms 이내여야 한다(수정 전 약 5.6초)`);
  // 결과 동일성 — 앞 50행을 예전 식(행마다 [...raws, ...hosts])으로 다시 계산해 대조한다.
  for (let i = 0; i < 50; i++) {
    const r = rows[i]; const raws = [r.deviceId, r.deviceKey, r.deviceName];
    for (const f of ['detail', 'label', 'rawState']) assert.equal(out[i][f], oldScrubHosts(r[f], [...raws, ...HOSTS]), `${i}.${f}`);
    assert.ok(!out[i].detail.includes(r.deviceId), '주소 원문이 남으면 안 된다');
  }
});

test('RECENT2602-01: 작업 로그·폴러 상태·베어메탈 대상 가림도 목록당 한 번 — 2,000건 200ms 이내 · 결과 동일', () => {
  const events = [];
  for (let i = 0; i < 2000; i++) {
    const h = HOSTS[i % HOSTS.length];
    events.push({ at: 1, deviceId: h.replace(/^https:\/\//, ''), name: 'n', host: h, ok: false, error: `connect ETIMEDOUT ${h.replace(/^https:\/\//, '')}:443` });
  }
  let t0 = performance.now();
  const ev = maskActivityEvents(events, HOSTS);
  let ms = performance.now() - t0;
  assert.ok(ms < 200, `작업 로그 가림 ${ms.toFixed(0)}ms`);
  for (let i = 0; i < 30; i++) {
    const e = events[i];
    assert.equal(ev[i].error, oldScrubHosts(e.error, [e.host, ...HOSTS]));
    assert.equal(ev[i].host, '');
  }
  const poller = { errors: events.map((e) => e.error), lastError: events[0].error, inFlight: [{ host: HOSTS[0], name: HOSTS[1] }] };
  t0 = performance.now();
  const p = maskPollerStatus(poller, HOSTS);
  ms = performance.now() - t0;
  assert.ok(ms < 200, `폴러 가림 ${ms.toFixed(0)}ms`);
  assert.equal(p.errors[5], oldScrubHosts(poller.errors[5], HOSTS));
  assert.notEqual(p.inFlight[0].name, HOSTS[1], '등록 주소와 같은 이름은 라벨로 바뀐다');

  const targets = HOSTS.map((h, i) => ({ key: `K${i}`, serverId: h.replace(/^https:\/\//, ''), name: 'db', idracHost: h, osHostName: null }));
  const match = addressMatcher(HOSTS);
  t0 = performance.now();
  const masked = targets.map((x) => maskTargetAddress(x, HOSTS, match));
  ms = performance.now() - t0;
  assert.ok(ms < 200, `베어메탈 대상 가림 ${ms.toFixed(0)}ms`);
  // 판정기를 넘기지 않은 예전 호출 형태와 같은 결과
  for (let i = 0; i < 20; i++) assert.deepEqual(masked[i], maskTargetAddress(targets[i], HOSTS));
  assert.equal(masked[3].idracHost, '');
  assert.match(masked[3].serverId, /^masked-/);
  // 자기 주소(등록부 목록에 없는 호스트명)도 여전히 가린다
  assert.match(maskTargetAddress({ key: 'X', name: 'bmc-only.corp', idracHost: 'https://bmc-only.corp' }, HOSTS, match).name, /이름 가림/);
});

/* ── AUTHZ-2602-01: 범위 operator 는 svcmon 전역 설정을 바꿀 수 없다(조회는 그대로) ── */
let server; let base;
let who = null;
before(async () => {
  const express = (await import('express')).default;
  const { svcmonRouter } = await import('../src/routes/svcmon.js');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = who; next(); });
  app.use('/api/svcmon', svcmonRouter);
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api/svcmon`;
});
after(() => { try { server?.close(); } catch { /* */ } try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ } });

const SCOPED_OP = { username: 'scoperator', role: 'operator', scope: { vcenters: ['vc-us-east'] } };
const FULL_OP = { username: 'fullop', role: 'operator' };
async function call(method, p, body) {
  const r = await fetch(`${base}${p}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch { /* */ }
  return { status: r.status, body: j };
}

test('AUTHZ-2602-01: 범위 operator 의 변경 요청은 403 · 저장되지 않는다', async () => {
  who = SCOPED_OP;
  const cases = [
    ['PUT', '/assign/zzz', {}], ['DELETE', '/assign/zzz'], ['PUT', '/sort', { mode: 'name' }],
    ['POST', '/folders', { kind: 'infra', path: 'A' }], ['PUT', '/reorder/targets', { ids: [] }],
    ['POST', '/targets', { kind: 'infra', path: 'A', name: 'x', host: '10.0.0.1' }],
    ['POST', '/templates', { name: 't' }], ['POST', '/targets/import', { csv: 'a' }],
    ['POST', '/targets/generate', { spec: {} }], ['POST', '/edges/zzz/probe'], ['DELETE', '/edges/zzz'],
    ['POST', '/refresh'], ['POST', '/push-now'], ['POST', '/silence-check'], ['POST', '/config-pull-now'],
  ];
  for (const [m, p, b] of cases) {
    const r = await call(m, p, b);
    assert.equal(r.status, 403, `${m} ${p} → ${r.status}`);
    assert.match(r.body?.reason || '', /전체 범위/);
  }
  // 유령 배정이 생기지 않았다
  who = FULL_OP;
  const a = await call('GET', '/assign');
  assert.equal(a.status, 200);
  assert.ok(!(a.body.assignments || []).some((x) => x.agent === 'zzz'), '범위 계정의 PUT 이 저장되면 안 된다');
});

test('AUTHZ-2602-01: 범위 계정의 조회와 저장하지 않는 변환은 그대로 · 전체 범위 operator 는 변경 가능', async () => {
  who = SCOPED_OP;
  assert.equal((await call('GET', '/assign')).status, 200);
  assert.equal((await call('GET', '/targets/export.csv')).status, 200);
  assert.equal((await call('POST', '/targets/hostmap/export.csv', { pairs: [] })).status, 200);
  who = FULL_OP;
  const r = await call('PUT', '/assign/edge-ok', { mode: 'preview' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const s = await call('PUT', '/sort', { mode: 'name' });
  assert.notEqual(s.status, 403);
  who = { username: 'v', role: 'viewer' };
  assert.equal((await call('PUT', '/sort', { mode: 'name' })).status, 403, 'viewer 는 예전대로 역할에서 막힌다');
});
