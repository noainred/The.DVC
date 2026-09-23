/**
 * v2.593 — 4차 점검(7축 병렬 감사 + 축별 반증 검증) 확정분 회귀 고정.
 *
 * 각 테스트는 **수정을 되돌리면 실패하도록** 입력을 골랐다(변이 검증은 릴리스 노트에 기록).
 * 라우트 권한은 소스 grep 이 아니라 **실제 라우터를 띄워 응답으로** 본다(v2.506·v2.536 교훈).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { stripComments } from './_stripComments.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../src');
const read = (p) => stripComments(fs.readFileSync(path.join(SRC, p), 'utf8'));

/* ── R2593-01 iDRAC 세션 동시 생성 — 뒤 요청이 앞 요청의 세션을 지워 거짓 401 이 나던 것 ── */
test('R2593-01 — 같은 키로 동시에 캐시를 놓쳐도 세션은 하나만 만들고 401 이 나지 않는다', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2593-rf-'));
  const script = `
    import http from 'node:http';
    const valid = new Set(); let n = 0, del = 0, get401 = 0;
    const srv = http.createServer((req, res) => {
      let b = ''; req.on('data', (d) => b += d); req.on('end', () => {
        if (req.method === 'POST' && req.url === '/redfish/v1/SessionService/Sessions') {
          const t = 'tok' + (++n); valid.add(t);
          setTimeout(() => { res.writeHead(201, { 'X-Auth-Token': t, Location: '/redfish/v1/SessionService/Sessions/' + n }); res.end('{}'); }, 20 * n);
          return;
        }
        if (req.method === 'DELETE') { del++; valid.delete('tok' + req.url.split('/').pop()); res.writeHead(200); res.end(); return; }
        const t = req.headers['x-auth-token'];
        setTimeout(() => {
          if (t && valid.has(t)) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"Members":[]}'); }
          else { if (t) get401++; res.writeHead(401); res.end('{}'); }
        }, 80);
      });
    });
    srv.listen(0, '127.0.0.1', async () => {
      const { fetchPower } = await import(${JSON.stringify(path.join(SRC, 'idrac/redfish.js'))});
      const e = { host: 'http://127.0.0.1:' + srv.address().port, username: 'u', password: 'p' };
      const r = await Promise.allSettled([fetchPower(e), fetchPower(e), fetchPower(e)]);
      const authFailed = r.filter((x) => x.status === 'rejected' && x.reason?.authFailed).length;
      console.log('@@' + JSON.stringify({ sessions: n, deletes: del, get401, authFailed }));
      srv.close(); process.exit(0);
    });`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, CONFIG_DIR: dir, SSRF_ALLOW_LOOPBACK: 'true', DATA_SOURCE: 'live' }, encoding: 'utf8', timeout: 60_000,
  });
  const line = r.stdout.split('\n').find((l) => l.startsWith('@@'));
  assert.ok(line, `자식 실패: ${r.stderr.slice(-800)}`);
  const o = JSON.parse(line.slice(2));
  assert.equal(o.sessions, 1, '세션 생성은 키마다 한 번(진행 중인 생성을 공유)');
  assert.equal(o.get401, 0, '교체된 세션 때문에 401 이 나면 안 된다');
  assert.equal(o.authFailed, 0, '거짓 401 은 authGuard 로 주기 수집을 멈춘다');
});

/* ── R2593-02 tar 하드링크 사본이 압축 폭탄 상한을 우회하던 것 ── */
function tarHeader(name, size, type, link = '') {
  const b = Buffer.alloc(512);
  b.write(name, 0, 100);
  b.write('0000644\0', 100); b.write('0000000\0', 108); b.write('0000000\0', 116);
  b.write(size.toString(8).padStart(11, '0') + '\0', 124);
  b.write('00000000000\0', 136);
  b.write('        ', 148);
  b.write(type, 156);
  b.write(link, 157, 100);
  b.write('ustar\0' + '00', 257);
  let sum = 0; for (const x of b) sum += x;
  b.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  return b;
}
test('R2593-02 — 하드링크 사본까지 풀린 크기에 세어, 작은 tgz 로 상한을 넘기면 거부한다', async () => {
  const { parseTarGz, MAX_BUNDLE_BYTES } = await import('../src/upgrade/archive.js');
  const size = 8 * 1024 * 1024; // 8MB 원본 + 하드링크 30개 = 248MB > 200MB
  const parts = [tarHeader('pkg/big', size, '0'), Buffer.alloc(size)];
  for (let i = 0; i < 30; i++) parts.push(tarHeader(`pkg/l${i}`, 0, '1', 'pkg/big'));
  parts.push(Buffer.alloc(1024));
  const tgz = zlib.gzipSync(Buffer.concat(parts));
  assert.ok(tgz.length < 200 * 1024, '입력은 작다(압축 해제 상한은 원본 한 번만 센다)');
  assert.ok(size * 31 > MAX_BUNDLE_BYTES);
  assert.throws(() => parseTarGz(tgz), /너무 큽니다|상한/);
  // 정상 하드링크(작은 파일)는 그대로 풀린다 — v2.591 P4 회귀 방지
  const ok = zlib.gzipSync(Buffer.concat([tarHeader('pkg/a', 5, '0'), Buffer.from('hello').subarray(0, 5), Buffer.alloc(507), tarHeader('pkg/b', 0, '1', 'pkg/a'), Buffer.alloc(1024)]));
  const e = parseTarGz(ok);
  assert.deepEqual(e.map((x) => x.name), ['pkg/a', 'pkg/b']);
  assert.equal(String(e[1].data), 'hello');
});

