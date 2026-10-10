/**
 * test/audit2732e_isiPower.test.js — 점검 2회차(v2.732) B2-07: Isilon 전원 노드 합이 **일부 노드만** 더한 값일 때
 * '측정' 이 아니라 부분 합(partial + missing)으로 싣는가.
 *
 * 재현(수정 전): 키는 맞는데 값을 못 읽은 노드 행(`value:null`, error)을 조용히 건너뛰어 6노드 중 4노드 합을
 * `{watts:2000, nodes:4, parts:4}` 로 냈고 powerResult 에 missing 이 없어 합산이 '측정 1 · 부분 0' 으로 셌다
 * (v2.682 R3D-03 partial 경로를 Isilon 만 쓰지 않았다). 노드가 행 자체를 빠뜨리면 노드 수(REST cluster/nodes · SSH isi status)로 대조한다.
 * ⑥ 은 실제 REST 수집 진입(collect)을 가짜 OneFS HTTPS 장비에 붙여 노드 수 대조 배선까지 본다.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FX = path.join(HERE, 'fixtures', 'rvI-tls');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'a2732e-isi-'));
process.env.CONFIG_DIR = TMP;
process.env.SSRF_ALLOW_LOOPBACK = 'true';
process.env.STORAGE_TLS_VERIFY = 'false'; // 가짜 장비 자체서명 — 명시적 예외(모듈 로드 때 읽는다)
process.env.SSH_HOSTKEY_POLICY = 'observe'; // 호스트키가 주제가 아니다(가짜 SSH 장비)
after(async () => {
  // 가짜 SSH 장비의 호스트키 관찰 기록(묶음 저장)을 먼저 비운다 — 아니면 종료 flush 가 지운 임시 폴더를 다시 만든다.
  try { (await import('../src/security/peerTrust.js')).flushPeerTrust(); } catch { /* */ }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ }
});

const ip = await import('../src/storage/collectors/isilonPower.js');
const { readIsiPowerSsh, collectViaSsh, ISI_STATS_CMD } = await import('../src/storage/collectors/isilonSsh.js');
const { buildPowerTotal } = await import('../src/power/total.js');

const KEY = 'node.power.consumption';
const restRows = (n, okN) => ({ stats: Array.from({ length: n }, (_, i) => ({ key: KEY, devid: i + 1, value: i < okN ? 500 : null, ...(i < okN ? {} : { error: 'node unreachable' }) })) });

test('① 값 없는 노드 행은 missing 으로 센다 — 부분 합을 측정으로 말하지 않는다', () => {
  const p = ip.isiPowerFromStats(restRows(6, 4), KEY);
  assert.deepEqual(p, { watts: 2000, nodes: 4, parts: 4, missing: 2 });
  const r = ip.isiPowerResult(p, KEY, `OneFS statistics ${KEY}`);
  assert.equal(r.partial, true);
  assert.equal(r.missing, 2);
  assert.equal(r.scope, 'node');
  const now = Date.now();
  const t = buildPowerTotal({ storage: [{ id: 'i1', name: 'isi', type: 'isilon', collectMethod: 'api', snap: { ok: true, collectedAt: now, nodes: { count: 6 }, extra: { power: r } } }], now });
  assert.equal(t.storage.partial, 1, '합산이 부분 합으로 센다');
  assert.equal(t.storage.measured, 0);
});

test('② 모든 노드를 읽었으면 예전 모양 그대로(missing 없음) · 같은 노드의 값 있는 행이 있으면 빠진 것이 아니다', () => {
  assert.deepEqual(ip.isiPowerFromStats(restRows(4, 4), KEY), { watts: 2000, nodes: 4, parts: 4 });
  const dup = { stats: [{ key: KEY, devid: 1, value: null }, { key: KEY, devid: 1, value: 400 }, { key: KEY, devid: 2, value: 300 }] };
  assert.deepEqual(ip.isiPowerFromStats(dup, KEY), { watts: 700, nodes: 2, parts: 2 });
  assert.equal(ip.isiPowerResult(ip.isiPowerFromStats(restRows(4, 4), KEY), KEY, 's').partial, undefined);
});

