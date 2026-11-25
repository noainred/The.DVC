/**
 * snapHolds3350.test.js — v3.35.0 스냅샷 보류 목록(시안 ⑫ · 사용자 '시안 권장안대로 구현해줘').
 *   ① holdRows — 보류마다 지금 상태(has · none · gone · unknown): 못 읽은 vCenter 의 VM 을 ‘없음’ 으로 단정하지 않는다 · 등록에서 뺀 vCenter 는 gone ·
 *      등록부를 못 읽었으면(registered = null) 단정하지 않는다 · 건 계정은 관리자 판본만 · 범위 → 고른 법인 순
 *   ② GET 라우트 — 상태를 싣는다 · 전체 수(total)는 전체 범위 계정만 · 범위 계정은 자기 범위의 보류만
 *   ③ PUT 풀기 — VM 이 인벤토리에 없어도 그 보류가 목록에 있으면 푼다(예전 404) · 걸기 · 연장은 여전히 VM 이 있어야 · 조회 밖 404 → 쓰기 밖 403
 *   ④ POST 여러 건 풀기 — 하나라도 조회 밖 · 목록에 없음이면 404 이고 아무것도 풀지 않는다 · 쓰기 밖 403 · 모양 400 · 파일은 한 번만 쓴다 · 관리자만
 * 실제 api 라우터를 index.js 순서(queryNormalizer → express.json → 사용자 → 라우터)로 띄운다(로그인 켠 채 — 역할 · 범위 판정이 돈다).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const DIR = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'snapholds3350-'));
Object.assign(process.env, { CONFIG_DIR: DIR, DB_DIR: DIR, AUTH_ENABLED: 'true', DATA_SOURCE: 'mock', API_RATE_DISABLED: 'true', SNAPHIST_DB_PATH: path.join(DIR, 'snap-history.db') });
delete process.env.CENTRAL_URL;

const DAY = 86_400_000;
const NOW = Math.floor(Date.now() / 3_600_000) * 3_600_000;   // 정시 경계(docs/rules/common.md)
// 등록부: vc-9 는 등록에서 뺐다(보류만 남음)
fs.writeFileSync(path.join(DIR, 'vcenters.json'), JSON.stringify({ vcenters: [{ id: 'vc-1', name: 'Seoul', host: '127.0.0.1' }, { id: 'vc-2', name: 'Warsaw', host: '127.0.0.1' }, { id: 'vc-3', name: 'Dallas', host: '127.0.0.1' }] }));

const express = (await import('express')).default;
const { queryNormalizer } = await import('../src/util/queryNormalize.js');
const { store } = await import('../src/store.js');
const { holdRows, HOLD_STATES } = await import('../src/snaphist/view.js');
const { setHold, loadHolds, releaseHolds, HOLDS_FILE_NAME, _resetHoldsForTest } = await import('../src/vmhygiene/holds.js');

const INV = {
  generatedAt: new Date(NOW).toISOString(), source: 'mock',
  vcenters: [{ id: 'vc-1', name: 'Seoul', status: 'connected' }, { id: 'vc-2', name: 'Warsaw', status: 'connected' }, { id: 'vc-3', name: 'Dallas', status: 'pending' }],
  hosts: [], datastores: [], alarms: [], networks: [],
  vms: [
    { id: 'vc-1:a', vcenterId: 'vc-1', name: 'erp-app-02', cluster: 'CL1', snapshotCount: 2, snapshotSizeGB: 10, snapshotOldestTs: NOW - 10 * DAY },
    { id: 'vc-1:b', vcenterId: 'vc-1', name: 'db-ap-0133', snapshotCount: 0, snapshotSizeGB: 0 },
    { id: 'vc-1:n', vcenterId: 'vc-1', name: 'no-count' },
    { id: 'vc-2:c', vcenterId: 'vc-2', name: 'web-eu-0205', snapshotCount: 1, snapshotSizeGB: 2, snapshotOldestTs: NOW - DAY },
  ],
};
store.snapshot = INV;

const USERS = {
  fadm: { username: 'fadm', role: 'admin' },                                                            // 전체 범위 관리자
  sadm: { username: 'sadm', role: 'admin', scope: { vcenters: ['vc-1'] } },                             // 범위 관리자(vc-1)
  wadm: { username: 'wadm', role: 'admin', scope: { vcenters: ['vc-1', 'vc-2'], writeVcenters: ['vc-1'] } },   // vc-2 는 조회만
  op: { username: 'op', role: 'operator' },                                                             // 관리자 아님
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

/** 보류를 처음 모양으로 — 보류는 VM 이 있을 때 걸렸다(gone1 · y 는 그 뒤 VM · vCenter 가 사라졌다). */
const SEED = [['vc-1', 'vc-1:a', 'erp-app-02'], ['vc-1', 'vc-1:b', 'db-ap-0133'], ['vc-1', 'vc-1:gone1', 'tmp-restore-eu-07'], ['vc-1', 'vc-1:n', 'no-count'],
  ['vc-3', 'vc-3:x', 'mes-cn-011'], ['vc-9', 'vc-9:y', 'batch-kr-0412'], ['vc-2', 'vc-2:c', 'web-eu-0205'], ['vc-2', 'vc-2:gone2', 'old-eu-01']];