/* ── R2593-03 위임 요청 큐 TTL 만료도 폐기 기록에 남긴다 ── */
test('R2593-03 — 엣지가 가져가지 않은 요청의 TTL 만료가 drops 에 남고 사유가 나뉜다', async () => {
  const { createCollectRequestQueue } = await import('../src/util/collectRequestQueue.js');
  const q = createCollectRequestQueue({ ttlMs: 15 * 60e3, ackMs: 10 * 60e3 });
  q.request('dev1', 'edge-a', 0);
  q.request('dev2', 'edge-a', 0);
  q.take('edge-a', 1000, 1); // dev1 만 가져감
  const d = q.drops(27 * 60e3);
  assert.equal(q.has('dev2', 27 * 60e3), false);
  assert.equal(d.find((x) => x.id === 'dev2')?.reason, 'untaken', '한 번도 안 가져간 요청은 untaken');
  // dev1 은 시한(10분) 뒤 재대기로 돌아갔다가(27분) 다시 가져가지 않은 채 TTL(15분)이 지난다
  const d2 = q.drops(43 * 60e3);
  assert.equal(d2.find((x) => x.id === 'dev1')?.reason, 'requeued-expired', '재대기 뒤 만료도 기록');
});

/* ── R2593-04 수신 집계 상한에서 검증된 행은 밀리지 않는다(v2.589 pullStats 의 형제) ── */
test('R2593-04 — 미검증 이름 500개로 개별 토큰 엣지의 수신 기록을 밀어내지 못한다', async () => {
  const s = await import('../src/central/ingestStats.js');
  s.resetIngestStats();
  s.recordIngest('real-edge', '/inventory', { wireBytes: 1, verified: true });
  for (let i = 0; i < 600; i++) s.recordIngest(`fake-${i}`, '/inventory', { wireBytes: 1 });
  const names = s.getIngestStats().rows.map((a) => a.agent);
  assert.ok(names.includes('real-edge'));
  assert.ok(names.length <= 500);
  s.resetIngestStats();
});