test('③ 노드 수 대조 — 응답이 노드 행을 빠뜨리면 차이만큼 missing · 노드 수를 모르면 대조하지 않는다', () => {
  assert.equal(ip.isiPowerFromStats(restRows(4, 4), KEY, { expectedNodes: 6 }).missing, 2);
  assert.equal(ip.isiPowerFromStats(restRows(6, 4), KEY, { expectedNodes: 6 }).missing, 2, '값 없는 행과 노드 수 차이를 이중으로 세지 않는다');
  assert.equal(ip.isiPowerFromStats(restRows(6, 4), KEY, { expectedNodes: 8 }).missing, 4);
  for (const e of [null, 0, 4, 3, '', 'x']) assert.equal('missing' in ip.isiPowerFromStats(restRows(4, 4), KEY, { expectedNodes: e }), false, `expectedNodes=${e}`);
  // 클러스터 행만 있으면 전체 값 — 노드 수와 대조하지 않는다
  const cl = ip.isiPowerFromStats({ stats: [{ key: KEY, devid: 0, value: 3000 }] }, KEY, { expectedNodes: 6 });
  assert.deepEqual(cl, { watts: 3000, nodes: null, parts: 1 });
});

test('④ SSH — 값 없는 노드 · 노드 수 부족이면 partial', async () => {
  ip._resetIsiPowerCache();
  const sh = { exec: async (cmd) => (/list keys/.test(cmd) ? { stdout: `${KEY}  W\n` }
    : { stdout: JSON.stringify([{ node: 1, [KEY]: 350 }, { node: 2, [KEY]: 360 }, { node: 3, [KEY]: null }]) }) };
  const r1 = await readIsiPowerSsh(sh, 'h1');
  assert.equal(r1.power.watts, 710);
  assert.equal(r1.power.partial, true);
  assert.equal(r1.power.missing, 1);
  ip._resetIsiPowerCache();
  const sh2 = { exec: async (cmd) => (/list keys/.test(cmd) ? { stdout: `${KEY}  W\n` }
    : { stdout: JSON.stringify([{ node: 1, [KEY]: 350 }, { node: 2, [KEY]: 360 }]) }) };
  const r2 = await readIsiPowerSsh(sh2, 'h2', { expectedNodes: 4 });
  assert.equal(r2.power.partial, true);
  assert.equal(r2.power.missing, 2);
  ip._resetIsiPowerCache();
  const r3 = await readIsiPowerSsh(sh2, 'h3', { expectedNodes: 2 });
  assert.equal(r3.power.partial, undefined, '노드를 전부 읽었으면 측정');
});

test('⑤ 값을 하나도 못 읽으면 예전처럼 probe(no-field) — 0 W 를 지어내지 않는다', async () => {
  assert.equal(ip.isiPowerFromStats(restRows(3, 0), KEY), null);
  ip._resetIsiPowerCache();
  const sh = { exec: async (cmd) => (/list keys/.test(cmd) ? { stdout: `${KEY}  W\n` } : { stdout: JSON.stringify([{ node: 1, [KEY]: null }]) }) };
  const r = await readIsiPowerSsh(sh, 'h4');
  assert.equal(r.power, undefined);
  assert.equal(r.probe.reason, 'no-field');
});

