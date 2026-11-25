/**
 * rebut3350.test.js — v3.35.0 스냅샷 보류 목록(4c7d5880) 반증 회차에서 확정한 것.
 *   ① 쓰기 범위 밖 보류는 writable:false — 쓰기를 줄인 관리자(조회 vc-1 · vc-2, 쓰기 vc-1)의 화면이 풀기 · 고르기를 잠글 근거.
 *      예전 응답에는 이 값이 없어 화면이 vc-2 보류에도 풀기 · 고르기를 열었고, ‘보이는 보류 모두 고르기 → 고른 것 풀기’ 가 매번 403(아무것도 풀지 않음)이었다.
 *   ② 여러 건 풀기 감사 줄 — 이름 경계에서 자르고 ‘외 N건’ 을 밝힌다(예전 `.slice(0, 500)` 은 이름 가운데를 표시 없이 잘랐다).
 * 실제 api 라우터를 index.js 순서(queryNormalizer → express.json → 사용자 → 라우터)로 띄운다(snapHolds3350 과 같은 구성).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const DIR = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'rebut3350-'));
Object.assign(process.env, { CONFIG_DIR: DIR, DB_DIR: DIR, DATA_DIR: DIR, AUTH_ENABLED: 'true', DATA_SOURCE: 'mock', API_RATE_DISABLED: 'true', SNAPHIST_DB_PATH: path.join(DIR, 'snap-history.db') });
delete process.env.CENTRAL_URL;

const DAY = 86_400_000;
const NOW = Math.floor(Date.now() / 3_600_000) * 3_600_000;   // 정시 경계(docs/rules/common.md)
fs.writeFileSync(path.join(DIR, 'vcenters.json'), JSON.stringify({ vcenters: [{ id: 'vc-1', name: 'Seoul', host: '127.0.0.1' }, { id: 'vc-2', name: 'Warsaw', host: '127.0.0.1' }] }));

const express = (await import('express')).default;
const { queryNormalizer } = await import('../src/util/queryNormalize.js');
const { store } = await import('../src/store.js');
const { setHold, loadHolds, HOLDS_FILE_NAME, _resetHoldsForTest } = await import('../src/vmhygiene/holds.js');
const { listAudit } = await import('../src/audit.js');

store.snapshot = {
  generatedAt: new Date(NOW).toISOString(), source: 'mock',
  vcenters: [{ id: 'vc-1', name: 'Seoul', status: 'connected' }, { id: 'vc-2', name: 'Warsaw', status: 'connected' }],
  hosts: [], datastores: [], alarms: [], networks: [],
  vms: [{ id: 'vc-1:a', vcenterId: 'vc-1', name: 'erp-app-02', snapshotCount: 1, snapshotSizeGB: 1, snapshotOldestTs: NOW - DAY },
    { id: 'vc-2:c', vcenterId: 'vc-2', name: 'web-eu-0205', snapshotCount: 1, snapshotSizeGB: 1, snapshotOldestTs: NOW - DAY }],
};
const USERS = {
  fadm: { username: 'fadm', role: 'admin' },
  wadm: { username: 'wadm', role: 'admin', scope: { vcenters: ['vc-1', 'vc-2'], writeVcenters: ['vc-1'] } },   // vc-2 는 조회만
};
const { api } = await import('../src/routes/api.js');
const app = express();
app.use(queryNormalizer());
app.use(express.json());
app.use((req, _res, next) => { if (req.headers['x-u']) req.user = USERS[req.headers['x-u']] || null; next(); });
app.use('/api', api);
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => res.status(Number(err?.status) || 500).json({ ok: false, error: 'internal error' }));
const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const PORT = srv.address().port;
test.after(() => { srv.close(); try { fs.rmSync(DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* 정리 실패는 시험 결과가 아니다 */ } });

function send(user, method, url, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port: PORT, path: url, method, headers: { 'x-u': user, ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}) } }, (res) => {
      let t = ''; res.setEncoding('utf8'); res.on('data', (c) => { t += c; });
      res.on('end', () => { let j = null; try { j = JSON.parse(t); } catch { /* */ } resolve({ status: res.statusCode, body: j }); });
    });
    req.setTimeout(20_000, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (data) req.write(data); req.end();
  });
}
function reset() {
  try { fs.rmSync(path.join(DIR, HOLDS_FILE_NAME)); } catch { /* 없음 */ }
  _resetHoldsForTest();
}

