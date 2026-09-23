// v2.589 — 5축 감사(아키텍처·버그·보안·웹·성능) 확정분 회귀. 각 항목은 실행으로 재현한 결함을 고정한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { stripComments } from './_stripComments.js';

const HOUR = 3_600_000;
const NOW = Math.floor(Date.now() / HOUR) * HOUR - 30 * 60_000; // v2.517 규약 — 경계에서 떨어뜨린 고정 기준

test('B1/SEC-01/ARCH-A1 — 인증 실패 GET 은 주장한 엣지 이름으로 기록되지 않는다(위조·밀어내기 차단)', async () => {
  const express = (await import('express')).default;
  const { centralRouter } = await import('../src/routes/central.js');
  const { pullStats, resetPullStats, PULL_UNAUTH_KEY } = await import('../src/central/pullStats.js');
  resetPullStats();
  const app = express(); app.use('/api/central', centralRouter);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${srv.address().port}/api/central`;
  await fetch(`${base}/storage-config?agent=edge-a`, { headers: { 'X-Agent-Name': 'edge-a' } }).then((r) => r.text());
  srv.close();
  const names = pullStats().rows.map((r) => r.agent);
  assert.ok(!names.includes('edge-a'), `주장한 이름이 기록됐다: ${names}`);
  assert.ok(names.includes(PULL_UNAUTH_KEY), '막힌 pull 이 있었다는 사실은 남긴다');
});

test('B1 — 상한 초과 때 검증된 행은 밀려나지 않는다', async () => {
  const { recordPull, pullStats, resetPullStats } = await import('../src/central/pullStats.js');
  resetPullStats();
  recordPull('edge-real', '/storage-config', { status: 200, verified: true, now: NOW - 10 * HOUR });
  for (let i = 0; i < 600; i++) recordPull(`junk-${i}`, '/storage-config', { status: 200, now: NOW + i });
  assert.ok(pullStats().rows.some((r) => r.agent === 'edge-real'));
});

test('ARCH-A2 — RMA SSH·볼트·RMA 접근 허용 판정은 비정규 IPv4(8진 해석 위험)를 거부한다', async () => {
  const { targetAllowed } = await import('../src/rma/commands.js');
  const { hostAllowed } = await import('../src/security/credentialStore.js');
  const { ipAllowed } = await import('../src/rma/settings.js');
  const L = ['10.0.0.0/8'];
  assert.equal(targetAllowed('010.0.0.5', L), false);      // dns.lookup 은 8.0.0.5 로 해석한다
  assert.equal(targetAllowed('010.0.0.5', []), false);     // 빈 목록(전부 허용)이어도 비정규 표기는 거부
  assert.equal(targetAllowed('10.0.0.5', L), true);
  assert.equal(targetAllowed('host.a', ['*.a']), true);
  assert.equal(hostAllowed('010.0.0.5', L), false);
  assert.equal(hostAllowed('10.0.0.5', L), true);
  assert.equal(ipAllowed('10..0.5', L), false);            // Number('') === 0 계열
  assert.equal(ipAllowed('::ffff:10.0.0.5', L), true);
  // 사본 금지 — 세 파일이 util/ipv4 를 쓴다
  for (const f of ['rma/commands.js', 'security/credentialStore.js', 'rma/settings.js']) {
    const src = stripComments(fs.readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8'));
    assert.ok(!/split\('\.'\)\.map\(Number\)/.test(src), `${f} 에 IPv4 파서 사본`);
    assert.ok(/strictIpv4Num/.test(src), `${f} 가 strictIpv4Num 을 쓰지 않는다`);
  }
});

test('B2 — 통신 지도는 엣지의 가장 최근 수신 행을 쓴다(바이트 순 첫 행이 아니라)', async () => {
  const { buildCommMap } = await import('../src/commmap/build.js');
  const m = buildCommMap({
    now: NOW,
    collectors: [{ id: 'gm1', name: 'GM1' }],
    status: { gm1: { ok: true, at: NOW - 60_000 } },
    ingest: { rows: [
      { agent: 'GM1', lastAt: NOW - 3 * HOUR, wireBytes: 9e9, pushes: 100 },
      { agent: 'gm1', lastAt: NOW - 10_000, wireBytes: 10, pushes: 1 },
    ] },
    rejects: { rows: [{ agent: 'gm1', lastAt: NOW - HOUR, total: 1 }] },
  });
  assert.notEqual(m.edges[0].push.state, 'rejected');
});

test('B3 — 삭제된 vCenter 를 가리키는 명시 지정은 귀속으로 세지 않는다(표 합계 = KPI)', async () => {
  const { serversByCorp } = await import('../src/idrac/serverByCorp.js');
  const r = serversByCorp([{ id: 's1', name: 'srv1', vcenterId: 'vc-deleted' }], [], { knownVcenters: new Set(['vc-a']) });
  assert.equal(r.byVcenter['vc-deleted'], undefined);
  assert.equal(r.matchedBy.explicitStale, 1);
  // knownVcenters 를 주지 않는 호출(예전 동작)은 그대로
  assert.equal(serversByCorp([{ id: 's1', vcenterId: 'vc-x' }], []).byVcenter['vc-x'], 1);
});

test('B4 — 범위 밖 시각은 던지지 않고 빈 문자열', async () => {
  const { dayKey, localStamp } = await import('../src/util/dayKey.js');
  assert.equal(dayKey(1e16), ''); assert.equal(localStamp(1e16), '');
  assert.equal(dayKey(Date.UTC(2026, 8, 22, 15, 30)), '2026-09-23');
});

test('B5 — (기타)로 빠진 거부도 개수에서 사라지지 않는다', async () => {
  const { buildDataFlow } = await import('../src/dataflow/build.js');
  const f = buildDataFlow({ now: NOW, routes: [{ side: 'central', method: 'POST', path: '/inventory' }],
    rejects: { rows: [{ agent: 'x', total: 3 }], recent: [
      { agent: 'x', endpoint: '/inventory', at: NOW, reason: 'r' },
      { agent: 'x', endpoint: '(기타)', at: NOW, reason: 'r' },
    ] } });
  assert.equal(f.rejectsWithoutTime, 2); // 3 − 선에 올린 1
});

test('B6 — svcmon 파일명·버킷 경계는 프로세스 TZ 가 아니라 포탈 오프셋', async () => {
  const { periodKey } = await import('../src/svcmon/csvlog.js');
  const t = Date.UTC(2026, 8, 22, 15, 30); // 2026-09-23 00:30 KST
  assert.equal(periodKey(t, 'day'), '20260923');
  assert.equal(periodKey(t, 'hour'), '20260923-00');
  const src = stripComments(fs.readFileSync(new URL('../src/svcmon/csvlog.js', import.meta.url), 'utf8'));
  assert.ok(!/\.getHours\(\)|\.getDate\(\)/.test(src));
});

test('B7·SEC-02 — 디스크 가드 기본값·curuser 범위 계정 필드(소스 고정)', () => {
  const vm = stripComments(fs.readFileSync(new URL('../src/vmseries/poller.js', import.meta.url), 'utf8'));
  assert.ok(/numOrNull\(process\.env\.VMSERIES_MIN_FREE_GB\)\s*\?\?\s*5/.test(vm));
  const cu = stripComments(fs.readFileSync(new URL('../src/routes/api/curUser.js', import.meta.url), 'utf8'));
  assert.equal((cu.match(/overLimit:\s*scope\.overLimit/g) || []).length, 0, '범위 무관 overLimit 이 남았다');
  assert.ok(/push:\s*scopedVcenterIds\(req\.user, snap\)\s*\?\s*null/.test(cu));
});

test('ARCH-A3 — 로그 분석 합산은 선형이고 오래된 버킷의 http 키를 줄인다', async () => {
  const { newState, mergeState, compactState } = await import('../src/loganalysis/engine.js');
  const mk = (seed) => { const st = newState(); for (let i = 0; i < 700; i++) st.http[`GET /x${seed}-${i}`] = { n: 1, sumMs: 1, slow: 0, maxMs: 1, rid: '' }; return st; };
  // v2.590 TEST-1: 입력 생성(168×700 객체)을 측정 구간 밖으로 뺐다 — 안에 두면 콜드 실행·머신 부하에서 벽시계가
  //   부풀어 전량 병렬 실행 중 621ms 로 실패한 적이 있다(제품 결함 아님). 재는 것은 합산 루프뿐이다.
  const inputs = Array.from({ length: 168 }, (_, i) => mk(i));
  const acc = newState(); const t0 = performance.now();
  for (const st of inputs) mergeState(acc, st);
  assert.ok(performance.now() - t0 < 600, `합산이 너무 느리다(예전 ~1.7초): ${Math.round(performance.now() - t0)}ms`);
  const c = compactState(mk(0));
  assert.ok(Object.keys(c.http).length <= 100); assert.ok(c.overflow.http >= 600);
});

test('ARCH-A4 — 통신 점검의 중앙→엣지 호출이 데이터 흐름 지도 계측에 남는다', async () => {
  const { stepHttp } = await import('../src/linkcheck/checks.js');
  const { outboundStats, resetOutboundStats } = await import('../src/util/outboundStats.js');
  resetOutboundStats();
  const srv = await new Promise((r) => { const s = http.createServer((q, res) => res.end('{"ok":true}')).listen(0, '127.0.0.1', () => r(s)); });
  await stepHttp({ url: `http://127.0.0.1:${srv.address().port}/api/collector/ping`, ip: '127.0.0.1', timeoutMs: 3000 });
  srv.close();
  const row = outboundStats().rows.find((r) => r.path === '/api/collector/ping');
  assert.ok(row && row.okCount === 1);
});