test('⑥ REST 수집 진입(collect) — cluster/nodes 노드 수로 대조해 partial 을 싣는다', async () => {
  ip._resetIsiPowerCache();
  const nodes = Array.from({ length: 6 }, (_, i) => ({ id: i + 1, lnn: i + 1, status: { health: 'ok' } }));
  const srv = https.createServer({ key: fs.readFileSync(path.join(FX, 'self-a.key')), cert: fs.readFileSync(path.join(FX, 'self-a.crt')) }, (req, res) => {
    const u = new URL(req.url, 'https://x');
    let body = {};
    if (u.pathname === '/platform/1/cluster/config') body = { name: 'isi-test', onefs_version: { release: '9.5.0.0' } };
    else if (u.pathname === '/platform/3/cluster/nodes') body = { nodes };
    else if (u.pathname === '/platform/1/statistics/keys') body = { keys: [{ key: KEY }, { key: 'ifs.bytes.total' }] };
    else if (u.pathname === '/platform/1/statistics/current' && u.searchParams.get('key') === KEY) {
      body = { stats: [1, 2, 3, 4].map((d) => ({ key: KEY, devid: d, value: 500 })) }; // 노드 5·6 은 행이 없다
    } else if (u.pathname === '/platform/1/statistics/current') body = { stats: [] };
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(body));
  });
  srv.keepAliveTimeout = 1;
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  process.env.STORAGE_ISILON_PORT = String(srv.address().port);
  try {
    const { collect } = await import('../src/storage/collectors/isilon.js');
    const snap = await collect({ id: 'isi-1', type: 'isilon', collectMethod: 'api', host: '127.0.0.1', username: 'svc', password: 'pw' });
    assert.equal(snap.nodes?.count, 6);
    assert.ok(snap.extra?.power, `전원을 읽었다 ${JSON.stringify(snap.extra?.powerProbe || null)}`);
    assert.equal(snap.extra.power.watts, 2000);
    assert.equal(snap.extra.power.partial, true, '6노드 중 4노드 합은 부분 합');
    assert.equal(snap.extra.power.missing, 2);
  } finally {
    await new Promise((r) => { srv.closeAllConnections?.(); srv.close(() => r()); });
    delete process.env.STORAGE_ISILON_PORT;
  }
});

test('⑦ SSH 수집 진입(collectViaSsh) — isi status 노드 수로 대조해 partial 을 싣는다', async () => {
  ip._resetIsiPowerCache();
  const ssh2 = createRequire(import.meta.url)('ssh2');
  // ⚠ ssh2 의 ed25519 생성기는 자기 파서가 거부하는 키를 만들 수 있다(v2.590 CI 사고) — EC SEC1 PEM.
  const hostKey = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ type: 'sec1', format: 'pem' });
  // 합성 isi status(식별자는 문서용 주소 — v2.513 규약) — 노드 3대
  const status = [
    'Cluster Name: synth-isi', 'Cluster Health:     [  OK ]',
    'Cluster Storage:  HDD                 SSD Storage', 'Size:             100T (100T Raw)     0 (0 Raw)',
    'Used:             10T (10%)           0 (n/a)', 'Avail:            90T (90%)           0 (n/a)', '',
    '  1|192.0.2.11    | OK  | C |    0|    0|    0| 3.0T/ 33T( 9%)|      L3:  373G',
    '  2|192.0.2.12    | OK  | C |    0|    0|    0| 3.0T/ 33T( 9%)|      L3:  373G',
    '  3|192.0.2.13    | OK  | C |    0|    0|    0| 4.0T/ 34T(12%)|      L3:  373G', '',
  ].join('\n');
  const reply = (cmd) => {
    if (cmd === 'isi status') return status;
    if (cmd === ISI_STATS_CMD) return '';
    if (cmd === ip.ISI_POWER_KEYS_CMD) return `${KEY}  Power consumed\n`;
    if (cmd === ip.isiPowerQueryCmd(KEY)) return JSON.stringify([{ node: 1, [KEY]: 400 }, { node: 2, [KEY]: 410 }]); // 노드 3 행 없음
    return '';
  };
  const srv = new ssh2.Server({ hostKeys: [hostKey] }, (client) => {
    client.on('authentication', (ctx) => ctx.accept());
    client.on('ready', () => client.on('session', (accept) => {
      const s = accept();
      s.on('pty', (a) => a && a());
      s.on('exec', (a, _r, info) => { const ch = a(); ch.write(reply(info.command)); ch.exit(0); ch.end(); });
    }));
    client.on('error', () => {});
  });
  const port = await new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
  try {
    const snap = await collectViaSsh({ id: 'isi-ssh', type: 'isilon', host: '127.0.0.1', sshPort: port, username: 'svc', password: 'pw' });
    assert.equal(snap.nodes?.count, 3, `isi status 를 읽었다 ${snap.error || ''}`);
    assert.ok(snap.extra?.power, `전원을 읽었다 ${JSON.stringify(snap.extra?.powerProbe || null)}`);
    assert.equal(snap.extra.power.watts, 810);
    assert.equal(snap.extra.power.partial, true, '3노드 중 2노드 합은 부분 합');
    assert.equal(snap.extra.power.missing, 1);
  } finally { srv.close(); }
});
