// v2.771 점검 6회차 수정 그룹 c(IPAM) — R6-F2-1 ~ F2-4 회귀.
//   F2-1 범위 계정 /24 시트(·엑셀 — 같은 생성기)에 범위 밖 IP 의 메모·태그와 전역 정책이 실리던 것
//   F2-2 본문 claimedVcenterId '' 가 기존 claim 으로 판정돼 범위 계정이 전역(미귀속) 예약을 만들던 것(PUT·bulk·CSV)
//   F2-3 엣지가 보낸 비정규 IPv4 표기를 스캔 결과·이력 키로 그대로 쓰던 것(+ 이미 저장된 비정규 키는 로드에서 합친다)
//   F2-4 범위 계정의 /8 정책 하나가 함대 전체 스캔 보존 정리를 끄던 것(정책 크기 상한 /16)
// 재현 스크립트(scratchpad r6/f2/repro_*.mjs)를 옮겼다. 라우트는 실제 api 라우터를 express 에 띄워 상태코드로 본다.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2771c-'));
process.env.CONFIG_DIR = TMP;
process.env.DATA_SOURCE = 'mock';
process.env.AUTH_ENABLED = 'true';

// 기준 시각 — 실제 시각을 정시 경계로 떨어뜨려 고정(docs/rules/common.md).
const BASE = Math.floor(Date.now() / 3_600_000) * 3_600_000;

fs.writeFileSync(path.join(TMP, 'vcenters.json'), JSON.stringify({ vcenters: [
  { id: 'vc-a', name: 'A', host: 'https://10.9.9.1', username: 'u', password: 'p' },
  { id: 'vc-b', name: 'B', host: 'https://10.9.9.2', username: 'u', password: 'p' },
] }));
// F2-3 로드 정제: 옛 판본이 남긴 비정규 키(같은 IP 두 표기 + 한 표기만 있는 IP).
fs.writeFileSync(path.join(TMP, 'ipam-scan-results.json'), JSON.stringify({
  '10.60.0.5': { ip: '10.60.0.5', openPorts: [22], services: [], hostname: '', lastSeen: BASE - 7_200_000, agent: 'edge-old' },
  '010.60.0.5': { ip: '010.60.0.5', openPorts: [443], services: [], hostname: '', lastSeen: BASE - 3_600_000, agent: 'edge-new' },
  '10.060.000.009': { ip: '10.060.000.009', openPorts: [80], services: [], hostname: '', lastSeen: BASE - 3_600_000, agent: 'edge-x' },
}));
fs.writeFileSync(path.join(TMP, 'ipam-scan-history.json'), JSON.stringify({
  '10.60.0.5': { ip: '10.60.0.5', firstSeen: BASE - 9_000_000, lastSeen: BASE - 7_200_000, status: 'up', agent: 'edge-old', events: [] },
  '010.60.0.5': { ip: '010.60.0.5', firstSeen: BASE - 8_000_000, lastSeen: BASE - 3_600_000, status: 'up', agent: 'edge-new', events: [] },
  '10.060.000.009': { ip: '10.060.000.009', firstSeen: BASE - 8_000_000, lastSeen: BASE - 3_600_000, status: 'up', agent: 'edge-x', events: [] },
}));

