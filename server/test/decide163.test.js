/**
 * 163회차 — 사용자 결정 5(152 결정 D1 · 157 판정 '전역 처리기 400 은 안전측이 아님' → 자리별 수정).
 *  /api 라우트가 본문 값을 String() · Number() · 템플릿 · .trim() 으로 바꾸는데, 값이 `{"toString":1}` · 배열 같은 객체면 던져 **500** 이었다.
 *  목 서버(DATA_SOURCE=mock · AUTH_ENABLED=false)에 상태 변경 라우트 전부를 '모양이 틀린 본문' 으로 보내 모은 500 가운데
 *  위험 큰 자리(인증 · 자격증명 · 설정 저장 · 원격 실행 · 삭제)를 고쳤다 — 핸들러(또는 본문을 읽는 게이트) **앞에서** 400(code 'not-text').
 *  실제 라우터(adminRouter · api · remoteRouter)를 index.js 와 같은 순서(queryNormalizer → express.json → authMiddleware → requireEnrolled)로 띄운다.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const DIR = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'decide163-'));
Object.assign(process.env, { CONFIG_DIR: DIR, AUTH_ENABLED: 'false', DATA_SOURCE: 'mock', API_RATE_DISABLED: 'true' });
delete process.env.CENTRAL_URL;

const CT = await import('../src/util/coercionTrap.js');
const express = (await import('express')).default;
const { queryNormalizer } = await import('../src/util/queryNormalize.js');
const { authMiddleware, requireEnrolled } = await import('../src/auth/auth.js');
const { adminRouter } = await import('../src/routes/admin.js');
const { api } = await import('../src/routes/api.js');
const { remoteRouter } = await import('../src/routes/remote.js');
const { insightsRouter } = await import('../src/routes/insights.js');

const app = express();
app.use(queryNormalizer());
app.use(express.json());
app.use('/api/admin', authMiddleware, requireEnrolled, adminRouter);
app.use('/api/remote', authMiddleware, requireEnrolled, remoteRouter);
app.use('/api/insights', authMiddleware, requireEnrolled, insightsRouter);
app.use('/api', authMiddleware, requireEnrolled, api);
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => res.status(Number(err?.status) || 500).json({ ok: false, error: 'internal error' }));
const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const PORT = srv.address().port;
test.after(() => { srv.close(); fs.rmSync(DIR, { recursive: true, force: true }); });

function send(method, url, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port: PORT, path: url, method, headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {} }, (res) => {
      let t = ''; res.setEncoding('utf8'); res.on('data', (c) => { t += c; });
      res.on('end', () => { let j = null; try { j = JSON.parse(t); } catch { /* */ } resolve({ status: res.statusCode, body: j }); });
    });
    req.setTimeout(20_000, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (data) req.write(data); req.end();
  });
}

const TRAP = { toString: 1 };
const TRAP2 = { toString: null, valueOf: null };

test('nonTextField · rejectNonText: 객체 · 배열만 거절, 빠진 값 · 글자 · 수 · 불리언은 통과', () => {
  assert.equal(CT.nonTextField({ a: 'x', b: 5, c: true, d: null, e: undefined }, ['a', 'b', 'c', 'd', 'e', 'f']), null);
  assert.equal(CT.nonTextField({ a: 'x', b: TRAP }, ['a', 'b']), 'b');
  assert.equal(CT.nonTextField({ a: ['x'] }, ['a']), 'a');
  assert.equal(CT.nonTextField({ a: TRAP }, ['b']), null, '고르지 않은 필드는 보지 않는다');
  assert.equal(CT.nonTextField(null, ['a']), null);
});