/* ── AUTHZ-01·02 — 실제 라우터로 ── */
function runApp(script, extraFiles = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2593-api-'));
  for (const [f, v] of Object.entries(extraFiles)) fs.writeFileSync(path.join(dir, f), JSON.stringify(v));
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', `
    const express = (await import('express')).default;
    const { api } = await import(${JSON.stringify(path.join(SRC, 'routes/api.js'))});
    const { store } = await import(${JSON.stringify(path.join(SRC, 'store.js'))});
    await store.refresh();
    const mk = (role) => { const app = express(); app.use(express.json()); app.use((req, _r, next) => { req.user = { username: 'u', role, scope: null, permissions: ['tools', 'dashboard'] }; next(); }); app.use('/api', api); return app; };
    const serve = async (role) => new Promise((r) => { const s = mk(role).listen(0, '127.0.0.1', () => r(s)); });
    ${script}
  `], { env: { ...process.env, CONFIG_DIR: dir, DATA_SOURCE: 'mock', AUTH_ENABLED: 'false' }, encoding: 'utf8', cwd: path.resolve(SRC, '..'), timeout: 180_000 });
  const line = r.stdout.split('\n').find((l) => l.startsWith('@@'));
  assert.ok(line, `자식 실패: ${r.stderr.slice(-1500)}`);
  return JSON.parse(line.slice(2));
}
test('AUTHZ-01 — /tools/relaytopo 는 비-admin 에게 주소·계정을 가리고 그 사실을 밝힌다', () => {
  const topo = { version: 1, main: { name: 'Main', privateIp: '10.1.1.1', publicIp: '203.0.113.1' },
    sites: [{ dc: 'KR', edge: { privateIp: '10.2.2.2', publicIp: '203.0.113.2', vcenterIp: '10.2.2.9', ssh: { username: 'root' } }, irs: { privateIp: '10.3.3.3', publicIp: '', vcenterIp: '', ssh: {} } }] };
  const o = runApp(`
    const get = async (role) => { const s = await serve(role); const r = await fetch('http://127.0.0.1:' + s.address().port + '/api/tools/relaytopo'); const b = await r.json(); s.close(); return { status: r.status, b }; };
    console.log('@@' + JSON.stringify({ op: await get('operator'), ad: await get('admin') }));
  `, { 'relay-topology.json': topo });
  assert.equal(o.op.status, 200);
  const opText = JSON.stringify(o.op.b.topology);
  for (const ip of ['10.1.1.1', '203.0.113.1', '10.2.2.2', '10.2.2.9', '10.3.3.3']) assert.ok(!opText.includes(ip), `operator 응답에 ${ip} 가 없어야 한다`);
  assert.ok(!opText.includes('"root"'), 'SSH 계정명도 가린다');
  assert.equal(o.op.b.addressHidden, true);
  assert.deepEqual(o.op.b.issues, []);
  assert.equal(typeof o.op.b.issueCount, 'number');
  assert.ok(JSON.stringify(o.ad.b.topology).includes('10.2.2.2'), 'admin 은 그대로 본다');
  assert.equal(o.ad.b.addressHidden, undefined);
});
test('AUTHZ-02 — /tools/ip-ping 은 그 vCenter VM 에서 수집된 IP 만 받는다', () => {
  const o = runApp(`
    const vm = store.get().vms.find((v) => v.ipAddress);
    const s = await serve('operator');
    const post = async (body) => { const r = await fetch('http://127.0.0.1:' + s.address().port + '/api/tools/ip-ping', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, b: await r.json() }; };
    const bad = await post({ vcenterId: vm.vcenterId, ips: ['8.8.8.8'] });
    const mixed = await post({ vcenterId: vm.vcenterId, ips: [vm.ipAddress, '8.8.4.4'] });
    s.close();
    console.log('@@' + JSON.stringify({ bad, mixed }));
  `);
  assert.equal(o.bad.status, 400, '외부 IP 는 거부');
  assert.equal(o.mixed.status, 200);
  assert.equal(o.mixed.b.rejected, 1, '뺀 개수를 밝힌다');
});

/* ── EDGE-1·2·4 — 무음 실패 ── */
test('EDGE-1 — svcmon ack 가 성공해야 appliedSig 를 세운다(실패하면 다음 pull 이 다시 적용·보고)', () => {
  const s = read('agent/svcmonConfigPull.js');
  assert.match(s, /if \(!r\.ok\)[^\n]*return false;/, 'ack 가 r.ok 를 본다');
  assert.match(s, /const acked = await ack\(/);
  assert.match(s, /&& acked\) appliedSig = d\.sig/, 'appliedSig 는 ack 성공 뒤에');
  assert.ok(!/appliedSig = d\.sig;\s*\n\s*await ack\(/.test(s), 'ack 전에 appliedSig 를 세우지 않는다');
});
test('EDGE-2·4 — iDRAC 스캔 결과 회신 실패가 상태(last)에 남는다', () => {
  const sc = read('agent/scanner.js');
  assert.ok(!/postResult\([\s\S]{0,400}?\}\)\.catch\(\(\) => \{\}\)/.test(sc), '회신 실패를 삼키지 않는다');
  assert.match(sc, /return r\.ok \? null/);
  assert.match(sc, /postError: postErr/);
  const w = read('agent/idracScanWorker.js');
  assert.match(w, /const postErr = await postResult\(/);
  assert.match(w, /postError: postErr/);
});

/* ── DATA-01 REST 스토리지 사용량 결측 → null ── */
test('DATA-01 — REST 수집기는 사용량을 못 읽으면 0 이 아니라 null(pct 도 null)', async () => {
  const { normalizeUnity } = await import('../src/storage/collectors/unity.js');
  const u = normalizeUnity({ id: 'u', type: 'unity480', host: 'h' }, { cap: { entries: [{ content: { sizeTotal: 1e12 } }] }, pools: { entries: [{ content: { name: 'p', sizeTotal: 1e12 } }] } });
  assert.equal(u.capacity.usedBytes, null);
  assert.equal(u.capacity.pct, null);
  assert.equal(u.pools[0].usedBytes, null);
  const { normalizeIsilon } = await import('../src/storage/collectors/isilon.js');
  const i = normalizeIsilon({ id: 'i', type: 'isilon', host: 'h' }, { stats: { stats: [{ key: 'ifs.bytes.total', value: 1e12 }] } });
  assert.equal(i.capacity.usedBytes, null);
  const i2 = normalizeIsilon({ id: 'i', type: 'isilon', host: 'h' }, { stats: { stats: [{ key: 'ifs.bytes.total', value: 1000 }, { key: 'ifs.bytes.avail', value: 400 }] } });
  assert.equal(i2.capacity.usedBytes, 600, 'avail 로 계산할 수 있으면 계산한다');
  const i3 = normalizeIsilon({ id: 'i', type: 'isilon', host: 'h' }, { stats: { stats: [{ key: 'ifs.bytes.total', value: 1000 }, { key: 'ifs.bytes.used', value: 0 }] } });
  assert.equal(i3.capacity.usedBytes, 0, '보고된 0 은 값이다');
  const { powermaxCapacity } = await import('../src/storage/collectors/powermax.js');
  const pm = powermaxCapacity({ physicalCapacity: { total_capacity_gb: 100 } });
  assert.equal(pm.usedBytes, null);
});

/* ── DATA-02·04 GPU ── */
test('DATA-02 — MIG(utilNA) 게스트는 사용률 null + utilNA 로 저장되고 0% 가 되지 않는다', async () => {
  const g = await import('../src/gpu/store.js');
  g.setGuestGpu({ vms: [{ vmId: 'vm-mig', utilNA: true, utilPct: null, memUsedPct: 12, host: 'h', vcenterId: 'vc' }] });
  const v = g.getGuestGpuVms().find((x) => x.vmId === 'vm-mig');
  assert.ok(v, 'MIG VM 도 수집된 것으로 남는다');
  assert.equal(v.utilPct, null);
  assert.equal(v.utilNA, true);
  const p = read('gpu/poller.js');
  assert.match(p, /utilPct: r\.utilNA \? null : r\.utilPct/);
  assert.match(p, /if \(!r\.utilNA\) \{ const arr = byHost/, '호스트 대표값에서 뺀다');
});
test('DATA-04 — nvidia-smi 빈 칸은 0 이 아니라 결측이다', async () => {
  const { parseNvidiaSmiCsv } = await import('../src/gpu/guestops.js');
  const r = parseNvidiaSmiCsv(', 5, 100, 1000, Disabled');
  assert.equal(r.gpus[0].utilPct, null);
  assert.equal(r.utilNA, true);
  assert.equal(parseNvidiaSmiCsv('0, 5, 100, 1000, Disabled').utilPct, 0, '보고된 0 은 값이다');
});

/* ── PERF-2 릴리스 노트 캐시 ── */
test('PERF-2 — listNotes 는 파일이 그대로면 다시 읽지 않는다(사본을 준다)', async () => {
  const m = await import('../src/release-notes.js');
  const a = m.listNotes();
  const spy = fs.readFileSync;
  let reads = 0;
  fs.readFileSync = (...args) => { reads++; return spy(...args); };
  try { m.listNotes(); } finally { fs.readFileSync = spy; }
  assert.equal(reads, 0);
  const b = m.listNotes();
  assert.notEqual(a, b, '호출부가 배열을 고쳐도 캐시가 오염되지 않게 사본');
  assert.equal(a.length, b.length);
});

/* ── DEPS-01·02·03·06 ── */
test('DEPS-01 — tcpProbeMany·pingMany 는 concurrency 0 이어도 대상을 잰다(공용 풀)', async () => {
  const { tcpProbeMany } = await import('../src/util/ping.js');
  const r = await tcpProbeMany([{ host: '127.0.0.1', port: 1 }], { concurrency: 0, timeoutMs: 500 });
  assert.equal(r.length, 1);
  assert.equal(r[0].alive, false);
});
test('DEPS-02 — 튜플 비교기는 cmpVersion 이라는 이름을 쓰지 않는다(문자열 단일 소스와 혼동)', () => {
  const s = read('upgrade/upgrade.js');
  assert.ok(!/export function cmpVersion\(/.test(s));
  assert.match(s, /export function cmpVersionTuple\(/);
});
test('DEPS-03 — ipam/scanStore 의 IPv4 파서는 util/ipv4 다', () => {
  const s = read('ipam/scanStore.js');
  assert.ok(!/split\('\.'\)\.map\(Number\)/.test(s));
  assert.match(s, /from '\.\.\/util\/ipv4\.js'/);
});
test('DEPS-06 — 아키텍처 스윕이 재수출(export … from) edge 도 센다', () => {
  const t = fs.readFileSync(path.join(HERE, 'arch2579.test.js'), 'utf8');
  assert.match(t, /\(\?:import\|export\)/);
});
test('DEPS-05 — CI 가 루트 의존성도 audit 한다', () => {
  const ci = fs.readFileSync(path.resolve(HERE, '../../.github/workflows/ci.yml'), 'utf8');
  assert.match(ci, /echo '=== root[^\n]*npm audit --audit-level=critical/);
});