const USERS = {
  full: { username: 'full', role: 'admin' },
  opA: { username: 'opA', role: 'operator', scope: { vcenters: ['vc-a'] } },
  sadmA: { username: 'sadmA', role: 'admin', scope: { vcenters: ['vc-a'] } },
  // 조회 전체 + 쓰기 vc-a 만
  opW: { username: 'opW', role: 'operator', scope: { writeVcenters: ['vc-a'] } },
};
let server; let base;
before(async () => {
  const express = (await import('express')).default;
  const { api } = await import('../src/routes/api.js');
  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use((req, _res, next) => { req.user = USERS[req.headers['x-u']] || null; next(); });
  app.use('/api', api);
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
});
after(() => {
  try { server?.close(); } catch { /* */ }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ }
});
async function call(u, method, p, body) {
  const r = await fetch(`${base}${p}`, { method, headers: { 'x-u': u, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch { /* */ }
  return { status: r.status, body: j };
}

// ---- F2-1 ------------------------------------------------------------------------------------------
test('R6-F2-1: 범위 계정 /24 시트에 범위 밖 IP 메모·태그·전역 정책이 실리지 않는다(전체 계정은 그대로)', async () => {
  const { setAnnotation } = await import('../src/ipam/annotations.js');
  const { setPolicy, deletePolicy } = await import('../src/ipam/rangePolicies.js');
  const { setOverride, clearOverride } = await import('../src/ipam/overrides.js');
  const { buildSubnetSheets, buildSubnetSheetsAsync } = await import('../src/ipam/ledger.js');
  setAnnotation('10.1.1.7', { memo: 'vc-b 법인 비밀 메모', tags: ['corp-b'] }, { username: 'adminB' });
  setAnnotation('10.1.1.5', { memo: 'vc-a 메모', tags: ['corp-a'] }, { username: 'adminA' });
  setAnnotation('10.1.1.20', { memo: '소유 VM 없는 IP 메모(claim vc-a)', tags: [] }, { username: 'adminA' });
  setAnnotation('10.1.1.21', { memo: '소유 VM 없는 IP 메모(claim 없음)', tags: [] }, { username: 'full' });
  setOverride('10.1.1.20', { status: 'reserved', claimedVcenterId: 'vc-a' }, { username: 'adminA' });
  const g = setPolicy({ spec: '10.1.1.0/24', status: 'reserved', label: '전역 정책 라벨' }, { username: 'full' });
  const a = setPolicy({ spec: '10.1.1.128/25', status: 'reserved', label: 'vc-a 정책', claimedVcenterId: 'vc-a' }, { username: 'full' });
  assert.ok(g.ok && a.ok);
  try {
    const snap = { generatedAt: BASE + 1, vcenters: [{ id: 'vc-a', name: 'A' }, { id: 'vc-b', name: 'B' }],
      vms: [{ id: 'vc-a:vm-1', name: 'a1', vcenterId: 'vc-a', ipAddresses: ['10.1.1.5'] },
        { id: 'vc-b:vm-2', name: 'b-db', vcenterId: 'vc-b', ipAddresses: ['10.1.1.7'] }], hosts: [] };
    const allowed = new Set(['vc-a']);
    const cellOf = (sheet, ip) => sheet.rows.find((r) => r.ip === ip);
    for (const build of [
      (o) => buildSubnetSheets(snap, o),
      (o) => buildSubnetSheetsAsync(snap, o), // 엑셀 내보내기 경로(같은 생성기)
    ]) {
      const [s] = await build({ vcenterId: '', onlyBase: '10.1.1', allowed, cache: false });
      assert.equal(cellOf(s, '10.1.1.7').memo, '', '범위 밖(vc-b) VM IP 메모 — 예전: 실렸다');
      assert.deepEqual(cellOf(s, '10.1.1.7').tags, []);
      assert.equal(cellOf(s, '10.1.1.21').memo, '', '소유 VM 도 claim 도 없는 IP 메모는 범위 계정에 숨김(GET /annotation 과 같다)');
      assert.equal(cellOf(s, '10.1.1.5').memo, 'vc-a 메모', '범위 안 VM IP 메모는 보인다');
      assert.equal(cellOf(s, '10.1.1.20').memo, '소유 VM 없는 IP 메모(claim vc-a)', 'claim 이 범위 안이면 보인다');
      assert.ok(!s.policies.some((p) => p.id === g.policy.id), '전역 정책 미노출 — 예전: 실렸다');
      assert.ok(!s.rows.some((r) => r.purpose === '정책: 전역 정책 라벨'), '빈 칸 정책 덧칠에도 전역 정책 라벨이 없다');
    }
    // vc-a 를 고른 범위 계정 시트에는 vc-a 귀속 정책이 보인다(GET /policies 와 같은 필터).
    const [sa] = buildSubnetSheets(snap, { vcenterId: 'vc-a', onlyBase: '10.1.1', allowed, cache: false });
    assert.deepEqual(sa.policies.map((p) => p.id), [a.policy.id]);
    // 전체 계정은 불변.
    const [sf] = buildSubnetSheets(snap, { vcenterId: '', onlyBase: '10.1.1', allowed: null, cache: false });
    assert.equal(cellOf(sf, '10.1.1.7').memo, 'vc-b 법인 비밀 메모');
    assert.equal(cellOf(sf, '10.1.1.21').memo, '소유 VM 없는 IP 메모(claim 없음)');
    assert.ok(sf.policies.some((p) => p.id === g.policy.id));
  } finally {
    deletePolicy(g.policy.id); deletePolicy(a.policy.id); clearOverride('10.1.1.20');
  }
});

test('R6-F2-1: 판정 코어는 하나 — 시트와 라우트가 같은 ipInWriteScope 를 쓴다', async () => {
  const L = await import('../src/ipam/ledger.js');
  const R = await import('../src/routes/api/ipamExport.js');
  assert.equal(R.ipInWriteScope, L.ipInWriteScope);
});

// ---- F2-2 ------------------------------------------------------------------------------------------
test('R6-F2-2: 범위 계정이 PUT 으로 claim 을 비워 전역 예약을 만들 수 없다', async () => {
  const ip = '10.250.99.7'; // 어느 VM 도 쓰지 않는 IP
  assert.equal((await call('opA', 'PUT', `/tools/ipam/ip/${ip}`, { status: 'reserved', label: 'x' })).status, 404, 'claim 없는 새 예약은 예전처럼 404');
  assert.equal((await call('opA', 'PUT', `/tools/ipam/ip/${ip}`, { status: 'reserved', label: 'A-예약', claimedVcenterId: 'vc-a' })).status, 200);
  const r = await call('opA', 'PUT', `/tools/ipam/ip/${ip}`, { claimedVcenterId: '' });
  assert.equal(r.status, 404, `예전: 200(claim '' 저장) — ${JSON.stringify(r.body)}`);
  assert.equal((await call('opA', 'PUT', `/tools/ipam/ip/${ip}`, { claimedVcenterId: null })).status, 404, 'null 도 귀속 지움(저장 규칙과 같다)');
  const g = await call('opA', 'GET', `/tools/ipam/ip/${ip}`);
  assert.equal(g.status, 200);
  assert.equal(g.body.override.claimedVcenterId, 'vc-a', 'claim 이 그대로 남는다');
  // 키가 없는 부분 수정은 기존 claim 으로 판정(불변).
  assert.equal((await call('opA', 'PUT', `/tools/ipam/ip/${ip}`, { label: 'A-예약2' })).status, 200);
  // 조회 전체 + 쓰기 vc-a 계정도 claim 비우기는 403.
  assert.equal((await call('opW', 'PUT', `/tools/ipam/ip/${ip}`, { claimedVcenterId: '' })).status, 403);
  // 전체 범위 계정 동작 불변 — claim 을 비울 수 있다.
  const f = await call('full', 'PUT', `/tools/ipam/ip/${ip}`, { claimedVcenterId: '' });
  assert.equal(f.status, 200);
  assert.equal(f.body.override.claimedVcenterId, '');
  assert.equal((await call('full', 'DELETE', `/tools/ipam/ip/${ip}`)).status, 200);
});

test('R6-F2-2: 일괄 적용(bulk)도 fields.claimedVcenterId 키가 있으면 빈 값을 새 claim 으로 판정', async () => {
  const ip = '10.250.99.8';
  assert.equal((await call('opA', 'POST', '/tools/ipam/bulk', { ips: [ip], status: 'reserved', claimedVcenterId: 'vc-a' })).status, 200);
  const r = await call('opA', 'POST', '/tools/ipam/bulk', { ips: [ip], claimedVcenterId: '' });
  assert.equal(r.status, 403, `예전: 200 — ${JSON.stringify(r.body)}`);
  assert.equal((await call('opA', 'GET', `/tools/ipam/ip/${ip}`)).body.override.claimedVcenterId, 'vc-a');
  assert.equal((await call('opA', 'POST', '/tools/ipam/bulk', { ips: [ip], owner: 'A팀' })).status, 200, '키 없으면 기존 claim(불변)');
  assert.equal((await call('full', 'POST', '/tools/ipam/bulk', { ips: [ip], claimedVcenterId: '' })).status, 200, '전체 계정 불변');
  await call('full', 'DELETE', `/tools/ipam/ip/${ip}`);
});

test('R6-F2-2: CSV 가져오기의 귀속 빈 칸도 새 claim 으로 판정(범위 계정 거부)', async () => {
  const ip = '10.250.99.9';
  assert.equal((await call('sadmA', 'PUT', `/tools/ipam/ip/${ip}`, { status: 'reserved', label: 'A', claimedVcenterId: 'vc-a' })).status, 200);
  const csv = `ip,label,vcenter\n${ip},A2,\n`;
  const r = await call('sadmA', 'POST', '/tools/ipam/manage/import', { csv, dryRun: false });
  assert.equal(r.status, 200);
  assert.equal(r.body.applied, 0, `예전: 1(claim '' 저장) — ${JSON.stringify(r.body.report)}`);
  assert.equal((await call('sadmA', 'GET', `/tools/ipam/ip/${ip}`)).body.override.claimedVcenterId, 'vc-a');
  // 귀속 열이 없는 파일은 기존 claim 으로 판정(불변).
  const r2 = await call('sadmA', 'POST', '/tools/ipam/manage/import', { csv: `ip,label\n${ip},A3\n`, dryRun: false });
  assert.equal(r2.body.applied, 1);
  // 전체 계정 불변.
  const r3 = await call('full', 'POST', '/tools/ipam/manage/import', { csv, dryRun: false });
  assert.equal(r3.body.applied, 1);
  assert.equal((await call('full', 'GET', `/tools/ipam/ip/${ip}`)).body.override.claimedVcenterId, '');
  await call('full', 'DELETE', `/tools/ipam/ip/${ip}`);
});

test('R6-F2-2: manageCsv 는 귀속 열이 없으면 verdict 에 undefined 를 넘긴다(열이 있으면 빈 값 그대로)', async () => {
  const { parseManageCsv, analyzeManageImport } = await import('../src/ipam/manageCsv.js');
  const seen = [];
  const ctx = { getOverride: () => ({ claimedVcenterId: 'vc-a' }), getAnnotation: () => null, resolveVc: (s) => s,
    verdict: (ip, claimed) => { seen.push(claimed); return null; }, statuses: ['reserved'], deviceTypes: [], dayOf: () => '' };
  for (const text of ['ip,label\n10.9.0.1,x\n', 'ip,label,vcenter\n10.9.0.1,x,\n']) {
    const p = parseManageCsv(text, {});
    analyzeManageImport(p.rows, p.columns, ctx);
  }
  assert.deepEqual(seen, [undefined, '']);
});

// ---- F2-3 ------------------------------------------------------------------------------------------
test('R6-F2-3: mergeScanResults 는 정규형 키로 저장한다(비정규 표기 = 같은 IP)', async () => {
  const { mergeScanResults, getScanResults, getIpHistory } = await import('../src/ipam/scanStore.js');
  const { buildIpamRows } = await import('../src/ipam/ledger.js');
  const before = Object.keys(getScanResults()).length;
  mergeScanResults([{ ip: '10.1.2.5', openPorts: [22] }, { ip: '010.1.2.5', openPorts: [22] }, { ip: '10.001.002.005', openPorts: [80] }], BASE, 'edge-x');
  const res = getScanResults();
  assert.equal(Object.keys(res).length - before, 1, '예전: 3(표기마다 별도 행)');
  assert.ok(res['10.1.2.5']);
  assert.ok(!('010.1.2.5' in res) && !('10.001.002.005' in res));
  assert.ok(getIpHistory('10.1.2.5'));
  assert.equal(getIpHistory('010.1.2.5'), null);
  // 원장: VM 의 정규형 IP 와 같은 행으로 합쳐진다(미등록 '(네트워크 스캔)' 장비로 따로 보이지 않는다).
  const snap = { generatedAt: BASE + 2, vcenters: [{ id: 'vc-a', name: 'A' }], vms: [{ id: 'vc-a:1', name: 'web', vcenterId: 'vc-a', ipAddresses: ['10.1.2.5'] }], hosts: [] };
  const rows = buildIpamRows(snap, '', null).rows.filter((r) => /^0*10\.0*1\.0*2\.0*5$/.test(r.ip));
  assert.deepEqual(rows.map((r) => r.ip), ['10.1.2.5']);
});

test('R6-F2-3: 이미 저장된 비정규 키는 로드에서 정규 키로 합친다(결과·이력)', async () => {
  const { getScanResults, getIpHistory } = await import('../src/ipam/scanStore.js');
  const res = getScanResults();
  assert.ok(!('010.60.0.5' in res) && !('10.060.000.009' in res));
  assert.equal(res['10.60.0.5'].agent, 'edge-new', '같은 IP 두 표기는 마지막 확인이 늦은 쪽');
  assert.deepEqual(res['10.60.0.5'].openPorts, [443]);
  assert.equal(res['10.60.0.9'].ip, '10.60.0.9');
  const h = getIpHistory('10.60.0.5');
  assert.equal(h.ip, '10.60.0.5');
  assert.equal(h.agent, 'edge-new');
  assert.equal(h.firstSeen, BASE - 9_000_000, 'firstSeen 은 이른 쪽');
  assert.equal(getIpHistory('010.60.0.5'), null);
  assert.equal(getIpHistory('10.60.0.9').ip, '10.60.0.9');
});

// ---- F2-4 ------------------------------------------------------------------------------------------
test('R6-F2-4: 범위 계정의 대역 정책은 /16 이하만(전체 계정은 불변)', async () => {
  const { deletePolicy } = await import('../src/ipam/rangePolicies.js');
  const wide = await call('opA', 'POST', '/tools/ipam/policies', { spec: '10.0.0.0/8', status: 'reserved', claimedVcenterId: 'vc-a' });
  assert.equal(wide.status, 400, `예전: 200 — ${JSON.stringify(wide.body)}`);
  assert.equal((await call('opA', 'POST', '/tools/ipam/policies', { spec: '10.0.0.0-10.1.0.1', status: 'reserved', claimedVcenterId: 'vc-a' })).status, 400, '범위 표기도');
  assert.equal((await call('opW', 'POST', '/tools/ipam/policies', { spec: '10.0.0.0/15', status: 'reserved', claimedVcenterId: 'vc-a' })).status, 400, '쓰기 범위 계정도');
  const ok = await call('opA', 'POST', '/tools/ipam/policies', { spec: '10.20.0.0/16', status: 'reserved', claimedVcenterId: 'vc-a' });
  assert.equal(ok.status, 200);
  const id = ok.body.policy.id;
  assert.equal((await call('opA', 'PUT', `/tools/ipam/policies/${id}`, { spec: '10.0.0.0/8' })).status, 400, '수정으로 넓히기도 거부');
  assert.equal((await call('opA', 'PUT', `/tools/ipam/policies/${id}`, { label: '라벨만' })).status, 200, '대역을 안 바꾸는 수정은 허용');
  const f = await call('full', 'POST', '/tools/ipam/policies', { spec: '10.0.0.0/8', status: 'reserved', claimedVcenterId: 'vc-a' });
  assert.equal(f.status, 200, '전체 범위 계정 불변');
  // 전체 계정이 만든 넓은 vc-a 귀속 정책의 라벨은 범위 계정이 고칠 수 있다(대역 변경이 아니다).
  assert.equal((await call('opA', 'PUT', `/tools/ipam/policies/${f.body.policy.id}`, { label: '넓은 정책' })).status, 200);
  deletePolicy(id); deletePolicy(f.body.policy.id);
});

test('R6-F2-4: isCoveredByAnyPolicy 의 귀속 무시(v2.287)는 그대로 — 전역·귀속 정책 모두 관리 IP', async () => {
  const { setPolicy, deletePolicy, isCoveredByAnyPolicy } = await import('../src/ipam/rangePolicies.js');
  const { ipToNum } = await import('../src/util/ipv4.js');
  const p = setPolicy({ spec: '10.77.0.0/16', status: 'reserved', claimedVcenterId: 'vc-a' }, { username: 'full' });
  try { assert.equal(isCoveredByAnyPolicy(ipToNum('10.77.3.4')), true); } finally { deletePolicy(p.policy.id); }
});