/* (메서드, 경로, 필드) — 퍼징에서 500 이 났던 자리. 고친 뒤에는 400 · code 'not-text' · field 가 그 이름. */
const FIXED = [
  ['POST', '/api/admin/security/peer-trust/approve', 'kind'],
  ['POST', '/api/admin/security/peer-trust/approve', 'host'],
  ['POST', '/api/admin/security/peer-trust/reject', 'kind'],
  ['POST', '/api/admin/security/peer-trust/remove', 'kind'],
  ['POST', '/api/admin/security/peer-trust/approve-observed', 'kind'],
  ['PUT', '/api/admin/security/peer-trust/policy', 'mode'],
  ['POST', '/api/admin/vcenters', 'host'],
  ['POST', '/api/admin/guest/add-user', 'vcenterId'],
  ['PUT', '/api/admin/security/guest-scans', 'vcenterId'],
  ['PUT', '/api/admin/veeam/em/map', 'emId'],
  ['POST', '/api/admin/edge-users/zz163', 'username'],
  ['POST', '/api/admin/gpu-physical', 'host'],
  ['POST', '/api/admin/gpu-physical/auto-register', 'username'],
  ['POST', '/api/admin/gpu-physical/bulk-auto-register', 'username'],
  ['POST', '/api/admin/gpu-physical/test', 'port'],
  ['POST', '/api/admin/gpu-guest/test-ssh', 'ip'],
  ['POST', '/api/admin/idrac/bulk-add', 'password'],
  ['POST', '/api/admin/idrac/delete', 'vcenterId'],
  ['POST', '/api/admin/ipam/scan/agent/delete', 'agent'],
  ['POST', '/api/admin/ipam/scan/migration/move', 'agent'],
  ['POST', '/api/admin/ipam/scan/migration/remove', 'vcenterId'],
  ['POST', '/api/admin/idrac', 'host'],
  ['POST', '/api/admin/central/inventory/owner', 'agent'],
  ['POST', '/api/admin/central/agent-tokens', 'agent'],
  ['POST', '/api/admin/agent-deploy', 'host'],
  ['POST', '/api/admin/agent-deploy/targets/import', 'csv'],
  ['POST', '/api/admin/ollama-deploy', 'ollamaPort'],
  ['POST', '/api/admin/collectors/import', 'csv'],
  ['POST', '/api/admin/collectors/set-password', 'password'],
  ['POST', '/api/admin/datacenters', 'name'],
  ['POST', '/api/admin/collectors/test', 'url'],
  ['POST', '/api/admin/api-keys', 'name'],
  ['POST', '/api/settings/ssh-access/accounts', 'name'],
  ['PUT', '/api/tools/rma/agents/zz163/schedule', 'test'],
  ['POST', '/api/tools/rma/tests/validate', 'test'],
  ['POST', '/api/tools/rma/run', 'cmd'],
  ['POST', '/api/tools/rma/deploy/list', 'host'],
  ['POST', '/api/tools/rma/deploy/list', 'username'],
  ['POST', '/api/tools/rma/deploy', 'host'],
  ['POST', '/api/tools/rma/deploy/remove', 'host'],
  ['PUT', '/api/admin/net/monitors', 'id'],
  ['POST', '/api/remote/proxies', 'name'],
  ['POST', '/api/tools/san-flow/delete', 'deviceId'],
  ['POST', '/api/tools/san-flow/forget', 'name'],
  ['POST', '/api/tools/credentials/inspect-key', 'privateKey'],
  ['POST', '/api/tools/bm-usage/accounts', 'name'],
  ['DELETE', '/api/tools/bm-usage/onboard/edge-rows', 'name'],
  ['POST', '/api/tools/bm-usage/onboard/test', 'id'],
  ['POST', '/api/tools/relaytopo/test-ssh', 'dc'],
  ['POST', '/api/remote/probe', 'targetHost'],
  ['POST', '/api/remote/mappings', 'targetHost'],
  ['POST', '/api/remote/mappings', 'vcenterId'],
  ['POST', '/api/remote/quick-connect', 'targetHost'],
  ['POST', '/api/admin/perf/measure', 'samples'],
  ['POST', '/api/admin/dir-usage/run', 'targetId'],
  ['POST', '/api/admin/os-scan/run', 'vcenterId'],
  ['POST', '/api/admin/provision/jobs', 'sourceId'],
  ['POST', '/api/admin/log-analysis/journal', 'hours'],
  ['POST', '/api/admin/horizon', 'id'],
  ['POST', '/api/admin/horizon/test', 'id'],
  ['POST', '/api/admin/horizon/servers/import/test', 'csv'],
  ['POST', '/api/admin/horizon/servers/import', 'csv'],
  ['POST', '/api/admin/idrac/scan', 'agent'],
  ['POST', '/api/admin/idrac/register-scanned', 'agent'],
  ['PUT', '/api/admin/idrac/scan-ranges', 'vcenterId'],
  ['POST', '/api/admin/idrac/scan-ranges/import', 'csv'],
  ['POST', '/api/admin/idrac/scan-ranges/scan', 'id'],
  ['POST', '/api/admin/idrac/scan-job/cancel', 'reqId'],
  ['PUT', '/api/admin/ipam/scan/settings', 'datacenterId'],
  ['POST', '/api/admin/ipam/scan/ranges/line', 'value'],
  ['POST', '/api/admin/ipam/scan/ranges/import', 'csv'],
  ['PUT', '/api/admin/ipam/vc-ranges', 'vcenterId'],
  ['POST', '/api/admin/ipam/vc-ranges/import', 'csv'],
  ['POST', '/api/admin/portal-db/location/preflight', 'targetDir'],
  ['POST', '/api/admin/portal-db/location/script', 'targetDir'],
  ['POST', '/api/tools/guest-partition/mail/preview', 'target'],
  ['POST', '/api/tools/guest-partition/mail/send', 'target'],
  ['POST', '/api/tools/vclogs/federate', 'vcenterId'],
  ['POST', '/api/vms/usage', 'days'],
  ['POST', '/api/tools/vm-finder', 'os'],
  ['POST', '/api/tools/esxi-temp/spark', 'hours'],
  ['POST', '/api/issues/autocreate/simulate', 'hours'],
  ['POST', '/api/tools/portal-check/tokens/probe', 'agent'],
  ['POST', '/api/tools/portal-check/tokens/edge-pull', 'agent'],
  ['POST', '/api/tools/bareos-backup/groups', 'vcenterId'],
  ['POST', '/api/tools/san-flow/check', 'deviceId'],
  ['POST', '/api/tools/san-flow/deactivate', 'name'],
  ['POST', '/api/tools/san-flow/activate', 'name'],
  ['POST', '/api/tools/san-flow/show', 'deviceId'],
  ['POST', '/api/tools/sanswitch/test', 'type'],
  ['POST', '/api/tools/sanswitch/devices/import/test', 'text'],
  ['POST', '/api/tools/part-faults/close', 'partKey'],
  ['POST', '/api/tools/vm-clone/jobs', 'vmId'],
  ['POST', '/api/tools/vm-clone/nfs-datastores', 'vcenterId'],
  ['PUT', '/api/tools/vm-clone/corps/mounts', 'corpKey'],
  ['POST', '/api/tools/storage/test', 'type'],
  ['POST', '/api/tools/storage/devices/import/test', 'text'],
  ['POST', '/api/tools/xfer-speed/run', 'agent'],
  ['POST', '/api/tools/svc-inventory/op', 'op'],
  ['PUT', '/api/veeam/vm-list/prefs', 'slot'],
  ['PUT', '/api/tools/backup-detail/marks', 'vcenterId'],
  ['POST', '/api/tools/disk-bad/jobs/zz163/retry', 'agent'],
  ['PUT', '/api/tools/ipam/subnet-note', 'base'],
  ['PUT', '/api/tools/ipam/annotation', 'ip'],
  ['POST', '/api/tools/pdu/csv/import', 'csv'],
  ['POST', '/api/tools/pdu/test', 'host'],
  ['POST', '/api/tools/pdu/devices', 'name'],
  ['POST', '/api/tools/focus-mon/targets', 'host'],
  ['POST', '/api/tools/focus-mon/groups', 'name'],
  ['POST', '/api/tools/focus-mon/targets/import/preview', 'text'],
  ['POST', '/api/tools/focus-mon/targets/import', 'text'],
  ['POST', '/api/tools/focus-mon/targets/move', 'to'],
  ['POST', '/api/tools/focus-mon/sessions', 'interval'],
  ['POST', '/api/tools/focus-mon/events', 'target'],
  ['POST', '/api/tools/focus-mon/alerts/rules', 'name'],
  ['POST', '/api/tools/focus-mon/alerts/preview', 'target'],
  ['POST', '/api/tools/bm-storage/import', 'csv'],
  ['POST', '/api/tools/edge-log/fetch', 'agent'],
  ['POST', '/api/tools/ip-ping', 'vcenterId'],
  ['PUT', '/api/tools/bareos-backup/settings', 'rev'],
  ['POST', '/api/tools/bareos-backup/jobs', 'vmId'],
  ['POST', '/api/tools/bareos-backup/jobs/bulk', 'vcenterId'],
  ['POST', '/api/tools/bareos-backup/rehearsal/run', 'directorId'],
  ['POST', '/api/tools/periodic-report/run', 'kind'],
  ['PUT', '/api/insights/fleet/tag', 'key'],
  ['PUT', '/api/insights/fleet/assign', 'serviceTag'],
  ['PUT', '/api/insights/fleet/assign-bulk', 'vcenterId'],
  ['POST', '/api/admin/idrac/assign-vcenter', 'vcenterId'],
  ['POST', '/api/admin/idrac/test', 'host'],
  ['POST', '/api/tools/sanswitch/devices/import', 'text'],
  ['POST', '/api/tools/storage/devices/import', 'text'],
  ['POST', '/api/tools/ipam/policies', 'id'],
  ['POST', '/api/tools/ipam/policies', 'spec'],
  ['PUT', '/api/tools/ipam/policies/zz163', 'spec'],
  ['POST', '/api/tools/bm-storage/servers', 'host'],
  ['POST', '/api/tools/bareos-backup/groups', 'name'],
  ['POST', '/api/admin/idrac/expand-ips', 'ips'],
  ['PUT', '/api/admin/ipam/scan/settings', 'ranges'],
  ['PUT', '/api/admin/ipam/vc-ranges', 'ranges'],
];