function seed() {
  const f = path.join(DIR, HOLDS_FILE_NAME);
  try { fs.rmSync(f); } catch { /* 없음 */ }
  _resetHoldsForTest();
  for (const [vcenterId, vmId, vmName] of SEED) assert.equal(setHold({ vcenterId, vmId, vmName, days: 30, reason: `사유 ${vmName}` }, 'kim.ops', NOW).ok, true);
}
const heldKeys = () => loadHolds().holds.map((h) => h.vmId).sort();

test('① holdRows — 지금 상태 · 못 읽은 vCenter 는 단정하지 않음 · 등록에서 뺀 vCenter · 건 계정 · 범위', () => {
  seed();
  const holds = loadHolds(NOW).holds;
  const reg = new Set(['vc-1', 'vc-2', 'vc-3']);
  const rows = holdRows(INV, holds, { now: NOW, registered: reg, admin: true });
  const by = new Map(rows.map((r) => [r.vmId, r]));
  assert.deepEqual([...HOLD_STATES], ['has', 'none', 'gone', 'unknown']);
  assert.equal(by.get('vc-1:a').state, 'has'); assert.equal(by.get('vc-1:a').snapshotCount, 2); assert.equal(by.get('vc-1:a').snapGB, 10); assert.equal(by.get('vc-1:a').days, 10);
  assert.equal(by.get('vc-1:a').cluster, 'CL1'); assert.equal(by.get('vc-1:a').corpName, 'Seoul');
  assert.equal(by.get('vc-1:b').state, 'none'); assert.equal(by.get('vc-1:b').snapshotCount, 0);
  assert.equal(by.get('vc-1:gone1').state, 'gone', '읽을 수 있는 vCenter 에 없는 VM 은 gone');
  assert.equal(by.get('vc-1:gone1').vmName, 'tmp-restore-eu-07', '없는 VM 은 걸 때 적어 둔 이름');
  assert.equal(by.get('vc-1:n').state, 'unknown', '개수를 못 읽은 VM 은 스냅샷 없음이 아니다'); assert.equal(by.get('vc-1:n').why, 'no-count');
  assert.equal(by.get('vc-3:x').state, 'unknown', '첫 수집 중(pending) vCenter 의 VM 을 ‘없음’ 으로 단정하지 않는다'); assert.equal(by.get('vc-3:x').why, 'pending');
  assert.equal(by.get('vc-9:y').state, 'gone'); assert.equal(by.get('vc-9:y').why, 'vc-removed');
  assert.equal(by.get('vc-1:a').by, 'kim.ops', '관리자 판본은 건 계정을 싣는다');
  // 등록부를 못 읽었으면(registered = null) 등록에서 뺐다고 단정하지 않는다
  assert.equal(holdRows(INV, holds, { now: NOW, registered: null }).find((r) => r.vmId === 'vc-9:y').state, 'unknown');
  // 관리자 판본이 아니면 건 계정은 null
  assert.ok(holdRows(INV, holds, { now: NOW, registered: reg }).every((r) => r.by === null));
  // 점검중 vCenter(unreadVcenterReasons) 의 VM 도 단정하지 않는다
  const maint = { ...INV, vcenters: INV.vcenters.map((v) => (v.id === 'vc-1' ? { ...v, status: 'maintenance', maintenance: true } : v)) };
  const g = holdRows(maint, holds, { now: NOW, registered: reg }).find((r) => r.vmId === 'vc-1:gone1');
  assert.equal(g.state, 'unknown', '점검중 vCenter 의 VM 은 VM 없음이 아니다');
  // 범위 → 고른 법인
  assert.deepEqual(holdRows(INV, holds, { now: NOW, allowed: new Set(['vc-2']) }).map((r) => r.vmId).sort(), ['vc-2:c', 'vc-2:gone2']);
  assert.deepEqual(holdRows(INV, holds, { now: NOW, pick: new Set(['vc-3']) }).map((r) => r.vmId), ['vc-3:x']);
});

