/**
 * v2.621 감사 그룹 F — 서버 분석 화면의 HPE(iLO) 표시와 미지원 서버 '인증' 칸.
 *   WEB-04: 엣지 export · 중앙 원격 수신 정제 · /admin/idrac 행에 BMC 벤더를 싣는다(구버전 엣지 = 필드 없음 = 미상).
 *   WEB-05: 미지원 서버 행에 noCreds(그 벤더 계정이 없어 로그인하지 않음)를 싣는다 — 예전에는 authFailed:false 만 실려
 *           화면이 로그인한 적 없는 장비를 '통과' 라 말했다.
 * 웹 판정(배지·CSV·필터·인증 칸)은 web/src/views/tools/audit2621f.test.js 가 고정한다.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2621f-'));
process.env.CONFIG_DIR = tmp;
process.env.COLLECTOR_TOKEN = 'edge-tok-2621f';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '..', 'src');
const u = (p) => pathToFileURL(path.join(SRC, p)).href;

let registry, agent, remote, adminRouter, unsup;
before(async () => {
  registry = await import('../src/idrac/registry.js');
  agent = await import('../src/collector/agent.js');
  remote = await import('../src/collector/remoteInventory.js');
  ({ adminRouter } = await import('../src/routes/admin.js'));
  unsup = await import('../src/central/unsupportedServers.js');
});
after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

const REG = [
  { id: 'dell-r760', name: 'dell-r760', host: 'https://192.0.2.40', username: 'root', password: 'x', serviceTag: 'DTAG01' },
  { id: 'hpe-dl380', name: 'hpe-dl380', host: 'https://192.0.2.41', username: 'Administrator', password: 'y', serviceTag: 'CZJ0001', vendor: 'hpe' },
];

test('WEB-04 · 엣지 export 가 서버마다 벤더를 싣는다(hpe | dell) — 중앙 수신 정제를 거쳐도 남는다', async () => {
  registry.importServers(REG, 'replace');
  const exp = await agent.buildExport();
  const byId = Object.fromEntries((exp.servers || []).map((s) => [s.id, s]));
  assert.equal(byId['hpe-dl380']?.vendor, 'hpe', 'iLO 로 등록된 서버는 hpe');
  assert.equal(byId['dell-r760']?.vendor, 'dell', '등록부 규약: vendor 없음 = Dell iDRAC — 명시해 보낸다(구버전 엣지의 "필드 없음" 과 구분)');
  // 중앙 pull 경로(sanitizeEdgeExport → sanitizeRemoteServers)가 그 값을 버리지 않는다.
  const clean = remote.sanitizeEdgeExport(exp);
  const cById = Object.fromEntries(clean.servers.map((s) => [s.id, s]));
  assert.equal(cById['hpe-dl380'].vendor, 'hpe');
  assert.equal(cById['dell-r760'].vendor, 'dell');
});

test('WEB-04 · 수신 정제는 hpe·dell 만 받고 그 밖은 버리며 센다 — 필드 없음(구버전 엣지)을 Dell 로 채우지 않는다', () => {
  const r = remote.sanitizeRemoteServers([
    { id: 'old-edge', name: 'a' },                          // 구버전 엣지 — 필드 없음
    { id: 'hpe-up', name: 'b', vendor: ' HPE ' },            // 대소문자·공백 정규화
    { id: 'dell', name: 'c', vendor: 'dell' },
    { id: 'lenovo', name: 'd', vendor: 'lenovo' },            // 모르는 값 — 버리고 센다
    { id: 'obj', name: 'e', vendor: { toString: () => 'hpe' } }, // 객체 — 글자를 지어내지 않는다
  ]);
  const by = Object.fromEntries(r.servers.map((s) => [s.id, s]));
  assert.equal(Object.hasOwn(by['old-edge'], 'vendor'), false, '구버전 엣지 행에 벤더를 채우지 않는다(미상)');
  assert.equal(by['hpe-up'].vendor, 'hpe');
  assert.equal(by.dell.vendor, 'dell');
  assert.equal(Object.hasOwn(by.lenovo, 'vendor'), false);
  assert.equal(Object.hasOwn(by.obj, 'vendor'), false);
  assert.equal(r.coerced, 2, '버린 벤더 값 2개를 센다(조용히 빼지 않는다)');
});

/** GET /admin/idrac 의 마지막 핸들러를 직접 부른다(audit2620e 와 같은 하니스). */
function getIdrac() {
  const layer = adminRouter.stack.find((l) => l.route?.path === '/idrac' && l.route.methods.get);
  assert.ok(layer, '/idrac GET 라우트가 없다');
  const h = layer.route.stack.at(-1).handle;
  return new Promise((resolve, reject) => {
    const res = { code: 200, status(c) { this.code = c; return this; }, json(b) { resolve({ code: this.code, body: b }); } };
    try { h({ query: {}, user: { username: 'full', role: 'admin', scope: null } }, res, (e) => reject(e || new Error('next'))); }
    catch (e) { reject(e); }
  });
}