test('고친 자리: 글자가 아닌 본문 값 → 400 not-text (500 아님)', async () => {
  const bad = [];
  for (const [m, url, field] of FIXED) {
    for (const v of [TRAP, TRAP2]) {
      const r = await send(m, url, { [field]: v });
      if (r.status !== 400 || r.body?.field !== field || !/글자(여야| 또는 목록이어야)/.test(String(r.body?.reason || ''))) bad.push(`${m} ${url} ${field}=${JSON.stringify(v)} → ${r.status} ${JSON.stringify(r.body).slice(0, 120)}`);
    }
  }
  assert.deepEqual(bad, []);
});

test('quick-connect: 배열 targetHost(.trim 이 던지던 자리)도 400', async () => {
  const r = await send('POST', '/api/remote/quick-connect', { targetHost: ['10.0.0.1'] });
  assert.equal(r.status, 400); assert.equal(r.body.field, 'targetHost');
});

test('edge-rows: 쿼리로 온 객체(?name[a]=1 → queryNormalizer 뒤)도 500 이 아니다', async () => {
  const r = await send('DELETE', '/api/tools/bm-usage/onboard/edge-rows?agent=a&name[a]=1');
  assert.notEqual(r.status, 500);
});

test('정상 모양 본문은 예전 검사가 그대로 판정한다(not-text 가 아니다 · 수는 글자로 받는다)', async () => {
  // peer-trust: 모르는 종류는 예전 문구 그대로
  let r = await send('POST', '/api/admin/security/peer-trust/approve', { kind: 'bogus', host: 'h', port: 22 });
  assert.equal(r.status, 400); assert.equal(r.body.field, 'kind'); assert.match(r.body.reason, /종류\(kind\)는/);
  // 포트를 글자로 보내도(예전 Number('22')) 통과해 다음 검사(confirmVerified)로 간다
  r = await send('POST', '/api/admin/security/peer-trust/approve', { kind: 'ssh', host: 'h1', port: '22' });
  assert.equal(r.status, 400); assert.equal(r.body.field, 'confirmVerified');
  // probe: 형식이 틀린 글자는 예전 사유
  r = await send('POST', '/api/remote/probe', { targetHost: 'bad host!' });
  assert.equal(r.status, 400); assert.equal(r.body.reason, '대상 호스트가 올바르지 않습니다.');
  // quick-connect: 대상이 비면 예전 사유
  r = await send('POST', '/api/remote/quick-connect', {});
  assert.equal(r.status, 400); assert.equal(r.body.reason, '대상 IP가 필요합니다.');
  // collectors/set-password: 짧은 비밀번호는 예전 사유
  r = await send('POST', '/api/admin/collectors/set-password', { password: 'short' });
  assert.equal(r.status, 400); assert.match(r.body.reason, /8자 이상/);
  // central inventory owner: 빈 vcenterId 는 예전 사유 · 수 vcenterId 는 글자로 받아 다음 판정(404)으로
  r = await send('POST', '/api/admin/central/inventory/owner', {});
  assert.equal(r.status, 400); assert.match(r.body.reason, /vcenterId 가 필요/);
  r = await send('POST', '/api/admin/central/inventory/owner', { vcenterId: 12345 });
  assert.equal(r.status, 404);
  // credentials inspect-key: 키가 아닌 글자는 예전처럼 200 · ok:false
  r = await send('POST', '/api/tools/credentials/inspect-key', { privateKey: 'not a key' });
  assert.equal(r.status, 200); assert.equal(r.body.ok, false);
});