test('② GET — 상태를 싣는다 · 전체 수는 전체 범위만 · 범위 계정은 자기 범위의 보류만', async () => {
  seed();
  const f = await send('fadm', 'GET', '/api/tools/snapshots/holds');
  assert.equal(f.status, 200); assert.equal(f.body.holds.length, SEED.length); assert.equal(f.body.total, SEED.length); assert.equal(f.body.max, 2000);
  const st = Object.fromEntries(f.body.holds.map((r) => [r.vmId, r.state]));
  assert.equal(st['vc-1:gone1'], 'gone'); assert.equal(st['vc-9:y'], 'gone'); assert.equal(st['vc-3:x'], 'unknown'); assert.equal(st['vc-1:a'], 'has');
  assert.equal(f.body.holds.find((r) => r.vmId === 'vc-9:y').why, 'vc-removed', '라우트가 등록부를 읽어 넘긴다');
  assert.equal(f.body.holds[0].by, 'kim.ops');
  const s = await send('sadm', 'GET', '/api/tools/snapshots/holds');
  assert.equal(s.status, 200); assert.ok(s.body.holds.every((r) => r.vcenterId === 'vc-1')); assert.equal(s.body.total, null, '범위 밖 보류 수를 흘리지 않는다');
  const p = await send('fadm', 'GET', '/api/tools/snapshots/holds?vcenterIds=vc-2');
  assert.deepEqual(p.body.holds.map((r) => r.vmId).sort(), ['vc-2:c', 'vc-2:gone2'], '고른 법인으로 거른다');
});

test('③ PUT — VM 이 없어도 목록에 있는 보류는 푼다 · 걸기는 VM 이 있어야 · 조회 밖 404 → 쓰기 밖 403', async () => {
  seed();
  assert.equal((await send('fadm', 'PUT', '/api/tools/snapshots/holds', { vcenterId: 'vc-1', vmId: 'vc-1:gone1', days: 30, reason: '연장' })).status, 404, '없는 VM 에 걸기 · 연장은 여전히 404');
  assert.equal((await send('fadm', 'PUT', '/api/tools/snapshots/holds', { vcenterId: 'vc-1', vmId: 'vc-1:nohold', days: 0 })).status, 404, '보류도 VM 도 없으면 404');
  assert.equal((await send('sadm', 'PUT', '/api/tools/snapshots/holds', { vcenterId: 'vc-9', vmId: 'vc-9:y', days: 0 })).status, 404, '조회 밖은 보류가 있어도 404');
  assert.equal((await send('wadm', 'PUT', '/api/tools/snapshots/holds', { vcenterId: 'vc-2', vmId: 'vc-2:gone2', days: 0 })).status, 403, '조회는 되고 쓰기 밖이면 403');
  assert.equal((await send('op', 'PUT', '/api/tools/snapshots/holds', { vcenterId: 'vc-1', vmId: 'vc-1:gone1', days: 0 })).status, 403, '관리자만');
  assert.ok(heldKeys().includes('vc-1:gone1') && heldKeys().includes('vc-2:gone2') && heldKeys().includes('vc-9:y'), '거절된 요청은 아무것도 풀지 않는다');
  const r = await send('fadm', 'PUT', '/api/tools/snapshots/holds', { vcenterId: 'vc-1', vmId: 'vc-1:gone1', days: 0 });
  assert.equal(r.status, 200); assert.equal(r.body.hold, null);
  assert.equal(heldKeys().includes('vc-1:gone1'), false, '지워진 VM 의 보류가 풀렸다');
  assert.equal((await send('fadm', 'PUT', '/api/tools/snapshots/holds', { vcenterId: 'vc-9', vmId: 'vc-9:y', days: 0 })).status, 200, '등록에서 뺀 vCenter 의 보류도 푼다');
  assert.equal((await send('fadm', 'PUT', '/api/tools/snapshots/holds', { vcenterId: 'vc-1', vmId: 'vc-1:gone1', days: 0 })).status, 404, '이미 풀린 것은 404');
  // VM 이 있으면 예전 그대로(연장)
  const e = await send('fadm', 'PUT', '/api/tools/snapshots/holds', { vcenterId: 'vc-1', vmId: 'vc-1:a', days: 60, reason: '연장' });
  assert.equal(e.status, 200); assert.equal(e.body.hold.reason, '연장');
});