test('① 쓰기 범위 밖 보류는 writable:false — 화면이 풀기 · 고르기를 잠글 근거(조회는 그대로)', async () => {
  reset();
  for (const [vcenterId, vmId, vmName] of [['vc-1', 'vc-1:a', 'erp-app-02'], ['vc-2', 'vc-2:c', 'web-eu-0205'], ['vc-2', 'vc-2:gone', 'old-eu-01']]) {
    assert.equal(setHold({ vcenterId, vmId, vmName, days: 30, reason: 'r' }, 'kim.ops', NOW).ok, true);
  }
  const w = await send('wadm', 'GET', '/api/tools/snapshots/holds');
  assert.equal(w.status, 200);
  const by = Object.fromEntries(w.body.holds.map((h) => [h.vmId, h.writable]));
  assert.deepEqual(by, { 'vc-1:a': true, 'vc-2:c': false, 'vc-2:gone': false }, '조회는 되고 쓰기 밖인 vc-2 보류는 writable:false');
  // 그 근거가 맞다 — 서버는 vc-2 보류를 섞은 풀기를 통째로 거절한다
  const r = await send('wadm', 'POST', '/api/tools/snapshots/holds/release', { keys: w.body.holds.map((h) => ({ vcenterId: h.vcenterId, vmId: h.vmId })) });
  assert.equal(r.status, 403);
  // writable 인 것만 고르면 풀린다
  const ok = await send('wadm', 'POST', '/api/tools/snapshots/holds/release', { keys: w.body.holds.filter((h) => h.writable).map((h) => ({ vcenterId: h.vcenterId, vmId: h.vmId })) });
  assert.equal(ok.status, 200); assert.equal(ok.body.released, 1);
  const f = await send('fadm', 'GET', '/api/tools/snapshots/holds');
  assert.ok(f.body.holds.length === 2 && f.body.holds.every((h) => h.writable === true), '전체 범위 관리자는 전부 writable');
});

test('② 여러 건 풀기 감사 줄 — 이름 경계에서 자르고 남은 수를 밝힌다 · 다 들어가면 표지 없음', async () => {
  reset();
  const N = 40;
  const name = (i) => `batch-restore-temp-vm-${String(i).padStart(3, '0')}-long-name`;
  for (let i = 0; i < N; i += 1) assert.equal(setHold({ vcenterId: 'vc-1', vmId: `vc-1:g${i}`, vmName: name(i), days: 30, reason: 'r' }, 'kim.ops', NOW).ok, true);
  const keys = loadHolds().holds.map((h) => ({ vcenterId: h.vcenterId, vmId: h.vmId }));
  const r = await send('fadm', 'POST', '/api/tools/snapshots/holds/release', { keys });
  assert.equal(r.status, 200); assert.equal(r.body.released, N);
  const line = listAudit({ limit: 50 }).items.find((e) => e.action === 'snapshot.hold');
  assert.ok(line, '감사 줄이 있다');
  assert.equal(line.target, `${N}건`);
  const m = line.detail.match(/ … 외 (\d+)건$/);
  assert.ok(m, `잘랐으면 남은 수를 밝힌다: ${line.detail.slice(-60)}`);
  const listed = line.detail.replace(/^보류 풀기\(여러 건\) — /, '').replace(/ … 외 \d+건$/, '').split(', ');
  assert.equal(listed.length + Number(m[1]), N, '실린 이름 + 외 N건 = 푼 수');
  for (const s of listed) assert.match(s, /^vc-1\/batch-restore-temp-vm-\d{3}-long-name$/, `이름 가운데에서 자르지 않는다: ${s}`);
  assert.ok(line.detail.length <= 500, `상한 안: ${line.detail.length}`);
  // 몇 건이면 전부 싣고 표지를 달지 않는다
  reset();
  for (let i = 0; i < 2; i += 1) setHold({ vcenterId: 'vc-1', vmId: `vc-1:s${i}`, vmName: `s${i}`, days: 30, reason: 'r' }, 'kim.ops', NOW);
  await send('fadm', 'POST', '/api/tools/snapshots/holds/release', { keys: [{ vcenterId: 'vc-1', vmId: 'vc-1:s0' }, { vcenterId: 'vc-1', vmId: 'vc-1:s1' }] });
  const l2 = listAudit({ limit: 50 }).items.find((e) => e.action === 'snapshot.hold' && e.target === '2건');
  assert.equal(l2.detail, '보류 풀기(여러 건) — vc-1/s0, vc-1/s1');
});

test('③ 등록부가 JSON 손상이면(readError 없이 빈 목록) ‘vCenter 등록 삭제’ 로 단정하지 않는다 — 확인 못 함', async () => {
  reset();
  assert.equal(setHold({ vcenterId: 'vc-9', vmId: 'vc-9:y', vmName: 'batch-kr-0412', days: 30, reason: 'r' }, 'kim.ops', NOW).ok, true);
  const reg = path.join(DIR, 'vcenters.json'); const keep = fs.readFileSync(reg, 'utf8');
  const st = async () => (await send('fadm', 'GET', '/api/tools/snapshots/holds')).body.holds.find((h) => h.vmId === 'vc-9:y');
  const h0 = await st();
  assert.deepEqual([h0.state, h0.why], ['gone', 'vc-removed'], '읽은 등록부에 없으면 등록 삭제');
  fs.writeFileSync(reg, '{"vcenters": [ {"id": "vc-1", "name": "Seoul"');   // 잘린 JSON
  try {
    const h = await st();
    assert.equal(h.state, 'unknown', `손상된 등록부를 ‘등록 0개’ 로 읽지 않는다: ${h.state}/${h.why}`);
    fs.rmSync(reg);
    assert.equal((await st()).state, 'unknown', '등록부 파일이 없어도(손상 보존으로 옮겨짐 포함) 단정하지 않는다');
  } finally { fs.writeFileSync(reg, keep); }
  assert.equal((await st()).why, 'vc-removed', '다시 읽히면 예전 판정');
});
