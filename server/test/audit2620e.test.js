// v2.620 — 보안·정합성 수정분(리드 담당): 수집기 리다이렉트 거부 · 파트 장애 poller 가림 · CVP 오류 문구 가림 ·
// /perf/req-status 범위 · iDRAC 스캔 조회 fleetOnly · DataCenter 빈 순서 거부.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { stripComments } from './_stripComments.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2620e-'));
process.env.CONFIG_DIR = tmp;
after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });
const src = (p) => stripComments(fs.readFileSync(new URL(`../src/${p}`, import.meta.url), 'utf8'));

let adminRouter;
before(async () => { ({ adminRouter } = await import('../src/routes/admin.js')); });
const layerOf = (router, p, m) => router.stack.find((l) => l.route?.path === p && l.route.methods[m]);
const gateKinds = (layer) => layer.route.stack.map((s) => s.handle?.gate?.kind).filter(Boolean);

test('SEC2620-01 · 자격증명을 싣는 수집기 7곳은 redirect:manual + 3xx 거부', () => {
  for (const f of ['vcenter/soapClient.js', 'vcenter/restClient.js', 'horizon/horizon.js', 'nsx/client.js',
    'storage/collectors/isilon.js', 'storage/collectors/restCommon.js', 'sanswitch/collectors/fosRest.js']) {
    const s = src(f);
    assert.match(s, /redirect:\s*NO_REDIRECT/, `${f}: redirect:'manual' 이 빠졌다`);
    assert.match(s, /refuseRedirect\(/, `${f}: 3xx 를 실패로 밝히지 않는다`);
  }
});

test('SEC2620-01 · 307 을 받으면 Location 으로 다시 보내지 않고 사유와 함께 던진다', async () => {
  const { NO_REDIRECT, refuseRedirect } = await import('../src/util/noRedirect.js');
  let hitB = 0;
  const b = http.createServer((_q, r) => { hitB++; r.end('ok'); });
  await new Promise((r) => b.listen(0, '127.0.0.1', r));
  const a = http.createServer((_q, r) => { r.writeHead(307, { Location: `http://127.0.0.1:${b.address().port}/steal?token=x` }); r.end(); });
  await new Promise((r) => a.listen(0, '127.0.0.1', r));
  try {
    const res = await fetch(`http://127.0.0.1:${a.address().port}/login`, { method: 'POST', body: 'password=P@ss', redirect: NO_REDIRECT });
    assert.throws(() => refuseRedirect(res, '장비'), (e) => e.redirect === true && /HTTP 307/.test(e.message) && !/steal|token/.test(e.message));
    assert.equal(hitB, 0, '리다이렉트 대상에 본문이 다시 전송됐다');
    assert.equal(refuseRedirect({ status: 200, headers: new Headers() }).status, 200);
  } finally { a.close(); b.close(); }
});

test('SEC2620-02 · 파트 장애 poller.last 의 알림 결과(파트 키 원문)는 비-admin 에 개수만', async () => {
  const { lastView } = await import('../src/routes/api/partFaults.js');
  const last = { at: 1, notify: { sent: 2, results: [{ partKey: 'idrac:10.1.1.5:psu:1', result: 'ok' }, { partKey: 'x', result: 'ok' }] } };
  const v = lastView(last, false);
  assert.equal(v.notify.resultsCount, 2);
  assert.equal(v.notify.results, undefined);
  assert.ok(!JSON.stringify(v).includes('10.1.1.5'));
  assert.deepEqual(lastView(last, true), last);
  assert.match(src('routes/api/partFaults.js'), /last:\s*lastView\(st\.last,[^)]*\)\s*\}\s*:\s*null/);
  assert.match(src('routes/api/partFaults.js'), /\.\.\.st,\s*last:\s*lastView\(/);
});

test('SEC2620-03 · CVP 오류 문구의 주소는 비-admin 에 가린다(등록 주소 · URL · IPv4)', async () => {
  const { maskErrText } = await import('../src/routes/api/cvp.js');
  const out = maskErrText('리다이렉트(HTTP 302 → https://10.9.9.9) cvp.lab 10.1.1.1:443 실패', ['cvp.lab']);
  assert.ok(!/10\.9\.9\.9|10\.1\.1\.1|cvp\.lab/.test(out), out);
  assert.equal(maskErrText(null), null);
  assert.equal(maskErrText('버전 1.2.3 사유'), '버전 1.2.3 사유', '버전 번호를 주소로 오판했다');
});

test('SEC2620-04 · /perf/req-status 의 전부 보기는 전체 범위 admin 만', () => {
  assert.match(src('routes/api/perfClient.js'), /isAdmin\s*=\s*req\.user\?\.role === 'admin' && !scopedVcenterIds\(/);
});

test('SEC2620-05 · iDRAC 스캔 대역·결과·로그·잡 조회에 fleetOnly', () => {
  for (const p of ['/idrac/scan-result', '/idrac/scan-agents', '/idrac/scan-ranges', '/idrac/scan-ranges/export.csv',
    '/idrac/scan-ranges/status', '/idrac/scan-log', '/idrac/scan-jobs', '/idrac/scan-job-log']) {
    const l = layerOf(adminRouter, p, 'get');
    assert.ok(l, `${p} 라우트가 없다`);
    assert.ok(gateKinds(l).includes('fullScope'), `${p}: 전체 범위 게이트가 없다`);
  }
});

test('WEB2620-01 · DataCenter 빈 순서는 clear:true 없이 저장하지 않는다(400)', async () => {
  const l = layerOf(adminRouter, '/datacenter-order', 'put');
  const h = l.route.stack.at(-1).handle;
  const call = (body) => new Promise((resolve) => {
    const res = { code: 200, status(c) { this.code = c; return this; }, json(b) { resolve({ code: this.code, body: b }); } };
    h({ body, user: { username: 't' }, ip: '' }, res, (e) => resolve({ code: 500, body: String(e) }));
  });
  const r1 = await call({ order: [] });
  assert.equal(r1.code, 400);
  const r2 = await call({ order: [], clear: true });
  assert.equal(r2.code, 200);
});