test('④ POST 여러 건 풀기 — 전부 아니면 0 · 404 → 403 · 모양 400 · 한 번 쓰기 · 관리자만', async () => {
  seed();
  const before = heldKeys();
  const url = '/api/tools/snapshots/holds/release';
  // 하나라도 목록에 없으면 404 · 아무것도 풀지 않는다
  let r = await send('fadm', 'POST', url, { keys: [{ vcenterId: 'vc-1', vmId: 'vc-1:gone1' }, { vcenterId: 'vc-1', vmId: 'vc-1:nohold' }] });
  assert.equal(r.status, 404); assert.equal(r.body.missing, 1); assert.deepEqual(heldKeys(), before);
  // 조회 밖 키가 섞이면 404(존재 은닉) · 아무것도 풀지 않는다
  r = await send('sadm', 'POST', url, { keys: [{ vcenterId: 'vc-1', vmId: 'vc-1:gone1' }, { vcenterId: 'vc-2', vmId: 'vc-2:c' }] });
  assert.equal(r.status, 404); assert.deepEqual(heldKeys(), before);
  // 쓰기 밖 403 · 아무것도 풀지 않는다
  r = await send('wadm', 'POST', url, { keys: [{ vcenterId: 'vc-1', vmId: 'vc-1:gone1' }, { vcenterId: 'vc-2', vmId: 'vc-2:gone2' }] });
  assert.equal(r.status, 403); assert.deepEqual(heldKeys(), before);
  // 모양
  for (const body of [{}, { keys: [] }, { keys: 'vc-1' }, { keys: [{ vcenterId: { toString: 1 }, vmId: 'x' }] }, { keys: [['vc-1', 'vc-1:a']] }]) {
    r = await send('fadm', 'POST', url, body);
    assert.equal(r.status, 400, JSON.stringify(body)); assert.equal(r.body.field, 'keys');
  }
  assert.equal((await send('op', 'POST', url, { keys: [{ vcenterId: 'vc-1', vmId: 'vc-1:gone1' }] })).status, 403, '관리자만');
  assert.deepEqual(heldKeys(), before);
  // 성공 — 파일은 한 번만 쓴다(같은 키 두 번은 한 번으로)
  const file = path.join(DIR, HOLDS_FILE_NAME);
  const orig = fs.renameSync; let writes = 0;
  fs.renameSync = function patched(a, b) { if (b === file) writes += 1; return orig.apply(this, arguments); };
  try {
    r = await send('fadm', 'POST', url, { keys: [{ vcenterId: 'vc-1', vmId: 'vc-1:gone1' }, { vcenterId: 'vc-9', vmId: 'vc-9:y' }, { vcenterId: 'vc-3', vmId: 'vc-3:x' }, { vcenterId: 'vc-9', vmId: 'vc-9:y' }] });
  } finally { fs.renameSync = orig; }
  assert.equal(r.status, 200); assert.equal(r.body.released, 3);
  assert.equal(writes, 1, '여러 건을 풀어도 파일은 한 번만 쓴다');
  assert.deepEqual(heldKeys(), before.filter((k) => !['vc-1:gone1', 'vc-9:y', 'vc-3:x'].includes(k)));
});

test('⑤ releaseHolds — 못 읽은 파일 위에는 쓰지 않는다(503) · 목록에 없는 키는 건너뛴다', () => {
  seed();
  assert.deepEqual(releaseHolds([{ vcenterId: 'vc-1', vmId: 'nope' }], NOW).released, []);
  const f = path.join(DIR, HOLDS_FILE_NAME); const keep = fs.readFileSync(f, 'utf8');
  fs.rmSync(f); fs.mkdirSync(f); _resetHoldsForTest();
  assert.equal(releaseHolds([{ vcenterId: 'vc-1', vmId: 'vc-1:a' }], NOW).status, 503);
  fs.rmSync(f, { recursive: true }); fs.writeFileSync(f, keep); _resetHoldsForTest();
  assert.equal(loadHolds(NOW).holds.length, SEED.length);
});