test('저장 뒤에 던지던 자리: 틀린 모양이 저장되지 않는다 — 목록 · 원격 접속이 계속 열린다', async () => {
  // 네트워크 연속 모니터: 예전에는 id 객체가 저장된 뒤 응답에서 던졌고, 그 뒤로 GET 이 늘 500 이었다.
  for (const body of [{ id: TRAP }, { hostA: { host: TRAP } }, { hostB: ['x'] }, { hostA: { password: TRAP2 } }]) {
    const r = await send('PUT', '/api/admin/net/monitors', body);
    assert.equal(r.status, 400, JSON.stringify(body)); assert.equal(r.body.code, 'not-text');
  }
  let g = await send('GET', '/api/admin/net/monitors');
  assert.equal(g.status, 200); assert.equal(g.body.monitors.length, 0);
  // 정상 저장은 예전 그대로(새 id · 이름)
  const ok = await send('PUT', '/api/admin/net/monitors', { name: 'm163', hostA: { host: '10.0.0.9', port: 22, username: 'u' } });
  assert.equal(ok.status, 200); assert.equal(ok.body.name, 'm163'); assert.match(ok.body.id, /^mon_/);
  g = await send('GET', '/api/admin/net/monitors');
  assert.equal(g.status, 200); assert.equal(g.body.monitors.length, 1);

  // 중계 서버: 예전에는 vcenterIds 객체 · 수가 저장돼 resolveProxy 가 던졌고 모든 probe · quick-connect · mappings 가 500 이었다.
  for (const body of [{ name: 'p', vcenterIds: TRAP }, { name: 'p', vcenterIds: 12345 }, { name: 'p', vcenterIds: [TRAP] }, { name: TRAP2 }]) {
    const r = await send('POST', '/api/remote/proxies', body);
    assert.equal(r.status, 400, JSON.stringify(body)); assert.equal(r.body.code, 'not-text');
  }
  const pr = await send('POST', '/api/remote/probe', { targetHost: '10.0.0.5' });
  assert.equal(pr.status, 200, JSON.stringify(pr.body));
  const okp = await send('POST', '/api/remote/proxies', { name: 'p163', vcenterIds: ['vc-a'] });
  assert.equal(okp.status, 200, JSON.stringify(okp.body));
});

test('줄 목록 칸(ips · ranges)은 배열을 예전처럼 받는다 — 배열이 아닌 객체만 400', async () => {
  const a = await send('POST', '/api/admin/idrac/expand-ips', { ips: ['10.0.0.1', '10.0.0.2'] });
  assert.equal(a.status, 200); assert.equal(a.body.count ?? a.body.ips?.length, 2, JSON.stringify(a.body).slice(0, 200));
  const t = await send('POST', '/api/admin/idrac/expand-ips', { ips: '10.0.0.1\n10.0.0.3' });
  assert.equal(t.status, 200);
  const o = await send('POST', '/api/admin/idrac/expand-ips', { ips: { a: 1 } });
  assert.equal(o.status, 400); assert.equal(o.body.code, 'not-text');
});