test('WEB-04 · /admin/idrac 행: 중앙 등록부는 hpe|dell, 원격은 엣지가 보낸 값만(없으면 빈 값 = 미상)', async () => {
  registry.importServers(REG, 'replace');
  remote.setCollectorServers('c-old-2621f', 'Seoul', [{ id: 'r-old', name: 'r-old', serviceTag: 'OLD1', datacenterId: 'dcA' }]);
  remote.setCollectorServers('c-new-2621f', 'Warsaw', [
    { id: 'r-hpe', name: 'r-hpe', serviceTag: 'HPE1', vendor: 'hpe', datacenterId: 'dcB' },
    { id: 'r-dell', name: 'r-dell', serviceTag: 'DEL1', vendor: 'dell', datacenterId: 'dcB' },
  ]);
  try {
    const { code, body } = await getIdrac();
    assert.equal(code, 200);
    const by = Object.fromEntries(body.servers.map((s) => [s.id, s]));
    assert.equal(by['hpe-dl380'].vendor, 'hpe');
    assert.equal(by['dell-r760'].vendor, 'dell');
    assert.equal(by['r-hpe'].vendor, 'hpe');
    assert.equal(by['r-hpe'].remote, true);
    assert.equal(by['r-dell'].vendor, 'dell');
    assert.equal(by['r-old'].vendor, '', '구버전 엣지 서버는 빈 값(미상) — Dell 로 단정하지 않는다');
    assert.equal(by['r-old'].remote, true);
  } finally {
    remote.clearCollectorServers('c-old-2621f');
    remote.clearCollectorServers('c-new-2621f');
  }
});

test('WEB-05 · 중앙 보관소는 noCreds 를 보존한다(참만 참 — 문자열 "true" 를 지어내지 않는다)', () => {
  unsup._resetUnsupportedForTest();
  unsup.saveUnsupportedServers({ agent: 'edge-2621f', datacenterId: 'DC1', service: '' }, [
    { ip: '192.0.2.50', vendor: 'lenovo', noCreds: true },
    { ip: '192.0.2.51', vendor: 'lenovo', noCreds: 'true' },
    { ip: '192.0.2.52', vendor: 'hpe', authFailed: true },
  ]);
  const rows = Object.fromEntries(unsup.listUnsupportedServers({ datacenterId: 'DC1' }).rows.map((r) => [r.ip, r]));
  assert.equal(rows['192.0.2.50'].noCreds, true);
  assert.equal(rows['192.0.2.51'].noCreds, false);
  assert.equal(rows['192.0.2.52'].noCreds, false);
  assert.equal(rows['192.0.2.52'].authFailed, true);
});

test('WEB-05 · scanForIdracs: iLO 전용 대역에서 계정 없이 건너뛴 Lenovo 는 미지원 행에 noCreds:true 로 실린다', () => {
  // probeIdrac 만 바꿔 끼운다(실제 scan.js 의 분기·noteUnsupported 를 그대로 탄다). 가짜 probe 는 실제 probe 처럼
  //   서비스 루트 벤더를 먼저 정하고 credsFor 가 null 을 주면 로그인하지 않고 noCreds 를 돌려준다(redfish.js:443 과 같은 모양).
  const script = `
    import { mock } from 'node:test';
    const ROOTS = { '192.0.2.50': 'lenovo', '192.0.2.51': 'hpe', '192.0.2.52': 'supermicro' };
    mock.module(${JSON.stringify(u('idrac/redfish.js'))}, { namedExports: {
      probeIdrac: async (ip, username, password, _t, { credsFor } = {}) => {
        const vendor = ROOTS[ip] || 'unknown';
        const base = { ok: true, isIdrac: false, dell: false, redfish: true, vendor, vendorLabel: vendor, vendorEvidence: 'root', product: '' };
        if (typeof credsFor === 'function') {
          const c = credsFor(vendor);
          if (!c) return { ...base, authFailed: false, noCreds: true, credSet: '' };
        }
        return { ...base, authFailed: true, noCreds: false };
      },
    } });
    const { scanForIdracs } = await import(${JSON.stringify(u('idrac/scan.js'))});
    // iLO 계정만 있는 대역(Dell 계정 없음) — credsFor('lenovo') 는 null 이다.
    const onlyIlo = await scanForIdracs({ ips: '192.0.2.50\\n192.0.2.52', username: '', password: '', ilo: { username: 'Administrator', password: 'p' }, perHostTimeout: 200 });
    // Dell 계정이 있는 대역 — Lenovo 에도 로그인은 시도한다(거부됨).
    const withDell = await scanForIdracs({ ips: '192.0.2.50', username: 'root', password: 'x', perHostTimeout: 200 });
    console.log('@@' + JSON.stringify({ onlyIlo: onlyIlo.unsupported, withDell: withDell.unsupported }));
    process.exit(0);
  `;
  const r = spawnSync(process.execPath, ['--experimental-test-module-mocks', '--input-type=module', '-e', script],
    { encoding: 'utf8', timeout: 30_000, env: { ...process.env, CONFIG_DIR: tmp } });
  assert.equal(r.status, 0, r.stderr);
  const line = r.stdout.split('\n').find((l) => l.startsWith('@@'));
  assert.ok(line, r.stdout + r.stderr);
  const o = JSON.parse(line.slice(2));
  assert.equal(o.onlyIlo.length, 2);
  for (const row of o.onlyIlo) {
    assert.equal(row.noCreds, true, `${row.ip}: 로그인을 시도하지 않은 장비는 noCreds:true`);
    assert.equal(row.authFailed, false);
  }
  assert.equal(o.withDell.length, 1);
  assert.equal(o.withDell[0].noCreds, false, '계정으로 로그인을 시도한 장비는 noCreds:false');
  assert.equal(o.withDell[0].authFailed, true);
});
